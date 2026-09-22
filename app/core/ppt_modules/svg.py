"""Shared SVG image-reference repairs for merge and watermark operations."""

from __future__ import annotations

import logging
import re


_logger = logging.getLogger(__name__)


# Repair targets: only XML parts that may contain <a:blip> elements.
_BLIP_REPAIR_DIRS = (
    "ppt/slides/",
    "ppt/slideLayouts/",
    "ppt/slideMasters/",
    "ppt/notesSlides/",
    "ppt/notesMasters/",
)


# Pre-compiled regex for repairing <a:blip> elements that are missing the
# primary r:embed/r:link attribute. PowerPoint's "Save As" can strip the
# PNG fallback rel of an SVG image but leave the outer <a:blip> open-tag
# without any primary reference, only the nested <asvg:svgBlip r:embed>.
# Office 365 then rejects the package as corrupt.
_BLIP_OPEN_RE = re.compile(rb"<a:blip\b([^>]*?)(?<!/)>")


_BLIP_HAS_PRIMARY_RE = re.compile(rb"\br:(embed|link)\s*=")


_SVG_BLIP_EMBED_RE = re.compile(rb'<asvg:svgBlip\b[^>]*?\br:embed\s*=\s*"([^"]+)"')


def _repair_blip_in_xml(xml_bytes: bytes) -> tuple[bytes, int]:
    """Repair <a:blip> elements lacking the primary r:embed/r:link attribute.

    Strategy: when an <a:blip> open-tag has no r:embed/r:link but its body
    contains a nested <asvg:svgBlip r:embed="rIdX"/>, promote that rIdX as
    the outer <a:blip>'s r:embed so OOXML schema validation passes.

    Returns (possibly-modified bytes, number of repairs applied).
    Self-closed forms <a:blip .../> are skipped (they already have or
    intentionally omit attributes in the open-tag).
    """
    if b"<a:blip" not in xml_bytes or b"svgBlip" not in xml_bytes:
        return xml_bytes, 0

    out: list[bytes] = []
    cursor = 0
    fixed = 0
    close_tag = b"</a:blip>"
    while True:
        m = _BLIP_OPEN_RE.search(xml_bytes, cursor)
        if not m:
            out.append(xml_bytes[cursor:])
            break
        attrs = m.group(1)
        close_idx = xml_bytes.find(close_tag, m.end())
        if close_idx < 0:
            out.append(xml_bytes[cursor:])
            break
        # Append everything up to and including this <a:blip> element
        out.append(xml_bytes[cursor:m.start()])
        body = xml_bytes[m.end():close_idx]
        if _BLIP_HAS_PRIMARY_RE.search(attrs):
            out.append(xml_bytes[m.start():close_idx + len(close_tag)])
        else:
            svg_m = _SVG_BLIP_EMBED_RE.search(body)
            if svg_m:
                svg_rid = svg_m.group(1)
                out.append(b'<a:blip r:embed="' + svg_rid + b'"' + attrs + b">" + body + close_tag)
                fixed += 1
            else:
                out.append(xml_bytes[m.start():close_idx + len(close_tag)])
        cursor = close_idx + len(close_tag)

    if fixed == 0:
        return xml_bytes, 0
    return b"".join(out), fixed


def _repair_svg_blip_primary_embed(merged_files: dict[str, bytes]) -> int:
    """Sweep slide/slideLayout/slideMaster/notesSlide XMLs and repair every
    <a:blip> that lacks a primary r:embed/r:link reference but has a nested
    <asvg:svgBlip r:embed="..."/>.

    PowerPoint's "Save As" sometimes deletes the PNG fallback relationship
    behind an SVG image yet leaves the outer <a:blip> open-tag without any
    primary reference. Office 365 strictly validates this and flags the
    package as corrupt. Promoting the inner SVG rId as the outer r:embed
    restores schema validity without altering visible content.

    Returns the total number of repairs applied across the package.
    """
    total = 0
    for name in list(merged_files.keys()):
        if not name.endswith(".xml"):
            continue
        if not any(d in name for d in _BLIP_REPAIR_DIRS):
            continue
        data = merged_files[name]
        new_data, n = _repair_blip_in_xml(data)
        if n > 0:
            merged_files[name] = new_data
            total += n
            _logger.info("Repaired %d SVG <a:blip> primary r:embed in %s", n, name)
    return total
