"""OOXML serialization with preserved namespace declarations."""

from __future__ import annotations

import re
from xml.etree import ElementTree as ET

from .package import A_NS, PKG_CT_NS, PKG_REL_NS, P_NS, R_NS


# Regex to normalise .rels files that use "ns0:" prefix for the OPC relationships
# namespace instead of the correct default namespace (no prefix).
# Some tools (including older versions of this codebase) generate such files;
# Office 365 rejects them while WPS tolerates them.
_NS0_RELS_TAG_RE = re.compile(
    rb'<ns0:(Relationships|Relationship)([^>]*)>',
    re.DOTALL,
)


_NS0_RELS_CLOSE_RE = re.compile(rb'</ns0:Relationships>')


_NS0_XMLNS_RE = re.compile(
    rb'\s+xmlns:ns0=["\'][^"\']*["\']'
)


# XML declaration regex, used for replacing/normalizing XML declarations
_XML_DECL_RE = re.compile(rb"^<\?xml[^?]*\?>\s*", re.MULTILINE)


def _normalize_rels_bytes(data: bytes) -> bytes:
    """Fix .rels XML files that use 'ns0:' prefix instead of the default OPC namespace.

    This repairs files produced by some tools (including older versions of
    split_pptx_to_single_pages) that serialise the OPC Relationships namespace
    with an explicit ``ns0:`` prefix instead of the correct default namespace.
    Office 365 strictly rejects such files; WPS tolerates them.
    """
    if b'ns0:Relationships' not in data and b'ns0:Relationship ' not in data:
        return data
    # Remove xmlns:ns0="..." declaration
    data = _NS0_XMLNS_RE.sub(b'', data)
    # Replace <ns0:Relationships ...> with <Relationships xmlns="..." ...>
    ns_uri = b'http://schemas.openxmlformats.org/package/2006/relationships'
    def replace_open(m: re.Match) -> bytes:
        tag_name = m.group(1)  # b'Relationships' or b'Relationship'
        attrs = m.group(2)     # remaining attributes
        if tag_name == b'Relationships':
            return b'<Relationships xmlns="' + ns_uri + b'"' + attrs + b'>'
        return b'<Relationship' + attrs + b'>'
    data = _NS0_RELS_TAG_RE.sub(replace_open, data)
    data = _NS0_RELS_CLOSE_RE.sub(b'</Relationships>', data)
    # Add/fix standalone="yes" in the XML declaration
    data = _fix_xml_declaration(data)
    return data


def _extract_ns_declarations(xml_bytes: bytes) -> dict[str, str]:
    """Extract all xmlns:prefix="uri" and xmlns="uri" declarations from XML bytes.

    Returns a dict mapping prefix (empty string for default ns) -> URI.
    This is used to preserve namespace declarations that ElementTree may discard
    when serialising elements that only reference those namespaces in attribute
    values (e.g. mc:Ignorable="p14 p15").
    """
    result: dict[str, str] = {}
    # Match xmlns:prefix="uri" and xmlns="uri"
    for m in re.finditer(rb'xmlns(?::([\w.-]+))?=["\']([^"\']*)["\']', xml_bytes):
        prefix = m.group(1).decode("utf-8") if m.group(1) else ""
        uri = m.group(2).decode("utf-8")
        result[prefix] = uri
    return result


def _fix_xml_declaration(xml_bytes: bytes) -> bytes:
    """Replace/add XML declaration with canonical standalone="yes" form.

    Office requires ``standalone="yes"`` on OOXML part declarations.
    Python's ElementTree never emits the standalone attribute, so we patch it.
    """
    decl = b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    stripped = _XML_DECL_RE.sub(b"", xml_bytes, count=1)
    return decl + stripped


def _restore_ns_declarations(xml_bytes: bytes, original_ns: dict[str, str]) -> bytes:
    """Re-inject namespace declarations that ElementTree may have discarded.

    ElementTree only emits xmlns: declarations for namespaces actually used in
    element/attribute names. Namespaces referenced only in attribute *values*
    (e.g. mc:Ignorable="p14 p15") will be silently dropped, creating dangling
    prefix references that Office's MC processor rejects.

    This function finds the root element's opening tag and adds back any missing
    xmlns: declaration from `original_ns`.
    """
    if not original_ns:
        return xml_bytes

    # Find the end of the XML declaration (if any) and start of the root element
    root_start = _XML_DECL_RE.sub(b"", xml_bytes, count=1)
    # Find the root element's opening tag to determine where to insert
    tag_start = xml_bytes.find(b"<", xml_bytes.find(b"?>") + 2 if b"?>" in xml_bytes else 0)
    if tag_start == -1:
        return xml_bytes
    tag_end = xml_bytes.find(b">", tag_start)
    if tag_end == -1:
        return xml_bytes
    tag_slice = xml_bytes[tag_start:tag_end + 1]

    missing_decls: list[bytes] = []
    for prefix, uri in original_ns.items():
        ns_key = (f"xmlns:{prefix}" if prefix else "xmlns").encode("utf-8")
        if ns_key not in tag_slice:
            decl_bytes = (
                f' xmlns:{prefix}="{uri}"' if prefix else f' xmlns="{uri}"'
            ).encode("utf-8")
            missing_decls.append(decl_bytes)

    if not missing_decls:
        return xml_bytes

    # Insert missing declarations before the first whitespace/> after the tag name
    insert_at = tag_start
    # Skip to end of tag name
    m = re.search(rb"<[\w:]+", xml_bytes[tag_start:tag_end])
    if m:
        insert_at = tag_start + m.end()
    else:
        return xml_bytes

    return xml_bytes[:insert_at] + b"".join(missing_decls) + xml_bytes[insert_at:]


def _serialize_xml_with_ns_preservation(
    root: ET.Element,
    original_bytes: bytes | None = None,
    extra_ns: dict[str, str] | None = None,
) -> bytes:
    """Serialize an ElementTree element, preserving namespace declarations.

    1. Registers all namespaces found in `original_bytes` (and `extra_ns`) so
       ElementTree uses the original prefixes instead of auto-assigning ns0/ns1.
    2. Adds back the ``standalone="yes"`` XML declaration.
    3. Re-injects any xmlns: declarations that ElementTree silently dropped
       (those only referenced in attribute values, e.g. mc:Ignorable).
    """
    original_ns = _extract_ns_declarations(original_bytes) if original_bytes else {}
    if extra_ns:
        original_ns.update(extra_ns)

    # Register all original namespace prefixes so ET uses them
    for prefix, uri in original_ns.items():
        if prefix:  # skip default namespace (empty prefix) – ET handles it via ""
            try:
                ET.register_namespace(prefix, uri)
            except Exception:
                pass
        else:
            try:
                ET.register_namespace("", uri)
            except Exception:
                pass

    raw = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    raw = _fix_xml_declaration(raw)
    raw = _restore_ns_declarations(raw, original_ns)
    return raw


def _serialize_pres_xml(root: ET.Element, original_bytes: bytes | None = None) -> bytes:
    ET.register_namespace("a", A_NS)
    ET.register_namespace("p", P_NS)
    ET.register_namespace("r", R_NS)
    return _serialize_xml_with_ns_preservation(root, original_bytes)


def _serialize_rels_xml(root: ET.Element) -> bytes:
    ET.register_namespace("", PKG_REL_NS)
    raw = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    return _fix_xml_declaration(raw)


def _serialize_ct_xml(root: ET.Element) -> bytes:
    ET.register_namespace("", PKG_CT_NS)
    raw = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    return _fix_xml_declaration(raw)
