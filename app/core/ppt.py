from __future__ import annotations

import copy
import hashlib
import logging
import posixpath
import re
import shutil
import struct
import threading
import zipfile
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET

from PIL import Image, ImageDraw, ImageFont


A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
PKG_CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
SLIDE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
SLIDE_MASTER_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster"
SLIDE_LAYOUT_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
THEME_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"
IMAGE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"

ET.register_namespace("a", A_NS)
ET.register_namespace("p", P_NS)
ET.register_namespace("r", R_NS)


def _local_name(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[1]
    return tag


def _clean_font_name(name: str) -> str | None:
    value = name.strip()
    if not value or value.startswith("+"):
        return None
    return value


def detect_ppt_fonts(pptx_path: Path) -> list[str]:
    """Detect fonts explicitly used by real text runs, excluding bullet fonts."""
    fonts: set[str] = set()
    if pptx_path.suffix.lower() != ".pptx":
        return []

    slide_name_re = re.compile(r"^ppt/slides/slide\d+\.xml$")
    with zipfile.ZipFile(pptx_path) as package:
        for name in package.namelist():
            if not slide_name_re.match(name):
                continue
            try:
                root = ET.fromstring(package.read(name))
            except ET.ParseError:
                continue

            for run_tag in (f"{{{A_NS}}}r", f"{{{A_NS}}}fld"):
                for run in root.iter(run_tag):
                    run_props = run.find(f"{{{A_NS}}}rPr")
                    if run_props is None:
                        continue
                    for child in list(run_props):
                        # Bullet fonts live under paragraph properties as buFont;
                        # by looking only under text run properties they are ignored.
                        if _local_name(child.tag) not in {"latin", "ea", "cs", "sym"}:
                            continue
                        typeface = child.attrib.get("typeface")
                        if typeface:
                            cleaned = _clean_font_name(typeface)
                            if cleaned:
                                fonts.add(cleaned)
    return sorted(fonts, key=str.lower)


def slide_count(pptx_path: Path) -> int:
    if pptx_path.suffix.lower() != ".pptx":
        return 0
    try:
        with zipfile.ZipFile(pptx_path) as package:
            try:
                root = ET.fromstring(package.read("ppt/presentation.xml"))
            except Exception:
                return 0
    except zipfile.BadZipFile:
        entries = _scan_zip_entries(pptx_path.read_bytes())
        presentation = next((data for name, data in entries if name == "ppt/presentation.xml"), None)
        if presentation is None:
            return 0
        try:
            root = ET.fromstring(presentation)
        except ET.ParseError:
            return 0
    slide_list = root.find(f"{{{P_NS}}}sldIdLst")
    if slide_list is None:
        return 0
    return len(list(slide_list))


def _read_pptx_entries(pptx_path: Path) -> list[tuple[str, bytes]]:
    """Read all zip entries as (name, uncompressed_bytes).

    Falls back to scanning local file headers when the central directory is
    inconsistent with local headers (seen in some malformed PPTX files).
    """
    try:
        entries: list[tuple[str, bytes]] = []
        with zipfile.ZipFile(pptx_path) as package:
            for info in package.infolist():
                entries.append((info.filename, package.read(info.filename)))
        return entries
    except zipfile.BadZipFile:
        return _scan_zip_entries(pptx_path.read_bytes())


def _scan_zip_entries(data: bytes) -> list[tuple[str, bytes]]:
    """Scan a zip by walking local file headers, ignoring the central directory.

    Returns a list of (filename, uncompressed_bytes). Directory entries (names
    ending with "/") are skipped. Used as a fallback when the central directory
    references are inconsistent with the actual local file headers.
    """
    LFH_SIG = b"PK\x03\x04"
    CD_SIG = b"PK\x01\x02"
    DD_SIG = b"PK\x07\x08"

    entries: list[tuple[str, bytes]] = []
    offset = 0
    total = len(data)

    while offset + 4 <= total:
        sig = data[offset:offset + 4]
        if sig == CD_SIG:
            break
        if sig != LFH_SIG:
            idx = data.find(LFH_SIG, offset + 1)
            if idx < 0:
                break
            offset = idx
            continue
        if offset + 30 > total:
            break

        (_ver, flags, method, _mtime, _mdate, _crc,
         csize, _usize, fnlen, extralen) = struct.unpack(
            "<HHHHHIIIHH", data[offset + 4:offset + 30]
        )
        name_start = offset + 30
        name_end = name_start + fnlen
        extra_end = name_end + extralen
        if extra_end > total:
            break
        try:
            name = data[name_start:name_end].decode("utf-8")
        except UnicodeDecodeError:
            name = data[name_start:name_end].decode("cp437", "replace")
        data_start = extra_end

        if flags & 0x08:
            # Data descriptor: compressed size is not reliable in the header.
            dd_idx = data.find(DD_SIG, data_start)
            if dd_idx < 0:
                break
            compressed = data[data_start:dd_idx]
            next_offset = dd_idx + 16  # sig(4) + crc(4) + csize(4) + usize(4)
        else:
            compressed = data[data_start:data_start + csize]
            next_offset = data_start + csize

        try:
            if method == 0:
                content = compressed
            elif method == 8:
                content = zlib.decompress(compressed, -15)
            else:
                offset = next_offset
                continue
        except zlib.error:
            offset = next_offset
            continue

        if not name.endswith("/"):
            entries.append((name, content))
        offset = next_offset

    return entries


# ---------------------------------------------------------------------------
# PPT split: dependency collection helpers
# ---------------------------------------------------------------------------

_PRECOMPRESSED_EXTS = frozenset({
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff',
    '.mp4', '.m4v', '.mp3', '.wmv', '.wma', '.avi', '.mov',
    '.emf', '.wmf',
})

_logger = logging.getLogger(__name__)


def _resolve_rel_path(base_dir: str, target: str) -> str:
    """Resolve a relative target path against a base directory inside the ZIP.

    Example: base_dir='ppt/slides/', target='../media/image1.png' -> 'ppt/media/image1.png'
    """
    if target.startswith('/'):
        return target.lstrip('/')
    combined = PurePosixPath(base_dir) / target
    parts: list[str] = []
    for part in combined.parts:
        if part == '..':
            if parts:
                parts.pop()
        elif part != '.':
            parts.append(part)
    return '/'.join(parts)


def _parse_rels_targets(rels_data: bytes) -> list[str]:
    """Parse a .rels XML and return all internal Target values."""
    if not rels_data:
        return []
    try:
        root = ET.fromstring(rels_data)
    except ET.ParseError:
        return []
    targets: list[str] = []
    for rel in root:
        if rel.attrib.get('TargetMode', 'Internal') == 'External':
            continue
        target = rel.attrib.get('Target', '')
        if target:
            targets.append(target)
    return targets


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

    new_master_xml = ET.tostring(master_root, encoding='utf-8', xml_declaration=True)
    new_rels_xml = ET.tostring(new_rels, encoding='utf-8', xml_declaration=True)
    return new_master_xml, new_rels_xml


def split_pptx_to_single_pages(pptx_path: Path, output_dir: Path, progress_callback=None) -> list[Path]:
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
            try:
                page_deps, master_path, layout_path = _collect_slide_deps_by_path(slide_path, entry_map)
                needed = shared_entries | page_deps
            except Exception:
                # Fallback: include all entries
                _logger.warning("Fallback to full entries for page %d", index)
                needed = all_entry_names
                master_path = None
                layout_path = None
        else:
            # Cannot determine slide path, fallback
            needed = all_entry_names
        page_plans.append((index, slide_id, needed, kept_rid, master_path, layout_path))

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
        new_rels_bytes = ET.tostring(new_rels, encoding="utf-8", xml_declaration=True)

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
        new_presentation_bytes = ET.tostring(new_pres, encoding="utf-8", xml_declaration=True)

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


# ---------------------------------------------------------------------------
# PPTX merging
# ---------------------------------------------------------------------------


def _rels_path_for(part: str) -> str:
    """Return the rels file path for a given part name."""
    parent = posixpath.dirname(part)
    name = posixpath.basename(part)
    rels_name = f"{name}.rels"
    return f"{parent}/_rels/{rels_name}" if parent else f"_rels/{rels_name}"


def _resolve_target(source_part: str, target: str) -> str:
    """Resolve a (possibly relative) relationship target to a zip-internal path."""
    if target.startswith("/"):
        return target.lstrip("/")
    source_dir = posixpath.dirname(source_part)
    return posixpath.normpath(posixpath.join(source_dir, target))


def _make_relative(source_part: str, target_part: str) -> str:
    source_dir = posixpath.dirname(source_part)
    return posixpath.relpath(target_part, source_dir or ".")


def _suffix_part_name(part: str, tag: str) -> str:
    """Insert a uniqueness tag before the file extension, e.g. slide1.xml -> slide1_src2.xml."""
    parent = posixpath.dirname(part)
    name = posixpath.basename(part)
    if "." in name:
        stem, ext = name.rsplit(".", 1)
        new_name = f"{stem}_{tag}.{ext}"
    else:
        new_name = f"{name}_{tag}"
    return f"{parent}/{new_name}" if parent else new_name


def _read_rels_root(files: dict[str, bytes], part: str) -> ET.Element | None:
    """Parse the .rels file for a given part. Returns None if missing or invalid."""
    data = files.get(_rels_path_for(part))
    if not data:
        return None
    try:
        return ET.fromstring(data)
    except ET.ParseError:
        return None


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
    merged_files[master_part] = ET.tostring(master_root, encoding="utf-8", xml_declaration=True)


def _serialize_pres_xml(root: ET.Element) -> bytes:
    ET.register_namespace("a", A_NS)
    ET.register_namespace("p", P_NS)
    ET.register_namespace("r", R_NS)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _serialize_rels_xml(root: ET.Element) -> bytes:
    ET.register_namespace("", PKG_REL_NS)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _serialize_ct_xml(root: ET.Element) -> bytes:
    ET.register_namespace("", PKG_CT_NS)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _set_slide_hidden(slide_xml: bytes) -> bytes:
    """Parse a slide XML and set show='0' on the root <p:sld> element."""
    root = ET.fromstring(slide_xml)
    root.set("show", "0")
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def _get_slide_paths_from_presentation(pres_xml: bytes, rels_xml: bytes) -> list[str]:
    """Parse presentation.xml and its rels to get ordered list of slide file paths."""
    pres_root = ET.fromstring(pres_xml)
    rels_root = ET.fromstring(rels_xml)

    slide_list = pres_root.find(f"{{{P_NS}}}sldIdLst")
    if slide_list is None:
        return []

    # Build rId -> target path mapping from rels
    rid_to_path: dict[str, str] = {}
    for rel in rels_root:
        rid = rel.attrib.get("Id")
        rtype = rel.attrib.get("Type", "")
        target = rel.attrib.get("Target", "")
        target_mode = rel.attrib.get("TargetMode", "Internal")
        if rid and rtype == SLIDE_REL_TYPE and target_mode != "External":
            rid_to_path[rid] = _resolve_rel_path("ppt/", target)

    # Get ordered slide paths following sldIdLst order
    rel_id_attr = f"{{{R_NS}}}id"
    slide_paths: list[str] = []
    for sld_id in slide_list:
        rid = sld_id.attrib.get(rel_id_attr)
        if rid and rid in rid_to_path:
            slide_paths.append(rid_to_path[rid])

    return slide_paths


def _apply_hidden_to_single_pptx(src_path: Path, output_path: Path) -> None:
    """Copy a single PPTX but set show='0' on all slides' root <p:sld> elements."""
    with zipfile.ZipFile(src_path) as zf_in:
        # Determine which files are slides
        pres_xml = zf_in.read("ppt/presentation.xml")
        rels_xml = zf_in.read("ppt/_rels/presentation.xml.rels")
        slide_paths = set(_get_slide_paths_from_presentation(pres_xml, rels_xml))

        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf_out:
            for info in zf_in.infolist():
                if info.is_dir():
                    continue
                data = zf_in.read(info.filename)
                if info.filename in slide_paths:
                    data = _set_slide_hidden(data)
                zf_out.writestr(info.filename, data)


def _apply_hidden_flags_to_merged(
    merged_files: dict[str, bytes],
    source_paths: list[Path],
    hidden_flags: list[bool],
) -> None:
    """Post-process merged PPTX to set show='0' on <p:sld> root elements for hidden slides.

    Each source PPTX contributes N slides (determined by its own sldIdLst).
    The merged sldIdLst preserves the same order: all slides from source 0,
    then all from source 1, etc.
    """
    # Determine how many slides each source contributed
    slide_counts: list[int] = []
    for p in source_paths:
        slide_counts.append(slide_count(p))

    # Get ordered slide file paths from the merged presentation
    pres_xml = merged_files.get("ppt/presentation.xml")
    rels_xml = merged_files.get("ppt/_rels/presentation.xml.rels")
    if not pres_xml or not rels_xml:
        return

    slide_paths = _get_slide_paths_from_presentation(pres_xml, rels_xml)

    # Determine which slides need to be hidden and modify their XML
    offset = 0
    for file_idx, count in enumerate(slide_counts):
        if file_idx < len(hidden_flags) and hidden_flags[file_idx]:
            for i in range(offset, offset + count):
                if i < len(slide_paths):
                    slide_path = slide_paths[i]
                    if slide_path in merged_files:
                        merged_files[slide_path] = _set_slide_hidden(merged_files[slide_path])
        offset += count


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
            merged_files[info.filename] = zf.read(info.filename)

    if "ppt/presentation.xml" not in merged_files or "ppt/_rels/presentation.xml.rels" not in merged_files:
        raise ValueError(f"{paths[0]} is not a valid PPTX package")

    presentation_root = ET.fromstring(merged_files["ppt/presentation.xml"])
    pres_rels_root = ET.fromstring(merged_files["ppt/_rels/presentation.xml.rels"])
    content_types_root = ET.fromstring(merged_files.get("[Content_Types].xml", b"<Types/>"))

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
        )

    merged_files["ppt/presentation.xml"] = _serialize_pres_xml(presentation_root)
    merged_files["ppt/_rels/presentation.xml.rels"] = _serialize_rels_xml(pres_rels_root)
    merged_files["[Content_Types].xml"] = _serialize_ct_xml(content_types_root)

    # Apply hidden slide flags if provided
    if hidden_flags:
        _apply_hidden_flags_to_merged(merged_files, paths, hidden_flags)

    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as out:
        for name, data in merged_files.items():
            out.writestr(name, data)


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
) -> None:
    src_files: dict[str, bytes] = {}
    with zipfile.ZipFile(src_path) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            src_files[info.filename] = zf.read(info.filename)

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
            # Check if this dep should redirect to a shared master/layout part
            redirect = layout_redirect.get(dep) or master_redirect.get(dep)
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


# ---------------------------------------------------------------------------
# Build a PPTX from a list of images (one image per slide)
# ---------------------------------------------------------------------------

# 16:9 宽屏主流幻灯片尺寸（13.333" x 7.5"，单位 EMU）
_IMG_SLIDE_W_EMU = 12192000
_IMG_SLIDE_H_EMU = 6858000

_IMG_EXT_TO_CT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}

_IMG_PPTX_ROOT_RELS = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>"""

_IMG_PPTX_THEME = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">
<a:themeElements>
<a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2>
<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1>
<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
<a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
<a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink>
<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="Office">
<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="Office">
<a:fillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:fillStyleLst>
<a:lnStyleLst>
<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
</a:lnStyleLst>
<a:effectStyleLst>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
</a:effectStyleLst>
<a:bgFillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>"""

_IMG_PPTX_MASTER = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld>
<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree>
</p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>"""

_IMG_PPTX_MASTER_RELS = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>"""

_IMG_PPTX_LAYOUT = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="\xe7\xa9\xba\xe7\x99\xbd">
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>"""

_IMG_PPTX_LAYOUT_RELS = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>"""


def _build_image_slide_xml() -> bytes:
    """生成幻灯片 XML：不插入图片，改为在幻灯片背景中以图片填充全页。"""
    return (
        b"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
        b"<p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\""
        b" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\""
        b" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">"
        b"<p:cSld>"
        b"<p:bg><p:bgPr>"
        b"<a:blipFill dpi=\"0\" rotWithShape=\"1\">"
        b"<a:blip r:embed=\"rId2\"/>"
        b"<a:srcRect/>"
        b"<a:stretch><a:fillRect/></a:stretch>"
        b"</a:blipFill>"
        b"<a:effectLst/>"
        b"</p:bgPr></p:bg>"
        b"<p:spTree>"
        b"<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>"
        b"<p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/>"
        b"<a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>"
        b"</p:spTree></p:cSld>"
        b"<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>"
        b"</p:sld>"
    )


def _build_image_slide_rels(image_target: str) -> bytes:
    return (
        b"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
        b"<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
        b"<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>"
        + f"<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"{image_target}\"/>".encode("utf-8")
        + b"</Relationships>"
    )


def _read_image_size(path: Path) -> tuple[int, int]:
    """读取图片像素尺寸，失败时返回 16:9 占位尺寸。保留为其他调用点备用。"""
    try:
        from PIL import Image as _PILImage  # 延迟导入，避免循环依赖
        with _PILImage.open(path) as img:
            return int(img.width), int(img.height)
    except Exception:
        return 1600, 900


def build_image_pptx(image_paths: list[Path], output_path: Path) -> None:
    """以一组图片构建一个纯图 PPTX，每张图作为一页。

    每页以“图片填充”的形式将图片作为幻灯片背景填满全页，不插入独立的图片对象；
    幻灯片尺寸采用 16:9 宽屏，母版为纯白背景。
    仅依赖 zipfile 与字符串，不引入 python-pptx 等额外依赖。
    """
    if not image_paths:
        raise ValueError("image_paths must not be empty")
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    paths = [Path(p) for p in image_paths]

    files: dict[str, bytes] = {}
    files["_rels/.rels"] = _IMG_PPTX_ROOT_RELS
    files["ppt/theme/theme1.xml"] = _IMG_PPTX_THEME
    files["ppt/slideMasters/slideMaster1.xml"] = _IMG_PPTX_MASTER
    files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = _IMG_PPTX_MASTER_RELS
    files["ppt/slideLayouts/slideLayout1.xml"] = _IMG_PPTX_LAYOUT
    files["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = _IMG_PPTX_LAYOUT_RELS

    slide_id_lst: list[str] = []
    pres_rels: list[str] = []
    ct_overrides: list[str] = []
    used_exts: set[str] = set()

    pres_rels.append(
        '<Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
    )
    pres_rels.append(
        '<Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>'
    )

    slide_w = _IMG_SLIDE_W_EMU
    slide_h = _IMG_SLIDE_H_EMU

    for index, img_path in enumerate(paths, start=1):
        ext = img_path.suffix.lower() or ".png"
        if ext not in _IMG_EXT_TO_CT:
            ext = ".png"
        used_exts.add(ext)
        media_name = f"image{index}{ext}"
        try:
            img_bytes = img_path.read_bytes()
        except OSError as exc:
            raise ValueError(f"无法读取图片: {img_path}") from exc
        files[f"ppt/media/{media_name}"] = img_bytes

        slide_xml = _build_image_slide_xml()
        slide_rels_xml = _build_image_slide_rels(f"../media/{media_name}")
        files[f"ppt/slides/slide{index}.xml"] = slide_xml
        files[f"ppt/slides/_rels/slide{index}.xml.rels"] = slide_rels_xml

        slide_rid = f"rIdSlide{index}"
        slide_id_lst.append(
            f'<p:sldId id="{255 + index + 1}" r:id="{slide_rid}"/>'
        )
        pres_rels.append(
            f'<Relationship Id="{slide_rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{index}.xml"/>'
        )
        ct_overrides.append(
            f'<Override PartName="/ppt/slides/slide{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        )

    presentation_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
        ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">'
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster1"/></p:sldMasterIdLst>'
        f'<p:sldIdLst>{"".join(slide_id_lst)}</p:sldIdLst>'
        f'<p:sldSz cx="{slide_w}" cy="{slide_h}"/>'
        '<p:notesSz cx="6858000" cy="9144000"/>'
        '</p:presentation>'
    ).encode("utf-8")
    files["ppt/presentation.xml"] = presentation_xml

    pres_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(pres_rels)
        + '</Relationships>'
    ).encode("utf-8")
    files["ppt/_rels/presentation.xml.rels"] = pres_rels_xml

    default_exts = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
                    '<Default Extension="xml" ContentType="application/xml"/>']
    for ext in sorted(used_exts):
        ct = _IMG_EXT_TO_CT.get(ext)
        if not ct:
            continue
        default_exts.append(f'<Default Extension="{ext.lstrip(".")}" ContentType="{ct}"/>')

    content_types_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + "".join(default_exts)
        + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
        + "".join(ct_overrides)
        + '</Types>'
    ).encode("utf-8")
    files["[Content_Types].xml"] = content_types_xml

    with zipfile.ZipFile(output_path, "w") as zf:
        for name, data in files.items():
            ext = Path(name).suffix.lower()
            compress_type = zipfile.ZIP_STORED if ext in _PRECOMPRESSED_EXTS else zipfile.ZIP_DEFLATED
            zf.writestr(zipfile.ZipInfo(name), data, compress_type=compress_type)


# ---------------------------------------------------------------------------
# 水印工具函数
# ---------------------------------------------------------------------------


def add_watermark_to_image(img: Image.Image, text: str) -> Image.Image:
    """在图片上叠加平铺的半透明斜向水印文字，返回新的 RGBA 图片。"""
    if not text:
        return img
    base = img.convert("RGBA")
    w, h = base.size

    # 根据图片尺寸选择合适字号（略大以确保可读）
    font_size = max(22, min(w, h) // 20)
    font = _get_cjk_font(font_size)

    # 计算单行文字尺寸
    tmp_draw = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    bbox = tmp_draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]

    # 创建足够大的单层画布（旋转后会裁剪，因此需要更大）
    diagonal = int((w**2 + h**2) ** 0.5) + text_w * 2
    tile = Image.new("RGBA", (diagonal * 2, diagonal * 2), (0, 0, 0, 0))
    draw = ImageDraw.Draw(tile)

    # 间距：加大间距以降低密度
    gap_x = text_w + 200
    gap_y = text_h + 260

    y = 0
    while y < diagonal * 2:
        x = 0
        while x < diagonal * 2:
            draw.text((x, y), text, font=font, fill=(140, 140, 140, 120))
            x += gap_x
        y += gap_y

    # 旋转 -30 度并裁剪到原图尺寸
    rotated = tile.rotate(-30, expand=False, resample=Image.BICUBIC)
    # 取中心区域
    cx, cy = rotated.size[0] // 2, rotated.size[1] // 2
    crop_box = (cx - w // 2, cy - h // 2, cx + w // 2, cy + h // 2)
    watermark_layer = rotated.crop(crop_box)

    return Image.alpha_composite(base, watermark_layer)


# 常见 CJK 字体路径（Linux 服务器常见安装位置）
_CJK_FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
    "arial.ttf",
    "msyh.ttf",
]


def _get_cjk_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """尝试加载支持 CJK 字符的字体，逐级回退。"""
    for path in _CJK_FONT_PATHS:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _watermark_shape_xml(
    shape_id: int,
    text: str,
    box_x: int,
    box_y: int,
    box_w: int,
    box_h: int,
    font_size: int = 3200,
) -> str:
    """生成一个文本框 shape 的 XML 片段，用于 PPTX 水印。"""
    # 旋转 -30 度（单位: 1/60000 度）
    rotation = -30 * 60000
    escaped_text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return (
        f'<p:sp>'
        f'<p:nvSpPr>'
        f'<p:cNvPr id="{shape_id}" name="Watermark {shape_id}"/>'
        f'<p:cNvSpPr txBox="1"/>'
        f'<p:nvPr/>'
        f'</p:nvSpPr>'
        f'<p:spPr>'
        f'<a:xfrm rot="{rotation}">'
        f'<a:off x="{box_x}" y="{box_y}"/>'
        f'<a:ext cx="{box_w}" cy="{box_h}"/>'
        f'</a:xfrm>'
        f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
        f'<a:noFill/>'
        f'<a:ln><a:noFill/></a:ln>'
        f'</p:spPr>'
        f'<p:txBody>'
        f'<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr" anchorCtr="1"/>'
        f'<a:lstStyle/>'
        f'<a:p><a:pPr algn="ctr"/>'
        f'<a:r>'
        f'<a:rPr lang="zh-CN" sz="{font_size}" b="0" i="0" u="none" strike="noStrike" dirty="0">'
        f'<a:solidFill><a:srgbClr val="909090"><a:alpha val="60000"/></a:srgbClr></a:solidFill>'
        f'<a:latin typeface="Microsoft YaHei"/>'
        f'<a:ea typeface="Microsoft YaHei"/>'
        f'</a:rPr>'
        f'<a:t>{escaped_text}</a:t>'
        f'</a:r>'
        f'</a:p>'
        f'</p:txBody>'
        f'</p:sp>'
    )


def add_watermark_to_pptx(pptx_path: Path, text: str) -> None:
    """就地修改 PPTX 文件，在每个 slide 上叠加半透明水印文本框（2×2 平铺）。"""
    if not text:
        return

    A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
    P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"

    # 读取所有文件
    with zipfile.ZipFile(pptx_path, "r") as zf:
        all_files = {name: zf.read(name) for name in zf.namelist()}

    # 找出所有 slide XML 文件（排除 rels、_rels 目录）
    slide_pattern = re.compile(r"^ppt/slides/slide\d+\.xml$")
    slide_names = sorted(
        [n for n in all_files if slide_pattern.match(n)],
        key=lambda n: int(re.search(r"slide(\d+)", n).group(1)),  # type: ignore
    )

    # 读取 presentation.xml 获取幻灯片尺寸
    pres_xml = ET.fromstring(all_files["ppt/presentation.xml"])
    sld_sz = pres_xml.find(f"{{{P_NS}}}sldSz")
    slide_w = int(sld_sz.get("cx", "12192000")) if sld_sz is not None else 12192000
    slide_h = int(sld_sz.get("cy", "6858000")) if sld_sz is not None else 6858000

    # 2×2 平铺水印布局参数
    wm_w = int(slide_w * 0.50)
    wm_h = int(slide_h * 0.14)
    positions = [
        (int(slide_w * 0.08), int(slide_h * 0.18)),
        (int(slide_w * 0.48), int(slide_h * 0.28)),
        (int(slide_w * 0.12), int(slide_h * 0.60)),
        (int(slide_w * 0.50), int(slide_h * 0.70)),
    ]

    for slide_name in slide_names:
        root = ET.fromstring(all_files[slide_name])
        # 找到 spTree
        sp_tree = root.find(f".//{{{P_NS}}}spTree")
        if sp_tree is None:
            continue

        # 找到当前最大 id
        max_id = 1
        for cNvPr in sp_tree.iter(f"{{{P_NS}}}cNvPr"):
            try:
                max_id = max(max_id, int(cNvPr.get("id", "1")))
            except ValueError:
                pass
        # 也检查 drawingml 命名空间
        for cNvPr in sp_tree.iter(f"{{{A_NS}}}cNvPr"):
            try:
                max_id = max(max_id, int(cNvPr.get("id", "1")))
            except ValueError:
                pass

        # 在 4 个位置各添加一个水印 shape
        for i, (bx, by) in enumerate(positions):
            wm_xml = _watermark_shape_xml(
                max_id + 100 + i, text, bx, by, wm_w, wm_h, font_size=3200,
            )
            wm_elem = ET.fromstring(wm_xml)
            sp_tree.append(wm_elem)

        # 序列化回 bytes
        all_files[slide_name] = ET.tostring(root, xml_declaration=True, encoding="UTF-8")

    # 写回 zip
    tmp_path = pptx_path.with_suffix(".tmp")
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in all_files.items():
            zf.writestr(name, data)
    tmp_path.replace(pptx_path)

