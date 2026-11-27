"""Cross-slide jump links must not block importing a deck as single pages.

Slide 2 of a typical deck is a table of contents whose entries jump to other
slides. Splitting such a deck into one-page resources used to fail the whole
import; the link is now dropped from the standalone page instead.
"""

from __future__ import annotations

import re
import tempfile
import unittest
import zipfile
from pathlib import Path

from pptx import Presentation
from pptx.util import Inches

from app.core.ppt import split_pptx_to_single_pages
from app.services.resource_import.validation import _validate_import_ppt_package


def build_deck(path: Path, *, cross_slide_links: int = 0) -> None:
    """Write a 3-slide deck whose first slide links to the last one."""
    deck = Presentation()
    slides = []
    for index in range(3):
        slide = deck.slides.add_slide(deck.slide_layouts[5])
        box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1))
        box.text_frame.text = f"第 {index + 1} 页"
        slides.append(slide)
    for _ in range(cross_slide_links):
        link = slides[0].shapes.add_textbox(Inches(1), Inches(3), Inches(4), Inches(1))
        link.text_frame.text = "跳转"
        link.click_action.target_slide = slides[-1]
    deck.save(path)


def slide_parts(page: Path) -> list[str]:
    with zipfile.ZipFile(page) as archive:
        return sorted(
            name for name in archive.namelist()
            if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
        )


def rels_slide_targets(page: Path) -> list[str]:
    """Return slide targets declared by the page's own slide-level rels."""
    with zipfile.ZipFile(page) as archive:
        targets: list[str] = []
        for name in archive.namelist():
            if not name.startswith("ppt/slides/_rels/") or not name.endswith(".rels"):
                continue
            targets.extend(re.findall(rb'Target="([^"]*slides/[^"]*)"', archive.read(name)))
        return [target.decode() for target in targets]


def dangling_relationship_ids(page: Path) -> set[str]:
    with zipfile.ZipFile(page) as archive:
        dangling: set[str] = set()
        for name in archive.namelist():
            if not name.endswith(".xml") or name.endswith(".rels"):
                continue
            rels_name = f"{name.rsplit('/', 1)[0]}/_rels/{name.rsplit('/', 1)[-1]}.rels"
            used = set(re.findall(rb'r:(?:id|embed|link)="([^"]+)"', archive.read(name)))
            if not used:
                continue
            declared = (
                set(re.findall(rb'Id="([^"]+)"', archive.read(rels_name)))
                if rels_name in archive.namelist() else set()
            )
            dangling |= {item.decode() for item in used - declared}
        return dangling


class CrossSlideLinkSplitTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-cross-link-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_cross_slide_jump_is_pruned_instead_of_failing_the_import(self):
        source = self.root / "deck.pptx"
        build_deck(source, cross_slide_links=1)

        report: dict = {}
        pages = split_pptx_to_single_pages(source, self.root / "pages", report=report)

        self.assertEqual(len(pages), 3)
        self.assertEqual(report, {"stripped_links": [{"page": 1, "count": 1}]})
        first = pages[0]
        self.assertEqual(slide_parts(first), ["ppt/slides/slide1.xml"])
        self.assertEqual(rels_slide_targets(first), [])
        self.assertEqual(dangling_relationship_ids(first), set())
        with zipfile.ZipFile(first) as archive:
            slide_xml = archive.read("ppt/slides/slide1.xml")
        self.assertNotIn(b"hlinksldjump", slide_xml)
        _validate_import_ppt_package(first)
        # The jump target stays a normal page of its own.
        self.assertEqual(slide_parts(pages[2]), ["ppt/slides/slide3.xml"])

    def test_deck_without_jump_links_reports_nothing(self):
        source = self.root / "plain.pptx"
        build_deck(source)

        report: dict = {}
        pages = split_pptx_to_single_pages(source, self.root / "pages", report=report)

        self.assertEqual(len(pages), 3)
        self.assertEqual(report, {})

    def test_unused_cross_slide_relationship_is_still_dropped(self):
        """A leftover .rels entry must not fail the import even if nothing uses it.

        PowerPoint keeps the relationship when the hyperlink element is deleted
        from the slide XML, so the guard used to reject such decks as well.
        """
        linked = self.root / "linked.pptx"
        build_deck(linked, cross_slide_links=1)
        source = self.root / "stale.pptx"
        with zipfile.ZipFile(linked) as original, zipfile.ZipFile(source, "w", zipfile.ZIP_DEFLATED) as rewritten:
            for item in original.infolist():
                data = original.read(item.filename)
                if item.filename == "ppt/slides/slide1.xml":
                    data = re.sub(rb"<a:hlinkClick[^>]*/>", b"", data)
                rewritten.writestr(item, data)

        report: dict = {}
        pages = split_pptx_to_single_pages(source, self.root / "pages", report=report)

        self.assertEqual(len(pages), 3)
        self.assertEqual(report, {"stripped_links": [{"page": 1, "count": 1}]})
        self.assertEqual(slide_parts(pages[0]), ["ppt/slides/slide1.xml"])
        self.assertEqual(rels_slide_targets(pages[0]), [])
        self.assertEqual(dangling_relationship_ids(pages[0]), set())


if __name__ == "__main__":
    unittest.main()
