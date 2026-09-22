"""Read-only PPTX inspection: used fonts and slide count."""

from __future__ import annotations

import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from app.core.resource_import_fonts import detect_used_ppt_fonts

from .package import P_NS, _scan_zip_entries


def detect_ppt_fonts(pptx_path: Path) -> list[str]:
    """Detect fonts actually used by slide text, including inherited styles."""
    return detect_used_ppt_fonts(pptx_path)


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


__all__ = ['detect_ppt_fonts', 'slide_count']
