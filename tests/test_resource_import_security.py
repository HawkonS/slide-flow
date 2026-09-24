"""Isolated safety checks for the resource-import wizard (no live DB writes)."""

import asyncio
import io
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException, UploadFile, FastAPI, File
from fastapi.testclient import TestClient
from starlette.requests import Request
from PIL import Image

from app.middleware import resource_import as import_guard
from app.middleware.resource_import import ResourceImportRequestGuard
from app.services.resource_import import limits as import_limits
from app.services.resource_import import sessions as import_sessions
from app.services.resource_import import validation as import_validation


class ResourceImportSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="slideflow-import-security-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def reject(self, status, callback, *args):
        with self.assertRaises(HTTPException) as caught:
            callback(*args)
        self.assertEqual(caught.exception.status_code, status)

    def test_oversized_stream_removes_partial_upload(self):
        upload = UploadFile(filename="source.pptx", file=io.BytesIO(b"0123456789"))
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(import_validation._save_resource_import_upload(upload, self.root, "source_", max_bytes=4, total_bytes=0))
        self.assertEqual(caught.exception.status_code, 413)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_batch_stream_limit_removes_partial_upload(self):
        upload = UploadFile(filename="image.png", file=io.BytesIO(b"0123456789"))
        with patch.object(import_validation, "RESOURCE_IMPORT_MAX_TOTAL_BYTES", 12):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(import_validation._save_resource_import_upload(upload, self.root, "image_", max_bytes=100, total_bytes=3))
        self.assertEqual(caught.exception.status_code, 413)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_actual_image_format_and_pixel_limit_are_enforced(self):
        image = self.root / "image.png"
        Image.new("RGB", (3, 2)).save(image)
        import_validation._validate_import_image(image)
        wrong_suffix = self.root / "wrong.jpg"
        wrong_suffix.write_bytes(image.read_bytes())
        self.reject(400, import_validation._validate_import_image, wrong_suffix)
        with patch.object(import_validation, "RESOURCE_IMPORT_MAX_IMAGE_PIXELS", 5):
            self.reject(413, import_validation._validate_import_image, image)
        image.write_bytes(b"not an image")
        self.reject(400, import_validation._validate_import_image, image)

    def test_ppt_zip_expansion_and_traversal_are_rejected(self):
        ppt = self.root / "source.pptx"
        with zipfile.ZipFile(ppt, "w", zipfile.ZIP_DEFLATED) as package:
            package.writestr("ppt/presentation.xml", b"a" * 100)
        with patch.object(import_validation, "RESOURCE_IMPORT_MAX_PPT_UNCOMPRESSED_BYTES", 99):
            self.reject(413, import_validation._validate_import_ppt_package, ppt)
        with zipfile.ZipFile(ppt, "w") as package:
            package.writestr("../outside.xml", b"x")
        self.reject(400, import_validation._validate_import_ppt_package, ppt)

    def test_session_files_must_be_regular_and_contained(self):
        sid = "a" * 32
        folder = self.root / sid
        folder.mkdir()
        source = folder / "source.pptx"
        source.write_bytes(b"fixture")
        outside = self.root / "other.pptx"
        outside.write_bytes(b"outside")
        session = {"session_id": sid, "temp_dir": str(folder)}
        with patch.object(import_sessions, "_resource_import_root", return_value=self.root):
            self.assertEqual(import_sessions._resource_import_file(session, str(source)), source)
            self.reject(410, import_sessions._resource_import_file, session, str(outside))
            self.reject(410, import_sessions._resource_import_file, session, str(folder))
            linked = folder / "linked.pptx"
            linked.symlink_to(source)
            self.reject(410, import_sessions._resource_import_file, session, str(linked))
            nested = folder / "nested"
            nested.mkdir()
            (nested / "source.pptx").write_bytes(b"fixture")
            alias = folder / "alias"
            alias.symlink_to(nested, target_is_directory=True)
            self.reject(410, import_sessions._resource_import_file, session, str(alias / "source.pptx"))

    def test_font_mapping_is_limited_to_detected_fonts(self):
        session = {"fonts": ["微软雅黑"]}
        self.assertEqual(import_validation._validate_resource_import_replacements(session, {"微软雅黑": "Arial"}, {"arial"}), {"微软雅黑": "Arial"})
        self.reject(400, import_validation._validate_resource_import_replacements, session, {"Not in PPT": "Arial"}, {"arial"})
        self.reject(400, import_validation._validate_resource_import_replacements, session, {"微软雅黑": "Unknown font"}, {"arial"})
        self.reject(400, import_validation._validate_resource_import_replacements, session, {}, {"arial"})

    def test_scope_ids_are_bounded_integers_for_existing_users(self):
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        self.addCleanup(db.close)
        db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY)")
        db.execute("INSERT INTO users (id) VALUES (1)")
        self.assertEqual(import_validation._validate_resource_import_payload({"visible_user_ids": [1, 1]}, db)["visible_user_ids"], [1])
        self.reject(400, import_validation._validate_resource_import_payload, {"visible_user_ids": [True]}, db)
        self.reject(400, import_validation._validate_resource_import_payload, {"visible_user_ids": [2]}, db)
        self.reject(400, import_validation._validate_resource_import_payload, {"visible_user_ids": "1"}, db)
        self.reject(400, import_validation._validate_resource_import_payload, {"name_prefix": "x" * 121}, db)

    def test_cross_site_origin_rejected_but_proxy_same_origin_works(self):
        def request(origin, site):
            return Request({"type": "http", "method": "POST", "scheme": "http", "path": "/", "headers": [
                (b"host", b"testserver"), (b"origin", origin.encode()), (b"sec-fetch-site", site.encode()),
            ]})
        self.reject(403, import_validation._require_resource_import_origin, request("https://evil.example", "cross-site"))
        import_validation._require_resource_import_origin(request("http://testserver", "same-origin"))
        import_validation._require_resource_import_origin(request("https://localhost:5173", "same-origin"))

    def test_request_guard_bounds_multipart_before_route(self):
        app = FastAPI()
        app.add_middleware(ResourceImportRequestGuard)

        @app.post("/api/resource-import/prepare")
        async def prepare(file: UploadFile = File(...)):
            return {"unexpected": True}

        @app.post("/api/tasks/split-import")
        async def create_task(file: UploadFile = File(...)):
            return {"unexpected": True}

        with TestClient(app) as client:
            oversized_length = import_limits.RESOURCE_IMPORT_MAX_TOTAL_BYTES + 2 * 1024 * 1024
            response = client.post("/api/resource-import/prepare", content=b"x", headers={"Content-Length": str(oversized_length)})
            self.assertEqual(response.status_code, 413)
            response = client.post("/api/tasks/split-import", content=b"x", headers={"Content-Length": str(oversized_length)})
            self.assertEqual(response.status_code, 413)
        with patch.object(import_guard, "RESOURCE_IMPORT_MAX_TOTAL_BYTES", 0), TestClient(app) as client:
            boundary = b"--guard\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.pptx\"\r\n\r\n"

            def chunks():
                yield boundary
                for _ in range(17):
                    yield b"x" * 65536
                yield b"\r\n--guard--\r\n"

            response = client.post(
                "/api/resource-import/prepare",
                content=chunks(),
                headers={"Content-Type": "multipart/form-data; boundary=guard"},
            )
            self.assertEqual(response.status_code, 413)
            response = client.post(
                "/api/tasks/split-import",
                content=chunks(),
                headers={"Content-Type": "multipart/form-data; boundary=guard"},
            )
            self.assertEqual(response.status_code, 413)

    def test_unsafe_xml_and_external_media_rejected(self):
        ppt = self.root / "source.pptx"
        for name, content in [
            ("ppt/presentation.xml", '<!DOCTYPE a [<!ENTITY x "test">]><a/>'),
            ("ppt/_rels/presentation.xml.rels", '<Relationships><Relationship TargetMode="External" Type="http://example/image" Target="http://127.0.0.1/private"/></Relationships>'),
        ]:
            with zipfile.ZipFile(ppt, "w") as package:
                package.writestr(name, content)
            self.reject(400, import_validation._validate_import_ppt_package, ppt)


if __name__ == "__main__":
    unittest.main()
