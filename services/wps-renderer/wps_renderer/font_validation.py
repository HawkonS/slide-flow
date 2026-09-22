"""Bound font metadata before asking fontTools or Windows to load it."""
import struct

from .errors import RenderError


def preflight_font(path):
    """Reject oversized TTC counts and aliased name-string allocation bombs.

    fontTools parses TTC faces and every name record eagerly before callers can
    inspect their counts. SFNT directory/name bounds must therefore come first.
    This is metadata validation, not a replacement for an OS font-engine sandbox.
    """
    try:
        size = path.stat().st_size
        if size < 12 or size > 64 * 1024 * 1024:
            raise ValueError("Font size limit")
        with path.open("rb") as source:
            def read_at(offset, length):
                if offset < 0 or length < 0 or offset + length > size:
                    raise ValueError("Font table outside file")
                source.seek(offset)
                data = source.read(length)
                if len(data) != length:
                    raise ValueError("Truncated font table")
                return data

            header = read_at(0, 12)
            if header[:4] == b"ttcf":
                count = struct.unpack(">I", header[8:12])[0]
                if not 1 <= count <= 64:
                    raise ValueError("Font collection face limit")
                offsets = struct.unpack(f">{count}I", read_at(12, count * 4))
                if len(set(offsets)) != len(offsets):
                    raise ValueError("Duplicate collection face offsets")
            else:
                offsets = (0,)
            metadata_bytes = 0
            for offset in offsets:
                header = read_at(offset, 12)
                if header[:4] not in {b"\x00\x01\x00\x00", b"OTTO", b"true"}:
                    raise ValueError("Unsupported SFNT signature")
                count = struct.unpack(">H", header[4:6])[0]
                if not 1 <= count <= 512:
                    raise ValueError("Font table count limit")
                directory = read_at(offset + 12, count * 16)
                names = None
                tags = set()
                for index in range(count):
                    tag, _, table_offset, length = struct.unpack_from(">4sIII", directory, index * 16)
                    if tag in tags or table_offset + length > size:
                        raise ValueError("Invalid font table directory")
                    tags.add(tag)
                    if tag == b"name":
                        if length > 2 * 1024 * 1024 or length < 6:
                            raise ValueError("Font name table limit")
                        names = read_at(table_offset, length)
                if not {b"name", b"head", b"maxp"} <= tags or names is None:
                    raise ValueError("Missing mandatory font tables")
                format_id, count, string_offset = struct.unpack_from(">HHH", names)
                if format_id not in {0, 1} or not 1 <= count <= 2048 or 6 + count * 12 > len(names):
                    raise ValueError("Font name record limit")
                if string_offset < 6 + count * 12 or string_offset > len(names):
                    raise ValueError("Invalid font name string storage")
                metadata_bytes += len(names)
                for index in range(count):
                    _, _, _, _, length, relative = struct.unpack_from(">6H", names, 6 + index * 12)
                    if length > 8192 or string_offset + relative + length > len(names):
                        raise ValueError("Font name record limit")
                    # Count repeated/aliased strings too: each creates an object
                    # when fontTools decompiles the name table.
                    metadata_bytes += length
                if metadata_bytes > 8 * 1024 * 1024:
                    raise ValueError("Font collection metadata budget")
    except (OSError, ValueError, struct.error) as exc:
        raise RenderError("invalid_font", "Malformed font or font metadata exceeds safety limits") from exc
