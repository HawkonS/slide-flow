from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.core.permissions import require_user
from app.db import init_db, now_iso
from app.routers import tasks as tasks_router
from app.routers.dependencies import db_dep, db_read_dep


class TaggingTaskManagementTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-task-tagging-")
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
        self.user_a = self._insert_user("tagging-a", "Tagging A", "user")
        self.user_b = self._insert_user("tagging-b", "Tagging B", "user")
        self.admin = self._insert_user("tagging-admin", "Tagging Admin", "system_admin")
        self._insert_resource(1, "产品封面", "resource-token-a", self.user_a["id"], deleted_at=None)
        self._insert_resource(2, "市场海报", "resource-token-b", self.user_a["id"], deleted_at=None)
        self._insert_task(
            101,
            self.user_a["id"],
            "completed",
            {"target_type": "resource", "target_id": 1, "connection_name": "视觉模型", "model": "vision-a"},
            {"target_type": "resource", "target_id": 1, "suggested_tags": ["精选", "对外"]},
            "2026-11-15T10:00:00",
        )
        self._insert_task(
            102,
            self.user_a["id"],
            "failed",
            {"target_type": "resource", "target_id": 2, "connection_name": "备用连接", "model": "vision-b"},
            {},
            "2026-11-15T09:00:00",
            error_message="模型标注请求超时",
        )
        self._insert_task(
            103,
            self.user_b["id"],
            "pending",
            {"target_type": "resource", "target_id": 1, "connection_name": "别人的连接", "model": "vision-c"},
            {},
            "2026-11-15T08:00:00",
        )
        self.db.commit()
        self.current_user = self.user_a

        app = FastAPI()
        app.include_router(tasks_router.router)

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

    def _insert_user(self, username: str, name: str, role: str) -> sqlite3.Row:
        cursor = self.db.execute(
            """INSERT INTO users
               (name, username, username_key, password_hash, role, created_at, updated_at)
               VALUES (?, ?, ?, 'not-used', ?, ?, ?)""",
            (name, username, username, role, now_iso(), now_iso()),
        )
        self.db.commit()
        return self.db.execute("SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)).fetchone()

    def _insert_resource(self, resource_id: int, name: str, token: str, owner_id: int, *, deleted_at: str | None) -> None:
        self.db.execute(
            """INSERT INTO resources
               (id, detail_token, name, owner_id, visibility_scope, management_scope,
                secrecy_level, current_version, created_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, 'private', 'private', '', 1, ?, ?, ?)""",
            (resource_id, token, name, owner_id, now_iso(), now_iso(), deleted_at),
        )

    def _insert_task(
        self,
        task_id: int,
        owner_id: int,
        status: str,
        params: dict,
        result_data: dict,
        updated_at: str,
        *,
        error_message: str | None = None,
    ) -> None:
        self.db.execute(
            """INSERT INTO tasks
               (id, task_type, status, owner_id, params, result_data, message, error_message,
                progress, total, created_at, updated_at, completed_at)
               VALUES (?, 'ai_tagging', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)""",
            (
                task_id,
                status,
                owner_id,
                json.dumps(params, ensure_ascii=False),
                json.dumps(result_data, ensure_ascii=False),
                "等待智能标注…" if status == "pending" else "",
                error_message,
                1 if status == "completed" else 0,
                updated_at,
                updated_at,
                updated_at if status in {"completed", "failed", "cancelled"} else None,
            ),
        )

    def _list(self, **params):
        return self.client.get("/api/tasks", params={"task_type": "ai_tagging", **params})

    def test_ai_list_enriches_target_and_keeps_the_current_user_scope(self):
        response = self._list(page_size=20)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["total"], 2)
        by_id = {item["id"]: item for item in body["items"]}
        self.assertEqual(by_id[101]["params"]["target_name"], "产品封面")
        self.assertEqual(by_id[101]["params"]["target_detail_token"], "resource-token-a")
        self.assertFalse(by_id[101]["params"]["target_deleted"])
        self.assertEqual(by_id[101]["result_data"]["suggested_tags"], ["精选", "对外"])
        self.assertEqual(by_id[102]["params"]["target_name"], "市场海报")

        self.current_user = self.admin
        admin_body = self._list(page_size=20).json()
        self.assertEqual(admin_body["total"], 3)
        self.assertIn(103, {item["id"] for item in admin_body["items"]})

    def test_ai_search_matches_resource_model_and_suggested_tags(self):
        self.assertEqual([item["id"] for item in self._list(search="产品").json()["items"]], [101])
        self.assertEqual([item["id"] for item in self._list(search="视觉模型").json()["items"]], [101])
        self.assertEqual([item["id"] for item in self._list(search="vision-b").json()["items"]], [102])
        self.assertEqual([item["id"] for item in self._list(search="精选").json()["items"]], [101])
        self.assertEqual([item["id"] for item in self._list(search="市场").json()["items"]], [102])
        self.assertEqual(self._list(search="不存在的素材").json()["items"], [])

    def test_deleted_target_is_not_linkable_but_keeps_the_name(self):
        self.db.execute("UPDATE resources SET deleted_at = ? WHERE id = 2", (now_iso(),))
        self.db.commit()
        body = self._list(page_size=20).json()
        by_id = {item["id"]: item for item in body["items"]}
        self.assertEqual(by_id[102]["params"]["target_name"], "市场海报")
        self.assertEqual(by_id[102]["params"]["target_detail_token"], "")
        self.assertTrue(by_id[102]["params"]["target_deleted"])

    def test_single_task_endpoint_includes_the_same_target_brief(self):
        response = self.client.get("/api/tasks/101")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["params"]["target_name"], "产品封面")
        self.assertEqual(body["params"]["target_detail_token"], "resource-token-a")
        self.current_user = self.user_b
        self.assertEqual(self.client.get("/api/tasks/101").status_code, 403)


if __name__ == "__main__":
    unittest.main()
