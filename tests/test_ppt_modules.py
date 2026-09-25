"""Public PPT utility and module-boundary regressions, using temporary files only."""

from __future__ import annotations

import ast
from importlib.util import resolve_name
from pathlib import Path, PurePosixPath
import posixpath
import tempfile
import unittest
from unittest.mock import patch
from xml.etree import ElementTree as ET
import zipfile

from PIL import Image, ImageChops, ImageFont

from app.core import ppt


ROOT = Path(__file__).resolve().parents[1]
MODULE_ROOT = ROOT / "app/core/ppt_modules"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _ordered_slides(package: zipfile.ZipFile) -> list[str]:
    """Read slide ordering independently of the implementation under test."""
    presentation = ET.fromstring(package.read("ppt/presentation.xml"))
    relationships = ET.fromstring(package.read("ppt/_rels/presentation.xml.rels"))
    targets = {rel.attrib["Id"]: rel.attrib["Target"] for rel in relationships}
    return [
        posixpath.normpath(posixpath.join("ppt", targets[slide.attrib[f"{{{R_NS}}}id"]]))
        for slide in presentation.find(f"{{{P_NS}}}sldIdLst")
    ]


class PptPublicContractTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="slideflow-ppt-modules-test-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.images = [self.root / "landscape.png", self.root / "portrait.png"]
        for path, size, color in zip(self.images, [(320, 180), (120, 240)], ["red", "blue"]):
            with Image.new("RGB", size, color) as image:
                image.save(path)

    def build(self, name="source.pptx", images=None):
        output = self.root / name
        ppt.build_image_pptx(self.images if images is None else images, output)
        return output

    def assert_valid_package(self, path):
        with zipfile.ZipFile(path) as package:
            self.assertIsNone(package.testzip())
            names = package.namelist()
            self.assertEqual(len(names), len(set(names)), "Duplicate ZIP entries")
            for name in names:
                if name.endswith((".xml", ".rels")):
                    root = ET.fromstring(package.read(name))
                if not name.endswith(".rels"):
                    continue
                source_dir = str(PurePosixPath(name).parent.parent)
                for rel in root:
                    if rel.get("TargetMode") == "External":
                        continue
                    target = rel.attrib["Target"]
                    resolved = (
                        target.lstrip("/") if target.startswith("/")
                        else posixpath.normpath(posixpath.join(source_dir, target))
                    )
                    self.assertIn(resolved, names, f"Dangling relationship in {name}: {target}")

    def test_legacy_facade_exports_callables(self):
        for name in (
            "detect_ppt_fonts", "slide_count", "split_pptx_to_single_pages",
            "merge_pptx_files", "build_image_pptx", "determine_pdf_canvas_size",
            "fit_image_to_canvas", "_build_watermark_tile",
            "add_watermark_to_image", "add_watermark_to_pptx",
        ):
            with self.subTest(name=name):
                function = getattr(ppt, name)
                self.assertTrue(callable(function))
                self.assertTrue(function.__module__.startswith("app.core.ppt_modules."))

    def test_split_keeps_nested_diagram_media_and_enforces_total_budget(self):
        source = self.build()
        with zipfile.ZipFile(source) as package:
            parts = {n:package.read(n) for n in package.namelist()}
        rel = '<Relationship Id="rDiagram" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramDrawing" Target="../diagrams/drawing1.xml"/>'
        parts["ppt/slides/_rels/slide1.xml.rels"] = parts["ppt/slides/_rels/slide1.xml.rels"].replace(b"</Relationships>",rel.encode()+b"</Relationships>")
        parts["ppt/diagrams/drawing1.xml"] = b'<drawing xmlns="test"><cached-content/></drawing>'
        parts["ppt/diagrams/_rels/drawing1.xml.rels"] = b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="image" Target="../media/nested.png"/></Relationships>'
        parts["ppt/media/nested.png"] = self.images[0].read_bytes()
        enriched = self.root / "nested.pptx"
        with zipfile.ZipFile(enriched,"w") as package:
            for name,data in parts.items(): package.writestr(name,data)
        singles = ppt.split_pptx_to_single_pages(enriched,self.root/"nested-split")
        with zipfile.ZipFile(singles[0]) as package:
            for name in ("ppt/diagrams/drawing1.xml","ppt/diagrams/_rels/drawing1.xml.rels","ppt/media/nested.png","ppt/slides/slide1.xml"):
                self.assertEqual(package.read(name),parts[name])
        with self.assertRaisesRegex(ValueError,"总量过大"):
            ppt.split_pptx_to_single_pages(enriched,self.root/"limited",max_total_bytes=1)
        self.assertFalse(list((self.root/"limited").glob("*.pptx")))

    def test_split_removes_embedded_fonts_and_their_package_metadata(self):
        source = self.build()
        with zipfile.ZipFile(source) as package:
            parts = {name: package.read(name) for name in package.namelist()}

        presentation = ET.fromstring(parts["ppt/presentation.xml"])
        presentation.set("embedTrueTypeFonts", "1")
        presentation.set("saveSubsetFonts", "1")
        embedded_fonts = ET.SubElement(presentation, f"{{{P_NS}}}embeddedFontLst")
        embedded_font = ET.SubElement(embedded_fonts, f"{{{P_NS}}}embeddedFont")
        ET.SubElement(embedded_font, f"{{{P_NS}}}font", {"typeface": "Test Sans"})
        ET.SubElement(embedded_font, f"{{{P_NS}}}regular", {f"{{{R_NS}}}id": "rIdFont1"})
        parts["ppt/presentation.xml"] = ET.tostring(
            presentation, encoding="utf-8", xml_declaration=True
        )

        relationships = ET.fromstring(parts["ppt/_rels/presentation.xml.rels"])
        ET.SubElement(
            relationships,
            f"{{{relationships.tag.rsplit('}', 1)[0][1:]}}}Relationship",
            {
                "Id": "rIdFont1",
                "Type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font",
                "Target": "fonts/font1.fntdata",
            },
        )
        parts["ppt/_rels/presentation.xml.rels"] = ET.tostring(
            relationships, encoding="utf-8", xml_declaration=True
        )
        parts["ppt/fonts/font1.fntdata"] = b"embedded-font-payload" * 1000
        content_types = ET.fromstring(parts["[Content_Types].xml"])
        content_types.append(
            ET.Element(
                "{http://schemas.openxmlformats.org/package/2006/content-types}Default",
                {"Extension": "fntdata", "ContentType": "application/x-fontdata"},
            )
        )
        parts["[Content_Types].xml"] = ET.tostring(
            content_types, encoding="utf-8", xml_declaration=True
        )

        embedded_source = self.root / "embedded-fonts.pptx"
        with zipfile.ZipFile(embedded_source, "w", zipfile.ZIP_DEFLATED) as package:
            for name, data in parts.items():
                package.writestr(name, data)

        pages = ppt.split_pptx_to_single_pages(embedded_source, self.root / "fontless-pages")
        self.assertEqual(len(pages), 2)
        for page in pages:
            self.assert_valid_package(page)
            with zipfile.ZipFile(page) as package:
                self.assertFalse(any(name.startswith("ppt/fonts/") for name in package.namelist()))
                split_presentation = ET.fromstring(package.read("ppt/presentation.xml"))
                self.assertNotIn("embedTrueTypeFonts", split_presentation.attrib)
                self.assertNotIn("saveSubsetFonts", split_presentation.attrib)
                self.assertIsNone(split_presentation.find(f"{{{P_NS}}}embeddedFontLst"))
                split_relationships = ET.fromstring(
                    package.read("ppt/_rels/presentation.xml.rels")
                )
                self.assertFalse(
                    any(rel.attrib.get("Type", "").endswith("/font") for rel in split_relationships)
                )
                split_content_types = ET.fromstring(package.read("[Content_Types].xml"))
                self.assertFalse(
                    any(
                        node.attrib.get("Extension", "").lower() == "fntdata"
                        for node in split_content_types
                    )
                )

    def test_image_pptx_is_inspectable_and_preserves_images(self):
        source = self.build()
        self.assertEqual(ppt.slide_count(source), 2)
        self.assertEqual(ppt.detect_ppt_fonts(source), [])
        self.assert_valid_package(source)
        with zipfile.ZipFile(source) as package:
            self.assertEqual(len(_ordered_slides(package)), 2)
            for index, image in enumerate(self.images, start=1):
                self.assertEqual(package.read(f"ppt/media/image{index}.png"), image.read_bytes())

    def test_split_and_merge_roundtrip_keeps_order_media_and_source(self):
        source = self.build()
        before = source.read_bytes()
        progress = []
        pages = ppt.split_pptx_to_single_pages(
            source, self.root / "pages", progress_callback=lambda done, total: progress.append((done, total))
        )
        self.assertEqual(len(pages), 2)
        self.assertEqual(progress, [(1, 2), (2, 2)])
        for index, page in enumerate(pages):
            self.assertEqual(ppt.slide_count(page), 1)
            self.assert_valid_package(page)
            with zipfile.ZipFile(page) as package:
                media = [package.read(name) for name in package.namelist() if name.startswith("ppt/media/")]
                self.assertEqual(media, [self.images[index].read_bytes()])
        merged = self.root / "merged.pptx"
        ppt.merge_pptx_files(pages, merged)
        self.assertEqual(ppt.slide_count(merged), 2)
        self.assert_valid_package(merged)
        with zipfile.ZipFile(merged) as package:
            for index, slide_path in enumerate(_ordered_slides(package)):
                path = PurePosixPath(slide_path)
                rels = ET.fromstring(package.read(str(path.parent / "_rels" / (path.name + ".rels"))))
                image_rel = next(rel for rel in rels if rel.get("Type", "").endswith("/image"))
                image_path = posixpath.normpath(posixpath.join(str(path.parent), image_rel.attrib["Target"]))
                self.assertEqual(package.read(image_path), self.images[index].read_bytes())
        self.assertEqual(source.read_bytes(), before)

    def test_hidden_flags_apply_to_every_slide_of_the_selected_source(self):
        first = self.build("first.pptx")
        second = self.build("second.pptx", [self.images[0]])
        before = [path.read_bytes() for path in (first, second)]
        for flags, expected in (([True, False], [True, True, False]), ([False, True], [False, False, True])):
            with self.subTest(flags=flags):
                merged = self.root / ("hidden-first.pptx" if flags[0] else "hidden-second.pptx")
                ppt.merge_pptx_files([first, second], merged, hidden_flags=flags)
                self.assertEqual(ppt.slide_count(merged), 3)
                self.assert_valid_package(merged)
                with zipfile.ZipFile(merged) as package:
                    hidden = [ET.fromstring(package.read(path)).get("show") == "0" for path in _ordered_slides(package)]
                    self.assertEqual(hidden, expected)
        self.assertEqual([path.read_bytes() for path in (first, second)], before)

    def test_single_source_merge_supports_copy_and_hidden_paths(self):
        source = self.build()
        before = source.read_bytes()
        copied = self.root / "copied.pptx"
        ppt.merge_pptx_files([source], copied)
        self.assertEqual(copied.read_bytes(), before)
        hidden = self.root / "hidden.pptx"
        ppt.merge_pptx_files([source], hidden, hidden_flags=[True])
        self.assert_valid_package(hidden)
        with zipfile.ZipFile(hidden) as package:
            self.assertTrue(all(ET.fromstring(package.read(path)).get("show") == "0" for path in _ordered_slides(package)))
        self.assertEqual(source.read_bytes(), before)

    def test_canvas_size_handles_mixed_images_fallbacks_and_resolution_limit(self):
        self.assertEqual(ppt.determine_pdf_canvas_size(self.images), (320, 240))
        self.assertEqual(ppt.determine_pdf_canvas_size([self.root / "missing.png"]), (1920, 1080))
        jpeg = self.root / "odd-size.jpg"
        with Image.new("RGB", (121, 241), "white") as image:
            image.save(jpeg)
        self.assertEqual(ppt.determine_pdf_canvas_size([jpeg]), (122, 242))
        large = self.root / "large.png"
        with Image.new("RGB", (4000, 2400), "white") as image:
            image.save(large)
        self.assertEqual(ppt.determine_pdf_canvas_size([large]), (3600, 2160))

    def test_fit_image_to_canvas_preserves_aspect_and_adds_white_padding(self):
        with Image.new("RGB", (120, 240), "blue") as original:
            with ppt.fit_image_to_canvas(original, 320, 240) as fitted:
                self.assertEqual(fitted.size, (320, 240))
                self.assertEqual(fitted.getpixel((0, 120)), (255, 255, 255))
                self.assertEqual(fitted.getpixel((160, 120)), (0, 0, 255))
                self.assertEqual(fitted.getpixel((319, 120)), (255, 255, 255))
            self.assertEqual(original.size, (120, 240))
            self.assertEqual(original.getpixel((0, 0)), (0, 0, 255))
        with Image.new("RGB", (320, 240)) as same_size:
            self.assertIs(ppt.fit_image_to_canvas(same_size, 320, 240), same_size)

    def test_image_watermark_supports_generated_and_reusable_tiles(self):
        # Keep this independent of the machine's fonts and configured data folder.
        with patch("app.core.ppt_modules.watermark._get_cjk_font", return_value=ImageFont.load_default()):
            with Image.new("RGB", (640, 360), "white") as original:
                before = original.tobytes()
                self.assertIs(ppt.add_watermark_to_image(original, ""), original)
                with ppt.add_watermark_to_image(original, "CONFIDENTIAL") as automatic:
                    self.assertEqual(automatic.size, original.size)
                    self.assertEqual(automatic.mode, "RGBA")
                    with automatic.convert("RGB") as rgb:
                        with ImageChops.difference(original, rgb) as difference:
                            self.assertIsNotNone(difference.getbbox())
                    with ppt._build_watermark_tile(640, 360, "CONFIDENTIAL") as tile:
                        with ppt.add_watermark_to_image(original, "CONFIDENTIAL", tile=tile) as reused:
                            self.assertEqual(reused.tobytes(), automatic.tobytes())
                        self.assertTrue(tile.tobytes(), "A caller-owned tile must stay usable")
                self.assertEqual(original.tobytes(), before)

    def test_pptx_watermark_preserves_package_and_escapes_text(self):
        source = self.build()
        before = source.read_bytes()
        ppt.add_watermark_to_pptx(source, "")
        self.assertEqual(source.read_bytes(), before)
        text = 'Internal & <review> "draft"'
        ppt.add_watermark_to_pptx(source, text)
        self.assertEqual(ppt.slide_count(source), 2)
        self.assert_valid_package(source)
        self.assertEqual(ppt.detect_ppt_fonts(source), ["Microsoft YaHei"])
        with zipfile.ZipFile(source) as package:
            master = ET.fromstring(package.read("ppt/slideMasters/slideMaster1.xml"))
            self.assertEqual([node.text for node in master.iter(f"{{{A_NS}}}t")], [text] * 6)
            for index, image in enumerate(self.images, start=1):
                self.assertEqual(package.read(f"ppt/media/image{index}.png"), image.read_bytes())
        self.assertFalse(source.with_suffix(".tmp").exists())


class PptModuleArchitectureTests(unittest.TestCase):
    def test_compatibility_facade_only_declares_explicit_exports(self):
        source = (ROOT / "app/core/ppt.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        self.assertLessEqual(len(source.splitlines()), 60)
        for node in tree.body:
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
                continue  # Module docstring.
            self.assertIsInstance(node, (ast.ImportFrom, ast.Assign))
            if isinstance(node, ast.Assign):
                self.assertEqual([target.id for target in node.targets], ["__all__"])
                self.assertEqual(set(ast.literal_eval(node.value)), set(ppt.__all__))

    def test_shared_helpers_have_one_owner_and_module_dependencies_are_acyclic(self):
        prefix = "app.core.ppt_modules."
        modules = {}
        owners = {}
        for source in sorted(MODULE_ROOT.glob("*.py")):
            module_name = prefix + source.stem
            modules[module_name] = set()
            tree = ast.parse(source.read_text(encoding="utf-8"))
            for node in tree.body:
                if isinstance(node, ast.FunctionDef):
                    self.assertNotIn(node.name, owners, f"Duplicated implementation: {node.name}")
                    owners[node.name] = module_name
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom):
                    target = node.module or ""
                    if node.level:
                        target = resolve_name("." * node.level + target, prefix.rstrip("."))
                    if target.startswith(prefix):
                        modules[module_name].add(target)
                elif isinstance(node, ast.Import):
                    modules[module_name].update(alias.name for alias in node.names if alias.name.startswith(prefix))

        completed = set()

        def visit(module, active):
            self.assertNotIn(module, active, f"Dependency cycle: {' -> '.join([*active, module])}")
            if module in completed:
                return
            for dependency in modules[module]:
                self.assertIn(dependency, modules)
                visit(dependency, [*active, module])
            completed.add(module)

        for module in modules:
            visit(module, [])

    def test_implementation_modules_do_not_import_the_compatibility_facade(self):
        violations = []
        for source in sorted(MODULE_ROOT.rglob("*.py")):
            package_name = ".".join(source.parent.relative_to(ROOT).parts)
            tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
            for node in ast.walk(tree):
                targets = []
                if isinstance(node, ast.Import):
                    targets = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    module = node.module or ""
                    if node.level:
                        module = resolve_name("." * node.level + module, package_name)
                    targets = [module, *(module + "." + alias.name for alias in node.names)]
                elif isinstance(node, ast.Call) and node.args:
                    function = getattr(node.func, "attr", getattr(node.func, "id", ""))
                    if function in {"import_module", "__import__"} and isinstance(node.args[0], ast.Constant):
                        targets = [node.args[0].value]
                if any(isinstance(target, str) and (target == "app.core.ppt" or target.startswith("app.core.ppt.")) for target in targets):
                    violations.append(f"{source.relative_to(ROOT)}:{node.lineno}")
        self.assertEqual(violations, [], "Implementation modules must not depend on the compatibility facade")

    def test_ppt_modules_use_explicit_imports(self):
        violations = []
        for source in [ROOT / "app/core/ppt.py", *sorted(MODULE_ROOT.rglob("*.py"))]:
            tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and any(alias.name == "*" for alias in node.names):
                    violations.append(f"{source.relative_to(ROOT)}:{node.lineno}")
        self.assertEqual(violations, [], "Explicit imports make cross-module dependencies reviewable")


if __name__ == "__main__":
    unittest.main()
