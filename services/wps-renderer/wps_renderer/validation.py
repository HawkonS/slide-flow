"""Treat even authenticated callers and Office containers as untrusted input."""
import hashlib
import json
import re
import stat
import zipfile
from pathlib import Path, PurePosixPath

from .errors import RenderError
from .office_xml import validate_xml

HASH = re.compile(r"^[0-9a-f]{64}$")
PAGE = re.compile(r"^pages/[A-Za-z0-9_-]+\.pptx$")
SOURCE = re.compile(r"^source/[A-Za-z0-9_-]+\.pptx$")
FONT = re.compile(r"^fonts/[A-Za-z0-9_-]+\.(ttf|otf|ttc|otc)$", re.I)
SLIDE = re.compile(r"^ppt/slides/slide[0-9]+\.xml$")
RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.I)


def _manifest_json(data):
    """Reject duplicate keys and non-finite constants in uploaded manifests."""
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate manifest key")
            result[key] = value
        return result
    return json.loads(
        data,
        object_pairs_hook=pairs,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid manifest number")),
    )


def digest(path):
    result = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def _entries(archive, limit, count=4096):
    infos = archive.infolist()
    if len(infos) > count:
        raise RenderError("invalid_archive", "Archive has too many entries")
    names = set()
    total = 0
    for item in infos:
        path = PurePosixPath(item.filename)
        name = item.filename
        if (not name or "\\" in name or ":" in name or "\x00" in name or path.is_absolute()
                or any(part in {"..", "."} for part in name.split("/"))
                or any(RESERVED.match(part) or part.endswith((" ", ".")) for part in path.parts)
                or name.casefold() in names or item.flag_bits & 1
                or stat.S_ISLNK(item.external_attr >> 16)):
            raise RenderError("invalid_archive", "Unsafe archive entry")
        names.add(name.casefold())
        total += item.file_size
        if total > limit or item.file_size > max(1024 * 1024, item.compress_size * 1000):
            raise RenderError("archive_too_large", "Archive exceeds expanded-size or compression-ratio limit", 413)
    return infos


def _validate_pptx(path, expanded_limit, expected_slides):
    try:
        with zipfile.ZipFile(path) as archive:
            infos = _entries(archive, expanded_limit)
            names = {item.filename for item in infos}
            if "[Content_Types].xml" not in names or "ppt/presentation.xml" not in names:
                raise RenderError("invalid_pptx", "A valid PPTX is required")
            if len([name for name in names if SLIDE.fullmatch(name)]) != expected_slides:
                raise RenderError("invalid_pptx", "PPTX slide count does not match its manifest")
            xml_bytes = 0
            for item in infos:
                lower = item.filename.lower()
                if any(part in lower for part in ("vbaproject", "activex/", "embeddings/", "oleobject")):
                    raise RenderError("unsafe_pptx", "Macros, ActiveX, and embedded executable/Office objects are not accepted")
                if lower.endswith((".xml", ".rels")):
                    xml_bytes += item.file_size
                    if item.file_size > 8 * 1024 * 1024 or xml_bytes > 32 * 1024 * 1024:
                        raise RenderError("invalid_pptx", "PPTX XML exceeds size limits")
                    validate_xml(
                        archive.read(item), lower,
                        expected_slides if lower == "ppt/presentation.xml" else 1,
                    )
    except RenderError:
        raise
    except Exception as exc:
        raise RenderError("invalid_pptx", "Malformed or unsafe PPTX container") from exc


def validate_pptx(path, expanded_limit):
    _validate_pptx(path, expanded_limit, 1)


def validate_render_source_pptx(path, expanded_limit, expected_slides):
    if type(expected_slides) is not int or expected_slides < 1:
        raise RenderError("invalid_manifest", "Invalid render-source slide count")
    _validate_pptx(path, expanded_limit, expected_slides)


def unpack_bundle(bundle, destination, settings):
    """Extract protocol-v1 single pages or one protocol-v2 multi-page source."""
    try:
        with zipfile.ZipFile(bundle) as archive:
            infos = _entries(archive, settings.max_expanded_bytes, 256)
            by_name = {item.filename: item for item in infos}
            manifest_info = by_name.get("manifest.json")
            if not manifest_info or manifest_info.file_size > 256 * 1024:
                raise RenderError("invalid_manifest", "Missing or oversized manifest.json")
            manifest = _manifest_json(archive.read(manifest_info))
            version = manifest.get("version") if isinstance(manifest, dict) else None
            if type(version) is not int or version not in {1, 2}:
                raise RenderError("invalid_manifest", "Protocol version 1 or 2 is required")
            dpi = manifest.get("dpi", 150)
            pages, fonts = manifest.get("pages"), manifest.get("fonts", [])
            required = manifest.get("required_fonts", [])
            font_hashes = manifest.get("font_hashes")
            font_bindings = manifest.get("font_bindings", [])
            if font_hashes is not None and (not isinstance(font_hashes, list) or len(font_hashes) > 64
                    or any(not isinstance(sha, str) or not HASH.fullmatch(sha) for sha in font_hashes)
                    or len(set(font_hashes)) != len(font_hashes)):
                raise RenderError("invalid_manifest", "Invalid font hash inventory")
            if type(dpi) is not int or not 72 <= dpi <= settings.max_dpi:
                raise RenderError("invalid_manifest", "DPI is outside the configured range")
            page_limit = settings.max_pages if version == 1 else settings.max_batch_pages
            if not isinstance(pages, list) or not 1 <= len(pages) <= page_limit:
                raise RenderError("invalid_manifest", "Invalid batch page count")
            if not isinstance(fonts, list) or len(fonts) > 64:
                raise RenderError("invalid_manifest", "Invalid font count")
            if (not isinstance(required, list) or len(required) > 128
                    or any(not isinstance(name, str) or not name.strip() or len(name) > 256 for name in required)):
                raise RenderError("invalid_manifest", "Invalid required font names")
            if (not isinstance(font_bindings, list) or len(font_bindings) > 512
                    or any(
                        not isinstance(binding, dict)
                        or not isinstance(binding.get("name"), str)
                        or binding.get("name") not in required
                        or not isinstance(binding.get("sha256"), str)
                        or font_hashes is None
                        or binding.get("sha256") not in font_hashes
                        for binding in font_bindings
                    )):
                raise RenderError("invalid_manifest", "Invalid font alias bindings")
            binding_pairs = {
                (binding["name"], binding["sha256"])
                for binding in font_bindings
            }
            if (len(binding_pairs) != len(font_bindings)
                    or (font_bindings and {name for name, _ in binding_pairs} != set(required))):
                raise RenderError("invalid_manifest", "Incomplete or duplicate font alias bindings")

            expected = {"manifest.json"}
            indexes = set()
            file_items = []
            if version == 1:
                for page in pages:
                    if not isinstance(page, dict):
                        raise RenderError("invalid_manifest", "Invalid page entry")
                    name, sha, index = page.get("file", ""), page.get("sha256", ""), page.get("index")
                    if (not isinstance(name, str) or not PAGE.fullmatch(name) or not isinstance(sha, str)
                            or not HASH.fullmatch(sha) or type(index) is not int or not 0 <= index <= 100000
                            or index in indexes):
                        raise RenderError("invalid_manifest", "Invalid or duplicate page entry")
                    indexes.add(index)
                    file_items.append(page)
            else:
                source = manifest.get("source")
                if not isinstance(source, dict):
                    raise RenderError("invalid_manifest", "Missing render source")
                source_name, source_sha = source.get("file", ""), source.get("sha256", "")
                slide_count = source.get("slide_count")
                if (not isinstance(source_name, str) or not SOURCE.fullmatch(source_name)
                        or not isinstance(source_sha, str) or not HASH.fullmatch(source_sha)
                        or type(slide_count) is not int or not 1 <= slide_count <= settings.max_source_slides):
                    raise RenderError("invalid_manifest", "Invalid render source")
                slides = []
                for page in pages:
                    if not isinstance(page, dict):
                        raise RenderError("invalid_manifest", "Invalid page entry")
                    index, slide = page.get("index"), page.get("slide")
                    if (type(index) is not int or not 0 <= index <= 100000 or index in indexes
                            or type(slide) is not int or not 1 <= slide <= slide_count or slide in slides):
                        raise RenderError("invalid_manifest", "Invalid or duplicate page mapping")
                    indexes.add(index)
                    slides.append(slide)
                if slides != sorted(slides):
                    raise RenderError("invalid_manifest", "Batch slides must be ordered")
                file_items.append(source)

            for font in fonts:
                if not isinstance(font, dict):
                    raise RenderError("invalid_manifest", "Invalid font entry")
                name, sha = font.get("file", ""), font.get("sha256", "")
                if not isinstance(name, str) or not FONT.fullmatch(name) or not isinstance(sha, str) or not HASH.fullmatch(sha):
                    raise RenderError("invalid_manifest", "Invalid font file or SHA-256")
                file_items.append(font)

            for item in file_items:
                name = item["file"]
                if name in expected or name not in by_name:
                    raise RenderError("invalid_manifest", "Missing or duplicate manifest file")
                expected.add(name)
                if by_name[name].file_size > settings.max_input_file_bytes:
                    raise RenderError("file_too_large", "Individual PPTX or font exceeds the configured input-file limit", 413)
            if expected != set(by_name):
                raise RenderError("invalid_archive", "Bundle contains unmanifested files")
            if font_hashes is not None and any(entry["sha256"] not in font_hashes for entry in fonts):
                raise RenderError("invalid_manifest", "Uploaded fonts must belong to the declared hash inventory")

            for item in file_items:
                output = destination / item["file"]
                output.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item["file"]) as source_stream, open(output, "xb") as sink:
                    sha, size = hashlib.sha256(), 0
                    while True:
                        chunk = source_stream.read(1024 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > by_name[item["file"]].file_size:
                            raise RenderError("invalid_archive", "Archive size mismatch")
                        sha.update(chunk)
                        sink.write(chunk)
                if sha.hexdigest() != item["sha256"]:
                    raise RenderError("checksum_mismatch", "Bundle file checksum mismatch")

            if version == 1:
                for page in pages:
                    validate_pptx(destination / page["file"], min(settings.max_expanded_bytes, 128 * 1024 * 1024))
            else:
                source = manifest["source"]
                validate_render_source_pptx(
                    destination / source["file"], settings.max_expanded_bytes, source["slide_count"],
                )
            manifest["dpi"] = dpi
            return manifest
    except RenderError:
        raise
    except Exception as exc:
        raise RenderError("invalid_archive", "Malformed upload bundle") from exc
