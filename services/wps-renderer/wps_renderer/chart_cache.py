"""Render cached charts without handing embedded Excel workbooks to WPS."""
import io
import posixpath
from urllib.parse import unquote, urlsplit

from defusedxml.minidom import parseString
from defusedxml import ElementTree as ET

from .errors import RenderError

CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart"
RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"
WORKBOOK_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _xml(archive, name):
    if archive.getinfo(name).file_size > 8 * 1024 * 1024:
        raise RenderError("invalid_pptx", "PPTX XML exceeds size limits")
    data = archive.read(name)
    nodes = depth = 0
    for event, node in ET.iterparse(io.BytesIO(data), events=("start", "end"),
                                  forbid_dtd=True, forbid_entities=True, forbid_external=True):
        if event == "start":
            nodes += 1
            depth += 1
            if nodes > 200_000 or depth > 128:
                raise RenderError("invalid_pptx", "PPTX XML exceeds node or nesting limits")
        else:
            node.clear()
            depth -= 1
    return parseString(data, forbid_dtd=True, forbid_entities=True, forbid_external=True)


def _target(part, relationship):
    if relationship.getAttribute("TargetMode").lower() not in {"", "internal"}:
        return None
    decoded = unquote(relationship.getAttribute("Target"))
    parsed = urlsplit(decoded)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or "\\" in decoded or "\x00" in decoded:
        return None
    return posixpath.normpath(posixpath.join(posixpath.dirname(posixpath.dirname(part)), parsed.path)).lstrip("/")


def _require_caches(chart):
    # Every formula reference needs its own cache. A cache elsewhere in the
    # chart cannot stand in for a missing category/series/value cache.
    refs = {"numRef": "numCache", "strRef": "strCache", "multiLvlStrRef": "multiLvlStrCache"}
    for reference, cache in refs.items():
        for node in chart.getElementsByTagNameNS(CHART, reference):
            if not any(child.namespaceURI == CHART and child.localName == cache for child in node.childNodes):
                raise RenderError("chart_cache_missing", "Chart workbook cannot be removed without a complete display cache")
    for node in chart.getElementsByTagNameNS(CHART, "autoUpdate"):
        if node.getAttribute("val").lower() in {"1", "true", "on"}:
            raise RenderError("chart_cache_missing", "Chart requires a workbook refresh; save it with an up-to-date display cache")


def cached_chart_edits(archive, infos):
    """Return XML edits and workbook removals for job-local render copies.

    Only internal .xlsx attachments owned exclusively by chart externalData
    are eligible. OLE objects, macros, linked workbooks and other embedded
    packages remain subject to the ordinary strict validator.
    """
    names = {item.filename for item in infos}
    edits, removed, owners = {}, set(), set()
    for part in sorted(names):
        if not (part.startswith("ppt/charts/_rels/") and part.endswith(".xml.rels")):
            continue
        chart_name = "ppt/charts/" + posixpath.basename(part)[:-5]
        if chart_name not in names:
            continue
        relationships = _xml(archive, part)
        chart = _xml(archive, chart_name)
        changed = False
        try:
            for rel in list(relationships.getElementsByTagNameNS(RELS, "Relationship")):
                if rel.getAttribute("Type") != OFFICE_RELS + "/package":
                    continue
                target = _target(part, rel)
                if not target or not target.startswith("ppt/embeddings/") or not target.lower().endswith(".xlsx") or target not in names:
                    continue
                rid = rel.getAttribute("Id")
                links = [node for node in chart.getElementsByTagNameNS(CHART, "externalData")
                         if rid and node.getAttributeNS(OFFICE_RELS, "id") == rid]
                if len(links) != 1:
                    continue
                _require_caches(chart)
                links[0].parentNode.removeChild(links[0])
                rel.parentNode.removeChild(rel)
                removed.add(target)
                owners.add((part, rid))
                changed = True
            if changed:
                # minidom retains namespace declarations and prefixes, including
                # those mentioned only by mc:Ignorable on vendor extensions.
                edits[part] = relationships.toxml(encoding="utf-8")
                edits[chart_name] = chart.toxml(encoding="utf-8")
        finally:
            relationships.unlink()
            chart.unlink()
    if not removed:
        return {}, set()

    for part in sorted(name for name in names if name.endswith(".rels")):
        relationships = _xml(archive, part)
        try:
            for rel in relationships.getElementsByTagNameNS(RELS, "Relationship"):
                if _target(part, rel) in removed and (part, rel.getAttribute("Id")) not in owners:
                    raise RenderError("unsafe_pptx", "Chart workbook is also referenced by another Office object")
        finally:
            relationships.unlink()
    types = _xml(archive, "[Content_Types].xml")
    try:
        defaults = {node.getAttribute("Extension").lower(): node.getAttribute("ContentType")
                    for node in types.getElementsByTagNameNS(CONTENT_TYPES, "Default")}
        overrides = {node.getAttribute("PartName").lstrip("/"): node
                     for node in types.getElementsByTagNameNS(CONTENT_TYPES, "Override")}
        for name in removed:
            override = overrides.get(name)
            content_type = override.getAttribute("ContentType") if override is not None else defaults.get("xlsx")
            if content_type != WORKBOOK_TYPE:
                raise RenderError("unsafe_pptx", "Chart attachment is not an ordinary Excel workbook")
            if override is not None:
                override.parentNode.removeChild(override)
        edits["[Content_Types].xml"] = types.toxml(encoding="utf-8")
    finally:
        types.unlink()
    return edits, removed
