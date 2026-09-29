from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.core.permissions import SESSION_COOKIE, _auth_db_dep
from app.core.security import create_session_token
from app.db import init_db, now_iso
from app.routers import tags
from app.routers.dependencies import db_dep, db_read_dep
from app.services.tagging import set_entity_tags


class TagBatchRenameTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-tag-batch-")
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
        self.db.execute("DELETE FROM users")
        self.db.commit()

        self.admin_id = self.insert_user("batch-admin", role="system_admin")
        self.user_id = self.insert_user("batch-user")

        app = FastAPI()
        app.include_router(tags.router, prefix="/api")

        def override_db():
            yield self.db

        app.dependency_overrides[db_dep] = override_db
        app.dependency_overrides[db_read_dep] = override_db
        app.dependency_overrides[_auth_db_dep] = override_db
        self.app = app

    def tearDown(self):
        self.db.close()
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temporary.cleanup()

    def insert_user(self, username: str, *, role: str = "user", tags_value: str = "") -> int:
        timestamp = now_iso()
        user_id = int(
            self.db.execute(
                """
                INSERT INTO users (
                    name, username, username_key, password_hash, tags, role,
                    created_at, updated_at
                ) VALUES (?, ?, ?, 'not-used', ?, ?, ?, ?)
                """,
                (username, username, username, tags_value, role, timestamp, timestamp),
            ).lastrowid
        )
        for tag_name in filter(None, tags_value.split(",")):
            self.db.execute(
                "INSERT INTO user_tags (user_id, tag_name) VALUES (?, ?)",
                (user_id, tag_name),
            )
        self.db.commit()
        return user_id

    def client_for(self, user_id: int) -> TestClient:
        client = TestClient(self.app)
        client.cookies.set(
            SESSION_COOKIE,
            create_session_token(user_id, settings.secret_key, ttl_seconds=300),
        )
        return client

    def create_definition(self, table: str, name: str) -> int:
        category, _, label = name.partition("-")
        if not label:
            category, label = "未分类", name
        cursor = self.db.execute(
            f"""
            INSERT INTO {table} (name, category, label, sort_order, created_by, created_at)
            VALUES (?, ?, ?, 0, ?, ?)
            """,
            (name, category, label, self.admin_id, now_iso()),
        )
        self.db.commit()
        return int(cursor.lastrowid)

    def create_resource(self, *, subject: str = "", tags_value: str = "", status: str = "") -> int:
        timestamp = now_iso()
        cursor = self.db.execute(
            """
            INSERT INTO resources (
                detail_token, name, owner_id, subject, tags, status,
                visibility_scope, management_scope, secrecy_level, created_at, updated_at
            ) VALUES (?, 'Resource', ?, ?, ?, ?, 'public', 'private', '', ?, ?)
            """,
            (
                f"tag-batch-resource-{now_iso().replace(':', '').replace('-', '')}",
                self.admin_id,
                subject,
                tags_value,
                status,
                timestamp,
                timestamp,
            ),
        )
        self.db.commit()
        return int(cursor.lastrowid)

    def create_show(self, tags_value: str) -> int:
        timestamp = now_iso()
        cursor = self.db.execute(
            """
            INSERT INTO shows (
                name, owner_id, tags, status, visibility_scope, management_scope,
                secrecy_level, created_at, updated_at
            ) VALUES ('Show', ?, ?, 'active', 'public', 'private', '', ?, ?)
            """,
            (self.admin_id, tags_value, timestamp, timestamp),
        )
        self.db.commit()
        return int(cursor.lastrowid)

    def test_resource_tag_batch_rename_updates_resources_and_shows(self):
        red_id = self.create_definition("tags", "team-red")
        blue_id = self.create_definition("tags", "team-blue")
        resource_id = self.create_resource(tags_value="team-red,team-blue,team-redwood")
        show_id = self.create_show("team-red,team-blue,team-redwood")

        with self.client_for(self.admin_id) as client:
            response = client.put(
                "/api/admin/tags/batch",
                json={
                    "updates": [
                        {"id": red_id, "name": "team-green"},
                        {"id": blue_id, "name": "team-yellow"},
                    ]
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            [item["name"] for item in response.json()["updated"]],
            ["team-green", "team-yellow"],
        )
        self.assertEqual(
            self.db.execute("SELECT tags FROM resources WHERE id = ?", (resource_id,)).fetchone()[0],
            "team-green,team-yellow,team-redwood",
        )
        self.assertEqual(
            self.db.execute("SELECT tags FROM shows WHERE id = ?", (show_id,)).fetchone()[0],
            "team-green,team-yellow,team-redwood",
        )

    def test_resource_category_rename_updates_all_children_without_changing_ids(self):
        product_name_id = self.create_definition("tags", "产品-名称")
        product_type_id = self.create_definition("tags", "产品-类型")
        product_scene_id = self.create_definition("tags", "产品-场景")
        resource_id = self.create_resource(tags_value="产品-名称,产品-类型")
        show_id = self.create_show("产品-场景")
        set_entity_tags(
            self.db,
            relation_table="resource_tags",
            entity_column="resource_id",
            entity_id=resource_id,
            names="产品-名称,产品-类型",
            cache_table="resources",
            created_by=self.admin_id,
        )
        set_entity_tags(
            self.db,
            relation_table="show_tags",
            entity_column="show_id",
            entity_id=show_id,
            names="产品-场景",
            cache_table="shows",
            created_by=self.admin_id,
        )
        self.db.commit()

        with self.client_for(self.admin_id) as client:
            response = client.put(
                "/api/admin/tags/categories/rename",
                json={"old_category": "产品", "new_category": "功能"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"updated_count": 3, "category": "功能"})
        definitions = self.db.execute(
            "SELECT id, name, category, label FROM tags ORDER BY id"
        ).fetchall()
        self.assertEqual(
            [(row["id"], row["name"], row["category"], row["label"]) for row in definitions],
            [
                (product_name_id, "功能-名称", "功能", "名称"),
                (product_type_id, "功能-类型", "功能", "类型"),
                (product_scene_id, "功能-场景", "功能", "场景"),
            ],
        )
        self.assertEqual(
            self.db.execute("SELECT tags FROM resources WHERE id = ?", (resource_id,)).fetchone()[0],
            "功能-名称,功能-类型",
        )
        self.assertEqual(
            self.db.execute("SELECT tags FROM shows WHERE id = ?", (show_id,)).fetchone()[0],
            "功能-场景",
        )
        self.assertEqual(
            [
                row["name"]
                for row in self.db.execute(
                    """
                    SELECT t.name FROM resource_tags rt
                    JOIN tags t ON t.id = rt.tag_id
                    WHERE rt.resource_id = ? ORDER BY rt.position
                    """,
                    (resource_id,),
                ).fetchall()
            ],
            ["功能-名称", "功能-类型"],
        )

    def test_resource_category_rename_rejects_existing_target_category_atomically(self):
        first_id = self.create_definition("tags", "产品-名称")
        second_id = self.create_definition("tags", "功能-名称")

        with self.client_for(self.admin_id) as client:
            response = client.put(
                "/api/admin/tags/categories/rename",
                json={"old_category": "产品", "new_category": "功能"},
            )

        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(
            self.db.execute(
                "SELECT name FROM tags WHERE id IN (?, ?) ORDER BY id",
                (first_id, second_id),
            ).fetchall()[0][0],
            "产品-名称",
        )

    def test_user_tag_batch_rename_updates_users_and_user_tags(self):
        red_id = self.create_definition("user_tag_definitions", "team-red")
        blue_id = self.create_definition("user_tag_definitions", "team-blue")
        user_id = self.insert_user("tagged-user", tags_value="team-red,team-blue")

        with self.client_for(self.admin_id) as client:
            response = client.put(
                "/api/admin/user-tags/batch",
                json={
                    "updates": [
                        {"id": red_id, "name": "team-green"},
                        {"id": blue_id, "name": "team-yellow"},
                    ]
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            self.db.execute("SELECT tags FROM users WHERE id = ?", (user_id,)).fetchone()[0],
            "team-green,team-yellow",
        )
        self.assertEqual(
            [row[0] for row in self.db.execute(
                "SELECT tag_name FROM user_tags WHERE user_id = ? ORDER BY tag_name",
                (user_id,),
            ).fetchall()],
            ["team-green", "team-yellow"],
        )

    def test_metadata_tag_batch_rename_updates_subject_and_status_fields(self):
        subject_a = self.create_definition("subject_tag_definitions", "subject-a")
        subject_b = self.create_definition("subject_tag_definitions", "subject-b")
        status_a = self.create_definition("status_tag_definitions", "status-a")
        status_b = self.create_definition("status_tag_definitions", "status-b")
        resource_id = self.create_resource(subject="subject-a", status="status-a")

        with self.client_for(self.admin_id) as client:
            subject_response = client.put(
                "/api/admin/subject-tags/batch",
                json={
                    "updates": [
                        {"id": subject_a, "name": "subject-main"},
                        {"id": subject_b, "name": "subject-secondary"},
                    ]
                },
            )
            status_response = client.put(
                "/api/admin/status-tags/batch",
                json={
                    "updates": [
                        {"id": status_a, "name": "status-active"},
                        {"id": status_b, "name": "status-archived"},
                    ]
                },
            )

        self.assertEqual(subject_response.status_code, 200, subject_response.text)
        self.assertEqual(status_response.status_code, 200, status_response.text)
        row = self.db.execute(
            "SELECT subject, status FROM resources WHERE id = ?", (resource_id,)
        ).fetchone()
        self.assertEqual(row["subject"], "subject-main")
        self.assertEqual(row["status"], "status-active")
        self.assertEqual(
            self.db.execute(
                "SELECT category, label FROM subject_tag_definitions WHERE id = ?", (subject_a,)
            ).fetchone()[0:2],
            ("主体", "subject-main"),
        )
        self.assertEqual(
            self.db.execute(
                "SELECT category, label FROM status_tag_definitions WHERE id = ?", (status_a,)
            ).fetchone()[0:2],
            ("状态", "status-active"),
        )

    def test_duplicate_batch_names_return_conflict_without_partial_updates(self):
        first_id = self.create_definition("tags", "team-red")
        second_id = self.create_definition("tags", "team-blue")
        resource_id = self.create_resource(tags_value="team-red,team-blue")

        with self.client_for(self.admin_id) as client:
            response = client.put(
                "/api/admin/tags/batch",
                json={
                    "updates": [
                        {"id": first_id, "name": "team-merged"},
                        {"id": second_id, "name": "team-merged"},
                    ]
                },
            )

        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(
            [row[0] for row in self.db.execute(
                "SELECT name FROM tags WHERE id IN (?, ?) ORDER BY id",
                (first_id, second_id),
            ).fetchall()],
            ["team-red", "team-blue"],
        )
        self.assertEqual(
            self.db.execute("SELECT tags FROM resources WHERE id = ?", (resource_id,)).fetchone()[0],
            "team-red,team-blue",
        )

    def test_non_admin_cannot_call_any_tag_batch_rename_endpoint(self):
        endpoints = [
            ("/api/admin/tags/batch", "tags"),
            ("/api/admin/user-tags/batch", "user_tag_definitions"),
            ("/api/admin/subject-tags/batch", "subject_tag_definitions"),
            ("/api/admin/status-tags/batch", "status_tag_definitions"),
        ]
        for endpoint, table in endpoints:
            tag_id = self.create_definition(table, f"permission-{table}")
            with self.client_for(self.user_id) as client:
                response = client.put(
                    endpoint,
                    json={"updates": [{"id": tag_id, "name": f"renamed-{table}"}]},
                )
            self.assertEqual(response.status_code, 403, (endpoint, response.text))


if __name__ == "__main__":
    unittest.main()
