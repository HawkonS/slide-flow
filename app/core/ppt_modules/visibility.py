"""Preserve per-source hidden-slide flags during PPTX merging."""

from __future__ import annotations

import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from .inspect import slide_count
from .package import _get_slide_paths_from_presentation


def _set_slide_hidden(slide_xml: bytes) -> bytes:
    """Set show='0' on the root <p:sld> element using byte-level injection.

    Avoids XML round-tripping through ElementTree which would lose namespace
    declarations and rename prefixes (e.g. 'mc:' -> 'ns0:'), causing Office to
    report corrupt content.
    """
    # Use regex to inject/overwrite show="0" without parsing/re-serializing the whole XML.
    # Step 1: remove any existing show= attribute from the root <p:sld ...> tag.
    new_xml = re.sub(
        rb'(<p:sld(?=[ >/])[^>]*?) show=["\'][^"\'>]*["\']',
        rb'\1',
        slide_xml,
        count=1,
    )
    # Step 2: inject show="0" right after "<p:sld" (before the next char which is space or >).
    result = re.sub(
        rb'(<p:sld)([ />])',
        rb'\1 show="0"\2',
        new_xml,
        count=1,
    )
    if result != new_xml:
        return result
    # Fallback: XML round-trip (for edge cases where regex didn't match)
    root = ET.fromstring(slide_xml)
    root.set("show", "0")
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


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
