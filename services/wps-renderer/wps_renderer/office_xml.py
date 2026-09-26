"""Streaming OOXML checks with node/depth budgets and relationship validation."""
import io
import posixpath
from urllib.parse import unquote, urlsplit

from defusedxml import ElementTree as ET

from .errors import RenderError

REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
UNSAFE_PART_TYPES = ("vbaproject", "vbadata", "oleobject", "activex", "macroenabled")


def _relationship(node, part_name):
    relationship_type = node.attrib.get("Type", "").lower()
    if any(kind in relationship_type for kind in UNSAFE_PART_TYPES) or relationship_type.endswith(("/package", "/control")):
        raise RenderError("unsafe_pptx", "Macros, controls and embedded Office/OLE objects are not accepted")
    target = node.attrib.get("Target", "")
    mode = node.attrib.get("TargetMode", "Internal").lower()
    if not target or mode not in {"internal", "external"}:
        raise RenderError("invalid_pptx", "Invalid relationship target or mode")
    if mode == "external":
        if not relationship_type.endswith("/hyperlink"):
            raise RenderError("unsafe_pptx", "Externally linked render assets are not accepted")
        if urlsplit(target).scheme.lower() not in {"https", "http", "mailto"}:
            raise RenderError("unsafe_pptx", "Only web/email external hyperlinks are accepted")
        return
    decoded = unquote(target)
    parsed = urlsplit(decoded)
    if parsed.scheme or parsed.netloc or "\\" in decoded or "\x00" in decoded:
        raise RenderError("unsafe_pptx", "Internal relationship cannot reference a filesystem or network resource")
    # _rels/foo.xml.rels is relative to foo.xml's folder; absolute OPC part
    # references start at package root, not the Windows filesystem root.
    parent = posixpath.dirname(posixpath.dirname(part_name))
    resolved = posixpath.normpath(posixpath.join(parent, parsed.path))
    if resolved == ".." or resolved.startswith("../"):
        raise RenderError("unsafe_pptx", "Relationship escapes the Office package")


def validate_xml(data, part_name, expected_slides=1):
    nodes = depth = slide_ids = 0
    root_seen = False
    for event, node in ET.iterparse(io.BytesIO(data), events=("start", "end"),
                                  forbid_dtd=True, forbid_entities=True, forbid_external=True):
        if event == "start":
            if not root_seen:
                root_seen = True
                if part_name.endswith(".rels") and node.tag != "{" + REL_NS + "}Relationships":
                    raise RenderError("invalid_pptx", "Relationships part has an invalid root namespace")
            nodes += 1
            depth += 1
            if nodes > 200_000 or depth > 128:
                raise RenderError("invalid_pptx", "PPTX XML exceeds node or nesting limits")
            if part_name == "ppt/presentation.xml" and node.tag == "{" + PRESENTATION_NS + "}sldId":
                slide_ids += 1
        else:
            if part_name.endswith(".rels") and node.tag.rsplit("}", 1)[-1] == "Relationship":
                if not node.tag.startswith("{" + REL_NS + "}"):
                    raise RenderError("invalid_pptx", "Relationship has an invalid namespace")
                _relationship(node, part_name)
            content_type = node.attrib.get("ContentType", "").lower()
            if any(kind in content_type for kind in UNSAFE_PART_TYPES):
                raise RenderError("unsafe_pptx", "Unsafe Office content type")
            node.clear()
            depth -= 1
    if part_name == "ppt/presentation.xml" and expected_slides is not None and slide_ids != expected_slides:
        raise RenderError("invalid_pptx", f"The presentation must reference exactly {expected_slides} slide(s)")
