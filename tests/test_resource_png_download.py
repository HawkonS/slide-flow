from __future__ import annotations

import sqlite3
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.config import settings
from app.core.permissions import require_user
from app.db import init_db, now_iso
from app.routers.dependencies import db_read_dep
from app.routers.resources.files import router as resource_files_router


class ResourcePngDownloadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-png-download-")
        self.root = Path(self.temporary.name)
        paths = {
            "root_dir": self.root,
            "data_dir": self.root / "data",
            "db_dir": self.root / "data" / "db",
            "assets_dir": self.root / "data" / "assets",
            "resources_dir": self.root / "data" / "assets" / "resources",
            "templates_dir": self.root / "data" / "assets" / "templates",
            "fonts_dir": self.root / "data" / "assets" / "fonts",
            "thumbs_dir": self.root / "data" / "assets" / "thumbs",
            "downloads_dir": self.root / "data" / "assets" / "downloads",
            "log_dir": self.root / "data" / "logs",
            "db_path": self.root / "data" / "db" / "slide_flow.db",
        }
        self.patchers = [patch.object(settings, name, value) for name, value in paths.items()]
        self.patchers.append(patch.object(settings, "storage_backend", "local"))
        for patcher in self.patchers:
            patcher.start()
        init_db()
        settings.resources_dir.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(settings.db_path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.user = self.db.execute("SELECT * FROM users ORDER BY id LIMIT 1").fetchone()
        self.assertIsNotNone(self.user)

        now = now_iso()
        self.resource_id = int(
            self.db.execute(
                """
                INSERT INTO resources (
                    detail_token, name, owner_id, subject, tags, status,
                    visibility_scope, management_scope, secrecy_level,
                    current_version, updated_by, created_at, updated_at
                ) VALUES ('png-test-token', 'PNG test', ?, '测试', '', 'active',
                          'private', 'private', 'public', 1, ?, ?, ?)
                """,
                (int(self.user["id"]), int(self.user["id"]), now, now),
            ).lastrowid
        )
        png = settings.resources_dir / "preview.png"
        Image.new("RGB", (2400, 1200), "#204060").save(png)
        self.db.execute(
            """
            INSERT INTO resource_versions (
                resource_id, version_no, ppt_path, png_path, created_by, created_at
            ) VALUES (?, 1, ?, ?, ?, ?)
            """,
            (
                self.resource_id,
                str(settings.resources_dir / "unused.pptx"),
                settings.store_path(png),
                int(self.user["id"]),
                now,
            ),
        )
        self.db.commit()

        app = FastAPI()
        app.include_router(resource_files_router)
        app.dependency_overrides[require_user] = lambda: self.user

        def override_db():
            yield self.db

        app.dependency_overrides[db_read_dep] = override_db
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.db.close()
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temporary.cleanup()

    def test_resolution_option_resizes_png_without_upscaling_other_downloads(self):
        low = self.client.get(
            f"/api/resources/{self.resource_id}/download?format=png&resolution=720p"
        )
        self.assertEqual(low.status_code, 200, low.text)
        self.assertEqual(low.headers["content-type"], "image/png")
        self.assertIn("_720p.png", low.headers["content-disposition"])
        with Image.open(BytesIO(low.content)) as image:
            self.assertEqual(image.size, (1280, 640))

        four_k = self.client.get(
            f"/api/resources/{self.resource_id}/download?format=png&resolution=4k"
        )
        self.assertEqual(four_k.status_code, 200, four_k.text)
        with Image.open(BytesIO(four_k.content)) as image:
            self.assertEqual(image.size, (2400, 1200))

    def test_non_embedded_pptx_from_oss_is_proxied_and_cleaned_after_response(self):
        self.db.execute(
            "UPDATE resource_versions SET ppt_path = ? WHERE resource_id = ?",
            ("oss://test/resources/ppt/source.pptx", self.resource_id),
        )
        self.db.commit()
        materialized = self.root / "materialized-source.pptx"

        def materialize(_: str) -> Path:
            materialized.write_bytes(b"original-pptx-content")
            return materialized

        with patch("app.services.files.oss_storage.materialize", side_effect=materialize):
            response = self.client.get(
                f"/api/resources/{self.resource_id}/download?format=pptx"
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, b"original-pptx-content")
        self.assertNotIn("location", response.headers)
        self.assertIn(".pptx", response.headers["content-disposition"])
        self.assertFalse(materialized.exists())


if __name__ == "__main__":
    unittest.main()
