"""Content types, relationship integrity and metadata repair."""

from __future__ import annotations

import posixpath
import re
from xml.etree import ElementTree as ET

from .package import PKG_CT_NS, P_NS, _local_name, _rels_path_for, _resolve_target


def _ensure_default_content_type(
    content_types_root: ET.Element, ext: str, src_files: dict[str, bytes], src_part: str
) -> None:
    """Ensure a Default entry for `ext` exists in [Content_Types].xml."""
    for child in content_types_root:
        if _local_name(child.tag) == "Default" and child.attrib.get("Extension", "").lower() == ext:
            return
    # Derive content type from source's [Content_Types].xml
    src_ct_data = src_files.get("[Content_Types].xml", b"<Types/>")
    try:
        src_ct_root = ET.fromstring(src_ct_data)
    except ET.ParseError:
        return
    for child in src_ct_root:
        if _local_name(child.tag) == "Default" and child.attrib.get("Extension", "").lower() == ext:
            ET.SubElement(
                content_types_root,
                f"{{{PKG_CT_NS}}}Default",
                {"Extension": ext, "ContentType": child.attrib.get("ContentType", "")},
            )
            return


def _add_override_content_type(
    content_types_root: ET.Element, new_part: str, src_files: dict[str, bytes], src_part: str
) -> None:
    """Add an Override entry for `new_part` using the content type of `src_part`."""
    pn = "/" + new_part
    for child in content_types_root:
        if _local_name(child.tag) == "Override" and child.attrib.get("PartName", "") == pn:
            return
    # Look up source part's content type
    src_ct_data = src_files.get("[Content_Types].xml", b"<Types/>")
    try:
        src_ct_root = ET.fromstring(src_ct_data)
    except ET.ParseError:
        return
    src_pn = "/" + src_part
    for child in src_ct_root:
        if _local_name(child.tag) == "Override" and child.attrib.get("PartName", "") == src_pn:
            ET.SubElement(
                content_types_root,
                f"{{{PKG_CT_NS}}}Override",
                {"PartName": pn, "ContentType": child.attrib.get("ContentType", "")},
            )
            return


# Content-type map: used by _ensure_content_types_complete to assign MIME types
_PART_CT_MAP: list[tuple[re.Pattern, str]] = [
    (re.compile(r'^ppt/slides/slide[^/]+\.xml$'), 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'),
    (re.compile(r'^ppt/slideLayouts/[^/]+\.xml$'), 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'),
    (re.compile(r'^ppt/slideMasters/[^/]+\.xml$'), 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'),
    (re.compile(r'^ppt/theme/[^/]+\.xml$'), 'application/vnd.openxmlformats-officedocument.theme+xml'),
    (re.compile(r'^ppt/notesMasters/[^/]+\.xml$'), 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml'),
    (re.compile(r'^ppt/notesSlides/[^/]+\.xml$'), 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml'),
    (re.compile(r'^ppt/tags/[^/]+\.xml$'), 'application/vnd.openxmlformats-officedocument.presentationml.tags+xml'),
    (re.compile(r'^ppt/charts/[^/]+\.xml$'), 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'),
    (re.compile(r'^ppt/diagrams/[^/]+\.xml$'), 'application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml'),
    (re.compile(r'^ppt/presentation\.xml$'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'),
    (re.compile(r'^ppt/presProps\.xml$'), 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml'),
    (re.compile(r'^ppt/viewProps\.xml$'), 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml'),
    (re.compile(r'^ppt/tableStyles\.xml$'), 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml'),
    (re.compile(r'^docProps/core\.xml$'), 'application/vnd.openxmlformats-package.core-properties+xml'),
    (re.compile(r'^docProps/app\.xml$'), 'application/vnd.openxmlformats-officedocument.extended-properties+xml'),
    (re.compile(r'^docProps/custom\.xml$'), 'application/vnd.openxmlformats-officedocument.custom-properties+xml'),
]


def _remove_dangling_rels(
    merged_files: dict[str, bytes],
    pres_rels_root: ET.Element,
    presentation_root: ET.Element,
) -> None:
    """Remove relationship entries that point to parts not present in merged_files.

    Single-page PPTXs created by split_pptx_to_single_pages() may carry .rels
    entries for embedded fonts, commentAuthors, global tags and other parts that
    were never extracted. Office 365 (unlike WPS) treats unresolvable references
    as a fatal package error. This function prunes every such dangling rel from
    pres_rels_root *and* removes the corresponding XML-level references inside
    presentation.xml (e.g. <p:embeddedFontLst> entries).
    """
    import posixpath

    # rels that the *merged* package is known to be missing
    to_remove: list[ET.Element] = []
    missing_ids: set[str] = set()

    for rel in list(pres_rels_root):
        target = rel.attrib.get("Target", "")
        rel_id = rel.attrib.get("Id", "")
        if not target or rel.attrib.get("TargetMode", "Internal") == "External":
            continue
        resolved = posixpath.normpath(posixpath.join("ppt", target))
        if resolved not in merged_files:
            to_remove.append(rel)
            missing_ids.add(rel_id)

    for rel in to_remove:
        pres_rels_root.remove(rel)

    # Detect whether any font relationships were removed
    font_rel_type = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"
    removed_font_rels = any(
        rel.attrib.get("Type") == font_rel_type for rel in to_remove
    )

    if not missing_ids:
        return

    # Also purge matching references inside presentation.xml -
    # most importantly <p:embeddedFontLst> which references font rId values.
    # We also remove <p:custDataLst> (custom data), <p:commentAuthors> refs, etc.
    EMBEDDED_FONT_TAG = f"{{{P_NS}}}embeddedFontLst"
    CUST_DATA_TAG = f"{{{P_NS}}}custDataLst"
    COMMENT_AUTHORS_TAG = f"{{{P_NS}}}cmAuthorLst"

    for container_tag in (EMBEDDED_FONT_TAG, CUST_DATA_TAG, COMMENT_AUTHORS_TAG):
        container = presentation_root.find(f".//{container_tag}")
        if container is None:
            # Try direct child
            container = presentation_root.find(container_tag)
        if container is None:
            continue
        # Check if *all* rId refs in this container are missing
        rids_in_container = set(re.findall(
            r'r:id\s*=\s*["\']([^"\']+)["\']',
            ET.tostring(container, encoding="unicode"),
        ))
        if rids_in_container and rids_in_container.issubset(missing_ids):
            # Remove the whole container from its parent
            parent = _find_parent(presentation_root, container)
            if parent is not None:
                parent.remove(container)

    # If embedded font files were removed, also clear the embedTrueTypeFonts
    # and saveSubsetFonts attributes on the root <p:presentation> element.
    # Leaving them set to "1" with no font parts causes Office 365 to flag
    # the package as corrupt.
    if removed_font_rels:
        for attr in ("embedTrueTypeFonts", "saveSubsetFonts"):
            if attr in presentation_root.attrib:
                del presentation_root.attrib[attr]


def _find_parent(root: ET.Element, target: ET.Element) -> ET.Element | None:
    """Return the direct parent of *target* within the tree rooted at *root*."""
    for parent in root.iter():
        if target in list(parent):
            return parent
    return None


def _remove_orphan_parts(
    merged_files: dict[str, bytes],
    pres_rels_root: ET.Element,
) -> None:
    """Remove ALL unreachable parts from the merged package.

    Performs a BFS from the root relationships (pres_rels_root), following
    every internal relationship recursively to collect the set of reachable
    parts. Then deletes every file in merged_files that is NOT reachable,
    except for a small set of always-kept structural files.

    This catches orphan slideMasters, slideLayouts, themes, notesMasters,
    media files, tags, and any other part that was copied into the package
    during merging but ended up unreferenced.
    """
    import posixpath

    # Files that are always kept regardless of reachability
    _ALWAYS_KEEP = {
        "[Content_Types].xml",
        "_rels/.rels",
        "docProps/app.xml",
        "docProps/core.xml",
        "docProps/custom.xml",
        "ppt/presentation.xml",
        "ppt/_rels/presentation.xml.rels",
    }

    # BFS: collect all parts reachable from the presentation rels
    reachable: set[str] = set()
    queue: list[str] = []

    def _enqueue(part: str) -> None:
        if part in merged_files and part not in reachable:
            reachable.add(part)
            queue.append(part)

    # Seed with all targets in pres_rels_root
    for rel in pres_rels_root:
        target = rel.attrib.get("Target", "")
        if not target or rel.attrib.get("TargetMode", "Internal") == "External":
            continue
        _enqueue(posixpath.normpath(posixpath.join("ppt", target)))

    while queue:
        part = queue.pop()
        rels_path = _rels_path_for(part)
        rels_data = merged_files.get(rels_path)
        if not rels_data:
            continue
        reachable.add(rels_path)
        try:
            rels_root = ET.fromstring(rels_data)
        except ET.ParseError:
            continue
        for rel in rels_root:
            if rel.attrib.get("TargetMode", "Internal") == "External":
                continue
            dep = _resolve_target(part, rel.attrib.get("Target", ""))
            _enqueue(dep)

    # Delete every part that is not reachable and not in the always-keep set
    to_delete = [
        name for name in list(merged_files)
        if name not in reachable and name not in _ALWAYS_KEEP
    ]
    for name in to_delete:
        del merged_files[name]


def _ensure_content_types_complete(
    merged_files: dict[str, bytes],
    content_types_root: ET.Element,
) -> None:
    """Synchronize [Content_Types].xml with the actual parts in merged_files.

    1. Remove Override entries whose PartName points to a part that no longer
       exists in the package. Such dangling references are produced when
       _remove_orphan_parts deletes deduplicated masters/themes/layouts but
       leaves the original Content_Types entries behind. Office 365 strictly
       validates OPC and refuses to open a package that advertises parts it
       cannot find ("needs repair"); WPS silently tolerates it.
    2. Add Override entries for every XML part that is present but missing
       from Content_Types. python-pptx and manual merges sometimes omit them
       and Office 365 falls back to the Default extension map which only
       covers generic types and will flag unknown XML parts as corrupt.
    """
    CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
    OVERRIDE_TAG = f"{{{CT_NS}}}Override"

    # ── Pass 1: prune dangling Override entries ─────────────────────────────
    for child in list(content_types_root):
        if child.tag != OVERRIDE_TAG:
            continue
        pn = child.attrib.get("PartName", "").lstrip("/")
        if pn and pn not in merged_files:
            content_types_root.remove(child)

    # ── Pass 2: collect remaining declared parts and add missing entries ────
    existing_parts: set[str] = set()
    for child in content_types_root:
        pn = child.attrib.get("PartName", "")
        if pn:
            existing_parts.add(pn.lstrip("/"))

    for name in merged_files:
        if name.endswith(".rels") or name == "[Content_Types].xml":
            continue
        if name in existing_parts:
            continue
        # Determine content type
        content_type: str | None = None
        for pattern, ct in _PART_CT_MAP:
            if pattern.match(name):
                content_type = ct
                break
        if content_type is None:
            continue  # Not an XML part we know about; skip
        override = ET.SubElement(content_types_root, OVERRIDE_TAG)
        override.attrib["PartName"] = f"/{name}"
        override.attrib["ContentType"] = content_type


def _strip_invalid_default_content_types(content_types_root: ET.Element) -> None:
    """Drop <Default> entries with malformed MIME types from [Content_Types].xml.

    Some upstream PPTX templates carry malformed Default entries such as
    <Default Extension="JPG" ContentType="image/.jpg"/> (subtype starts with
    a dot, violating RFC 2616 type/subtype syntax). Office 365 strict
    validation rejects the whole package over a single bad Default; older
    PowerPoint and WPS silently ignore it.
    """
    def _is_valid_mime(mime: str) -> bool:
        if not mime or "/" not in mime:
            return False
        main, _, sub = mime.partition("/")
        if not main or not sub:
            return False
        if sub.startswith(".") or main.startswith("."):
            return False
        ok_chars = lambda s: all(c.isalnum() or c in "+-._" for c in s)
        return ok_chars(main) and ok_chars(sub)

    for child in list(content_types_root):
        if _local_name(child.tag) != "Default":
            continue
        ct = child.attrib.get("ContentType", "")
        if not _is_valid_mime(ct):
            content_types_root.remove(child)


def _normalize_app_xml_metadata(merged_files: dict[str, bytes]) -> None:
    """Rewrite docProps/app.xml so Slides/Notes counts and vector sizes match reality.

    Some upstream PPTX (notably WPS exports and certain template generators)
    carry stale metadata declaring far more slides than actually exist (e.g.
    <Slides>147</Slides> with a 4-slide deck plus <vt:vector size="167">
    entries pointing at nothing). Office 365 strict validation flags this
    size mismatch as a corrupt package.

    We replace docProps/app.xml with a minimal-but-valid version that uses
    accurate counts. HeadingPairs/TitlesOfParts (which carry slide titles)
    are dropped — they are non-essential metadata and PowerPoint regenerates
    them on save.
    """
    if "ppt/presentation.xml" not in merged_files:
        return
    try:
        pres = ET.fromstring(merged_files["ppt/presentation.xml"])
    except ET.ParseError:
        return

    slide_count = 0
    for c in pres:
        if _local_name(c.tag) == "sldIdLst":
            slide_count = len(list(c))
            break
    notes_count = sum(
        1 for n in merged_files
        if n.startswith("ppt/notesSlides/") and n.endswith(".xml")
    )

    # Preserve original Application/AppVersion if present, else use defaults.
    app_name = b"SlideFlow"
    app_version = b"16.0000"
    orig = merged_files.get("docProps/app.xml")
    if orig:
        try:
            orig_root = ET.fromstring(orig)
            for child in orig_root:
                ln = _local_name(child.tag)
                if ln == "Application" and child.text:
                    app_name = child.text.encode("utf-8")
                elif ln == "AppVersion" and child.text:
                    app_version = child.text.encode("utf-8")
        except ET.ParseError:
            pass

    new_app = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        b'<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        b'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        b'<TotalTime>0</TotalTime>'
        b'<Application>' + app_name + b'</Application>'
        b'<Slides>' + str(slide_count).encode("ascii") + b'</Slides>'
        b'<Notes>' + str(notes_count).encode("ascii") + b'</Notes>'
        b'<HiddenSlides>0</HiddenSlides>'
        b'<MMClips>0</MMClips>'
        b'<ScaleCrop>false</ScaleCrop>'
        b'<LinksUpToDate>false</LinksUpToDate>'
        b'<SharedDoc>false</SharedDoc>'
        b'<HyperlinksChanged>false</HyperlinksChanged>'
        b'<AppVersion>' + app_version + b'</AppVersion>'
        b'</Properties>'
    )
    merged_files["docProps/app.xml"] = new_app
