import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from app.core.ppt import detect_ppt_fonts
from app.core.resource_import_fonts import replace_ppt_fonts


A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
R = "http://schemas.openxmlformats.org/package/2006/relationships"


def shape(text, *, run_props="", paragraph_props="", list_style="", placeholder="", style=""):
    ph = f"<p:ph {placeholder}/>" if placeholder else ""
    return (
        f"<p:sp><p:nvSpPr><p:nvPr>{ph}</p:nvPr></p:nvSpPr>{style}<p:txBody>"
        f"<a:bodyPr/><a:lstStyle>{list_style}</a:lstStyle><a:p>{paragraph_props}"
        f"<a:r>{run_props}<a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>"
    )


def slide(body, root="sld", extra=""):
    return f'<p:{root} xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree>{body}</p:spTree></p:cSld>{extra}</p:{root}>'.encode()


def relationships(*links):
    return (f'<Relationships xmlns="{R}">' + "".join(
        f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}" Target="{target}"/>'
        for i, (kind, target) in enumerate(links)
    ) + "</Relationships>").encode()


THEME = f'''<a:theme xmlns:a="{A}"><a:themeElements><a:fontScheme name="Fixture">
<a:majorFont><a:latin typeface="Heading Latin"/><a:ea typeface=""/><a:cs typeface=""/>
<a:font script="Hans" typeface="Heading Chinese"/><a:font script="Jpan" typeface="Unused Japanese Heading"/></a:majorFont>
<a:minorFont><a:latin typeface="Body Latin"/><a:ea typeface=""/><a:cs typeface=""/>
<a:font script="Hans" typeface="Body Chinese"/><a:font script="Hant" typeface="Traditional Chinese"/>
<a:font script="Jpan" typeface="Japanese"/><a:font script="Arab" typeface="Arabic"/>
<a:font script="Thai" typeface="Unused Thai"/></a:minorFont>
</a:fontScheme></a:themeElements></a:theme>'''.encode()


class ResourceImportFontTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / "input.pptx"
        self.target = Path(self.temp.name) / "output.pptx"

    def package(self, slide_body, *, layout_body="", master_body="", master_styles="", default_style="", theme=True, extra=None):
        parts = {
            "ppt/slides/slide1.xml": slide(slide_body),
            "ppt/slides/_rels/slide1.xml.rels": relationships(("slideLayout", "../slideLayouts/slideLayout1.xml")),
            "ppt/slideLayouts/slideLayout1.xml": slide(layout_body, "sldLayout"),
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels": relationships(("slideMaster", "../slideMasters/slideMaster1.xml")),
            "ppt/slideMasters/slideMaster1.xml": slide(master_body, "sldMaster", f"<p:txStyles>{master_styles}</p:txStyles>"),
            "ppt/presentation.xml": f'<p:presentation xmlns:p="{P}" xmlns:a="{A}"><p:defaultTextStyle>{default_style}</p:defaultTextStyle></p:presentation>'.encode(),
        }
        if theme:
            parts["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = relationships(("theme", "../theme/theme1.xml"))
            parts["ppt/theme/theme1.xml"] = THEME
        parts.update(extra or {})
        with zipfile.ZipFile(self.source, "w") as package:
            for name, data in parts.items():
                package.writestr(name, data)
        return parts

    def test_explicit_run_uses_only_fonts_for_actual_scripts(self):
        self.package(shape("中文", run_props='<a:rPr><a:latin typeface="Unused Latin"/><a:ea typeface="微软雅黑"/><a:cs typeface="Unused Complex"/></a:rPr>'))
        self.assertEqual(detect_ppt_fonts(self.source), ["微软雅黑"])

    def test_theme_tokens_resolve_only_languages_in_text(self):
        self.package(shape("Hello中文", run_props='<a:rPr><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:rPr>'))
        self.assertEqual(detect_ppt_fonts(self.source), ["Body Chinese", "Body Latin"])

    def test_paragraph_and_list_defaults_are_inherited(self):
        self.package(shape("Hello中文", paragraph_props='<a:pPr><a:defRPr><a:latin typeface="Paragraph Latin"/></a:defRPr><a:buFont typeface="Unused Bullet"/></a:pPr>', list_style='<a:lvl1pPr><a:defRPr><a:ea typeface="List Chinese"/></a:defRPr></a:lvl1pPr>'))
        self.assertEqual(detect_ppt_fonts(self.source), ["List Chinese", "Paragraph Latin"])

    def test_layout_idx_and_master_type_inheritance(self):
        self.package(
            shape("Hello中文", placeholder='idx="7"'),
            layout_body=shape("Template", placeholder='idx="7" type="body"', list_style='<a:lvl1pPr><a:defRPr><a:latin typeface="Layout Latin"/></a:defRPr></a:lvl1pPr>'),
            master_body=shape("Master template", placeholder='idx="1" type="body"', list_style='<a:lvl1pPr><a:defRPr><a:ea typeface="Master Chinese"/></a:defRPr></a:lvl1pPr>'),
        )
        self.assertEqual(detect_ppt_fonts(self.source), ["Layout Latin", "Master Chinese"])

    def test_title_master_style_resolves_major_theme(self):
        self.package(
            shape("Title中文", placeholder='type="title"'),
            layout_body=shape("Unused sample", placeholder='type="title"'),
            master_styles='<p:titleStyle><a:lvl1pPr><a:defRPr><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:lvl1pPr></p:titleStyle>',
        )
        self.assertEqual(detect_ppt_fonts(self.source), ["Heading Chinese", "Heading Latin"])

    def test_presentation_defaults_without_explicit_run_properties(self):
        self.package(shape("Hello"), default_style='<a:lvl1pPr><a:defRPr><a:latin typeface="Presentation Font"/></a:defRPr></a:lvl1pPr>')
        self.assertEqual(detect_ppt_fonts(self.source), ["Presentation Font"])

    def test_east_asian_language_and_complex_script_theme_defaults(self):
        self.package(shape("繁體字", run_props='<a:rPr lang="en-US" altLang="zh-TW"/>') + shape("مرحبا"))
        self.assertEqual(detect_ppt_fonts(self.source), ["Arabic", "Traditional Chinese"])

    def test_major_font_reference_without_explicit_typefaces(self):
        self.package(shape("Hello", style='<p:style><a:fontRef idx="major"/></p:style>'))
        self.assertEqual(detect_ppt_fonts(self.source), ["Heading Latin"])

    def test_static_master_text_but_not_placeholder_prompt(self):
        self.package(shape(""), master_body=shape("Visible", run_props='<a:rPr><a:latin typeface="Watermark Font"/></a:rPr>') + shape("Prompt", placeholder='type="body"', run_props='<a:rPr><a:latin typeface="Unused Prompt"/></a:rPr>'))
        self.assertEqual(detect_ppt_fonts(self.source), ["Watermark Font"])

    def test_field_text_is_detected(self):
        body = shape("123", run_props='<a:rPr><a:latin typeface="Field Font"/></a:rPr>').replace("<a:r>", '<a:fld id="id" type="slidenum">').replace("</a:r>", "</a:fld>")
        self.package(body)
        self.assertEqual(detect_ppt_fonts(self.source), ["Field Font"])

    def test_strict_namespace_is_detected(self):
        strict = slide(shape("Hello", run_props='<a:rPr><a:latin typeface="Strict Font"/></a:rPr>')).replace(A.encode(), b"http://purl.oclc.org/ooxml/drawingml/main").replace(P.encode(), b"http://purl.oclc.org/ooxml/presentationml/main")
        self.package("", extra={"ppt/slides/slide1.xml": strict})
        self.assertEqual(detect_ppt_fonts(self.source), ["Strict Font"])

    def test_symbol_characters_can_use_latin_slot(self):
        self.package(shape("\uf0fc", run_props='<a:rPr><a:latin typeface="Wingdings"/></a:rPr>'))
        self.assertEqual(detect_ppt_fonts(self.source), ["Wingdings"])

    def test_malformed_unrelated_xml_does_not_abort_detection(self):
        self.package(shape("Hello", run_props='<a:rPr><a:latin typeface="Valid Font"/></a:rPr>'), extra={"ppt/slides/slide2.xml": b"<not xml"})
        self.assertEqual(detect_ppt_fonts(self.source), ["Valid Font"])

    def test_replacement_is_simultaneous_and_never_changes_text(self):
        original = f'''<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="{P}" xmlns:draw="{A}" xmlns:other="urn:custom"><!-- typeface="A" -->
<draw:latin typeface = 'A'/><draw:ea typeface="B"/><draw:t>A</draw:t>
<other:latin typeface="A"/><draw:t><![CDATA[typeface="A"]]></draw:t></p:sld>'''.encode()
        self.package("", extra={"ppt/slides/slide1.xml": original, "ppt/media/image1.png": b"binary-image"})
        replace_ppt_fonts(self.source, {"A": "B", "B": "C"}, self.target)
        expected = original.replace(b"typeface = 'A'", b"typeface = 'B'").replace(b'<draw:ea typeface="B"', b'<draw:ea typeface="C"')
        with zipfile.ZipFile(self.target) as package:
            self.assertEqual(package.read("ppt/slides/slide1.xml"), expected)
            self.assertEqual(package.read("ppt/media/image1.png"), b"binary-image")

    def test_replacement_matches_entities_and_escapes_target(self):
        original = f'<a:latin xmlns:a="{A}" typeface="A&amp;B&#32;Font"/>'.encode()
        self.package("", extra={"ppt/theme/custom.xml": original})
        replace_ppt_fonts(self.source, {"A&B Font": 'C & "D" <E> \'F\''}, self.target)
        with zipfile.ZipFile(self.target) as package:
            replaced = package.read("ppt/theme/custom.xml")
        self.assertEqual(ET.fromstring(replaced).get("typeface"), 'C & "D" <E> \'F\'')

    def test_unrelated_attribute_values_cannot_be_mistaken_for_typeface(self):
        original = f'''<a:latin xmlns:a="{A}" custom=' typeface="A" ' typeface='A'/>'''.encode()
        self.package("", extra={"ppt/theme/custom.xml": original})
        replace_ppt_fonts(self.source, {"A": "B"}, self.target)
        with zipfile.ZipFile(self.target) as package:
            self.assertEqual(package.read("ppt/theme/custom.xml"), original.replace(b"typeface='A'", b"typeface='B'"))

    def test_utf16_replacement_preserves_encoding(self):
        original = f'<?xml version="1.0" encoding="UTF-16"?><a:latin xmlns:a="{A}" typeface="微软雅黑"/>'.encode("utf-16")
        self.package("", extra={"ppt/theme/custom.xml": original})
        replace_ppt_fonts(self.source, {"微软雅黑": "宋体"}, self.target)
        with zipfile.ZipFile(self.target) as package:
            replaced = package.read("ppt/theme/custom.xml")
        self.assertEqual(replaced, original.decode("utf-16").replace("微软雅黑", "宋体").encode("utf-16"))

    def test_utf16_without_bom_replacement_preserves_encoding(self):
        original = f'<?xml version="1.0" encoding="UTF-16"?><a:latin xmlns:a="{A}" typeface="A"/>'.encode("utf-16-le")
        self.package("", extra={"ppt/theme/custom.xml": original})
        replace_ppt_fonts(self.source, {"A": "B"}, self.target)
        with zipfile.ZipFile(self.target) as package:
            replaced = package.read("ppt/theme/custom.xml")
        self.assertEqual(replaced, original.replace("typeface=\"A\"".encode("utf-16-le"), "typeface=\"B\"".encode("utf-16-le")))

    def test_theme_replacement_changes_detected_inherited_font(self):
        self.package(shape("中文"))
        replace_ppt_fonts(self.source, {"Body Chinese": "Replacement Chinese"}, self.target)
        self.assertEqual(detect_ppt_fonts(self.target), ["Replacement Chinese"])


if __name__ == "__main__":
    unittest.main()
