"""Single-slide PPTX splitting and dependency collection."""

from __future__ import annotations

import copy
import logging
import posixpath
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from xml.etree import ElementTree as ET

from .package import (
    PKG_CT_NS,
    P_NS,
    R_NS,
    SLIDE_REL_TYPE,
    _PRECOMPRESSED_EXTS,
    _local_name,
    _parse_rels_targets,
    _read_pptx_entries,
    _resolve_rel_path,
)
from .xml import _serialize_rels_xml, _serialize_xml_with_ns_preservation


_logger = logging.getLogger(__name__)


def _collect_master_deps(master_path: str, entry_map: dict[str, bytes], needed: set[str]) -> None:
    """Collect slideMaster dependencies (theme + media + all referenced layouts).

    OPC requires every referenced slideLayout to ship with its own `.rels`
    file (pointing back to the slideMaster and any media it uses). Missing
    those rels makes PowerPoint flag the package as corrupted even though the
    layout XML itself is present.
    """
    parent = posixpath.dirname(master_path)
    name = posixpath.basename(master_path)
    rels_path = f"{parent}/_rels/{name}.rels"
    if rels_path not in entry_map:
        return
    needed.add(rels_path)
    targets = _parse_rels_targets(entry_map[rels_path])
    base_dir = parent + '/'
    for target in targets:
        resolved = _resolve_rel_path(base_dir, target)
        if resolved not in entry_map:
            continue
        needed.add(resolved)
        # Every layout the master references must ship with its own rels +
        # media, otherwise the package is broken from PowerPoint's view.
        if 'slideLayouts' in resolved:
            layout_parent = posixpath.dirname(resolved)
            layout_name = posixpath.basename(resolved)
            layout_rels = f"{layout_parent}/_rels/{layout_name}.rels"
            if layout_rels in entry_map and layout_rels not in needed:
                needed.add(layout_rels)
                layout_base = layout_parent + '/'
                for lt in _parse_rels_targets(entry_map[layout_rels]):
                    lt_resolved = _resolve_rel_path(layout_base, lt)
                    if lt_resolved in entry_map:
                        needed.add(lt_resolved)


def _collect_layout_deps(layout_path: str, entry_map: dict[str, bytes], needed: set[str]) -> None:
    """Collect slideLayout dependencies (media + slideMaster)."""
    parent = posixpath.dirname(layout_path)
    name = posixpath.basename(layout_path)
    rels_path = f"{parent}/_rels/{name}.rels"
    if rels_path not in entry_map:
        return
    needed.add(rels_path)
    targets = _parse_rels_targets(entry_map[rels_path])
    base_dir = parent + '/'
    for target in targets:
        resolved = _resolve_rel_path(base_dir, target)
        if resolved in entry_map:
            needed.add(resolved)
            if 'slideMasters' in resolved and resolved not in needed:
                _collect_master_deps(resolved, entry_map, needed)
            elif 'slideMasters' in resolved:
                # already added but ensure master deps collected
                _collect_master_deps(resolved, entry_map, needed)


def _collect_slide_deps_by_path(
    slide_path: str, entry_map: dict[str, bytes]
) -> tuple[set[str], str | None, str | None]:
    """Collect minimal ZIP entries for the slide at `slide_path`.

    Traverses only the direct dependency chain:
    slide -> (one) layout -> (one) master -> theme/tags/media.
    The master's OTHER layouts are intentionally pruned so each
    single-page PPTX is minimal. master.xml / master.xml.rels will be
    rewritten at write time to declare only the kept layout.

    Returns: (needed_entries, master_path, layout_path).
    """
    needed: set[str] = set()
    layout_path: str | None = None
    master_path: str | None = None

    if slide_path not in entry_map:
        return needed, None, None
    needed.add(slide_path)

    slide_dir = posixpath.dirname(slide_path)
    slide_name = posixpath.basename(slide_path)
    slide_rels_path = f"{slide_dir}/_rels/{slide_name}.rels"
    if slide_rels_path not in entry_map:
        return needed, None, None
    needed.add(slide_rels_path)

    base_dir = slide_dir + '/'
    for target in _parse_rels_targets(entry_map[slide_rels_path]):
        resolved = _resolve_rel_path(base_dir, target)
        if resolved not in entry_map:
            continue
        needed.add(resolved)

        if 'slideLayouts' in resolved and layout_path is None:
            layout_path = resolved
            l_dir = posixpath.dirname(resolved)
            l_name = posixpath.basename(resolved)
            l_rels = f"{l_dir}/_rels/{l_name}.rels"
            if l_rels in entry_map:
                needed.add(l_rels)
                for lt in _parse_rels_targets(entry_map[l_rels]):
                    lt_res = _resolve_rel_path(l_dir + '/', lt)
                    if lt_res not in entry_map:
                        continue
                    needed.add(lt_res)
                    if 'slideMasters' in lt_res and master_path is None:
                        master_path = lt_res
                        m_dir = posixpath.dirname(lt_res)
                        m_name = posixpath.basename(lt_res)
                        m_rels = f"{m_dir}/_rels/{m_name}.rels"
                        if m_rels in entry_map:
                            # master.xml.rels will be rewritten per-page,
                            # but the entry still needs to be in 'needed'.
                            needed.add(m_rels)
                            for mt in _parse_rels_targets(entry_map[m_rels]):
                                mt_res = _resolve_rel_path(m_dir + '/', mt)
                                if mt_res not in entry_map:
                                    continue
                                # Prune other layouts under the same master.
                                if 'slideLayouts' in mt_res and mt_res != layout_path:
                                    continue
                                needed.add(mt_res)
        elif 'notesSlides' in resolved:
            ns_parent = posixpath.dirname(resolved)
            ns_name = posixpath.basename(resolved)
            ns_rels = f"{ns_parent}/_rels/{ns_name}.rels"
            if ns_rels in entry_map:
                needed.add(ns_rels)
                for ns_target in _parse_rels_targets(entry_map[ns_rels]):
                    ns_resolved = _resolve_rel_path(ns_parent + '/', ns_target)
                    if ns_resolved not in entry_map:
                        continue
                    needed.add(ns_resolved)
                    if 'notesMasters' in ns_resolved:
                        _collect_generic_part_deps(ns_resolved, entry_map, needed)

    return needed, master_path, layout_path


def _get_shared_entries(entry_map: dict[str, bytes]) -> set[str]:
    """Return the set of entries that every single-page PPTX needs.

    Note: theme/*, slideMasters/*, slideLayouts/*, notesMasters/* and
    handoutMasters/* are intentionally NOT placed here. They are collected
    per-page through the slide's dependency chain so each output only ships
    the one master (and its referenced layouts/theme) that the page actually
    uses, keeping file size minimal.
    """
    shared: set[str] = set()
    for name in entry_map:
        if name == '[Content_Types].xml':
            shared.add(name)
        elif name == '_rels/.rels':
            shared.add(name)
        elif name.startswith('docProps/'):
            shared.add(name)
        elif name == 'ppt/presentation.xml':
            shared.add(name)
        elif name == 'ppt/_rels/presentation.xml.rels':
            shared.add(name)
        elif name == 'ppt/tableStyles.xml':
            shared.add(name)
        elif name == 'ppt/presProps.xml':
            shared.add(name)
        elif name == 'ppt/viewProps.xml':
            shared.add(name)
    return shared


def _filter_content_types(content_types_xml: bytes, needed_entries: set[str]) -> bytes:
    """Filter [Content_Types].xml to only keep Override entries for needed parts."""
    try:
        root = ET.fromstring(content_types_xml)
    except ET.ParseError:
        return content_types_xml
    overrides = root.findall(f"{{{PKG_CT_NS}}}Override")
    for override in overrides:
        part_name = override.get('PartName', '').lstrip('/')
        if part_name not in needed_entries:
            root.remove(override)
    ET.register_namespace('', PKG_CT_NS)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def _get_slide_path_from_rels(rid: str, rels_root: ET.Element) -> str | None:
    """Resolve the full ZIP path of the slide for a given rId in presentation.xml.rels."""
    for rel in rels_root:
        if rel.attrib.get('Id') == rid:
            target = rel.attrib.get('Target', '')
            if target:
                return _resolve_rel_path('ppt/', target)
    return None


def _collect_generic_part_deps(part_path: str, entry_map: dict[str, bytes], needed: set[str]) -> None:
    """Collect a part's own .rels and all internal targets it references (one level).

    Used for notesMaster/handoutMaster/extra slideMasters referenced from
    presentation.xml.rels but not reachable through the current slide's
    dependency chain. Ensures the produced single-page PPTX does not contain
    dangling references that would make PowerPoint flag it as corrupted.
    """
    if part_path in needed:
        return
    needed.add(part_path)
    parent = posixpath.dirname(part_path)
    name = posixpath.basename(part_path)
    rels_path = f"{parent}/_rels/{name}.rels"
    if rels_path not in entry_map:
        return
    needed.add(rels_path)
    base_dir = parent + '/'
    for target in _parse_rels_targets(entry_map[rels_path]):
        resolved = _resolve_rel_path(base_dir, target)
        if resolved in entry_map:
            needed.add(resolved)


def _rewrite_master_for_page(
    master_path: str,
    kept_layout_path: str | None,
    entry_map: dict[str, bytes],
    rel_id_attr: str,
) -> tuple[bytes, bytes] | None:
    """Rewrite a slideMaster's xml/rels so it only declares `kept_layout_path`.

    Returns (new_master_xml, new_master_rels_xml) or None on failure.
    """
    master_xml = entry_map.get(master_path)
    master_dir = posixpath.dirname(master_path)
    master_name = posixpath.basename(master_path)
    master_rels_path = f"{master_dir}/_rels/{master_name}.rels"
    master_rels_xml = entry_map.get(master_rels_path)
    if master_xml is None or master_rels_xml is None:
        return None

    try:
        rels_root = ET.fromstring(master_rels_xml)
        master_root = ET.fromstring(master_xml)
    except ET.ParseError:
        return None

    base_dir = master_dir + '/'
    layout_type_suffix = 'slideLayout'
    kept_rid: str | None = None
    new_rels = ET.Element(rels_root.tag, rels_root.attrib)
    for rel in rels_root:
        rtype = rel.attrib.get('Type', '')
        target = rel.attrib.get('Target', '')
        target_mode = rel.attrib.get('TargetMode', 'Internal')
        if target_mode == 'Internal' and layout_type_suffix in rtype and target:
            resolved = _resolve_rel_path(base_dir, target)
            if kept_layout_path is not None and resolved == kept_layout_path:
                kept_rid = rel.attrib.get('Id')
                new_rels.append(copy.deepcopy(rel))
            # else: drop this layout rel
            continue
        new_rels.append(copy.deepcopy(rel))

    # Filter master.xml's sldLayoutIdLst to keep only kept_rid.
    for child in list(master_root):
        if _local_name(child.tag) == 'sldLayoutIdLst':
            for item in list(child):
                rid = item.attrib.get(rel_id_attr)
                if kept_rid is None or rid != kept_rid:
                    child.remove(item)
            if len(list(child)) == 0:
                master_root.remove(child)
            break

    new_master_xml = _serialize_xml_with_ns_preservation(master_root, master_xml)
    new_rels_xml = _serialize_rels_xml(new_rels)
    return new_master_xml, new_rels_xml


def _complete_slide_dependencies(entry_map, needed, slide_path, master_path, layout_path):
    """Follow cached diagrams/charts/media through their complete OPC graph.

    The former one-level collector omitted SmartArt drawing images and chart
    style/workbook parts. Keep those byte-for-byte, while still pruning the
    unrelated layouts and slides of the original deck.
    """
    pending = list(needed - {"ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "_rels/.rels"})
    visited = set()
    while pending:
        part = pending.pop()
        if part in visited or part.endswith(".rels"):
            continue
        visited.add(part)
        parent, name = posixpath.dirname(part), posixpath.basename(part)
        rels_path = f"{parent}/_rels/{name}.rels"
        if rels_path not in entry_map:
            continue
        needed.add(rels_path)
        for relation in ET.fromstring(entry_map[rels_path]):
            if relation.get("TargetMode", "").lower() == "external":
                continue
            target = _resolve_rel_path(parent + "/", relation.get("Target", ""))
            if part == master_path and relation.get("Type", "").endswith("/slideLayout") and target != layout_path:
                continue
            if target.startswith("ppt/slides/") and not target.endswith(".rels") and target != slide_path:
                # A standalone resource must not silently contain another
                # slide's confidential contents via an internal hyperlink.
                raise ValueError("单页包含跳转到其他幻灯片的内部链接，请移除跨页链接后导入")
            if target in entry_map:
                needed.add(target)
                pending.append(target)
    return needed


def split_pptx_to_single_pages(pptx_path: Path, output_dir: Path, progress_callback=None, *, max_total_bytes=None) -> list[Path]:
    """Create one PPTX per referenced slide by pruning presentation slide references.

    Optimized: only writes entries each page actually depends on, uses ZIP_STORED
    for pre-compressed media, and processes pages in parallel.

    Args:
        pptx_path: Path to the source PPTX file.
        output_dir: Directory to write single-page PPTX files into.
        progress_callback: Optional callable(current_page, total_pages) invoked after each page.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    entries = _read_pptx_entries(pptx_path)
    entry_map: dict[str, bytes] = {name: data for name, data in entries}

    presentation_xml = entry_map.get("ppt/presentation.xml")
    rels_xml = entry_map.get("ppt/_rels/presentation.xml.rels")
    if presentation_xml is None or rels_xml is None:
        return []

    presentation_root = ET.fromstring(presentation_xml)
    rels_root = ET.fromstring(rels_xml)
    slide_list = presentation_root.find(f"{{{P_NS}}}sldIdLst")
    if slide_list is None:
        return []
    slide_ids = list(slide_list)
    if not slide_ids:
        return []

    # Pre-compute presentation structure
    pres_attribs = dict(presentation_root.attrib)
    pres_tag = presentation_root.tag
    non_slide_rels: list[ET.Element] = []
    for rel in rels_root:
        if rel.attrib.get("Type") != SLIDE_REL_TYPE:
            non_slide_rels.append(rel)

    rel_id_attr = f"{{{R_NS}}}id"
    total_pages = len(slide_ids)

    # Pre-compute shared entries
    shared_entries = _get_shared_entries(entry_map)
    all_entry_names = set(entry_map.keys())

    # Build page plans: (index, slide_id_elem, needed_entries, kept_rid, master_path, layout_path)
    page_plans: list[tuple[int, ET.Element, set[str], str, str | None, str | None]] = []
    for index, slide_id in enumerate(slide_ids, start=1):
        kept_rid = slide_id.attrib.get(rel_id_attr)
        if not kept_rid:
            continue
        slide_path = _get_slide_path_from_rels(kept_rid, rels_root)
        master_path: str | None = None
        layout_path: str | None = None
        if slide_path is not None and slide_path in entry_map:
            page_deps, master_path, layout_path = _collect_slide_deps_by_path(slide_path, entry_map)
            needed = shared_entries | page_deps
            needed = _complete_slide_dependencies(entry_map, needed, slide_path, master_path, layout_path)
        else:
            raise ValueError(f"第 {index} 页的幻灯片关系无效，不能安全拆分")
        page_plans.append((index, slide_id, needed, kept_rid, master_path, layout_path))

    if max_total_bytes is not None:
        # Preflight before writing hundreds of copies of shared media. ZIP
        # overhead is small but included; this conservative upper bound avoids
        # a tiny uploaded deck amplifying into an unbounded scratch directory.
        estimated = sum(sum(len(entry_map[n]) + 256 for n in plan[2]) for plan in page_plans)
        if estimated > max_total_bytes:
            raise ValueError("拆分后的文件总量过大，请分批导入")

    # Pre-build per-page XML content (must be done in main thread due to ET not being thread-safe)
    # We'll build all presentation.xml and rels.xml variants upfront
    # Tuple: (pres_xml, rels_xml, ct_xml, master_overrides)
    # master_overrides: dict[str, bytes] mapping entry path -> rewritten bytes
    page_xmls: list[tuple[bytes, bytes, bytes, dict[str, bytes]]] = []
    for index, slide_id, needed, kept_rid, master_path, layout_path in page_plans:
        # Build minimal rels: drop master-family relationships whose target is
        # not actually used by this page, so the output only carries this
        # page's own slideMaster (and optionally notesMaster/handoutMaster).
        new_rels = ET.Element(rels_root.tag, rels_root.attrib)
        kept_rel_ids: set[str] = set()
        for rel in non_slide_rels:
            rel_type = rel.attrib.get("Type", "")
            target = rel.attrib.get("Target", "")
            target_mode = rel.attrib.get("TargetMode", "Internal")
            if target_mode == "Internal" and target and (
                "slideMaster" in rel_type
                or "notesMaster" in rel_type
                or "handoutMaster" in rel_type
            ):
                resolved = _resolve_rel_path("ppt/", target)
                if resolved not in needed:
                    continue  # 该 master 不是当前页用到的，剔除
            new_rels.append(copy.deepcopy(rel))
            rid = rel.attrib.get("Id")
            if rid:
                kept_rel_ids.add(rid)
        for rel in rels_root:
            if rel.attrib.get("Type") == SLIDE_REL_TYPE and rel.attrib.get("Id") == kept_rid:
                new_rels.append(copy.deepcopy(rel))
                kept_rel_ids.add(kept_rid)
                break
        new_rels_bytes = _serialize_rels_xml(new_rels)

        # Build minimal presentation.xml: keep only the slideId for this page,
        # and prune master-id lists so they stay in sync with the rels above.
        new_pres = ET.Element(pres_tag, pres_attribs)
        for child in presentation_root:
            local = _local_name(child.tag)
            if local == 'sldIdLst':
                new_sld_list = ET.SubElement(new_pres, child.tag, child.attrib)
                new_sld_list.append(copy.deepcopy(slide_id))
            elif local in ('sldMasterIdLst', 'notesMasterIdLst', 'handoutMasterIdLst'):
                filtered_items = [
                    item for item in child
                    if item.attrib.get(rel_id_attr) in kept_rel_ids
                ]
                if filtered_items:
                    new_list = ET.SubElement(new_pres, child.tag, child.attrib)
                    for item in filtered_items:
                        new_list.append(copy.deepcopy(item))
                # 若过滤后为空（如本页无 notesMaster），整个列表节点省略
            else:
                new_pres.append(copy.deepcopy(child))
        new_presentation_bytes = _serialize_xml_with_ns_preservation(new_pres, presentation_xml)

        # Filter [Content_Types].xml
        ct_xml = entry_map.get('[Content_Types].xml', b'')
        filtered_ct = _filter_content_types(ct_xml, needed) if ct_xml else b''

        # Rewrite the master so it only declares the layout this page uses.
        master_overrides: dict[str, bytes] = {}
        if master_path is not None and master_path in needed:
            rewritten = _rewrite_master_for_page(master_path, layout_path, entry_map, rel_id_attr)
            if rewritten is not None:
                new_master_xml, new_master_rels_xml = rewritten
                master_overrides[master_path] = new_master_xml
                master_dir = posixpath.dirname(master_path)
                master_name = posixpath.basename(master_path)
                master_rels_path = f"{master_dir}/_rels/{master_name}.rels"
                master_overrides[master_rels_path] = new_master_rels_xml

        page_xmls.append((new_presentation_bytes, new_rels_bytes, filtered_ct, master_overrides))

    # Writer function for a single page
    def write_single_page(plan_index: int) -> tuple[int, Path]:
        index, slide_id, needed, kept_rid, _mp, _lp = page_plans[plan_index]
        pres_bytes, rels_bytes, ct_bytes, master_overrides = page_xmls[plan_index]

        output_path = output_dir / f"page_{index:02d}.pptx"
        with zipfile.ZipFile(output_path, 'w') as zf:
            for name in sorted(needed):
                if name == 'ppt/presentation.xml':
                    data = pres_bytes
                elif name == 'ppt/_rels/presentation.xml.rels':
                    data = rels_bytes
                elif name == '[Content_Types].xml':
                    data = ct_bytes
                elif name in master_overrides:
                    data = master_overrides[name]
                else:
                    data = entry_map[name]

                ext = Path(name).suffix.lower()
                compress_type = zipfile.ZIP_STORED if ext in _PRECOMPRESSED_EXTS else zipfile.ZIP_DEFLATED
                zf.writestr(zipfile.ZipInfo(name), data, compress_type=compress_type)

        return index, output_path

    # Parallel write
    outputs: list[Path | None] = [None] * len(page_plans)
    completed_count = 0
    progress_lock = threading.Lock()

    max_workers = min(4, len(page_plans))
    if max_workers <= 1:
        # Sequential for single page
        for pi in range(len(page_plans)):
            idx, path = write_single_page(pi)
            outputs[pi] = path
            completed_count += 1
            if progress_callback is not None:
                progress_callback(completed_count, total_pages)
    else:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(write_single_page, pi): pi
                for pi in range(len(page_plans))
            }
            for future in as_completed(futures):
                pi = futures[future]
                idx, path = future.result()
                outputs[pi] = path
                with progress_lock:
                    completed_count += 1
                    if progress_callback is not None:
                        progress_callback(completed_count, total_pages)

    return [p for p in outputs if p is not None]


__all__ = ['split_pptx_to_single_pages']
