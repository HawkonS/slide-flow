import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wps_renderer.errors import RenderError
from wps_renderer.fonts import FontManager, font_metadata
from wps_renderer.office_xml import validate_xml
from wps_renderer.validation import unpack_bundle
from wps_renderer.config import Settings


class InputBoundsTests(unittest.TestCase):
    def test_manifest_duplicate_keys_are_rejected(self):
        import io
        import zipfile
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / "bundle.zip"
            with zipfile.ZipFile(bundle, "w") as archive:
                archive.writestr("manifest.json", b'{"version":1,"version":1}')
            settings = Settings(wpscli="fake", data_dir=str(Path(directory) / "data"), token="x" * 40,
                                min_free_bytes=1, min_free_ratio=0)
            with self.assertRaises(RenderError):
                unpack_bundle(bundle, Path(directory) / "input", settings)

    def test_collection_count_rejected_before_fonttools_allocation(self):
        with tempfile.TemporaryDirectory() as directory:
            font = Path(directory) / "bomb.ttc"
            font.write_bytes(b"ttcf" + struct.pack(">II", 0x00010000, 0xffffffff))
            with patch("wps_renderer.fonts.TTCollection") as constructor:
                with self.assertRaises(RenderError):
                    font_metadata(font)
                constructor.assert_not_called()

    def test_repeated_font_name_record_budget_rejected_before_fonttools(self):
        with tempfile.TemporaryDirectory() as directory:
            font = Path(directory) / "bomb.ttf"
            count, string_size = 2048, 8192
            table = struct.pack(">HHH", 0, count, 6 + count * 12)
            table += struct.pack(">6H", 3, 1, 0x409, 1, string_size, 0) * count
            table += b"a" * string_size
            offset = 12 + 3 * 16
            header = b"\x00\x01\x00\x00" + struct.pack(">4H", 3, 0, 0, 0)
            header += struct.pack(">4sIII", b"name", 0, offset, len(table))
            header += struct.pack(">4sIII", b"head", 0, offset, 0)
            header += struct.pack(">4sIII", b"maxp", 0, offset, 0)
            font.write_bytes(header + table)
            with patch("wps_renderer.fonts.TTFont") as constructor:
                with self.assertRaises(RenderError):
                    font_metadata(font)
                constructor.assert_not_called()

    def test_font_inventory_cached_but_activation_can_force_refresh(self):
        manager = FontManager()
        with patch.object(manager, "_scan_installed", wraps=manager._scan_installed) as scan:
            manager.installed()
            manager.installed()
            manager.check(["Missing"], [])
            self.assertEqual(scan.call_count, 1)
            manager.installed(force=True)
            self.assertEqual(scan.call_count, 2)

    def test_relationship_cannot_hide_network_target_as_internal(self):
        for target in ("https://example.test/image.png", "file:///C:/secret.txt", "//server/share/file", "%5c%5cserver%5cshare", "../../../../secret"):
            with self.subTest(target=target):
                xml = ('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                       f'<Relationship Type="image" Target="{target}"/></Relationships>')
                with self.assertRaises(RenderError):
                    validate_xml(xml.encode(), "ppt/slides/_rels/slide1.xml.rels")

    def test_relationship_control_rejected_even_with_benign_filename(self):
        xml = ('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" '
               'Target="../media/picture.dat"/></Relationships>')
        with self.assertRaises(RenderError):
            validate_xml(xml.encode(), "ppt/slides/_rels/slide1.xml.rels")

    def test_safe_internal_assets_and_web_hyperlinks_allowed(self):
        xml = ('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Type="image" Target="../media/image1.png"/>'
               '<Relationship Type="office/hyperlink" TargetMode="External" Target="https://example.test/path"/>'
               '</Relationships>')
        validate_xml(xml.encode(), "ppt/slides/_rels/slide1.xml.rels")

    def test_dtd_and_excessive_xml_depth_rejected(self):
        for xml in (b'<!DOCTYPE x><x/>', b'<x>' * 129 + b'</x>' * 129):
            with self.assertRaises(Exception):
                validate_xml(xml, "ppt/slides/slide1.xml")

    def test_multiple_slide_references_rejected_even_with_one_slide_part(self):
        xml = ('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
               '<p:sldIdLst><p:sldId id="256"/><p:sldId id="257"/></p:sldIdLst></p:presentation>')
        with self.assertRaises(RenderError):
            validate_xml(xml.encode(), "ppt/presentation.xml")
