"""PPTX ZIP access, namespaces and package relationship paths."""

from __future__ import annotations

import posixpath
import struct
import zipfile
import zlib
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET


A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"


P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"


R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


PKG_CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"


SLIDE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"


SLIDE_MASTER_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster"


SLIDE_LAYOUT_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"


NOTES_MASTER_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster"


THEME_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"


IMAGE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"


def _local_name(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[1]
    return tag


def _clean_font_name(name: str) -> str | None:
    value = name.strip()
    if not value or value.startswith("+"):
        return None
    return value


def _read_pptx_entries(pptx_path: Path) -> list[tuple[str, bytes]]:
    """Read all zip entries as (name, uncompressed_bytes).

    Falls back to scanning local file headers when the central directory is
    inconsistent with local headers (seen in some malformed PPTX files).
    """
    try:
        entries: list[tuple[str, bytes]] = []
        with zipfile.ZipFile(pptx_path) as package:
            for info in package.infolist():
                entries.append((info.filename, package.read(info.filename)))
        return entries
    except zipfile.BadZipFile:
        return _scan_zip_entries(pptx_path.read_bytes())


def _scan_zip_entries(data: bytes) -> list[tuple[str, bytes]]:
    """Scan a zip by walking local file headers, ignoring the central directory.

    Returns a list of (filename, uncompressed_bytes). Directory entries (names
    ending with "/") are skipped. Used as a fallback when the central directory
    references are inconsistent with the actual local file headers.
    """
    LFH_SIG = b"PK\x03\x04"
    CD_SIG = b"PK\x01\x02"
    DD_SIG = b"PK\x07\x08"

    entries: list[tuple[str, bytes]] = []
    offset = 0
    total = len(data)

    while offset + 4 <= total:
        sig = data[offset:offset + 4]
        if sig == CD_SIG:
            break
        if sig != LFH_SIG:
            idx = data.find(LFH_SIG, offset + 1)
            if idx < 0:
                break
            offset = idx
            continue
        if offset + 30 > total:
            break

        (_ver, flags, method, _mtime, _mdate, _crc,
         csize, _usize, fnlen, extralen) = struct.unpack(
            "<HHHHHIIIHH", data[offset + 4:offset + 30]
        )
        name_start = offset + 30
        name_end = name_start + fnlen
        extra_end = name_end + extralen
        if extra_end > total:
            break
        try:
            name = data[name_start:name_end].decode("utf-8")
        except UnicodeDecodeError:
            name = data[name_start:name_end].decode("cp437", "replace")
        data_start = extra_end

        if flags & 0x08:
            # Data descriptor: compressed size is not reliable in the header.
            dd_idx = data.find(DD_SIG, data_start)
            if dd_idx < 0:
                break
            compressed = data[data_start:dd_idx]
            next_offset = dd_idx + 16  # sig(4) + crc(4) + csize(4) + usize(4)
        else:
            compressed = data[data_start:data_start + csize]
            next_offset = data_start + csize

        try:
            if method == 0:
                content = compressed
            elif method == 8:
                content = zlib.decompress(compressed, -15)
            else:
                offset = next_offset
                continue
        except zlib.error:
            offset = next_offset
            continue

        if not name.endswith("/"):
            entries.append((name, content))
        offset = next_offset

    return entries


# Media entries are already compressed; storing them avoids expensive
# recompression during split/merge/image-PPTX operations.
_PRECOMPRESSED_EXTS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff",
    ".mp4", ".m4v", ".mp3", ".wmv", ".wma", ".avi", ".mov",
    ".emf", ".wmf",
})


def _resolve_rel_path(base_dir: str, target: str) -> str:
    """Resolve a relative target path against a base directory inside the ZIP.

    Example: base_dir='ppt/slides/', target='../media/image1.png' -> 'ppt/media/image1.png'
    """
    if target.startswith('/'):
        return target.lstrip('/')
    combined = PurePosixPath(base_dir) / target
    parts: list[str] = []
    for part in combined.parts:
        if part == '..':
            if parts:
                parts.pop()
        elif part != '.':
            parts.append(part)
    return '/'.join(parts)


def _parse_rels_targets(rels_data: bytes) -> list[str]:
    """Parse a .rels XML and return all internal Target values."""
    if not rels_data:
        return []
    try:
        root = ET.fromstring(rels_data)
    except ET.ParseError:
        return []
    targets: list[str] = []
    for rel in root:
        if rel.attrib.get('TargetMode', 'Internal') == 'External':
            continue
        target = rel.attrib.get('Target', '')
        if target:
            targets.append(target)
    return targets


# ---------------------------------------------------------------------------
# PPTX merging
# ---------------------------------------------------------------------------


def _rels_path_for(part: str) -> str:
    """Return the rels file path for a given part name."""
    parent = posixpath.dirname(part)
    name = posixpath.basename(part)
    rels_name = f"{name}.rels"
    return f"{parent}/_rels/{rels_name}" if parent else f"_rels/{rels_name}"


def _resolve_target(source_part: str, target: str) -> str:
    """Resolve a (possibly relative) relationship target to a zip-internal path."""
    if target.startswith("/"):
        return target.lstrip("/")
    source_dir = posixpath.dirname(source_part)
    return posixpath.normpath(posixpath.join(source_dir, target))


def _make_relative(source_part: str, target_part: str) -> str:
    source_dir = posixpath.dirname(source_part)
    return posixpath.relpath(target_part, source_dir or ".")


def _suffix_part_name(part: str, tag: str) -> str:
    """Insert a uniqueness tag before the file extension, e.g. slide1.xml -> slide1_src2.xml."""
    parent = posixpath.dirname(part)
    name = posixpath.basename(part)
    if "." in name:
        stem, ext = name.rsplit(".", 1)
        new_name = f"{stem}_{tag}.{ext}"
    else:
        new_name = f"{name}_{tag}"
    return f"{parent}/{new_name}" if parent else new_name


def _read_rels_root(files: dict[str, bytes], part: str) -> ET.Element | None:
    """Parse the .rels file for a given part. Returns None if missing or invalid."""
    data = files.get(_rels_path_for(part))
    if not data:
        return None
    try:
        return ET.fromstring(data)
    except ET.ParseError:
        return None


def _get_slide_paths_from_presentation(pres_xml: bytes, rels_xml: bytes) -> list[str]:
    """Parse presentation.xml and its rels to get ordered list of slide file paths."""
    pres_root = ET.fromstring(pres_xml)
    rels_root = ET.fromstring(rels_xml)

    slide_list = pres_root.find(f"{{{P_NS}}}sldIdLst")
    if slide_list is None:
        return []

    # Build rId -> target path mapping from rels
    rid_to_path: dict[str, str] = {}
    for rel in rels_root:
        rid = rel.attrib.get("Id")
        rtype = rel.attrib.get("Type", "")
        target = rel.attrib.get("Target", "")
        target_mode = rel.attrib.get("TargetMode", "Internal")
        if rid and rtype == SLIDE_REL_TYPE and target_mode != "External":
            rid_to_path[rid] = _resolve_rel_path("ppt/", target)

    # Get ordered slide paths following sldIdLst order
    rel_id_attr = f"{{{R_NS}}}id"
    slide_paths: list[str] = []
    for sld_id in slide_list:
        rid = sld_id.attrib.get(rel_id_attr)
        if rid and rid in rid_to_path:
            slide_paths.append(rid_to_path[rid])

    return slide_paths


def _next_rel_id(rels_root: ET.Element) -> str:
    """Return an Id that is not already used inside *rels_root*."""
    used: set[str] = set()
    for child in rels_root:
        rid = child.attrib.get("Id", "")
        if rid:
            used.add(rid)
    n = 1
    while f"rId{n}" in used:
        n += 1
    return f"rId{n}"

ET.register_namespace("a", A_NS)
ET.register_namespace("p", P_NS)
ET.register_namespace("r", R_NS)
