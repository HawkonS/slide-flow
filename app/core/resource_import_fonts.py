"""Fonts used by slide text, and lossless font-name edits in OOXML packages."""
from __future__ import annotations

import codecs
import posixpath
import re
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.parsers import expat


_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
_NS = {"a": _A, "p": _P}
_STRICT_A = "http://purl.oclc.org/ooxml/drawingml/main"
_STRICT_P = "http://purl.oclc.org/ooxml/presentationml/main"
_DRAWING_NAMESPACES = {_A, _STRICT_A}


def _drawing(name: str) -> str:
    return f"{{{_A}}}{name}"


def _script_fonts(text: str, language: str) -> set[tuple[str, str]]:
    """Select only the font slots needed by real characters in a run."""
    scripts: set[tuple[str, str]] = set()
    lang = language.lower()
    han_script = "Jpan" if lang.startswith("ja") else "Hang" if lang.startswith("ko") else "Hant" if lang.startswith(("zh-tw", "zh-hk", "zh-mo", "zh-hant")) else "Hans"
    complex_ranges = (
        (0x0590, 0x05FF, "Hebr"), (0x0600, 0x08FF, "Arab"),
        (0x0900, 0x097F, "Deva"), (0x0980, 0x09FF, "Beng"),
        (0x0A00, 0x0A7F, "Guru"), (0x0A80, 0x0AFF, "Gujr"),
        (0x0B00, 0x0B7F, "Orya"), (0x0B80, 0x0BFF, "Taml"),
        (0x0C00, 0x0C7F, "Telu"), (0x0C80, 0x0CFF, "Knda"),
        (0x0D00, 0x0D7F, "Mlym"), (0x0D80, 0x0DFF, "Sinh"),
        (0x0E00, 0x0E7F, "Thai"), (0x0E80, 0x0EFF, "Laoo"),
        (0x0F00, 0x0FFF, "Tibt"), (0x1000, 0x109F, "Mymr"),
        (0x1780, 0x17FF, "Khmr"), (0xFB50, 0xFDFF, "Arab"),
        (0xFE70, 0xFEFF, "Arab"),
    )
    for char in text:
        code = ord(char)
        if 0x3040 <= code <= 0x30FF or 0x31F0 <= code <= 0x31FF or 0xFF66 <= code <= 0xFF9F:
            scripts.add(("ea", "Jpan"))
        elif 0x1100 <= code <= 0x11FF or 0x3130 <= code <= 0x318F or 0xAC00 <= code <= 0xD7AF:
            scripts.add(("ea", "Hang"))
        elif 0x2E80 <= code <= 0x303F or 0x3400 <= code <= 0x9FFF or 0xF900 <= code <= 0xFAFF or 0x20000 <= code <= 0x323AF:
            scripts.add(("ea", han_script))
        elif 0xE000 <= code <= 0xF8FF or 0xF0000 <= code <= 0x10FFFD:
            scripts.add(("sym", ""))
        else:
            complex_script = next((script for lo, hi, script in complex_ranges if lo <= code <= hi), None)
            if complex_script:
                scripts.add(("cs", complex_script))
            elif unicodedata.category(char)[0] in {"L", "N"}:
                scripts.add(("latin", "Latn"))
    # Punctuation shares the surrounding script. A punctuation-only run still
    # needs its Latin/default font; whitespace-only runs do not add a font.
    if not scripts and text.strip():
        scripts.add(("latin", "Latn"))
    return scripts


def _level_properties(style: ET.Element | None, level: int) -> list[ET.Element]:
    if style is None:
        return []
    result: list[ET.Element] = []
    for name in (f"lvl{level + 1}pPr", "defPPr"):
        props = style.find(f"a:{name}/a:defRPr", _NS)
        if props is not None:
            result.append(props)
    return result


def _placeholder(shape: ET.Element | None) -> ET.Element | None:
    return shape.find("p:nvSpPr/p:nvPr/p:ph", _NS) if shape is not None else None


def _matching_placeholder(root: ET.Element | None, reference: ET.Element | None, *, by_type: bool = False) -> ET.Element | None:
    if root is None or reference is None:
        return None
    index, kind = reference.get("idx", "0"), reference.get("type", "obj")
    candidates = [(shape, _placeholder(shape)) for shape in root.iter(f"{{{_P}}}sp")]
    # Slides identify layout placeholders by idx. Layouts identify master
    # placeholders by type, as their indices can be entirely different.
    for shape, ph in candidates:
        if ph is not None and (ph.get("type", "obj") == kind if by_type else ph.get("idx", "0") == index):
            return shape
    if by_type and kind in {"obj", "subTitle"}:
        return next((shape for shape, ph in candidates if ph is not None and ph.get("type") == "body"), None)
    return None


def _shape_defaults(shape: ET.Element | None, level: int) -> list[ET.Element]:
    if shape is None:
        return []
    body = shape.find("p:txBody", _NS)
    if body is None:
        return []
    props = []
    for paragraph in body.findall("a:p", _NS):
        paragraph_props = paragraph.find("a:pPr", _NS)
        if paragraph_props is not None and paragraph_props.get("lvl", "0") == str(level):
            default = paragraph_props.find("a:defRPr", _NS)
            if default is not None:
                props.append(default)
                break
    return props + _level_properties(body.find("a:lstStyle", _NS), level)


def detect_used_ppt_fonts(pptx_path: Path) -> list[str]:
    """Resolve fonts for slide text through paragraph, placeholder and theme styles.

    Theme font collections are fallbacks, not evidence that a font is used.
    In particular, a Chinese-only run must not pull in every language family
    listed in the presentation's theme.
    """
    if pptx_path.suffix.lower() != ".pptx":
        return []
    fonts: set[str] = set()
    with zipfile.ZipFile(pptx_path) as package:
        parsed: dict[str, ET.Element | None] = {}

        def xml(path: str | None) -> ET.Element | None:
            if not path:
                return None
            if path not in parsed:
                try:
                    parsed[path] = ET.fromstring(package.read(path))
                    # Strict OOXML uses different namespace URIs with the same
                    # structure. Canonicalize the in-memory tree only.
                    for element in parsed[path].iter():
                        if element.tag.startswith(f"{{{_STRICT_A}}}"):
                            element.tag = element.tag.replace(_STRICT_A, _A, 1)
                        elif element.tag.startswith(f"{{{_STRICT_P}}}"):
                            element.tag = element.tag.replace(_STRICT_P, _P, 1)
                except (KeyError, ET.ParseError):
                    parsed[path] = None
            return parsed[path]

        def related(path: str | None, kind: str) -> str | None:
            if not path:
                return None
            rels = xml(posixpath.join(posixpath.dirname(path), "_rels", posixpath.basename(path) + ".rels"))
            if rels is None:
                return None
            for rel in rels:
                if rel.get("TargetMode") == "External" or not rel.get("Type", "").endswith("/" + kind):
                    continue
                target = rel.get("Target", "")
                if target:
                    return target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
            return None

        presentation = xml("ppt/presentation.xml")
        default_style = presentation.find("p:defaultTextStyle", _NS) if presentation is not None else None
        for slide_path in package.namelist():
            if not re.fullmatch(r"ppt/slides/slide\d+\.xml", slide_path):
                continue
            slide = xml(slide_path)
            if slide is None:
                continue
            layout_path = related(slide_path, "slideLayout")
            master_path = related(layout_path, "slideMaster")
            layout, master = xml(layout_path), xml(master_path)
            theme_roots = [xml(related(path, "themeOverride")) for path in (slide_path, layout_path, master_path)]
            theme_roots += [xml(related(path, "theme")) for path in (slide_path, layout_path, master_path, "ppt/presentation.xml")]

            def theme_font(kind: str, slot: str, script: str) -> str | None:
                for theme in theme_roots:
                    if theme is None:
                        continue
                    collection = theme.find(f".//a:fontScheme/a:{kind}Font", _NS)
                    if collection is None:
                        continue
                    node = collection.find(f"a:{slot}", _NS)
                    if node is not None and node.get("typeface", "").strip():
                        return node.get("typeface", "").strip()
                    if slot in {"ea", "cs"}:
                        for supplemental in collection.findall("a:font", _NS):
                            if supplemental.get("script") == script and supplemental.get("typeface", "").strip():
                                return supplemental.get("typeface", "").strip()
                    # Missing script-specific defaults inherit the theme's Latin
                    # family (rather than unrelated supplemental language fonts).
                    node = collection.find("a:latin", _NS)
                    if node is not None and node.get("typeface", "").strip():
                        return node.get("typeface", "").strip()
                return None

            def inspect(root: ET.Element, inherited_only: bool = False) -> None:
                parents = {child: parent for parent in root.iter() for child in parent}
                for run in root.iter():
                    if run.tag not in {_drawing("r"), _drawing("fld")}:
                        continue
                    text = run.findtext("a:t", "", _NS)
                    if not text.strip():
                        continue
                    paragraph = parents.get(run)
                    if paragraph is None or paragraph.tag != _drawing("p"):
                        continue
                    body = parents.get(paragraph)
                    shape = body
                    while shape is not None and shape.tag != f"{{{_P}}}sp":
                        shape = parents.get(shape)
                    ph = _placeholder(shape)
                    # Placeholder sample text on layouts/masters is an editing
                    # prompt. Its formatting is resolved through real slide text.
                    if inherited_only and ph is not None:
                        continue
                    ppr = paragraph.find("a:pPr", _NS)
                    level = max(0, min(8, int(ppr.get("lvl", "0")))) if ppr is not None else 0
                    properties = [run.find("a:rPr", _NS), ppr.find("a:defRPr", _NS) if ppr is not None else None]
                    if body is not None:
                        properties += _level_properties(body.find("a:lstStyle", _NS), level)
                    layout_shape = _matching_placeholder(layout, ph) if root is slide else None
                    layout_ph = _placeholder(layout_shape)
                    master_shape = _matching_placeholder(master, layout_ph if layout_ph is not None else ph, by_type=True)
                    properties += _shape_defaults(layout_shape, level) + _shape_defaults(master_shape, level)
                    kind = (layout_ph if layout_ph is not None else ph)
                    placeholder_kind = kind.get("type", "obj") if kind is not None else ""
                    style_kind = "titleStyle" if placeholder_kind in {"title", "ctrTitle"} else "bodyStyle" if placeholder_kind in {"body", "obj", "subTitle"} else "otherStyle"
                    properties += _level_properties(master.find(f"p:txStyles/p:{style_kind}", _NS) if master is not None else None, level)
                    properties += _level_properties(default_style, level)
                    props = [prop for prop in properties if prop is not None]
                    languages = [prop.get(attr, "") for prop in props for attr in ("lang", "altLang") if prop.get(attr)]
                    east_asian_lang = next((lang for lang in languages if lang.lower().startswith(("zh", "ja", "ko"))), languages[0] if languages else "")
                    theme_kind = "major" if style_kind == "titleStyle" else "minor"
                    for candidate in (shape, layout_shape, master_shape):
                        ref = candidate.find("p:style/a:fontRef", _NS) if candidate is not None else None
                        if ref is not None and ref.get("idx") in {"major", "minor"}:
                            theme_kind = ref.get("idx", theme_kind)
                            break
                    for slot, script in _script_fonts(text, east_asian_lang):
                        face = None
                        for prop in props:
                            font = prop.find(f"a:{slot}", _NS)
                            if font is not None and font.get("typeface", "").strip():
                                face = font.get("typeface", "").strip()
                                break
                        if not face and slot == "sym":
                            # Legacy symbol fonts can put private-use characters
                            # in the Latin slot instead of an explicit sym slot.
                            for prop in props:
                                font = prop.find("a:latin", _NS)
                                if font is not None and font.get("typeface", "").strip():
                                    face = font.get("typeface", "").strip()
                                    break
                        if face and face.startswith("+"):
                            token = re.fullmatch(r"\+(mj|mn)-(lt|ea|cs)", face)
                            face = theme_font("major" if token.group(1) == "mj" else "minor", {"lt": "latin", "ea": "ea", "cs": "cs"}[token.group(2)], script) if token else None
                        elif not face:
                            face = theme_font(theme_kind, "latin" if slot == "sym" else slot, script)
                        if face:
                            fonts.add(face)

            inspect(slide)
            if layout is not None:
                inspect(layout, inherited_only=True)
            if master is not None and slide.get("showMasterSp", "1").lower() not in {"0", "false", "off"} and (layout is None or layout.get("showMasterSp", "1").lower() not in {"0", "false", "off"}):
                inspect(master, inherited_only=True)
    return sorted(fonts, key=str.lower)


def _replace_xml_typefaces(data: bytes, replacements: dict[str, str]) -> bytes:
    """Locate attributes with an XML parser, replacing only their value bytes."""
    had_utf16_bom = data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE))
    if had_utf16_bom:
        encoding = "utf-16"
    elif data[:2] == b"<\x00":
        encoding = "utf-16-le"
    elif data[:2] == b"\x00<":
        encoding = "utf-16-be"
    elif data.startswith(codecs.BOM_UTF8):
        encoding = "utf-8-sig"
    else:
        declaration = re.match(br"\s*<\?xml\b[^>]*\bencoding\s*=\s*['\"]([^'\"]+)['\"]", data)
        encoding = declaration.group(1).decode("ascii") if declaration else "utf-8"
        # XML permits UTF-16 parts without a BOM. Python's generic utf-16
        # codec requires one, so infer endianness from the first ASCII tag.
        if encoding.lower().replace("-", "") in {"utf16", "utf16le", "utf16be"}:
            encoding = "utf-16-le" if data[:2] == b"<\x00" else "utf-16-be" if data[:2] == b"\x00<" else "utf-16"
    working = data.decode(encoding).encode("utf-8")
    parser = expat.ParserCreate(encoding="utf-8", namespace_separator="}")
    edits: list[tuple[int, int, bytes]] = []
    attribute_re = re.compile(br"([^\s=/>]+)\s*=\s*([\"'])(.*?)\2", re.DOTALL)

    def start_element(name: str, attributes: dict[str, str]) -> None:
        namespace, _, local_name = name.rpartition("}")
        if namespace not in _DRAWING_NAMESPACES or local_name not in {"latin", "ea", "cs", "sym", "font", "buFont"}:
            return
        old_name = attributes.get("typeface", "").strip()
        if old_name not in replacements:
            return
        start = parser.CurrentByteIndex
        quote = None
        end = start + 1
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
            if match.group(1) != b"typeface":
                continue
            new_name = replacements[old_name]
            escaped = new_name.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;").replace("'", "&apos;").replace("\r", "&#13;").replace("\n", "&#10;").replace("\t", "&#9;")
            edits.append((match.start(3), match.end(3), escaped.encode("utf-8")))
            break

    def reject_doctype(*_args: object) -> None:
        raise ValueError("PPT XML cannot contain a document type declaration")

    parser.StartElementHandler = start_element
    parser.StartDoctypeDeclHandler = reject_doctype
    parser.Parse(working, True)
    if not edits:
        return data
    for start, end, value in reversed(edits):
        working = working[:start] + value + working[end:]
    result = working.decode("utf-8").encode(encoding)
    # Preserve byte order for big-endian UTF-16 parts as well.
    if data.startswith(codecs.BOM_UTF16_BE):
        result = codecs.BOM_UTF16_BE + working.decode("utf-8").encode("utf-16-be")
    return result


def replace_ppt_fonts(source: Path, replacements: dict[str, str], target: Path) -> None:
    """Apply mappings simultaneously without changing slide text or XML prefixes."""
    normalized = {str(old).strip(): str(new).strip() for old, new in replacements.items() if str(old).strip() and str(new).strip()}
    with zipfile.ZipFile(source, "r") as original, zipfile.ZipFile(target, "w") as output:
        output.comment = original.comment
        for info in original.infolist():
            data = original.read(info.filename)
            if normalized and info.filename.startswith("ppt/") and info.filename.lower().endswith(".xml"):
                data = _replace_xml_typefaces(data, normalized)
            output.writestr(info, data)
