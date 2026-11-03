import codecs
import ctypes
import hashlib
import sys
import tempfile
import unittest
import zipfile
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, patch

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTCollection, TTFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wps_renderer.errors import RenderError
from wps_renderer.font_faces import canonical_typefaces, resolve_faces
from wps_renderer.font_xml import normalize_pptx, replace_typefaces
from wps_renderer.fonts import FontManager, font_details
from wps_renderer.windows_fonts import verify_font

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"


def make_font(path, weight="105 Heavy", number=900):
    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder([".notdef", "A"])
    builder.setupCharacterMap({65: "A"})
    pen = TTGlyphPen(None)
    builder.setupGlyf({".notdef": pen.glyph(), "A": pen.glyph()})
    builder.setupHorizontalMetrics({".notdef": (500, 0), "A": (500, 0)})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    family = "Alibaba PuHuiTi 3.0 " + weight
    full = "Alibaba PuHuiTi 3 " + weight
    builder.setupNameTable({"familyName": family, "styleName": "Regular", "fullName": full,
                            "psName": "AlibabaPuHuiTi_3_" + weight.replace(" ", "_"),
                            "typographicFamily": "Alibaba PuHuiTi 3.0", "typographicSubfamily": weight})
    names = builder.font["name"]
    names.setName("阿里巴巴普惠体 3.0 " + weight, 1, 3, 1, 0x804)
    names.setName("阿里巴巴普惠体 3 " + weight, 4, 3, 1, 0x804)
    names.setName("Alibaba PuHuiTi 3.0", 1, 1, 0, 0)
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200, usWeightClass=number)
    builder.setupPost()
    builder.setupMaxp()
    builder.save(path)
    return font_details(path)[2][0]


class FontNameTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.heavy = make_font(self.root / "heavy.ttf")
        self.regular = make_font(self.root / "regular.ttf", "55 Regular", 400)
        self.profiles = {"a" * 64: (self.heavy,), "b" * 64: (self.regular,)}

    def resolve(self, names, bindings=None):
        return resolve_faces(names, bindings or [], self.profiles)

    def test_chinese_english_full_and_postscript_names_preserve_weight(self):
        names = ["阿里巴巴普惠体 3.0 105 Heavy", "Alibaba PuHuiTi 3.0 55 Regular", "AlibabaPuHuiTi_3_105_Heavy"]
        resolved = self.resolve(names)
        result = canonical_typefaces(resolved, lambda name, face: True)
        self.assertEqual(result[names[0]], "Alibaba PuHuiTi 3 105 Heavy")
        self.assertEqual(result[names[1]], "Alibaba PuHuiTi 3 55 Regular")
        self.assertEqual(result[names[2]], result[names[0]])
        self.assertEqual([faces[0][1].weight for faces in resolved.values()], [900, 400, 900])

    def test_hash_bound_display_alias_is_replaced_by_real_name(self):
        resolved = self.resolve(["Friendly Display Name"], [{"name": "Friendly Display Name", "sha256": "a" * 64}])
        self.assertEqual(canonical_typefaces(resolved, lambda name, face: True),
                         {"Friendly Display Name": self.heavy.full_name})
        with self.assertRaises(RenderError):
            self.resolve(["Unbound Display Name"])

    def test_fingerprints_use_original_tables_even_after_metadata_is_loaded(self):
        path = self.root / "heavy.ttf"
        with TTFont(path, lazy=True) as font:
            expected = tuple((tag, hashlib.sha256(font.reader[tag]).hexdigest()) for tag in ("name", "head"))
            # Simulate a decompiled table that fontTools would serialize
            # differently. Windows still sees the bytes in the original file.
            font["name"].names.reverse()
            font["head"].modified += 1
            from wps_renderer.font_faces import describe_face
            self.assertEqual(describe_face(font, 0).fingerprints, expected)

    def test_full_name_fallback_is_verified_before_use(self):
        checked = []
        def verify(name, face):
            checked.append(name)
            return name == face.family
        self.assertEqual(canonical_typefaces(self.resolve([self.heavy.family]), verify),
                         {self.heavy.family: self.heavy.family})
        self.assertEqual(checked, [self.heavy.full_name, self.heavy.family])
        with self.assertRaises(RenderError) as raised:
            canonical_typefaces(self.resolve([self.heavy.family]), lambda name, face: False)
        self.assertEqual(raised.exception.code, "font_unavailable")

    def test_uses_verified_native_name_because_wps_rejects_english_gdi_alias(self):
        chinese = "阿里巴巴普惠体 3.0 105 Heavy"
        result = canonical_typefaces(self.resolve([self.heavy.family]), lambda name, face: chinese)
        self.assertEqual(result, {self.heavy.family: chinese})

    def test_ambiguous_typographic_family_cannot_choose_arbitrary_weight(self):
        with self.assertRaises(RenderError) as raised:
            self.resolve(["Alibaba PuHuiTi 3.0"])
        self.assertEqual(raised.exception.code, "font_conflict")

    def test_style_linked_family_keeps_bold_and_italic_selection(self):
        profiles = {"a": (replace(self.regular, family="Linked Family", full_name="Linked Family Regular", names=frozenset({"linkedfamily"})),),
                    "b": (replace(self.heavy, family="Linked Family", full_name="Linked Family Bold", names=frozenset({"linkedfamily"})),)}
        checked = []
        result = canonical_typefaces(resolve_faces(["Linked Family"], [], profiles),
                                     lambda name, face: checked.append((name, face.weight)) or True)
        self.assertEqual(result, {"Linked Family": "Linked Family"})
        self.assertEqual(checked, [("Linked Family", 400), ("Linked Family", 900)])

    def test_collection_alias_must_identify_its_concrete_face(self):
        collection = TTCollection()
        collection.fonts = [TTFont(self.root / "heavy.ttf"), TTFont(self.root / "regular.ttf")]
        try:
            collection.save(self.root / "faces.ttc")
        finally:
            collection.close()
        profiles = {"collection": font_details(self.root / "faces.ttc")[2]}
        result = resolve_faces([self.heavy.family], [{"name": self.heavy.family, "sha256": "collection"}], profiles)
        self.assertEqual(result[self.heavy.family][0][1].weight, 900)
        with self.assertRaises(RenderError):
            resolve_faces(["Collection display"], [{"name": "Collection display", "sha256": "collection"}], profiles)

    def test_long_full_name_is_not_truncated_by_windows(self):
        face = replace(self.heavy, full_name="Long full name " * 5)
        names = canonical_typefaces({"alias": [("a", face)]}, lambda name, face: len(name) < 32)
        self.assertEqual(names, {"alias": face.family})

    def test_long_english_names_can_use_short_localized_family(self):
        face = replace(self.heavy, full_name="Long full name " * 5, family="Long family name " * 5,
                       localized_families=("阿里巴巴普惠体 3.0 105 Heavy",))
        names = canonical_typefaces({"alias": [("a", face)]}, lambda name, face: name)
        self.assertEqual(names, {"alias": "阿里巴巴普惠体 3.0 105 Heavy"})

    def test_gdi_rejects_fallback_even_with_the_same_display_name(self):
        for fallback in (False, True):
            with self.subTest(fallback=fallback):
                tables = {"name": b"same name", "head": b"different file" if fallback else b"expected file"}
                face = replace(self.heavy, fingerprints=tuple((tag, hashlib.sha256(value).hexdigest())
                               for tag, value in {"name": b"same name", "head": b"expected file"}.items()))
                gdi = MagicMock()
                gdi.CreateCompatibleDC.return_value = 1
                gdi.CreateFontW.return_value = 2
                gdi.SelectObject.return_value = 3
                def get_data(dc, tag, offset, buffer, size):
                    value = tables[tag.to_bytes(4, "little").decode()]
                    if buffer is not None:
                        ctypes.memmove(buffer, value, len(value))
                    return len(value)
                gdi.GetFontData.side_effect = get_data
                with patch("wps_renderer.windows_fonts.ctypes.WinDLL", return_value=gdi, create=True):
                    self.assertEqual(verify_font(face.full_name, face), False if fallback else face.full_name)
                gdi.DeleteObject.assert_called_once_with(2)
                gdi.DeleteDC.assert_called_once_with(1)

    def test_activation_rewrites_only_after_session_registration_and_verification(self):
        manager = FontManager()
        sha = "a" * 64
        manager._paths = {sha: self.root / "heavy.ttf"}
        manager._profiles = {sha: (self.heavy,)}
        manager._faces = {name: {sha} for name in self.heavy.full_names}
        manifest = {"required_fonts": ["Friendly"], "font_hashes": [sha],
                    "font_bindings": [{"name": "Friendly", "sha256": sha}], "fonts": []}
        gdi = MagicMock()
        gdi.AddFontResourceExW.return_value = 1
        gdi.RemoveFontResourceExW.return_value = 1
        def verify(name, face):
            gdi.AddFontResourceExW.assert_called_once()
            return True
        with patch("wps_renderer.fonts.os.name", "nt"), patch.object(manager, "installed", return_value={name: {sha} for name in self.heavy.names}), \
                patch("wps_renderer.fonts.ctypes.WinDLL", return_value=gdi, create=True), patch("wps_renderer.fonts.verify_font", side_effect=verify):
            with manager.activate(self.root, manifest) as replacements:
                self.assertEqual(replacements, {"Friendly": self.heavy.full_name})
        gdi.RemoveFontResourceExW.assert_called_once()

    def test_failed_selection_unloads_all_fonts_and_never_enters_converter(self):
        manager = FontManager()
        manager._paths = {"a" * 64: self.root / "heavy.ttf", "b" * 64: self.root / "regular.ttf"}
        manager._profiles = self.profiles
        manager._faces = {}
        manifest = {"required_fonts": [self.heavy.family, self.regular.family],
                    "font_hashes": list(self.profiles), "font_bindings": [], "fonts": []}
        inventory = {name: {sha} for sha, faces in self.profiles.items() for face in faces for name in face.names}
        gdi = MagicMock()
        gdi.AddFontResourceExW.return_value = gdi.RemoveFontResourceExW.return_value = 1
        with patch("wps_renderer.fonts.os.name", "nt"), patch.object(manager, "installed", return_value=inventory), \
                patch("wps_renderer.fonts.ctypes.WinDLL", return_value=gdi, create=True), \
                patch("wps_renderer.fonts.verify_font", return_value=False):
            with self.assertRaises(RenderError) as raised:
                with manager.activate(self.root, manifest):
                    self.fail("An unverified font must not reach the converter")
        self.assertEqual(raised.exception.code, "font_unavailable")
        self.assertEqual(gdi.RemoveFontResourceExW.call_count, 2)
        self.assertTrue(manager._healthy)

    def test_lossless_xml_preserves_text_geometry_bold_and_vertical_fonts(self):
        data = (f'<p:sld xmlns:p="{P}" xmlns:a="{A}" xmlns:other="urn:test">'
                '<!-- typeface="Friendly" --><a:rPr b="1" sz="1800"><a:latin typeface = \'Friendly\'/>'
                '<a:ea typeface="@Friendly"/></a:rPr><a:t>Friendly</a:t><a:off x="123" y="456"/>'
                '<other:latin typeface="Friendly"/><a:font script="Hans" typeface="Friendly"/></p:sld>').encode()
        expected = data.replace(b"typeface = 'Friendly'", b"typeface = 'Real Name'").replace(b'typeface="@Friendly"', b'typeface="@Real Name"').replace(b'script="Hans" typeface="Friendly"', b'script="Hans" typeface="Real Name"')
        self.assertEqual(replace_typefaces(data, {"Friendly": "Real Name"}), expected)
        self.assertEqual(replace_typefaces(data, {"FRIEND_LY": "Real Name"}), expected)

    def test_xml_encoding_and_strict_namespaces_are_preserved(self):
        for encoding in ("utf-8-sig", "utf-16", "utf-16-le", "utf-16-be"):
            with self.subTest(encoding=encoding):
                xml = '<a:ea xmlns:a="http://purl.oclc.org/ooxml/drawingml/main" typeface="中文名"/>'
                data = xml.encode(encoding)
                if encoding == "utf-16-be":
                    data = codecs.BOM_UTF16_BE + data
                expected = xml.replace("中文名", "Canonical Font").encode(encoding)
                if encoding == "utf-16-be":
                    expected = codecs.BOM_UTF16_BE + expected
                self.assertEqual(replace_typefaces(data, {"中文名": "Canonical Font"}), expected)

    def test_job_local_package_changes_no_media_or_layout_and_failure_is_atomic(self):
        source = self.root / "render.pptx"
        xml = f'<a:latin xmlns:a="{A}" typeface="Friendly"/>'.encode()
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("ppt/slides/slide1.xml", xml)
            archive.writestr("ppt/theme/theme1.xml", xml)
            archive.writestr("ppt/media/image1.png", b"unchanged-image")
        original = source.read_bytes()
        with self.assertRaises(RenderError):
            normalize_pptx(source, {"Friendly": "Real Name"}, 1, 1024 * 1024)
        self.assertEqual(source.read_bytes(), original)
        normalize_pptx(source, {"Friendly": "Real Name"}, 1024 * 1024, 1024 * 1024)
        with zipfile.ZipFile(source) as archive:
            self.assertEqual(archive.read("ppt/slides/slide1.xml"), xml.replace(b"Friendly", b"Real Name"))
            self.assertEqual(archive.read("ppt/theme/theme1.xml"), xml.replace(b"Friendly", b"Real Name"))
            self.assertEqual(archive.read("ppt/media/image1.png"), b"unchanged-image")
        self.assertFalse(source.with_suffix(".font-names.tmp").exists())


if __name__ == "__main__":
    unittest.main()
