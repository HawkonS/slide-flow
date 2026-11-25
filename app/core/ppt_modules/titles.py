"""Best-effort extraction of the visible title for each slide.

The extractor deliberately avoids OCR and body-text guessing. It prefers the
slide's real title placeholder; when that is absent it looks for the text a
presenter would consider the page title: the top-left title area of the slide,
then static text placed in the slide layout or master.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import logging
import re

logger = logging.getLogger(__name__)

MAX_TITLE_LENGTH = 120
_TITLE_TOP_LIMIT = 0.45
_TITLE_LEFT_LIMIT = 0.60
_LAYOUT_PENALTY = 30.0
_MASTER_PENALTY = 40.0
_WHITESPACE_RE = re.compile(r"[\u0000-\u001f\u007f\u200b-\u200d\ufeff\s]+")
_URL_RE = re.compile(r"(?:https?://\S+|www\.\S+|\S+@\S+\.\S+)", re.IGNORECASE)


@dataclass(frozen=True)
class _Candidate:
    score: float
    text: str


def _clean_title(value: str) -> str:
    text = _WHITESPACE_RE.sub(" ", value or "").strip()
    if len(text) > MAX_TITLE_LENGTH:
        text = text[: MAX_TITLE_LENGTH - 1].rstrip() + "…"
    return text


def _iter_text_shapes(shapes, parent_box=None):
    """Yield (shape, box), using the outer group box for grouped children.

    ``python-pptx`` exposes child coordinates inside a group relative to the
    group. Scoring those raw values would make grouped body items look like
    top-left titles, so grouped children inherit the enclosing group's box.
    """
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    for shape in shapes:
        box = parent_box or (shape.left, shape.top, shape.width, shape.height)
        if getattr(shape, "shape_type", None) == MSO_SHAPE_TYPE.GROUP:
            yield from _iter_text_shapes(shape.shapes, box)
        else:
            yield shape, box


def _first_text(shape) -> str:
    if not getattr(shape, "has_text_frame", False):
        return ""
    for paragraph in shape.text_frame.paragraphs:
        value = "".join(run.text for run in paragraph.runs) or paragraph.text
        value = _clean_title(value)
        if value:
            return value
    return ""


def _max_font_size(shape) -> float:
    sizes: list[float] = []
    for paragraph in shape.text_frame.paragraphs:
        if paragraph.font.size is not None:
            sizes.append(float(paragraph.font.size.pt))
        for run in paragraph.runs:
            if run.font.size is not None:
                sizes.append(float(run.font.size.pt))
    return max(sizes) if sizes else 0.0


def _placeholder_type(shape):
    try:
        if not getattr(shape, "is_placeholder", False):
            return None
        return shape.placeholder_format.type
    except Exception:
        return None


def _is_skipped_placeholder(shape) -> bool:
    from pptx.enum.shapes import PP_PLACEHOLDER

    return _placeholder_type(shape) in {
        PP_PLACEHOLDER.FOOTER,
        PP_PLACEHOLDER.SLIDE_NUMBER,
        PP_PLACEHOLDER.DATE,
    }


def _candidates(shapes, level: str, slide_width: float, slide_height: float, *, skip_placeholders: bool):
    from pptx.enum.shapes import PP_PLACEHOLDER

    result: list[_Candidate] = []
    for shape, box in _iter_text_shapes(shapes):
        if not getattr(shape, "has_text_frame", False):
            continue
        if getattr(shape, "has_table", False) or getattr(shape, "has_chart", False):
            continue
        if _is_skipped_placeholder(shape):
            continue
        placeholder_type = _placeholder_type(shape)
        # Layout/master placeholders contain prompt text that is not rendered
        # on the slide. Only non-placeholder static design text is inherited.
        if skip_placeholders and placeholder_type is not None:
            continue
        text = _first_text(shape)
        if not text or not any(char.isalnum() for char in text):
            continue
        if _URL_RE.fullmatch(text):
            continue

        left, top, width, height = (float(value or 0) for value in box)
        top_ratio = top / slide_height if slide_height else 0.0
        left_ratio = left / slide_width if slide_width else 0.0
        if top_ratio > _TITLE_TOP_LIMIT or left_ratio > _TITLE_LEFT_LIMIT:
            continue

        area_ratio = 0.0
        if slide_width and slide_height:
            area_ratio = min((width / slide_width) * (height / slide_height), 1.0)
        score = (1.0 - min(top_ratio, 1.0)) * 100.0
        score += (1.0 - min(left_ratio, 1.0)) * 15.0
        score += min(_max_font_size(shape), 72.0) * 2.0
        score += area_ratio * 15.0
        if placeholder_type in (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE):
            score += 1000.0
        elif placeholder_type == PP_PLACEHOLDER.SUBTITLE:
            score += 100.0
        if level == "layout":
            score -= _LAYOUT_PENALTY
        elif level == "master":
            score -= _MASTER_PENALTY
        if len(text) <= 1:
            score -= 20.0
        elif len(text) <= 40:
            score += 5.0
        else:
            score -= min((len(text) - 40) * 0.3, 30.0)
        result.append(_Candidate(score, text))
    return result


def _layout_candidates(slide, slide_width: float, slide_height: float, cache: dict[int, list[_Candidate]]):
    layout = slide.slide_layout
    key = id(layout)
    if key not in cache:
        cache[key] = _candidates(
            layout.shapes, "layout", slide_width, slide_height, skip_placeholders=True,
        )
    return cache[key]


def _master_candidates(slide, slide_width: float, slide_height: float, cache: dict[int, list[_Candidate]]):
    master = slide.slide_layout.slide_master
    key = id(master)
    if key not in cache:
        cache[key] = _candidates(
            master.shapes, "master", slide_width, slide_height, skip_placeholders=True,
        )
    return cache[key]


def _title_placeholder_text(slide) -> str:
    title = slide.shapes.title
    return _first_text(title) if title is not None else ""


def extract_pptx_titles(pptx_path: Path) -> list[str]:
    """Return one best-effort title per slide, aligned with slide order.

    A title placeholder is authoritative. Without one, the slide's top-left
    title area is used, followed by static text from the matching layout and
    master. An empty string means no title was found and the caller should
    fall back to its own naming scheme.
    """
    try:
        from pptx import Presentation
    except ImportError:
        logger.warning("缺少 python-pptx，无法提取 PPT 标题")
        return []

    try:
        presentation = Presentation(str(pptx_path))
    except Exception:
        logger.warning("PPT 标题提取失败，将使用默认命名: %s", pptx_path.name)
        return []

    slide_width = float(presentation.slide_width or 0) or 1.0
    slide_height = float(presentation.slide_height or 0) or 1.0
    layout_cache: dict[int, list[_Candidate]] = {}
    master_cache: dict[int, list[_Candidate]] = {}
    titles: list[str] = []

    for slide in presentation.slides:
        try:
            direct = _title_placeholder_text(slide)
            if direct:
                titles.append(direct)
                continue
            candidates = _candidates(
                slide.shapes, "slide", slide_width, slide_height, skip_placeholders=False,
            )
            candidates += _layout_candidates(slide, slide_width, slide_height, layout_cache)
            try:
                candidates += _master_candidates(slide, slide_width, slide_height, master_cache)
            except Exception:
                logger.warning("读取 PPT 母版标题文字失败")
            candidates.sort(key=lambda candidate: candidate.score, reverse=True)
            titles.append(candidates[0].text if candidates else "")
        except Exception:
            logger.warning("单页 PPT 标题提取失败，将使用默认命名")
            titles.append("")
    return titles


__all__ = ["extract_pptx_titles"]
