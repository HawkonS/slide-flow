from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.core.permissions import require_user
from app.db import init_db, new_resource_detail_token, now_iso
from app.routers.dependencies import db_dep
from app.routers.resources import mutations as resource_mutations


class ResourceBatchEditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-batch-edit-")
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
        self.owner = self.insert_user("batch-owner")
        self.editor = self.insert_user("batch-editor")
        self.other = self.insert_user("batch-other")
        self.current_user = self.owner
        timestamp = now_iso()
        self.db.executemany(
            """
            INSERT INTO user_tag_definitions (
                name, category, label, sort_order, is_default_filter, created_by, created_at
            ) VALUES (?, '团队', ?, 0, 0, ?, ?)
            """,
            [
                ("team-red", "红队", int(self.owner["id"]), timestamp),
                ("team-blue", "蓝队", int(self.owner["id"]), timestamp),
            ],
        )
        self.db.commit()

        app = FastAPI()
        app.include_router(resource_mutations.router)

        def override_user():
            return self.current_user

        def override_db():
            yield self.db

        app.dependency_overrides[require_user] = override_user
        app.dependency_overrides[db_dep] = override_db
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
                (username, username, username, timestamp, timestamp),
            ).lastrowid
        )
        self.db.commit()
        row = self.db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        assert row is not None
        return row

    def insert_resource(
        self,
        name: str,
        *,
        owner: sqlite3.Row | None = None,
        tags: str = "",
        management_scope: str = "private",
    ) -> int:
        owner = owner or self.owner
        timestamp = now_iso()
        resource_id = int(
            self.db.execute(
                """
                INSERT INTO resources (
                    detail_token, name, owner_id, subject, tags, status,
                    visibility_scope, management_scope, secrecy_level,
                    current_version, updated_by, created_at, updated_at
                ) VALUES (?, ?, ?, '测试主体', ?, 'active',
                          'private', ?, '', 1, ?, ?, ?)
                """,
                (
                    new_resource_detail_token(),
                    name,
                    int(owner["id"]),
                    tags,
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
                resource_id, version_no, ppt_path, created_by, created_at
            ) VALUES (?, 1, 'resource.pptx', ?, ?)
            """,
            (resource_id, int(owner["id"]), timestamp),
        )
        self.db.commit()
        return resource_id

    def batch(self, resource_ids: list[int], fields: dict):
        return self.client.put(
            "/api/resources/batch",
            json={"resource_ids": resource_ids, "fields": fields},
        )

    def resource(self, resource_id: int) -> sqlite3.Row:
        row = self.db.execute("SELECT * FROM resources WHERE id = ?", (resource_id,)).fetchone()
        assert row is not None
        return row

    def test_name_transform_modes_and_updated_by(self):
        first = self.insert_resource("季度复盘", management_scope="public")
        second = self.insert_resource("季度计划", management_scope="public")
        self.current_user = self.editor

        response = self.batch([first, second], {"name": {"mode": "prefix", "value": "[归档] "}})
        self.assertEqual(response.status_code, 200, response.text)
        response = self.batch([first, second], {"name": {"mode": "suffix", "value": " - 已审"}})
        self.assertEqual(response.status_code, 200, response.text)
        response = self.batch(
            [first, second],
            {"name": {"mode": "replace", "search": "季度", "value": "月度"}},
        )
        self.assertEqual(response.status_code, 200, response.text)

        self.assertEqual(self.resource(first)["name"], "[归档] 月度复盘 - 已审")
        self.assertEqual(self.resource(second)["name"], "[归档] 月度计划 - 已审")
        self.assertEqual(int(self.resource(first)["updated_by"]), int(self.editor["id"]))

    def test_invalid_name_keeps_whole_batch_unchanged(self):
        first = self.insert_resource("删除")
        second = self.insert_resource("保留删除")
        response = self.batch(
            [first, second],
            {"name": {"mode": "replace", "search": "删除", "value": ""}},
        )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(self.resource(first)["name"], "删除")
        self.assertEqual(self.resource(second)["name"], "保留删除")

    def test_tags_support_append_remove_and_replace(self):
        first = self.insert_resource("A", tags="alpha,beta")
        second = self.insert_resource("B", tags="beta")

        response = self.batch([first, second], {"tags": {"mode": "append", "values": ["beta", "gamma"]}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.resource(first)["tags"], "alpha,beta,gamma")
        self.assertEqual(self.resource(second)["tags"], "beta,gamma")

        response = self.batch([first, second], {"tags": {"mode": "remove", "values": ["beta"]}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.resource(first)["tags"], "alpha,gamma")
        self.assertEqual(self.resource(second)["tags"], "gamma")

        response = self.batch([first, second], {"tags": {"mode": "replace", "values": []}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.resource(first)["tags"], "")
        self.assertEqual(self.resource(second)["tags"], "")

    def test_partial_scope_accepts_user_tags_and_non_partial_clears_grants(self):
        resource_id = self.insert_resource("权限素材")
        response = self.batch(
            [resource_id],
            {
                "visibility_scope": "partial",
                "visible_user_ids": [int(self.editor["id"])],
                "visible_user_tags": ["team-red"],
                "management_scope": "partial",
                "manage_user_ids": [int(self.other["id"])],
                "manage_user_tags": ["team-blue"],
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        visible_user = self.db.execute(
            "SELECT user_id FROM resource_visibility WHERE resource_id = ?",
            (resource_id,),
        ).fetchone()
        visible_tag = self.db.execute(
            "SELECT tag_name FROM resource_visibility_tags WHERE resource_id = ?",
            (resource_id,),
        ).fetchone()
        self.assertEqual(int(visible_user["user_id"]), int(self.editor["id"]))
        self.assertEqual(visible_tag["tag_name"], "team-red")

        response = self.batch(
            [resource_id],
            {"visibility_scope": "public", "management_scope": "private"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        for table in (
            "resource_visibility",
            "resource_visibility_tags",
            "resource_management",
            "resource_management_tags",
        ):
            count = self.db.execute(
                f"SELECT COUNT(*) AS count FROM {table} WHERE resource_id = ?",
                (resource_id,),
            ).fetchone()["count"]
            self.assertEqual(count, 0, table)

    def test_permission_failure_is_atomic(self):
        editable = self.insert_resource("可编辑")
        blocked = self.insert_resource("不可编辑", owner=self.other)
        response = self.batch([editable, blocked], {"name": {"mode": "prefix", "value": "新-"}})
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(self.resource(editable)["name"], "可编辑")
        self.assertEqual(self.resource(blocked)["name"], "不可编辑")

    def test_subject_is_not_batch_editable(self):
        resource_id = self.insert_resource("元数据")
        response = self.batch([resource_id], {"subject": "不允许"})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("不支持的字段", response.text)


if __name__ == "__main__":
    unittest.main()
