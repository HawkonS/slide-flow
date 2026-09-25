from __future__ import annotations

import re
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.core.permissions import require_user
from app.db import _migrate_schema, init_db, new_resource_detail_token, now_iso
from app.routers.dependencies import db_read_dep
from app.routers.resources import mutations as resource_mutations


class ResourceDetailTokenTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-resource-key-")
        root = Path(self.temporary.name)
        paths = {
            "root_dir": root,
            "data_dir": root / "data",
            "db_dir": root / "data" / "db",
            "assets_dir": root / "data" / "assets",
            "resources_dir": root / "data" / "assets" / "resources",
            "templates_dir": root / "data" / "assets" / "templates",
            "fonts_dir": root / "data" / "assets" / "fonts",
            "thumbs_dir": root / "data" / "assets" / "thumbs",
            "downloads_dir": root / "data" / "assets" / "downloads",
            "log_dir": root / "data" / "logs",
            "db_path": root / "data" / "db" / "slide_flow.db",
        }
        self.patchers = [patch.object(settings, name, value) for name, value in paths.items()]
        self.patchers.append(patch.object(settings, "storage_backend", "local"))
        for patcher in self.patchers:
            patcher.start()
        init_db()
        self.db = sqlite3.connect(settings.db_path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.user = self.db.execute("SELECT * FROM users ORDER BY id LIMIT 1").fetchone()
        assert self.user is not None

    def tearDown(self):
        self.db.close()
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temporary.cleanup()

    def insert_resource(self, *, detail_token: str) -> int:
        timestamp = now_iso()
        resource_id = int(
            self.db.execute(
                """
                INSERT INTO resources (
                    detail_token, name, owner_id, subject, tags, status,
                    visibility_scope, management_scope, secrecy_level,
                    current_version, updated_by, created_at, updated_at
                ) VALUES (?, 'Token resource', ?, '测试', '', 'active',
                          'private', 'private', 'public', 1, ?, ?, ?)
                """,
                (detail_token, int(self.user["id"]), int(self.user["id"]), timestamp, timestamp),
            ).lastrowid
        )
        self.db.execute(
            """
            INSERT INTO resource_versions (
                resource_id, version_no, ppt_path, created_by, created_at
            ) VALUES (?, 1, 'resource.pptx', ?, ?)
            """,
            (resource_id, int(self.user["id"]), timestamp),
        )
        self.db.commit()
        return resource_id

    def test_detail_endpoint_uses_opaque_key_and_rejects_modified_or_numeric_keys(self):
        detail_token = new_resource_detail_token()
        resource_id = self.insert_resource(detail_token=detail_token)
        app = FastAPI()
        app.include_router(resource_mutations.router)

        def override_user():
            return self.user

        def override_db():
            yield self.db

        app.dependency_overrides[require_user] = override_user
        app.dependency_overrides[db_read_dep] = override_db

        with TestClient(app) as client:
            found = client.get(f"/api/resources/by-key/{detail_token}")
            self.assertEqual(found.status_code, 200, found.text)
            self.assertEqual(found.json()["resource"]["id"], resource_id)
            self.assertEqual(found.json()["resource"]["detail_token"], detail_token)

            replacement = "A" if detail_token[-1] != "A" else "B"
            modified = client.get(f"/api/resources/by-key/{detail_token[:-1]}{replacement}")
            self.assertEqual(modified.status_code, 404, modified.text)

            numeric = client.get(f"/api/resources/by-key/{resource_id}")
            self.assertEqual(numeric.status_code, 404, numeric.text)

    def test_migration_backfills_unique_url_safe_tokens_for_existing_resources(self):
        first_id = self.insert_resource(detail_token="")
        second_id = self.insert_resource(detail_token="")

        _migrate_schema(self.db, 15)
        rows = self.db.execute(
            "SELECT id, detail_token FROM resources WHERE id IN (?, ?) ORDER BY id",
            (first_id, second_id),
        ).fetchall()
        tokens = [str(row["detail_token"]) for row in rows]

        self.assertEqual(len(set(tokens)), 2)
        self.assertTrue(all(re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token) for token in tokens))


if __name__ == "__main__":
    unittest.main()
