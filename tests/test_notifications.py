from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db as database
from app.config import settings
from app.core.permissions import require_user
from app.db import init_db, now_iso
from app.routers import notifications
from app.routers.dependencies import db_dep, db_read_dep


def _stamp(minute: int) -> str:
    return f"2026-11-15T10:{minute:02d}:00"


class NotificationFeedTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-notifications-")
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
        self.user_a = self._insert_user("notice-a", "Notice A")
        self.user_b = self._insert_user("notice-b", "Notice B")
        self.current_user = self.user_a
        self.db.execute(
            """INSERT INTO shows
               (id, name, owner_id, visibility_scope, management_scope, created_at, updated_at)
               VALUES (1, '示例放映', ?, 'public', 'private', ?, ?)""",
            (self.user_a["id"], _stamp(0), _stamp(0)),
        )
        self.db.execute(
            """INSERT INTO resources
               (id, detail_token, name, owner_id, visibility_scope, management_scope,
                secrecy_level, current_version, created_at, updated_at)
               VALUES (1, 'resource-token', '示例单页', ?, 'public', 'private', '', 1, ?, ?)""",
            (self.user_a["id"], _stamp(0), _stamp(0)),
        )
        self.db.commit()

        app = FastAPI()
        app.include_router(notifications.router, prefix="/api")

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

    def _insert_user(self, username: str, name: str) -> sqlite3.Row:
        cursor = self.db.execute(
            """INSERT INTO users
               (name, username, username_key, password_hash, role, created_at, updated_at)
               VALUES (?, ?, ?, 'not-used', 'user', ?, ?)""",
            (name, username, username, now_iso(), now_iso()),
        )
        self.db.commit()
        return self.db.execute("SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)).fetchone()

    def _insert_task(
        self,
        *,
        user_id: int | None = None,
        task_type: str = "download",
        status: str = "completed",
        updated_at: str | None = None,
        completed_at: str | None = None,
        params: dict | None = None,
        result_data: dict | None = None,
        message: str | None = None,
        error_message: str | None = None,
        archived_at: str | None = None,
    ) -> int:
        stamp = updated_at or _stamp(30)
        cursor = self.db.execute(
            """INSERT INTO tasks
               (task_type, status, owner_id, params, result_data, message, error_message,
                created_at, updated_at, completed_at, archived_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                task_type,
                status,
                int((user_id if user_id is not None else self.user_a["id"])),
                json.dumps(params or {}, ensure_ascii=False),
                json.dumps(result_data or {}, ensure_ascii=False),
                message,
                error_message,
                stamp,
                stamp,
                completed_at if completed_at is not None else (stamp if status in {"completed", "failed", "cancelled"} else None),
                archived_at,
            ),
        )
        self.db.commit()
        return int(cursor.lastrowid)

    def _list(self, **params):
        response = self.client.get("/api/me/notifications", params=params)
        return response

    def test_terminal_tasks_become_notifications_and_active_tasks_do_not(self):
        download_id = self._insert_task(
            task_type="download",
            status="completed",
            updated_at=_stamp(5),
            params={"show_id": 1, "download_type": "pdf"},
            result_data={"file_name": "示例放映.pdf", "file_size": 10},
        )
        tagging_id = self._insert_task(
            task_type="ai_tagging",
            status="completed",
            updated_at=_stamp(6),
            params={"target_id": 1, "target_type": "resource"},
            result_data={"suggested_tags": ["精选", "对外"], "target_id": 1},
        )
        import_id = self._insert_task(
            task_type="batch_split_import",
            status="completed",
            updated_at=_stamp(7),
            params={"name_prefix": "季度汇报", "import_target": "resources", "file_name": "deck.pptx"},
            result_data={"created": 3, "resource_ids": [11, 12, 13]},
        )
        failed_id = self._insert_task(
            task_type="download",
            status="failed",
            updated_at=_stamp(8),
            params={"show_id": 1},
            message="下载任务处理失败",
            error_message="/private/tmp/internal-download-path",
        )
        cancelled_id = self._insert_task(
            task_type="ai_tagging",
            status="cancelled",
            updated_at=_stamp(9),
            params={"target_id": 1},
            message="任务已取消",
        )
        archived_id = self._insert_task(
            task_type="batch_split_import",
            status="failed",
            updated_at=_stamp(4),
            params={"name_prefix": "旧导入"},
            message="导入失败",
            archived_at=_stamp(20),
        )
        self._insert_task(
            task_type="download",
            status="pending",
            updated_at=_stamp(10),
            params={"show_id": 1},
        )
        self._insert_task(
            task_type="batch_split_import",
            status="processing",
            updated_at=_stamp(11),
            params={"name_prefix": "处理中"},
        )

        response = self._list(limit=50)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["unread_count"], 6)
        self.assertEqual(len(body["items"]), 6)
        self.assertTrue(all(item["read_at"] is None for item in body["items"]))

        by_id = {item["id"]: item for item in body["items"]}
        self.assertEqual(by_id[f"task:{download_id}"]["title"], "下载已完成")
        self.assertIn("示例放映", by_id[f"task:{download_id}"]["body"])
        self.assertIn("示例放映.pdf", by_id[f"task:{download_id}"]["body"])
        self.assertEqual(by_id[f"task:{download_id}"]["link"], "/manage/tasks")

        self.assertEqual(by_id[f"task:{tagging_id}"]["title"], "智能标注完成")
        self.assertIn("示例单页", by_id[f"task:{tagging_id}"]["body"])
        self.assertIn("2 个标签建议", by_id[f"task:{tagging_id}"]["body"])
        self.assertEqual(by_id[f"task:{tagging_id}"]["link"], "/resources/resource-token")

        self.assertEqual(by_id[f"task:{import_id}"]["title"], "单页素材导入完成")
        self.assertIn("已生成 3 个素材", by_id[f"task:{import_id}"]["body"])
        self.assertEqual(by_id[f"task:{import_id}"]["link"], "/manage/tasks?tab=uploads")

        self.assertEqual(by_id[f"task:{failed_id}"]["title"], "下载失败")
        self.assertNotIn("/private/tmp/internal-download-path", by_id[f"task:{failed_id}"]["body"])
        self.assertEqual(by_id[f"task:{cancelled_id}"]["title"], "智能标注已取消")
        self.assertEqual(by_id[f"task:{archived_id}"]["id"], f"task:{archived_id}")

        # Newest terminal task first.
        self.assertEqual(body["items"][0]["id"], f"task:{cancelled_id}")

    def test_read_state_is_per_user_and_idempotent(self):
        own_id = self._insert_task(updated_at=_stamp(5), params={"show_id": 1})
        other_id = self._insert_task(
            user_id=int(self.user_b["id"]),
            updated_at=_stamp(6),
            params={"show_id": 1},
            result_data={"file_name": "b.pdf"},
        )

        listed = self._list(limit=50).json()
        self.assertEqual([item["id"] for item in listed["items"]], [f"task:{own_id}"])
        self.assertEqual(listed["unread_count"], 1)

        first = self.client.post(f"/api/me/notifications/task:{own_id}/read")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["unread_count"], 0)
        encoded = self.client.post(f"/api/me/notifications/task%3A{own_id}/read")
        self.assertEqual(encoded.status_code, 200)
        second = self.client.post(f"/api/me/notifications/task:{own_id}/read")
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["unread_count"], 0)
        self.assertEqual(second.json()["read_at"], first.json()["read_at"])

        self.assertEqual(self._list(filter="unread").json()["items"], [])
        read_items = self._list(filter="read").json()["items"]
        self.assertEqual([item["id"] for item in read_items], [f"task:{own_id}"])

        foreign = self.client.post(f"/api/me/notifications/task:{other_id}/read")
        self.assertEqual(foreign.status_code, 404)

        self.current_user = self.user_b
        self.assertEqual(self._list().json()["unread_count"], 1)
        read_all = self.client.post("/api/me/notifications/read-all")
        self.assertEqual(read_all.status_code, 200)
        self.assertEqual(read_all.json()["marked"], 1)
        self.assertEqual(read_all.json()["unread_count"], 0)
        self.assertEqual(self._list(filter="unread").json()["items"], [])

    def test_mark_unread_restores_the_item_and_is_idempotent(self):
        own_id = self._insert_task(updated_at=_stamp(5), params={"show_id": 1})
        other_id = self._insert_task(
            user_id=int(self.user_b["id"]),
            updated_at=_stamp(6),
            params={"show_id": 1},
        )
        marked = self.client.post(f"/api/me/notifications/task:{own_id}/read")
        self.assertEqual(marked.status_code, 200)
        self.assertEqual(self._list().json()["unread_count"], 0)

        restored = self.client.delete(f"/api/me/notifications/task:{own_id}/read")
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(restored.json()["id"], f"task:{own_id}")
        self.assertEqual(restored.json()["unread_count"], 1)
        again = self.client.delete(f"/api/me/notifications/task%3A{own_id}/read")
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.json()["unread_count"], 1)

        self.assertEqual(
            [item["id"] for item in self._list(filter="unread").json()["items"]],
            [f"task:{own_id}"],
        )
        self.assertEqual(self._list(filter="read").json()["items"], [])

        self.assertEqual(
            self.client.delete(f"/api/me/notifications/task:{other_id}/read").status_code,
            404,
        )
        self.assertEqual(
            self.client.delete("/api/me/notifications/task:abc/read").status_code,
            400,
        )
        self.assertEqual(
            self.client.delete("/api/me/notifications/task:999999/read").status_code,
            404,
        )
        pending_id = self._insert_task(status="pending", updated_at=_stamp(7), params={"show_id": 1})
        self.assertEqual(
            self.client.delete(f"/api/me/notifications/task:{pending_id}/read").status_code,
            404,
        )

    def test_cursor_pagination_and_invalid_inputs(self):
        ids = [
            self._insert_task(updated_at=_stamp(10 + index), params={"show_id": 1})
            for index in range(5)
        ]
        first = self._list(limit=2)
        self.assertEqual(first.status_code, 200)
        first_body = first.json()
        self.assertEqual(len(first_body["items"]), 2)
        self.assertTrue(first_body["has_more"])
        self.assertIsNotNone(first_body["next_cursor"])

        seen: list[str] = []
        cursor = first_body["next_cursor"]
        for _ in range(5):
            page = self._list(limit=2, cursor=cursor).json()
            seen.extend(item["id"] for item in page["items"])
            if not page["has_more"]:
                break
            cursor = page["next_cursor"]
        all_ids = [f"task:{task_id}" for task_id in reversed(ids)]
        self.assertEqual([item["id"] for item in first_body["items"]], all_ids[:2])
        self.assertEqual(seen, all_ids[2:])

        invalid_cursor = self._list(cursor="not-a-cursor")
        self.assertEqual(invalid_cursor.status_code, 400)
        bad_id = self.client.post("/api/me/notifications/task:abc/read")
        self.assertEqual(bad_id.status_code, 400)
        missing_id = self.client.post("/api/me/notifications/task:999999/read")
        self.assertEqual(missing_id.status_code, 404)

        pending_id = self._insert_task(status="pending", updated_at=_stamp(20), params={"show_id": 1})
        not_terminal = self.client.post(f"/api/me/notifications/task:{pending_id}/read")
        self.assertEqual(not_terminal.status_code, 404)

        read_all = self.client.post("/api/me/notifications/read-all")
        self.assertEqual(read_all.json()["marked"], 5)
        self.assertEqual(read_all.json()["unread_count"], 0)

    def test_upgrade_baselines_existing_terminal_tasks_as_read(self):
        terminal_id = self._insert_task(updated_at=_stamp(5), params={"show_id": 1})
        self.assertEqual(self._list().json()["unread_count"], 1)

        self.db.execute("PRAGMA user_version = 33")
        self.db.commit()
        database.init_db()

        baseline = self.db.execute(
            "SELECT source_id FROM notification_reads WHERE user_id = ? ORDER BY source_id",
            (int(self.user_a["id"]),),
        ).fetchall()
        self.assertEqual([int(row["source_id"]) for row in baseline], [terminal_id])
        self.assertEqual(self._list().json()["unread_count"], 0)

        # Active tasks created after the baseline are not terminal, so they do
        # not appear; once one finishes it is unread again.
        pending_id = self._insert_task(status="pending", updated_at=_stamp(6), params={"show_id": 1})
        self.assertNotIn(f"task:{pending_id}", self._list(filter="unread").json()["items"])
        self._insert_task(
            task_type="ai_tagging",
            status="completed",
            updated_at=_stamp(7),
            params={"target_id": 1},
            result_data={"suggested_tags": []},
        )
        self.assertEqual(self._list().json()["unread_count"], 1)
