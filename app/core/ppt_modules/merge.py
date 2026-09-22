"""PPTX merge orchestration and source-part mapping."""

from __future__ import annotations

import logging
import re
import shutil
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from .integrity import (
    _add_override_content_type,
    _ensure_content_types_complete,
    _ensure_default_content_type,
    _normalize_app_xml_metadata,
    _remove_dangling_rels,
    _remove_orphan_parts,
    _strip_invalid_default_content_types,
)
from .masters import (
    _attach_layout_to_master,
    _ensure_notes_master_independent_theme,
    _is_blank_master,
    _master_group_signature,
)
from .package import (
    NOTES_MASTER_REL_TYPE,
    PKG_CT_NS,
    PKG_REL_NS,
    P_NS,
    R_NS,
    SLIDE_MASTER_REL_TYPE,
    SLIDE_REL_TYPE,
    _PRECOMPRESSED_EXTS,
    _local_name,
    _make_relative,
    _rels_path_for,
    _resolve_target,
    _suffix_part_name,
)
from .svg import _repair_svg_blip_primary_embed
from .visibility import _apply_hidden_flags_to_merged, _apply_hidden_to_single_pptx
from .xml import (
    _fix_xml_declaration,
    _normalize_rels_bytes,
    _serialize_ct_xml,
    _serialize_pres_xml,
    _serialize_rels_xml,
)


def merge_pptx_files(input_paths: list[Path], output_path: Path, *, hidden_flags: list[bool] | None = None) -> None:
    """Merge multiple .pptx files into one, preserving each source's layouts, masters, themes and media.

    The first input serves as the base (its theme / masters / layouts / dimensions are kept).
    For each subsequent input, all referenced slides, slideLayouts, slideMasters, themes,
    media, charts, embeddings, notesSlides, etc. are renamed with a unique suffix and merged
    in, with relationships, [Content_Types].xml and presentation.xml updated accordingly.

    If hidden_flags is provided, slides from sources marked as hidden will have
    the PowerPoint native "hide slide" attribute (show="0") set on their <p:sld>
    root element in the corresponding slide XML file (per ECMA-376 standard).
    """
    if not input_paths:
        raise ValueError("input_paths must not be empty")
    paths = [Path(p) for p in input_paths]
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if len(paths) == 1:
        if hidden_flags and hidden_flags[0]:
            # Single file but marked hidden: need to set show="0" on all slides
            _apply_hidden_to_single_pptx(paths[0], output_path)
        else:
            shutil.copyfile(str(paths[0]), str(output_path))
        return

    merged_files: dict[str, bytes] = {}
    with zipfile.ZipFile(paths[0]) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            data = zf.read(info.filename)
            # Normalize malformed .rels files (ns0: prefix issue)
            if info.filename.endswith(".rels"):
                data = _normalize_rels_bytes(data)
            merged_files[info.filename] = data

    if "ppt/presentation.xml" not in merged_files or "ppt/_rels/presentation.xml.rels" not in merged_files:
        raise ValueError(f"{paths[0]} is not a valid PPTX package")

    presentation_root = ET.fromstring(merged_files["ppt/presentation.xml"])
    pres_rels_root = ET.fromstring(merged_files["ppt/_rels/presentation.xml.rels"])
    content_types_root = ET.fromstring(merged_files.get("[Content_Types].xml", b"<Types/>"))

    # Identify base notesMaster (if any) so we can collapse every source's
    # notesMaster onto it. Otherwise the source's notesSlide rels would keep
    # referencing notesMaster1_src2/3.xml and produce orphan notesMasters that
    # are not declared in <p:notesMasterIdLst>, which Office 365 rejects.
    base_notes_master: str | None = None
    for rel in pres_rels_root:
        if rel.attrib.get("Type") != NOTES_MASTER_REL_TYPE:
            continue
        if rel.attrib.get("TargetMode", "Internal") == "External":
            continue
        nm_part = _resolve_target("ppt/presentation.xml", rel.attrib.get("Target", ""))
        if nm_part in merged_files:
            base_notes_master = nm_part
            break

    # Build master group fingerprint registry from the base file
    master_group_index: dict[str, str] = {}  # group_fp -> master_part in merged
    master_layout_index: dict[str, dict[str, str]] = {}  # group_fp -> {layout_fp -> layout_part}
    # Blank-master merging state: all blank masters collapse into one shared master.
    # {"master_part": str|None, "layout_fps": {layout_fp -> layout_part_in_merged}}
    blank_master_state: dict = {"master_part": None, "layout_fps": {}}

    for rel in pres_rels_root:
        if rel.attrib.get("Type") != SLIDE_MASTER_REL_TYPE:
            continue
        if rel.attrib.get("TargetMode", "Internal") == "External":
            continue
        base_master = _resolve_target("ppt/presentation.xml", rel.attrib.get("Target", ""))
        if base_master not in merged_files:
            continue
        group_fp, layout_fps, _ = _master_group_signature(merged_files, base_master)
        master_group_index.setdefault(group_fp, base_master)
        if group_fp not in master_layout_index:
            master_layout_index[group_fp] = {}
        for lp, lp_fp in layout_fps.items():
            master_layout_index[group_fp].setdefault(lp_fp, lp)
        # Register blank master if applicable
        if blank_master_state["master_part"] is None and _is_blank_master(merged_files, base_master):
            blank_master_state["master_part"] = base_master
            for lp, lp_fp in layout_fps.items():
                blank_master_state["layout_fps"].setdefault(lp_fp, lp)

    for idx, src_path in enumerate(paths[1:], start=2):
        _merge_pptx_into(
            src_path,
            source_tag=f"src{idx}",
            merged_files=merged_files,
            presentation_root=presentation_root,
            pres_rels_root=pres_rels_root,
            content_types_root=content_types_root,
            master_group_index=master_group_index,
            master_layout_index=master_layout_index,
            blank_master_state=blank_master_state,
            base_notes_master=base_notes_master,
        )

    # Save original bytes before modification for namespace preservation
    orig_pres_bytes = merged_files.get("ppt/presentation.xml")

    # ── Orphan-parts pass: remove unreachable master/layout/theme files ─────
    # When two source PPTXs share the same master fingerprint, _merge_pptx_into
    # deduplicates the master (redirects slides/layouts to the base master) but
    # the renamed copies (slideMaster1_src2.xml, etc.) may still end up in
    # merged_files because visit() followed their deps from the slide chain.
    # Those orphan parts are NOT listed in sldMasterIdLst and violate OPC rules,
    # causing Office 365 to report a corrupt package.
    _remove_orphan_parts(merged_files, pres_rels_root)

    # ── Repair pass: ensure each notesMaster has its own (independent) theme.
    # Two compliance issues are fixed in one shot:
    #   1. notesMaster missing the required /relationships/theme rel altogether.
    #   2. notesMaster sharing a theme part with a slideMaster (Office 365 strict
    #      validation rejects this; PowerPoint's own auto-repair splits the
    #      shared theme into a new theme part, which we mirror here).
    _ensure_notes_master_independent_theme(
        merged_files, pres_rels_root, content_types_root
    )

    # ── Integrity pass: remove dangling references ──────────────────────────
    # After merging, pres_rels_root and presentation_root may still reference
    # parts that weren't included (e.g. embedded font files, commentAuthors,
    # global tags) because the source single-page PPTXs only contain a subset
    # of the original file's parts. Dangling references cause Office 365 to
    # reject the package as corrupt.
    _remove_dangling_rels(merged_files, pres_rels_root, presentation_root)
    # Also ensure [Content_Types].xml has Override entries for every XML part
    # that is actually present in the package.
    _ensure_content_types_complete(merged_files, content_types_root)
    # Drop malformed Default entries (e.g. ContentType="image/.jpg") that
    # violate RFC 2616 type/subtype syntax. Office 365 strict validation
    # rejects the package over a single bad Default; older PowerPoint and
    # WPS silently ignore them, so they sneak in via templates.
    _strip_invalid_default_content_types(content_types_root)
    # Rewrite docProps/app.xml so Slides/Notes counts match the actual deck.
    # Some upstream PPTX (notably WPS exports) declare far more slides than
    # actually exist plus mismatched <vt:vector size=…> entries, which Office
    # 365 flags as corruption.
    _normalize_app_xml_metadata(merged_files)

    # ── Schema-repair pass: promote SVG <asvg:svgBlip> rId to the outer
    # <a:blip r:embed> when the primary reference is missing. Some upstream
    # sources (notably PowerPoint's "Save As") drop the PNG fallback rel of
    # an SVG image without restoring a primary r:embed on <a:blip>, which
    # Office 365 rejects as a corrupt package.
    _repair_svg_blip_primary_embed(merged_files)

    merged_files["ppt/presentation.xml"] = _serialize_pres_xml(presentation_root, orig_pres_bytes)
    merged_files["ppt/_rels/presentation.xml.rels"] = _serialize_rels_xml(pres_rels_root)
    merged_files["[Content_Types].xml"] = _serialize_ct_xml(content_types_root)

    # Apply hidden slide flags if provided
    if hidden_flags:
        _apply_hidden_flags_to_merged(merged_files, paths, hidden_flags)

    with zipfile.ZipFile(output_path, "w") as out:
        for name, data in merged_files.items():
            ext = Path(name).suffix.lower()
            # Ensure all XML files have proper standalone="yes" declaration.
            # This repairs source files that were generated without it.
            if ext == ".xml" and data and b"<?xml" in data[:100]:
                if b'standalone="yes"' not in data[:200] and b"standalone='yes'" not in data[:200]:
                    data = _fix_xml_declaration(data)
            compress_type = zipfile.ZIP_STORED if ext in _PRECOMPRESSED_EXTS else zipfile.ZIP_DEFLATED
            out.writestr(zipfile.ZipInfo(name), data, compress_type=compress_type)


def _merge_pptx_into(
    src_path: Path,
    *,
    source_tag: str,
    merged_files: dict[str, bytes],
    presentation_root: ET.Element,
    pres_rels_root: ET.Element,
    content_types_root: ET.Element,
    master_group_index: dict[str, str],
    master_layout_index: dict[str, dict[str, str]],
    blank_master_state: dict,
    base_notes_master: str | None = None,
) -> None:
    src_files: dict[str, bytes] = {}
    with zipfile.ZipFile(src_path) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            data = zf.read(info.filename)
            # Normalize malformed .rels files (ns0: prefix issue from older generators)
            if info.filename.endswith(".rels"):
                data = _normalize_rels_bytes(data)
            src_files[info.filename] = data

    if "ppt/presentation.xml" not in src_files or "ppt/_rels/presentation.xml.rels" not in src_files:
        return
    src_pres_root = ET.fromstring(src_files["ppt/presentation.xml"])
    src_pres_rels_root = ET.fromstring(src_files["ppt/_rels/presentation.xml.rels"])

    # map rId -> (type, absolute part path) for source presentation rels
    src_pres_rels_by_id: dict[str, tuple[str, str]] = {}
    for rel in src_pres_rels_root:
        rid = rel.attrib.get("Id")
        target = rel.attrib.get("Target", "")
        rtype = rel.attrib.get("Type", "")
        if rid and rel.attrib.get("TargetMode", "Internal") != "External":
            src_pres_rels_by_id[rid] = (rtype, _resolve_target("ppt/presentation.xml", target))

    rename_map: dict[str, str] = {}
    visited: set[str] = set()

    def visit(part: str) -> None:
        if part in visited or part not in src_files:
            return
        visited.add(part)
        rename_map.setdefault(part, _suffix_part_name(part, source_tag))
        rels_data = src_files.get(_rels_path_for(part))
        if not rels_data:
            return
        try:
            rels_root = ET.fromstring(rels_data)
        except ET.ParseError:
            return
        for rel in rels_root:
            if rel.attrib.get("TargetMode", "Internal") == "External":
                continue
            target = rel.attrib.get("Target", "")
            dep = _resolve_target(part, target)
            if dep in src_files:
                visit(dep)

    # Collect slides referenced by source's sldIdLst (preserve order)
    slide_src_parts: list[str] = []
    src_slide_list = src_pres_root.find(f"{{{P_NS}}}sldIdLst")
    if src_slide_list is not None:
        for slide_id_elem in src_slide_list:
            rid = slide_id_elem.attrib.get(f"{{{R_NS}}}id")
            if not rid or rid not in src_pres_rels_by_id:
                continue
            rtype, slide_part = src_pres_rels_by_id[rid]
            if rtype != SLIDE_REL_TYPE or slide_part not in src_files:
                continue
            visit(slide_part)
            slide_src_parts.append(slide_part)

    # Snapshot of parts already required by slides (used to avoid dropping shared deps)
    slide_required: set[str] = set(rename_map.keys())

    # Also pull in slide masters referenced from source presentation, with dedup
    master_src_parts: list[str] = []
    layout_redirect: dict[str, str] = {}  # src_layout_part -> base_layout_part (in merged)
    master_redirect: dict[str, str] = {}  # src_master_part -> base_master_part (in merged)
    notes_master_redirect: dict[str, str] = {}  # src_notes_master_part -> base_notes_master

    # Collapse every notesMaster from this source onto the merged base notesMaster.
    # Carrying the source's own notesMaster as notesMaster1_srcN.xml leaves an
    # orphan part (it is never declared in <p:notesMasterIdLst>) which Office
    # 365 flags as a corrupt package. WPS silently ignores it.
    #
    # Note: a source PPTX may itself be a previously merged product and contain
    # multiple notesMaster*.xml files (only one of which is referenced from its
    # own presentation.xml.rels; the others are reachable only via notesSlide
    # rels). To catch them all we scan src_files directly instead of relying on
    # src_pres_rels_root.
    if base_notes_master is not None:
        for src_nm in list(src_files.keys()):
            if not src_nm.startswith("ppt/notesMasters/") or not src_nm.endswith(".xml"):
                continue
            notes_master_redirect[src_nm] = base_notes_master
            # Drop it from rename_map so the duplicate copy isn't written out.
            # Its dependencies (theme/image) will become orphans and be removed
            # by the subsequent _remove_orphan_parts pass.
            rename_map.pop(src_nm, None)

    for rel in src_pres_rels_root:
        if rel.attrib.get("Type") != SLIDE_MASTER_REL_TYPE:
            continue
        if rel.attrib.get("TargetMode", "Internal") == "External":
            continue
        master_part = _resolve_target("ppt/presentation.xml", rel.attrib.get("Target", ""))
        if master_part not in src_files:
            continue

        group_fp, layout_fps, owned_parts = _master_group_signature(src_files, master_part)

        if group_fp in master_group_index:
            # This master group already exists in the merged output -- reuse it.
            base_master_part = master_group_index[group_fp]
            base_layout_fps = master_layout_index.get(group_fp, {})
            per_master_layout_redirects: dict[str, str] = {}
            unmatched = False
            for lp, lp_fp in layout_fps.items():
                base_lp = base_layout_fps.get(lp_fp)
                if base_lp is None:
                    unmatched = True
                    break
                per_master_layout_redirects[lp] = base_lp

            if not unmatched:
                # Successfully paired all layouts -- dedup this master.
                master_redirect[master_part] = base_master_part
                layout_redirect.update(per_master_layout_redirects)
                # Remove owned parts from rename_map unless they're also needed by slides.
                for op in owned_parts:
                    if op not in slide_required:
                        rename_map.pop(op, None)
                continue  # skip visit + skip master_src_parts
            else:
                logging.warning(
                    "PPTX merge: master group %s matched but layout fingerprint missing; "
                    "copying full master from %s",
                    group_fp[:12], src_path,
                )

        # --- Blank-master merging: if both the source master and the shared
        #     blank master are media-free, merge their layouts into one master.
        if _is_blank_master(src_files, master_part) and blank_master_state["master_part"] is not None:
            base_blank = blank_master_state["master_part"]
            existing_layout_fps = blank_master_state["layout_fps"]
            master_redirect[master_part] = base_blank
            # Process each layout under this blank master
            for src_lp, lp_fp in layout_fps.items():
                if lp_fp in existing_layout_fps:
                    # Layout already exists in shared blank master -- redirect
                    layout_redirect[src_lp] = existing_layout_fps[lp_fp]
                else:
                    # New layout: copy it into merged and attach to shared blank master
                    new_lp = _suffix_part_name(src_lp, source_tag)
                    merged_files[new_lp] = src_files[src_lp]
                    # Process layout's own .rels (rewrite master back-ref + copy deps)
                    lp_rels_data = src_files.get(_rels_path_for(src_lp))
                    if lp_rels_data:
                        try:
                            lp_rels_root = ET.fromstring(lp_rels_data)
                        except ET.ParseError:
                            lp_rels_root = None
                        if lp_rels_root is not None:
                            for lrel in lp_rels_root:
                                if lrel.attrib.get("TargetMode", "Internal") == "External":
                                    continue
                                lttype = lrel.attrib.get("Type", "")
                                ltarget = lrel.attrib.get("Target", "")
                                ldep = _resolve_target(src_lp, ltarget)
                                if lttype == SLIDE_MASTER_REL_TYPE:
                                    # Rewrite back-reference to shared blank master
                                    lrel.attrib["Target"] = _make_relative(new_lp, base_blank)
                                elif ldep in src_files:
                                    # Copy dependency (media etc.) with _srcN suffix
                                    new_dep = _suffix_part_name(ldep, source_tag)
                                    if new_dep not in merged_files:
                                        merged_files[new_dep] = src_files[ldep]
                                        # Ensure content type
                                        dep_ext = Path(new_dep).suffix.lstrip(".").lower()
                                        if dep_ext:
                                            _ensure_default_content_type(
                                                content_types_root, dep_ext, src_files, src_lp
                                            )
                                    lrel.attrib["Target"] = _make_relative(new_lp, new_dep)
                            merged_files[_rels_path_for(new_lp)] = _serialize_rels_xml(lp_rels_root)
                    # Add Override entry in [Content_Types].xml for the new layout
                    _add_override_content_type(content_types_root, new_lp, src_files, src_lp)
                    # Attach new layout to the shared blank master's .rels
                    _attach_layout_to_master(merged_files, base_blank, new_lp)
                    # Register for future dedup
                    existing_layout_fps[lp_fp] = new_lp
                    layout_redirect[src_lp] = new_lp
            # Drop owned parts that are not needed by slides
            for op in owned_parts:
                if op not in slide_required:
                    rename_map.pop(op, None)
            continue  # skip visit + skip master_src_parts

        # Default: copy this master and register it for future dedup
        visit(master_part)
        master_src_parts.append(master_part)
        new_master_part = rename_map.get(master_part, "")
        master_group_index.setdefault(group_fp, new_master_part)
        if group_fp not in master_layout_index:
            master_layout_index[group_fp] = {}
        for lp, lp_fp in layout_fps.items():
            new_lp = rename_map.get(lp)
            if new_lp:
                master_layout_index[group_fp].setdefault(lp_fp, new_lp)
        # If this is a blank master and no shared blank exists yet, register it
        if blank_master_state["master_part"] is None and _is_blank_master(src_files, master_part):
            blank_master_state["master_part"] = new_master_part
            for lp, lp_fp in layout_fps.items():
                new_lp_path = rename_map.get(lp)
                if new_lp_path:
                    blank_master_state["layout_fps"].setdefault(lp_fp, new_lp_path)

    # Copy each collected part under its new name, rewriting its rels to point to renamed targets
    for src_part, new_part in rename_map.items():
        merged_files[new_part] = src_files[src_part]
        rels_data = src_files.get(_rels_path_for(src_part))
        if not rels_data:
            continue
        try:
            rels_root = ET.fromstring(rels_data)
        except ET.ParseError:
            continue
        for rel in rels_root:
            if rel.attrib.get("TargetMode", "Internal") == "External":
                continue
            target = rel.attrib.get("Target", "")
            dep = _resolve_target(src_part, target)
            # Check if this dep should redirect to a shared master/layout/notesMaster part
            redirect = (
                layout_redirect.get(dep)
                or master_redirect.get(dep)
                or notes_master_redirect.get(dep)
            )
            if redirect is not None:
                rel.attrib["Target"] = _make_relative(new_part, redirect)
                continue
            new_dep = rename_map.get(dep)
            if new_dep:
                rel.attrib["Target"] = _make_relative(new_part, new_dep)
        merged_files[_rels_path_for(new_part)] = _serialize_rels_xml(rels_root)

    # Merge [Content_Types].xml entries
    src_ct_root = ET.fromstring(src_files.get("[Content_Types].xml", b"<Types/>"))
    src_overrides: dict[str, str] = {}
    src_defaults: dict[str, str] = {}
    for child in src_ct_root:
        local = _local_name(child.tag)
        if local == "Override":
            pn = child.attrib.get("PartName", "").lstrip("/")
            if pn:
                src_overrides[pn] = child.attrib.get("ContentType", "")
        elif local == "Default":
            ext = child.attrib.get("Extension", "").lower()
            if ext:
                src_defaults[ext] = child.attrib.get("ContentType", "")

    existing_overrides: set[str] = set()
    existing_defaults: set[str] = set()
    for child in content_types_root:
        local = _local_name(child.tag)
        if local == "Override":
            existing_overrides.add(child.attrib.get("PartName", ""))
        elif local == "Default":
            existing_defaults.add(child.attrib.get("Extension", "").lower())

    for new_part in rename_map.values():
        ext = Path(new_part).suffix.lstrip(".").lower()
        if ext and ext not in existing_defaults and ext in src_defaults:
            ET.SubElement(
                content_types_root,
                f"{{{PKG_CT_NS}}}Default",
                {"Extension": ext, "ContentType": src_defaults[ext]},
            )
            existing_defaults.add(ext)

    for src_part, new_part in rename_map.items():
        ct = src_overrides.get(src_part)
        pn = "/" + new_part
        if ct and pn not in existing_overrides:
            ET.SubElement(
                content_types_root,
                f"{{{PKG_CT_NS}}}Override",
                {"PartName": pn, "ContentType": ct},
            )
            existing_overrides.add(pn)

    # Allocate unique rIds in presentation.xml.rels
    existing_rids: set[int] = set()
    for rel in pres_rels_root:
        m = re.match(r"rId(\d+)$", rel.attrib.get("Id", ""))
        if m:
            existing_rids.add(int(m.group(1)))
    next_rid = [max(existing_rids) + 1 if existing_rids else 1]

    def alloc_rid() -> str:
        rid = f"rId{next_rid[0]}"
        next_rid[0] += 1
        return rid

    # Append new slide refs to base's sldIdLst (preserving source order)
    pres_slide_list = presentation_root.find(f"{{{P_NS}}}sldIdLst")
    if pres_slide_list is None:
        pres_slide_list = ET.SubElement(presentation_root, f"{{{P_NS}}}sldIdLst")
    existing_slide_ids: set[int] = set()
    for s in pres_slide_list:
        sid = s.attrib.get("id")
        if sid and sid.isdigit():
            existing_slide_ids.add(int(sid))
    next_slide_id = max(existing_slide_ids) + 1 if existing_slide_ids else 256

    for slide_part in slide_src_parts:
        new_part = rename_map.get(slide_part)
        if not new_part:
            continue
        rid = alloc_rid()
        ET.SubElement(
            pres_rels_root,
            f"{{{PKG_REL_NS}}}Relationship",
            {"Id": rid, "Type": SLIDE_REL_TYPE, "Target": _make_relative("ppt/presentation.xml", new_part)},
        )
        ET.SubElement(
            pres_slide_list,
            f"{{{P_NS}}}sldId",
            {"id": str(next_slide_id), f"{{{R_NS}}}id": rid},
        )
        next_slide_id += 1

    # Append new slide master refs
    pres_master_list = presentation_root.find(f"{{{P_NS}}}sldMasterIdLst")
    if pres_master_list is None:
        pres_master_list = ET.Element(f"{{{P_NS}}}sldMasterIdLst")
        inserted = False
        for i, child in enumerate(list(presentation_root)):
            if child.tag == f"{{{P_NS}}}sldIdLst":
                presentation_root.insert(i, pres_master_list)
                inserted = True
                break
        if not inserted:
            presentation_root.append(pres_master_list)
    existing_master_ids: set[int] = set()
    for m in pres_master_list:
        mid = m.attrib.get("id")
        if mid and mid.isdigit():
            existing_master_ids.add(int(mid))
    next_master_id = max(existing_master_ids) + 1 if existing_master_ids else 2147483648

    for master_part in master_src_parts:
        new_part = rename_map.get(master_part)
        if not new_part:
            continue
        rid = alloc_rid()
        ET.SubElement(
            pres_rels_root,
            f"{{{PKG_REL_NS}}}Relationship",
            {"Id": rid, "Type": SLIDE_MASTER_REL_TYPE, "Target": _make_relative("ppt/presentation.xml", new_part)},
        )
        ET.SubElement(
            pres_master_list,
            f"{{{P_NS}}}sldMasterId",
            {"id": str(next_master_id), f"{{{R_NS}}}id": rid},
        )
        next_master_id += 1


__all__ = ['merge_pptx_files']
