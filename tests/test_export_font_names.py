from __future__ import annotations

import codecs
from contextlib import ExitStack
import json
import sqlite3
import struct
import tempfile
import unittest
import zipfile
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTCollection, TTFont
from pptx import Presentation

from app.config import settings
from app.core import download_tasks
from app.core.fonts import FontResolutionError, normalize_font_name
from app.core.permissions import require_user
from app.core.ppt_modules.fonts import replace_typefaces
from app.routers import templates
from app.routers.dependencies import db_dep, db_read_dep
from app.routers.resources import files as resources
from app.routers.shows import downloads as shows
from app.services.downloads.cache import _show_download_cache_key
from app.services.downloads import embed_fonts as embedding
from app.services.downloads.embed_fonts import FontRow, embed_fonts_in_pptx
from app.services.downloads.fonts import normalized_pptx_bytes, resolve_font_typefaces


A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
BAD_NAME = "阿里巴巴普惠体3-55-Regular"
FAMILY = "Alibaba PuHuiTi 3.0 55 Regular"


def make_font(path, family=FAMILY, *, style="Regular", weight=400):
    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder([".notdef", "space"])
    builder.setupCharacterMap({32: "space"})
    pen = TTGlyphPen(None)
    builder.setupGlyf({".notdef": pen.glyph(), "space": pen.glyph()})
    builder.setupHorizontalMetrics({".notdef": (500, 0), "space": (250, 0)})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": family, "styleName": style,
                            "fullName": family + " " + style,
                            "psName": family.replace(" ", "") + "-" + style,
                            "typographicFamily": "Alibaba PuHuiTi 3.0"})
    builder.font["name"].setName("阿里巴巴普惠体 3 55 Regular", 4, 3, 1, 0x804)
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800,
                     usWinDescent=200, usWeightClass=weight)
    builder.setupPost()
    builder.setupMaxp()
    builder.save(path)


class ExportFontNameTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="slideflow-export-names-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.font = self.root / "Hanyi Alibaba-PuHuiTi-3-55-Regular.ttf"
        make_font(self.font)
        self.ppt = self.root / "source.pptx"
        deck = Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        run = slide.shapes.add_textbox(123, 456, 1000000, 900000).text_frame.paragraphs[0].add_run()
        run.text = "中文 English " + BAD_NAME
        run.font.name = BAD_NAME
        run.font.bold = True
        deck.save(self.ppt)
        self.original = self.ppt.read_bytes()
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.execute("CREATE TABLE fonts (id INTEGER PRIMARY KEY, family_name TEXT, aliases TEXT, file_path TEXT)")
        # Deliberately use an invented display name. It must never reach XML.
        self.db.execute("INSERT INTO fonts VALUES (1, ?, ?, ?)",
                        ("Friendly display", json.dumps([BAD_NAME]), str(self.font)))
        patcher = patch.object(settings, "fonts_dir", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.items = [{"name": "Export", "version_no": 1, "ppt_path": str(self.ppt),
                       "font_names": [BAD_NAME], "missing_fonts": [], "is_hidden": False}]

    def assert_repaired(self, content):
        with zipfile.ZipFile(BytesIO(self.original)) as source, zipfile.ZipFile(BytesIO(content)) as output:
            slide = source.read("ppt/slides/slide1.xml")
            expected = slide.replace(('typeface="' + BAD_NAME + '"').encode(), ('typeface="' + FAMILY + '"').encode())
            self.assertEqual(output.read("ppt/slides/slide1.xml"), expected)
            self.assertEqual(output.read("ppt/theme/theme1.xml"), source.read("ppt/theme/theme1.xml"))
        self.assertEqual(self.ppt.read_bytes(), self.original)
        self.assertEqual(len(Presentation(BytesIO(content)).slides), 1)

    def test_plain_export_uses_real_family_and_changes_only_font_attributes(self):
        self.assert_repaired(normalized_pptx_bytes(self.ppt, self.db))

    def test_embedded_family_agrees_with_eot_and_sfnt_and_aliases_are_deduplicated(self):
        row = FontRow("Friendly display", (BAD_NAME, FAMILY), self.font)
        with patch("app.services.downloads.embed_fonts._font_rows", return_value=({normalize_font_name(BAD_NAME): row}, [row])), \
                patch.object(embedding, "_font_data", wraps=embedding._font_data) as convert:
            content = embed_fonts_in_pptx(self.ppt, None, [BAD_NAME, FAMILY])
        convert.assert_called_once()
        self.assert_repaired(content)
        with zipfile.ZipFile(BytesIO(content)) as package:
            root = ET_from(package.read("ppt/presentation.xml"))
            entries = root.findall(f"{{{P}}}embeddedFontLst/{{{P}}}embeddedFont")
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0].find(f"{{{P}}}font").get("typeface"), FAMILY)
            data = package.read("ppt/fonts/font1.fntdata")
            self.assertEqual(entries[0].find(f"{{{P}}}font").get("charset"), str(data[26]))
            size = struct.unpack_from("<H", data, 82)[0]
            self.assertEqual(data[84:84 + size].decode("utf-16le"), FAMILY)
            payload_size = struct.unpack_from("<I", data, 4)[0]
            with TTFont(BytesIO(data[-payload_size:])) as font:
                self.assertEqual(font["name"].getDebugName(1), FAMILY)
                self.assertEqual(struct.unpack_from("<I", data, 60)[0], font["head"].checkSumAdjustment)
            self.assertEqual(len([name for name in package.namelist() if name.endswith(".fntdata")]), 1)

    def test_heavy_family_is_embedded_as_regular_instead_of_missing_normal_face(self):
        make_font(self.font, family="Heavy Face", weight=900)
        with TTFont(self.font) as font:
            font["OS/2"].fsSelection |= 0x20
            font["head"].macStyle |= 1
            # PuHuiTi uses a broad Mac family plus a numbered subfamily, but
            # a separate Windows family whose subfamily is Regular.
            font["name"].setName("Alibaba PuHuiTi 3.0", 1, 1, 0, 0)
            font["name"].setName("105 Heavy", 2, 1, 0, 0)
            font.save(self.font)
        row = FontRow("Display", (BAD_NAME,), self.font)
        with patch("app.services.downloads.embed_fonts._font_rows", return_value=({normalize_font_name(BAD_NAME): row}, [row])):
            content = embed_fonts_in_pptx(self.ppt, None, [BAD_NAME])
        with zipfile.ZipFile(BytesIO(content)) as package:
            entry = ET_from(package.read("ppt/presentation.xml")).find(f"{{{P}}}embeddedFontLst/{{{P}}}embeddedFont")
            self.assertIsNotNone(entry.find(f"{{{P}}}regular"))
            self.assertIsNone(entry.find(f"{{{P}}}bold"))

    def test_linked_family_combines_regular_and_bold_entries(self):
        bold = self.root / "bold.ttf"
        make_font(bold, style="Bold", weight=700)
        rows = [FontRow("Regular", (FAMILY,), self.font), FontRow("Bold", (FAMILY,), bold)]
        with patch("app.services.downloads.embed_fonts._font_rows", return_value=({normalize_font_name(FAMILY): rows[0]}, rows)):
            content = embed_fonts_in_pptx(self.ppt, None, [FAMILY])
        with zipfile.ZipFile(BytesIO(content)) as package:
            entry = ET_from(package.read("ppt/presentation.xml")).find(f"{{{P}}}embeddedFontLst/{{{P}}}embeddedFont")
            self.assertEqual([child.tag.rsplit("}", 1)[-1] for child in entry], ["font", "regular", "bold"])

    def test_collection_alias_selects_the_requested_face_and_ambiguous_alias_fails(self):
        heavy = self.root / "heavy.ttf"
        make_font(heavy, family="Heavy Face", weight=900)
        with TTFont(heavy) as font:
            for record in list(font["name"].names):
                if record.nameID == 4 and record.langID == 0x804:
                    font["name"].names.remove(record)
            font.save(heavy)
        collection_path = self.root / "faces.ttc"
        collection = TTCollection()
        collection.fonts = [TTFont(self.font), TTFont(heavy)]
        collection.save(collection_path)
        collection.close()
        sources = [("Collection label", ("Collection label",), collection_path)]
        match = resolve_font_typefaces(["Heavy Face"], sources)["Heavy Face"][0]
        self.assertEqual(match.face_index, 1)
        with self.assertRaises(FontResolutionError):
            resolve_font_typefaces(["Collection label"], sources)
        row = FontRow("Collection label", (FAMILY, "Heavy Face"), collection_path)
        with patch("app.services.downloads.embed_fonts._font_rows", return_value=({"heavyface": row}, [row])):
            content = embed_fonts_in_pptx(self.ppt, None, ["Heavy Face"])
        with zipfile.ZipFile(BytesIO(content)) as package:
            data = package.read("ppt/fonts/font1.fntdata")
            payload_size = struct.unpack_from("<I", data, 4)[0]
            with TTFont(BytesIO(data[-payload_size:])) as font:
                self.assertEqual(font["OS/2"].usWeightClass, 900)

    def test_non_embedded_export_removes_old_font_payload_and_declarations(self):
        row = FontRow("Display", (BAD_NAME,), self.font)
        with patch("app.services.downloads.embed_fonts._font_rows", return_value=({normalize_font_name(BAD_NAME): row}, [row])):
            self.ppt.write_bytes(embed_fonts_in_pptx(self.ppt, None, [BAD_NAME]))
        content = normalized_pptx_bytes(self.ppt, self.db)
        with zipfile.ZipFile(BytesIO(content)) as package:
            self.assertFalse(any(name.endswith(".fntdata") for name in package.namelist()))
            self.assertIsNone(ET_from(package.read("ppt/presentation.xml")).find(f"{{{P}}}embeddedFontLst"))
            self.assertNotIn(b"/relationships/font", package.read("ppt/_rels/presentation.xml.rels"))

    def test_plain_cache_keys_include_font_library_and_source_changes(self):
        for kind in ("pptx", "zip", "pptx_pages", "pptx_fonts", "pptx_embedded"):
            with self.subTest(kind=kind):
                before = _show_download_cache_key(1, kind, self.items, db=self.db)
                self.font.write_bytes(self.font.read_bytes() + b"changed")
                self.assertNotEqual(before, _show_download_cache_key(1, kind, self.items, db=self.db))

    def test_worker_merge_zip_and_page_exports_use_the_same_name_correction(self):
        with patch.object(download_tasks, "_safe_abs", side_effect=lambda ref: Path(ref)):
            for embedded, bundle in ((False, False), (False, True), (True, False)):
                with self.subTest(embedded=embedded, bundle=bundle):
                    out = self.root / ("result.zip" if bundle else "result.pptx")
                    # Avoid persisting a synthetic font in the application's DB.
                    with patch("app.services.downloads.embed_fonts._persist_generated_cache"):
                        download_tasks._generate_pptx(self.db, 1, "Show", self.items, "", bundle, embedded, out)
                    if bundle:
                        with zipfile.ZipFile(out) as package:
                            self.assert_repaired(package.read("Show.pptx"))
                    else:
                        self.assert_repaired(out.read_bytes())
            for generate in (download_tasks._generate_zip, download_tasks._generate_pptx_pages):
                out = self.root / "pages.zip"
                args = (self.db, 1, "Show", self.items, "")
                generate(*args, False, out) if generate == download_tasks._generate_zip else generate(*args, out)
                with zipfile.ZipFile(out) as package:
                    content = package.read(next(name for name in package.namelist() if name.endswith(".pptx")))
                    slide = zipfile.ZipFile(BytesIO(content)).read("ppt/slides/slide1.xml")
                    self.assertIn(('typeface="' + FAMILY + '"').encode(), slide)
                    self.assertIn(BAD_NAME.encode(), slide)  # Literal slide text is intact.

    def test_resource_template_and_sync_show_downloads_normalize_every_format(self):
        app = FastAPI()
        for router in (resources.router, templates.router, shows.router):
            app.include_router(router)
        app.dependency_overrides[require_user] = lambda: {"id": 1}
        app.dependency_overrides[db_read_dep] = lambda: self.db
        app.dependency_overrides[db_dep] = lambda: self.db
        row = {"name": "Export", "office_path": str(self.ppt), "office_file_name": "source.pptx",
               "font_names": json.dumps([BAD_NAME]), "missing_fonts": "[]"}
        version = {"version_no": 1, "ppt_path": str(self.ppt),
                   "font_names": json.dumps([BAD_NAME]), "missing_fonts": "[]"}
        with TestClient(app) as client, ExitStack() as stack:
            for context in (
                patch.object(resources, "_resource_row", return_value=row),
                patch.object(resources, "_version_row", return_value=version),
                patch.object(resources, "can_manage_resource", return_value=True),
                patch.object(resources, "_resource_file_abs", return_value=self.ppt),
                patch.object(templates, "_template_row", return_value=row),
                patch.object(templates, "can_view_template", return_value=True),
                patch.object(templates, "_resource_file_abs", return_value=self.ppt),
                patch.object(shows, "_show_row", return_value=row),
                patch.object(shows, "can_view_show", return_value=True),
                patch.object(shows, "_record_download", return_value="track"),
                patch.object(shows, "_collect_show_accessible_resources", return_value=self.items),
                patch.object(shows, "require_export_asset", return_value=self.ppt),
                patch.object(shows, "_get_cached_download", return_value=None),
                patch.object(shows, "_save_to_cache"),
                patch.object(settings, "downloads_dir", self.root),
                patch("app.services.downloads.embed_fonts._persist_generated_cache"),
            ):
                stack.enter_context(context)
            for kind in ("resources", "templates"):
                for fmt in ("pptx", "pptx-embedded", "zip"):
                    with self.subTest(kind=kind, fmt=fmt):
                        response = client.get(f"/api/{kind}/1/download?format={fmt}")
                        self.assertEqual(response.status_code, 200, response.text[:100] if response.status_code != 200 else "")
                        if fmt == "zip":
                            with zipfile.ZipFile(BytesIO(response.content)) as package:
                                self.assert_repaired(package.read(next(n for n in package.namelist() if n.endswith(".pptx"))))
                        else:
                            self.assert_repaired(response.content)
            for kind in ("pptx", "zip"):
                response = client.get(f"/api/shows/1/download/{kind}")
                self.assertEqual(response.status_code, 200)
                if kind == "pptx":
                    self.assert_repaired(response.content)
                else:
                    with zipfile.ZipFile(BytesIO(response.content)) as package:
                        self.assert_repaired(package.read("Export_v1.pptx"))

    def test_lossless_replacement_covers_scripts_bullets_strict_xml_and_vertical_names(self):
        xml = (f'<p:sld xmlns:p="{P}" xmlns:a="{A}" xmlns:x="urn:other">'
               '<a:rPr b="1" sz="1800"><a:latin typeface="Alias"/><a:ea typeface="@Alias"/>'
               '<a:cs typeface="Alias"/><a:sym typeface="Alias"/></a:rPr><a:buFont typeface="Alias"/>'
               '<a:font script="Hans" typeface="Alias"/><a:t>Alias</a:t>'
               '<x:font typeface="Alias"/><a:latin typeface="+mn-lt"/></p:sld>')
        expected = xml.replace('typeface="Alias"', 'typeface="Real &amp; Family"').replace('typeface="@Alias"', 'typeface="@Real &amp; Family"')
        expected = expected.replace('<x:font typeface="Real &amp; Family"', '<x:font typeface="Alias"')
        for encoding in ("utf-8", "utf-8-sig", "utf-16", "utf-16-be"):
            with self.subTest(encoding=encoding):
                data = xml.encode(encoding)
                want = expected.encode(encoding)
                if encoding == "utf-16-be":
                    data, want = codecs.BOM_UTF16_BE + data, codecs.BOM_UTF16_BE + want
                self.assertEqual(replace_typefaces(data, {"Alias": "Real & Family"}), want)
        strict = b'<a:ea xmlns:a="http://purl.oclc.org/ooxml/drawingml/main" typeface="Alias"/>'
        self.assertIn(b'typeface="Real"', replace_typefaces(strict, {"Alias": "Real"}))


def ET_from(data):
    from xml.etree import ElementTree
    return ElementTree.fromstring(data)
