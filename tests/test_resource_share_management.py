from __future__ import annotations

import hashlib
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.core.permissions import require_user
from app.db import init_db, new_resource_detail_token, now_iso
from app.routers import resource_shares
from app.routers.dependencies import db_dep, db_read_dep


class ResourceShareManagementTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-shares-")
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
        self.admin = self.db.execute(
            "SELECT * FROM users WHERE role = 'system_admin' ORDER BY id LIMIT 1"
        ).fetchone()
        assert self.admin is not None
        self.alice = self.insert_user("alice")
        self.bob = self.insert_user("bob")
        self.current_user = self.alice

        app = FastAPI()
        app.include_router(resource_shares.router)

        def override_user():
            return self.current_user

        def override_db():
            yield self.db

        app.dependency_overrides[require_user] = override_user
        app.dependency_overrides[db_dep] = override_db
        app.dependency_overrides[db_read_dep] = override_db
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.db.close()
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temporary.cleanup()

    def insert_user(self, username: str) -> sqlite3.Row:
        timestamp = now_iso()
        user_id = int(
            self.db.execute(
                """
                INSERT INTO users (
                    name, username, username_key, password_hash, role, created_at, updated_at
                ) VALUES (?, ?, ?, 'not-used', 'user', ?, ?)
                """,
                (username.title(), username, username, timestamp, timestamp),
            ).lastrowid
        )
        self.db.commit()
        row = self.db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        assert row is not None
        return row

    def insert_resource(
        self,
        *,
        owner: sqlite3.Row,
        name: str,
        status: str = "active",
        management_scope: str = "private",
    ) -> tuple[int, str]:
        timestamp = now_iso()
        detail_token = new_resource_detail_token()
        resource_id = int(
            self.db.execute(
                """
                INSERT INTO resources (
                    detail_token, name, owner_id, subject, tags, status,
                    visibility_scope, management_scope, secrecy_level,
                    current_version, updated_by, created_at, updated_at
                ) VALUES (?, ?, ?, '测试', '', ?, 'private', ?, 'public', 1, ?, ?, ?)
                """,
                (
                    detail_token,
                    name,
                    int(owner["id"]),
                    status,
                    management_scope,
                    int(owner["id"]),
                    timestamp,
                    timestamp,
                ),
            ).lastrowid
        )
        self.db.execute(
            """
            INSERT INTO resource_versions (
                resource_id, version_no, ppt_path, png_path, change_note,
                common_remark_html, created_by, created_at
            ) VALUES (?, 1, 'resource.pptx', 'preview.png', '初始版本', '<p>备注</p>', ?, ?)
            """,
            (resource_id, int(owner["id"]), timestamp),
        )
        self.db.commit()
        return resource_id, detail_token

    def create_share(self, resource_id: int, *, user: sqlite3.Row) -> dict:
        self.current_user = user
        response = self.client.post(
            f"/api/resources/{resource_id}/share-links",
            json={"expires_in_days": 7},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def insert_historical_share(self, resource_id: int, *, creator: sqlite3.Row) -> int:
        token = "H" * 43
        timestamp = now_iso()
        link_id = int(
            self.db.execute(
                """
                INSERT INTO resource_share_tokens (
                    resource_id, token_hash, token_ciphertext, created_by, expires_at, created_at
                ) VALUES (?, ?, NULL, ?, ?, ?)
                """,
                (
                    resource_id,
                    hashlib.sha256(token.encode("ascii")).hexdigest(),
                    int(creator["id"]),
                    (datetime.utcnow() + timedelta(days=3)).isoformat(timespec="seconds") + "Z",
                    timestamp,
                ),
            ).lastrowid
        )
        self.db.commit()
        return link_id

    def test_new_share_is_encrypted_and_management_list_restores_path(self):
        resource_id, detail_token = self.insert_resource(owner=self.alice, name="Alice material")
        created = self.create_share(resource_id, user=self.alice)
        token = created["token"]

        stored = self.db.execute(
            "SELECT token_hash, token_ciphertext FROM resource_share_tokens WHERE id = ?",
            (created["id"],),
        ).fetchone()
        assert stored is not None
        self.assertEqual(stored["token_hash"], hashlib.sha256(token.encode("ascii")).hexdigest())
        self.assertNotEqual(stored["token_ciphertext"], token)
        self.assertNotIn(token, stored["token_ciphertext"])

        managed = self.client.get("/api/resource-share-links")
        self.assertEqual(managed.status_code, 200, managed.text)
        item = managed.json()["items"][0]
        self.assertEqual(item["share_path"], f"/share/resources/{token}")
        self.assertEqual(item["resource"]["detail_path"], f"/resources/{detail_token}")

        public = self.client.get(f"/api/resource-shares/{token}")
        self.assertEqual(public.status_code, 200, public.text)
        self.assertEqual(public.json()["resource"]["detail_path"], f"/resources/{detail_token}")

    def test_regular_user_scope_admin_scope_and_historical_links(self):
        alice_resource, _ = self.insert_resource(owner=self.alice, name="Alice material")
        bob_resource, _ = self.insert_resource(owner=self.bob, name="Bob material")
        alice_share = self.create_share(alice_resource, user=self.alice)
        self.create_share(bob_resource, user=self.bob)
        historical_id = self.insert_historical_share(alice_resource, creator=self.alice)

        self.current_user = self.alice
        alice_list = self.client.get("/api/resource-share-links")
        self.assertEqual(alice_list.status_code, 200, alice_list.text)
        self.assertEqual({item["resource"]["id"] for item in alice_list.json()["items"]}, {alice_resource})
        historical = next(item for item in alice_list.json()["items"] if item["id"] == historical_id)
        self.assertIsNone(historical["share_path"])

        self.current_user = self.admin
        admin_list = self.client.get("/api/resource-share-links")
        self.assertEqual(admin_list.status_code, 200, admin_list.text)
        self.assertEqual(
            {item["resource"]["id"] for item in admin_list.json()["items"]},
            {alice_resource, bob_resource},
        )

        self.current_user = self.alice
        revoked = self.client.delete(
            f"/api/resources/{alice_resource}/share-links/{alice_share['id']}"
        )
        self.assertEqual(revoked.status_code, 200, revoked.text)
        revoked_list = self.client.get("/api/resource-share-links", params={"status": "revoked"})
        self.assertEqual(revoked_list.status_code, 200, revoked_list.text)
        self.assertEqual([item["id"] for item in revoked_list.json()["items"]], [alice_share["id"]])
        self.assertEqual(revoked_list.json()["stats"]["revoked"], 1)


if __name__ == "__main__":
    unittest.main()
