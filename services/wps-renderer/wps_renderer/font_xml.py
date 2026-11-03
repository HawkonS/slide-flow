"""Lossless font-name normalization in validated, job-local OOXML packages."""
import codecs
import re
import zipfile
from xml.parsers import expat

from .errors import RenderError
from .font_faces import normalized

DRAWING_NAMESPACES = {
    "http://schemas.openxmlformats.org/drawingml/2006/main",
    "http://purl.oclc.org/ooxml/drawingml/main",
}


def replace_typefaces(data, replacements):
    """Edit attribute value bytes only: preserve text, XML prefixes and layout."""
    encoding = "utf-8"
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        encoding = "utf-16"
    elif data[:2] in {b"<\x00", b"\x00<"}:
        encoding = "utf-16-le" if data[:2] == b"<\x00" else "utf-16-be"
    elif data.startswith(codecs.BOM_UTF8):
        encoding = "utf-8-sig"
    else:
        declaration = re.match(br"\s*<\?xml\b[^>]*\bencoding\s*=\s*['\"]([^'\"]+)['\"]", data)
        if declaration:
            encoding = declaration.group(1).decode("ascii")
    working = data.decode(encoding).encode("utf-8")
    parser = expat.ParserCreate(encoding="utf-8", namespace_separator="}")
    attribute_re = re.compile(br"([^\s=/>]+)\s*=\s*([\"'])(.*?)\2", re.DOTALL)
    edits = []
    lookup = {}
    for name, target in replacements.items():
        key = normalized(name)
        if key in lookup and lookup[key] != target:
            raise RenderError("font_conflict", "Equivalent aliases identify different render faces")
        lookup[key] = target

    def start_element(name, attributes):
        namespace, _, local = name.rpartition("}")
        if namespace not in DRAWING_NAMESPACES or local not in {"latin", "ea", "cs", "sym", "font", "buFont"}:
            return
        old = attributes.get("typeface", "").strip()
        target = lookup.get(normalized(old))
        if target is None:
            return
        if old.startswith("@"):
            target = "@" + target
        if target == old:
            return
        start = parser.CurrentByteIndex
        end, quote = start + 1, None
        while end < len(working):
            char = working[end]
            if quote is not None:
                if char == quote:
                    quote = None
            elif char in (34, 39):
                quote = char
            elif char == 62:
                break
            end += 1
        for match in attribute_re.finditer(working, start, end):
            if match.group(1) == b"typeface":
                escaped = (target.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
                           .replace("'", "&apos;").replace("\r", "&#13;").replace("\n", "&#10;").replace("\t", "&#9;"))
                edits.append((match.start(3), match.end(3), escaped.encode("utf-8")))
                break

    def reject_doctype(*_):
        raise RenderError("invalid_pptx", "PPT XML cannot contain a document type declaration")

    parser.StartElementHandler = start_element
    parser.StartDoctypeDeclHandler = reject_doctype
    parser.Parse(working, True)
    if not edits:
        return data
    for start, end, value in reversed(edits):
        working = working[:start] + value + working[end:]
    if data.startswith(codecs.BOM_UTF16_BE):
        return codecs.BOM_UTF16_BE + working.decode("utf-8").encode("utf-16-be")
    return working.decode("utf-8").encode(encoding)


def normalize_pptx(source, replacements, max_file_bytes, max_expanded_bytes):
    """Atomically replace the extracted render input; upstream source is intact."""
    if not replacements:
        return
    temporary = source.with_suffix(".font-names.tmp")
    try:
        total = 0
        with zipfile.ZipFile(source) as original, zipfile.ZipFile(temporary, "x") as output:
            output.comment = original.comment
            for info in original.infolist():
                data = original.read(info.filename)
                if info.filename.startswith("ppt/") and info.filename.lower().endswith(".xml"):
                    data = replace_typefaces(data, replacements)
                total += len(data)
                if total > max_expanded_bytes:
                    raise RenderError("archive_too_large", "Normalized PPT exceeds expanded size limit", 413)
                output.writestr(info, data)
                if output.fp.tell() > max_file_bytes:
                    raise RenderError("archive_too_large", "Normalized PPT exceeds input size limit", 413)
        if temporary.stat().st_size > max_file_bytes:
            raise RenderError("archive_too_large", "Normalized PPT exceeds input size limit", 413)
        temporary.replace(source)
    finally:
        temporary.unlink(missing_ok=True)
