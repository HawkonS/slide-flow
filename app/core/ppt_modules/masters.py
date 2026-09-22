"""Master/layout sharing, fingerprints and notes-master theme ownership."""

from __future__ import annotations

import hashlib
import posixpath
import re
from xml.etree import ElementTree as ET

from .package import (
    A_NS,
    IMAGE_REL_TYPE,
    PKG_CT_NS,
    PKG_REL_NS,
    P_NS,
    R_NS,
    SLIDE_LAYOUT_REL_TYPE,
    SLIDE_MASTER_REL_TYPE,
    THEME_REL_TYPE,
    _local_name,
    _make_relative,
    _next_rel_id,
    _read_rels_root,
    _rels_path_for,
    _resolve_target,
)
from .xml import _serialize_rels_xml, _serialize_xml_with_ns_preservation


def _master_group_signature(
    files: dict[str, bytes], master_part: str
) -> tuple[str, dict[str, str], set[str]]:
    """Compute a content-based fingerprint for a slideMaster group.

    A "master group" is the slideMaster part plus everything it owns: theme,
    every slideLayout it references, and any media referenced from the master
    or its layouts. Two master groups with identical bytes (under this
    canonicalization) share the same group fingerprint, which lets the merger
    deduplicate masters across source PPTX files generated from a common
    template.

    Returns:
      group_fp: SHA-256 hex digest covering master + theme + master media +
                each layout's per-layout fingerprint.
      layout_fps: mapping of layout zip path -> per-layout fingerprint, used
                  to pair source layouts with their counterparts in the
                  shared master group.
      owned_parts: set of zip paths considered private to this master group
                   (master xml + .rels, theme xml + .rels, layouts + .rels,
                   plus media referenced exclusively from these parts).
    """
    owned: set[str] = set()
    layout_fps: dict[str, str] = {}
    h = hashlib.sha256()

    h.update(b"M:")
    h.update(files.get(master_part, b""))
    owned.add(master_part)
    master_rels_path = _rels_path_for(master_part)
    if master_rels_path in files:
        owned.add(master_rels_path)

    layout_parts: list[str] = []
    theme_part: str | None = None
    master_media: list[str] = []
    master_rels_root = _read_rels_root(files, master_part)
    if master_rels_root is not None:
        for rel in master_rels_root:
            if rel.attrib.get("TargetMode", "Internal") == "External":
                continue
            ttype = rel.attrib.get("Type", "")
            target = rel.attrib.get("Target", "")
            dep = _resolve_target(master_part, target)
            if dep not in files:
                continue
            if ttype == SLIDE_LAYOUT_REL_TYPE:
                layout_parts.append(dep)
            elif ttype == THEME_REL_TYPE:
                theme_part = dep
            elif ttype == IMAGE_REL_TYPE or "/media/" in dep:
                master_media.append(dep)

    if theme_part is not None:
        h.update(b"T:")
        h.update(files.get(theme_part, b""))
        owned.add(theme_part)
        theme_rels_path = _rels_path_for(theme_part)
        if theme_rels_path in files:
            owned.add(theme_rels_path)
        theme_rels_root = _read_rels_root(files, theme_part)
        if theme_rels_root is not None:
            theme_media: list[str] = []
            for rel in theme_rels_root:
                if rel.attrib.get("TargetMode", "Internal") == "External":
                    continue
                target = rel.attrib.get("Target", "")
                dep = _resolve_target(theme_part, target)
                if dep in files:
                    theme_media.append(dep)
            for m in sorted(theme_media):
                h.update(b"TM:")
                h.update(files.get(m, b""))
                owned.add(m)

    for m in sorted(master_media):
        h.update(b"MM:")
        h.update(files.get(m, b""))
        owned.add(m)

    # Layouts: preserve source order so layout pairing is stable across same-template files.
    for lp in layout_parts:
        lp_h = hashlib.sha256()
        lp_h.update(b"L:")
        lp_h.update(files.get(lp, b""))
        owned.add(lp)
        lp_rels_path = _rels_path_for(lp)
        if lp_rels_path in files:
            owned.add(lp_rels_path)
        lp_rels_root = _read_rels_root(files, lp)
        if lp_rels_root is not None:
            extra_media: list[str] = []
            for rel in lp_rels_root:
                if rel.attrib.get("TargetMode", "Internal") == "External":
                    continue
                ttype = rel.attrib.get("Type", "")
                target = rel.attrib.get("Target", "")
                dep = _resolve_target(lp, target)
                if dep not in files:
                    continue
                # Skip the back-reference to the master itself; it would only add noise.
                if ttype == SLIDE_MASTER_REL_TYPE:
                    continue
                extra_media.append(dep)
            for m in sorted(extra_media):
                lp_h.update(b"LM:")
                lp_h.update(files.get(m, b""))
                owned.add(m)
        lp_fp = lp_h.hexdigest()
        layout_fps[lp] = lp_fp
        h.update(b"LFP:")
        h.update(lp_fp.encode("ascii"))

    return h.hexdigest(), layout_fps, owned


def _is_blank_master(files: dict[str, bytes], master_part: str) -> bool:
    """A master is considered 'blank' if its .rels has no image/media references.

    This means no LOGO, no background image, etc.  Text and placeholders are OK.
    """
    rels_root = _read_rels_root(files, master_part)
    if rels_root is None:
        return True
    for rel in rels_root:
        if rel.attrib.get("TargetMode", "Internal") == "External":
            continue
        ttype = rel.attrib.get("Type", "")
        target = rel.attrib.get("Target", "")
        if ttype == IMAGE_REL_TYPE or "/media/" in target:
            return False
    return True


def _attach_layout_to_master(
    merged_files: dict[str, bytes], master_part: str, layout_part: str
) -> None:
    """Add a slideLayout relationship to an existing master's .rels and update its sldLayoutIdLst."""
    # --- Update master's .rels ---
    master_rels_path = _rels_path_for(master_part)
    rels_data = merged_files.get(master_rels_path)
    if rels_data:
        rels_root = ET.fromstring(rels_data)
    else:
        rels_root = ET.Element(f"{{{PKG_REL_NS}}}Relationships")

    # Allocate next rId
    max_rid = 0
    for rel in rels_root:
        m = re.match(r"rId(\d+)$", rel.attrib.get("Id", ""))
        if m:
            max_rid = max(max_rid, int(m.group(1)))
    new_rid = f"rId{max_rid + 1}"
    ET.SubElement(
        rels_root,
        f"{{{PKG_REL_NS}}}Relationship",
        {
            "Id": new_rid,
            "Type": SLIDE_LAYOUT_REL_TYPE,
            "Target": _make_relative(master_part, layout_part),
        },
    )
    merged_files[master_rels_path] = _serialize_rels_xml(rels_root)

    # --- Update master XML's <p:sldLayoutIdLst> ---
    master_xml_data = merged_files.get(master_part)
    if not master_xml_data:
        return
    master_root = ET.fromstring(master_xml_data)
    # Ensure proper namespace registrations for serialization
    ET.register_namespace("a", A_NS)
    ET.register_namespace("p", P_NS)
    ET.register_namespace("r", R_NS)

    layout_id_list = master_root.find(f"{{{P_NS}}}sldLayoutIdLst")
    if layout_id_list is None:
        # Insert sldLayoutIdLst as the first child (standard position)
        layout_id_list = ET.Element(f"{{{P_NS}}}sldLayoutIdLst")
        master_root.insert(0, layout_id_list)

    # Allocate next layout id (these are unique within the master)
    max_lid = 2147483648
    for lid_elem in layout_id_list:
        lid_val = lid_elem.attrib.get("id", "")
        if lid_val.isdigit():
            max_lid = max(max_lid, int(lid_val))
    ET.SubElement(
        layout_id_list,
        f"{{{P_NS}}}sldLayoutId",
        {"id": str(max_lid + 1), f"{{{R_NS}}}id": new_rid},
    )
    merged_files[master_part] = _serialize_xml_with_ns_preservation(master_root, master_xml_data)


def _ensure_notes_master_independent_theme(
    merged_files: dict[str, bytes],
    pres_rels_root: ET.Element,
    content_types_root: ET.Element,
) -> None:
    """Ensure every notesMaster references its OWN theme part (not shared with slideMaster).

    Two related OOXML compliance issues are handled here:

    1. A notesMaster MUST declare a relationship of type .../relationships/theme.
       Some upstream generators omit the notesMasters/_rels/ directory entirely.
    2. Each master (slideMaster / notesMaster / handoutMaster) MUST own its
       own theme part. When notesMaster and slideMaster share the same
       theme (e.g. both pointing at ppt/theme/theme1.xml), Office 365 strict
       validation rejects the package as corrupt — even though the older
       PowerPoint and WPS silently accept it. PowerPoint's own "auto-repair"
       splits the shared theme into a new theme part, which is exactly what
       we mirror here.
    """
    import posixpath

    REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
    THEME_CT = "application/vnd.openxmlformats-officedocument.theme+xml"

    # Collect themes that any slideMaster references — these are "shared" and
    # must NOT also be referenced by a notesMaster.
    slide_master_themes: set[str] = set()
    for sm_name in merged_files:
        if not sm_name.startswith("ppt/slideMasters/") or not sm_name.endswith(".xml"):
            continue
        sm_rels_data = merged_files.get(_rels_path_for(sm_name))
        if not sm_rels_data:
            continue
        try:
            sm_rr = ET.fromstring(sm_rels_data)
        except ET.ParseError:
            continue
        for r in sm_rr:
            if r.attrib.get("Type") != THEME_REL_TYPE:
                continue
            if r.attrib.get("TargetMode", "Internal") == "External":
                continue
            tgt = posixpath.normpath(posixpath.join(
                posixpath.dirname(sm_name), r.attrib.get("Target", "")
            ))
            slide_master_themes.add(tgt)

    # Find a fallback primary theme (used when notesMaster has no theme rel at all).
    primary_theme: str | None = None
    for rel in pres_rels_root:
        if rel.attrib.get("Type") != THEME_REL_TYPE:
            continue
        if rel.attrib.get("TargetMode", "Internal") == "External":
            continue
        cand = posixpath.normpath(posixpath.join("ppt", rel.attrib.get("Target", "")))
        if cand in merged_files:
            primary_theme = cand
            break
    if primary_theme is None:
        for name in merged_files:
            if name.startswith("ppt/theme/") and name.endswith(".xml"):
                primary_theme = name
                break
    if primary_theme is None:
        return  # Nothing to reference; give up silently

    def _alloc_theme_part() -> str:
        n = 1
        while f"ppt/theme/theme{n}.xml" in merged_files:
            n += 1
        return f"ppt/theme/theme{n}.xml"

    def _add_theme_override(part: str) -> None:
        pn = "/" + part
        for child in content_types_root:
            if _local_name(child.tag) == "Override" and child.attrib.get("PartName") == pn:
                return
        ov = ET.SubElement(
            content_types_root,
            f"{{{PKG_CT_NS}}}Override",
        )
        ov.attrib["PartName"] = pn
        ov.attrib["ContentType"] = THEME_CT

    def _split_theme_if_shared(target_part: str) -> str:
        """If target_part is referenced by a slideMaster, duplicate it and
        return the new part name; otherwise return target_part unchanged.
        """
        if target_part not in slide_master_themes or target_part not in merged_files:
            return target_part
        new_part = _alloc_theme_part()
        merged_files[new_part] = merged_files[target_part]
        # Copy theme's sibling rels (if any) so embedded image refs survive.
        src_rels = merged_files.get(_rels_path_for(target_part))
        if src_rels:
            merged_files[_rels_path_for(new_part)] = src_rels
        _add_theme_override(new_part)
        return new_part

    for name in list(merged_files):
        if not name.startswith("ppt/notesMasters/") or not name.endswith(".xml"):
            continue
        rels_path = _rels_path_for(name)
        rels_data = merged_files.get(rels_path)
        if rels_data:
            try:
                rr = ET.fromstring(rels_data)
            except ET.ParseError:
                rr = ET.Element(f"{{{REL_NS}}}Relationships")
        else:
            rr = ET.Element(f"{{{REL_NS}}}Relationships")

        theme_rel: ET.Element | None = None
        for child in rr:
            if child.attrib.get("Type") == THEME_REL_TYPE:
                theme_rel = child
                break

        if theme_rel is None:
            # No theme rel: synthesize one. If the chosen target is shared
            # with a slideMaster, split it first.
            chosen = _split_theme_if_shared(primary_theme)
            new_rel = ET.SubElement(rr, f"{{{REL_NS}}}Relationship")
            new_rel.attrib["Id"] = _next_rel_id(rr)
            new_rel.attrib["Type"] = THEME_REL_TYPE
            new_rel.attrib["Target"] = _make_relative(name, chosen)
            merged_files[rels_path] = _serialize_rels_xml(rr)
            continue

        # Already has a theme rel: check whether it is shared with a slideMaster.
        cur_target = posixpath.normpath(posixpath.join(
            posixpath.dirname(name), theme_rel.attrib.get("Target", "")
        ))
        if cur_target not in slide_master_themes:
            continue  # already independent; nothing to do
        new_target = _split_theme_if_shared(cur_target)
        if new_target != cur_target:
            theme_rel.attrib["Target"] = _make_relative(name, new_target)
            merged_files[rels_path] = _serialize_rels_xml(rr)
