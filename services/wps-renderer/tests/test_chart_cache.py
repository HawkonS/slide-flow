import hashlib
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wps_renderer.chart_cache import CHART, OFFICE_RELS, RELS, WORKBOOK_TYPE
from wps_renderer.config import Settings
from wps_renderer.errors import RenderError
from wps_renderer.validation import prepare_render_pptx, unpack_bundle, validate_pptx
from test_service import pptx


def chart_pptx(*, cache=True, refresh=False, extra=None, shared=False, workbook_type=WORKBOOK_TYPE):
    cached = '<c:numCache><c:ptCount val="1"/><c:pt idx="0"><c:v>42</c:v></c:pt></c:numCache>' if cache else ''
    parts = {
        'ppt/charts/chart1.xml': (
            f'<c:chartSpace xmlns:c="{CHART}" xmlns:r="{OFFICE_RELS}" xmlns:mc="urn:mc" xmlns:vendor="urn:vendor" mc:Ignorable="vendor">'
            f'<c:chart><c:plotArea><c:barChart><c:ser><c:val><c:numRef><c:f>Sheet1!$A$1</c:f>{cached}'
            '</c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart>'
            f'<c:externalData r:id="rId1"><c:autoUpdate val="{int(refresh)}"/></c:externalData></c:chartSpace>'
        ),
        'ppt/charts/_rels/chart1.xml.rels': (
            f'<Relationships xmlns="{RELS}"><Relationship Id="rId1" Type="{OFFICE_RELS}/package" Target="../embeddings/chart.xlsx"/></Relationships>'
        ),
        'ppt/embeddings/chart.xlsx': b'not opened or executed; deleted from render copy',
    }
    if shared:
        parts['ppt/slides/_rels/slide1.xml.rels'] = (
            f'<Relationships xmlns="{RELS}"><Relationship Id="shared" Type="{OFFICE_RELS}/image" Target="../embeddings/chart.xlsx"/></Relationships>'
        )
    parts.update(extra or {})
    raw = pptx(parts)
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw)) as source, zipfile.ZipFile(output, 'w') as dest:
        for info in source.infolist():
            data = source.read(info)
            if info.filename == '[Content_Types].xml':
                data = data.replace(b'/>', (f'><Override PartName="/ppt/embeddings/chart.xlsx" ContentType="{workbook_type}"/></Types>').encode())
            dest.writestr(info, data)
    return output.getvalue()


class CachedChartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'render.pptx'

    def test_render_copy_keeps_chart_values_namespaces_and_other_parts(self):
        original = chart_pptx()
        self.path.write_bytes(original)
        with self.assertRaises(RenderError):
            validate_pptx(self.path, 1024 * 1024)
        prepare_render_pptx(self.path, 1024 * 1024)
        validate_pptx(self.path, 1024 * 1024)
        with zipfile.ZipFile(self.path) as result, zipfile.ZipFile(io.BytesIO(original)) as source:
            self.assertNotIn('ppt/embeddings/chart.xlsx', result.namelist())
            chart = result.read('ppt/charts/chart1.xml')
            self.assertIn(b'<c:v>42</c:v>', chart)
            self.assertIn(b'mc:Ignorable="vendor"', chart)
            self.assertIn(b'xmlns:vendor="urn:vendor"', chart)
            self.assertNotIn(b'externalData', chart)
            for name in ('ppt/slides/slide1.xml', 'ppt/presentation.xml'):
                self.assertEqual(result.read(name), source.read(name))

    def test_no_chart_package_is_byte_identical(self):
        original = pptx()
        self.path.write_bytes(original)
        prepare_render_pptx(self.path, 1024 * 1024)
        self.assertEqual(self.path.read_bytes(), original)

    def test_failed_preparation_preserves_original_and_removes_temporary_copy(self):
        for options, code in (
            ({'cache': False}, 'chart_cache_missing'),
            ({'refresh': True}, 'chart_cache_missing'),
            ({'shared': True}, 'unsafe_pptx'),
            ({'workbook_type': 'application/vnd.ms-excel.sheet.macroEnabled.12'}, 'unsafe_pptx'),
            ({'extra': {'ppt/embeddings/object.bin': b'OLE'}}, 'unsafe_pptx'),
            ({'extra': {'ppt/vbaProject.bin': b'macro'}}, 'unsafe_pptx'),
            ({'extra': {'ppt/slides/_rels/slide1.xml.rels': f'<Relationships xmlns="{RELS}"><Relationship Id="x" Type="{OFFICE_RELS}/image" TargetMode="External" Target="https://example.com/a.png"/></Relationships>'}}, 'unsafe_pptx'),
        ):
            with self.subTest(options=options):
                original = chart_pptx(**options)
                self.path.write_bytes(original)
                with self.assertRaises(RenderError) as caught:
                    prepare_render_pptx(self.path, 1024 * 1024)
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(self.path.read_bytes(), original)
                self.assertFalse(self.path.with_suffix('.cached.tmp').exists())

    def test_v1_and_v2_check_original_hash_before_normalizing_private_input(self):
        data = chart_pptx()
        for version in (1, 2):
            with self.subTest(version=version):
                filename = 'pages/0.pptx' if version == 1 else 'source/deck.pptx'
                item = {'file': filename, 'sha256': hashlib.sha256(data).hexdigest()}
                manifest = {'version': version, 'dpi': 150, 'fonts': [], 'required_fonts': []}
                if version == 1:
                    manifest['pages'] = [dict(item, index=0)]
                else:
                    manifest['source'] = dict(item, slide_count=1)
                    manifest['pages'] = [{'index': 0, 'slide': 1}]
                bundle = self.root / f'bundle-{version}.zip'
                with zipfile.ZipFile(bundle, 'w') as package:
                    package.writestr('manifest.json', json.dumps(manifest))
                    package.writestr(filename, data)
                original_bundle = bundle.read_bytes()
                settings = Settings(wpscli='fake', data_dir=str(self.root), token='x' * 40)
                destination = self.root / str(version)
                unpack_bundle(bundle, destination, settings)
                validate_pptx(destination / filename, 1024 * 1024)
                self.assertEqual(bundle.read_bytes(), original_bundle)
                self.assertNotEqual((destination / filename).read_bytes(), data)
                bad_manifest = json.loads(json.dumps(manifest))
                entry = bad_manifest['pages'][0] if version == 1 else bad_manifest['source']
                entry['sha256'] = '0' * 64
                with zipfile.ZipFile(bundle, 'w') as package:
                    package.writestr('manifest.json', json.dumps(bad_manifest))
                    package.writestr(filename, data)
                with self.assertRaises(RenderError) as caught:
                    unpack_bundle(bundle, self.root / f'bad-{version}', settings)
                self.assertEqual(caught.exception.code, 'checksum_mismatch')


if __name__ == '__main__':
    unittest.main()
