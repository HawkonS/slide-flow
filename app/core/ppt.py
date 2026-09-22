"""Backward-compatible PPTX utility facade.

The implementation is organized under :mod:`app.core.ppt_modules` by
responsibility. Existing callers can continue importing from ``app.core.ppt``.
"""
from app.core.ppt_modules.inspect import detect_ppt_fonts, slide_count
from app.core.ppt_modules.split import split_pptx_to_single_pages
from app.core.ppt_modules.merge import merge_pptx_files
from app.core.ppt_modules.images import (
    build_image_pptx,
    determine_pdf_canvas_size,
    fit_image_to_canvas,
)
from app.core.ppt_modules.watermark import (
    _build_watermark_tile,
    add_watermark_to_image,
    add_watermark_to_pptx,
)

__all__ = [
    "detect_ppt_fonts",
    "slide_count",
    "split_pptx_to_single_pages",
    "merge_pptx_files",
    "build_image_pptx",
    "determine_pdf_canvas_size",
    "fit_image_to_canvas",
    "_build_watermark_tile",
    "add_watermark_to_image",
    "add_watermark_to_pptx",
]
