"""Change only font attribute values, preserving all other OOXML bytes."""

import codecs
import re
import posixpath
import xml.etree.ElementTree as ET
from xml.parsers import expat

from app.core.fonts import FontResolutionError, normalize_font_name


FONT_NAMESPACES = {
    "http://schemas.openxmlformats.org/drawingml/2006/main",
    "http://purl.oclc.org/ooxml/drawingml/main",
    "http://schemas.openxmlformats.org/presentationml/2006/main",
    "http://purl.oclc.org/ooxml/presentationml/main",
}


def replace_typefaces(data: bytes, replacements: dict[str, str]) -> bytes:
    if not replacements:
        return data
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
        key = normalize_font_name(name)
        if key in lookup and lookup[key] != target:
            raise FontResolutionError(f"字体别名「{name}」对应多个不同家族")
        lookup[key] = target

    def start_element(name, attributes):
        namespace, _, local = name.rpartition("}")
        if namespace not in FONT_NAMESPACES or local not in {"latin", "ea", "cs", "sym", "font", "buFont"}:
            return
        old = attributes.get("typeface", "").strip()
        if old.lstrip("@").startswith("+"):
            return
        target = lookup.get(normalize_font_name(old))
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
        raise FontResolutionError("PPT XML 不能包含文档类型声明")

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


def replace_package_typefaces(parts: dict[str, bytes], replacements: dict[str, str]) -> None:
    for name, data in parts.items():
        if name.startswith("ppt/") and name.lower().endswith(".xml"):
            parts[name] = replace_typefaces(data, replacements)


def strip_embedded_fonts(parts: dict[str, bytes]) -> bool:
    """Remove source embeddings from a download explicitly requested without them."""
    presentation_path = "ppt/presentation.xml"
    rels_path = "ppt/_rels/presentation.xml.rels"
    if presentation_path not in parts or rels_path not in parts:
        return False
    presentation = ET.fromstring(parts[presentation_path])
    relationships = ET.fromstring(parts[rels_path])
    removed = set()
    for rel in list(relationships):
        if rel.get("Type", "").endswith("/font"):
            if rel.get("TargetMode") != "External":
                target = rel.get("Target", "")
                removed.add(posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join("ppt", target)))
            relationships.remove(rel)
    existing = [child for child in presentation if child.tag.rsplit("}", 1)[-1] == "embeddedFontLst"]
    if not removed and not existing:
        return False
    for child in existing:
        presentation.remove(child)
    presentation.attrib.pop("embedTrueTypeFonts", None)
    presentation.attrib.pop("saveSubsetFonts", None)
    for target in removed:
        parts.pop(target, None)
    parts[presentation_path] = ET.tostring(presentation, encoding="utf-8", xml_declaration=True)
    parts[rels_path] = ET.tostring(relationships, encoding="utf-8", xml_declaration=True)
    if "[Content_Types].xml" in parts:
        content_types = ET.fromstring(parts["[Content_Types].xml"])
        for child in list(content_types):
            if child.get("PartName", "").lstrip("/") in removed:
                content_types.remove(child)
        parts["[Content_Types].xml"] = ET.tostring(content_types, encoding="utf-8", xml_declaration=True)
    return True
