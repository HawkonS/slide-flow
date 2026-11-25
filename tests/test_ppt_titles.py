"""Slide-title extraction regressions using generated, template-neutral decks."""

from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from lxml import etree
from pptx import Presentation
from pptx.util import Inches, Pt

from app.core.ppt import extract_pptx_titles


P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"


def _q(ns: str, tag: str) -> str:
    return f"{{{ns}}}{tag}"


def _add_layout_textbox(layout, text: str, left: float, top: float, width: float, height: float, size: int = 32) -> None:
    """Add non-placeholder static text to a layout, as a reusable template title."""
    root = layout.part._element
    tree = root.find(f".//{_q(P_NS, 'cSld')}/{_q(P_NS, 'spTree')}")
    ids = [int(el.get("id")) for el in root.iter(_q(P_NS, "cNvPr")) if (el.get("id") or "").isdigit()]
    sp = etree.SubElement(tree, _q(P_NS, "sp"))
    nv = etree.SubElement(sp, _q(P_NS, "nvSpPr"))
    c_nv_pr = etree.SubElement(nv, _q(P_NS, "cNvPr"))
    c_nv_pr.set("id", str((max(ids) if ids else 1) + 1))
    c_nv_pr.set("name", "Layout Title")
    etree.SubElement(nv, _q(P_NS, "cNvSpPr")).set("txBox", "1")
    etree.SubElement(nv, _q(P_NS, "nvPr"))
    sp_pr = etree.SubElement(sp, _q(P_NS, "spPr"))
    xfrm = etree.SubElement(sp_pr, _q(A_NS, "xfrm"))
    off = etree.SubElement(xfrm, _q(A_NS, "off"))
    off.set("x", str(int(Inches(left)))); off.set("y", str(int(Inches(top))))
    ext = etree.SubElement(xfrm, _q(A_NS, "ext"))
    ext.set("cx", str(int(Inches(width)))); ext.set("cy", str(int(Inches(height))))
    tx_body = etree.SubElement(sp, _q(P_NS, "txBody"))
    etree.SubElement(tx_body, _q(A_NS, "bodyPr"))
    etree.SubElement(tx_body, _q(A_NS, "lstStyle"))
    paragraph = etree.SubElement(tx_body, _q(A_NS, "p"))
    run = etree.SubElement(paragraph, _q(A_NS, "r"))
    r_pr = etree.SubElement(run, _q(A_NS, "rPr"))
    r_pr.set("sz", str(size * 100))
    etree.SubElement(run, _q(A_NS, "t")).text = text


def _add_textbox(slide, text: str, left: float, top: float, width: float, height: float, size: int = 28) -> None:
    box = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    box.text_frame.text = text
    box.text_frame.paragraphs[0].runs[0].font.size = Pt(size)


def _add_group(slide, text: str, group_left: float, group_top: float, size: int = 20) -> None:
    group = slide.shapes.add_group_shape()
    child = group.shapes.add_textbox(Inches(0.1), Inches(0.1), Inches(2), Inches(0.5))
    child.text_frame.text = text
    child.text_frame.paragraphs[0].runs[0].font.size = Pt(size)
    # Set the outer box after adding children: python-pptx recalculates the
    # group's child offset when the first child is inserted.
    group.left = Inches(group_left)
    group.top = Inches(group_top)
    group.width = Inches(4)
    group.height = Inches(1)


class PptTitleExtractionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="slideflow-titles-test-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def save(self, presentation, name: str = "deck.pptx") -> Path:
        path = self.root / name
        presentation.save(path)
        return path

    def test_title_placeholder_wins_over_larger_body_text(self):
        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[5])
        slide.shapes.title.text = "标题甲"
        _add_textbox(slide, "更大的正文内容", 0.5, 2.0, 8.0, 1.5, size=40)
        self.assertEqual(extract_pptx_titles(self.save(prs)), ["标题甲"])

    def test_top_left_title_area_prefers_the_topmost_text(self):
        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        _add_textbox(slide, "目录乙", 0.6, 0.6, 6.0, 0.8, size=32)
        _add_textbox(slide, "章节丙", 0.6, 3.0, 6.0, 0.8, size=20)
        self.assertEqual(extract_pptx_titles(self.save(prs)), ["目录乙"])

    def test_layout_static_title_is_used_when_slide_has_only_grouped_body(self):
        prs = Presentation()
        layout = prs.slide_layouts[6]
        _add_layout_textbox(layout, "目录", 0.8, 0.6, 3.0, 1.0, size=32)
        slide = prs.slides.add_slide(layout)
        _add_group(slide, "章节 1", 1.0, 3.0, size=20)
        self.assertEqual(extract_pptx_titles(self.save(prs)), ["目录"])

    def test_group_uses_outer_box_instead_of_relative_child_coordinates(self):
        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        _add_textbox(slide, "真标题", 0.5, 0.2, 5.0, 0.8, size=32)
        _add_group(slide, "组内正文", 1.0, 3.0, size=20)
        self.assertEqual(extract_pptx_titles(self.save(prs)), ["真标题"])

    def test_layout_placeholder_prompt_is_not_treated_as_title(self):
        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[5])
        _add_textbox(slide, "页面真标题", 0.5, 0.2, 5.0, 0.8, size=28)
        # The title layout carries a prompt placeholder; it must not beat the
        # slide's own text.
        self.assertEqual(extract_pptx_titles(self.save(prs)), ["页面真标题"])

    def test_footer_only_slide_has_no_title(self):
        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        _add_textbox(slide, "www.example.com", 0.5, 6.8, 4.0, 0.4, size=12)
        self.assertEqual(extract_pptx_titles(self.save(prs)), [""])

    def test_long_title_is_truncated(self):
        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[5])
        slide.shapes.title.text = "标题" * 100
        titles = extract_pptx_titles(self.save(prs))
        self.assertEqual(len(titles), 1)
        self.assertEqual(len(titles[0]), 120)
        self.assertTrue(titles[0].endswith("…"))

    def test_unreadable_file_returns_no_titles(self):
        path = self.root / "broken.pptx"
        path.write_bytes(b"not a pptx")
        self.assertEqual(extract_pptx_titles(path), [])


if __name__ == "__main__":
    unittest.main()
