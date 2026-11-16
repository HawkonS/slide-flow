"""Feishu organization synchronization task and schedule tests."""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from app.config import settings
from app.db import init_db, now_iso
from app.services.directory_sync import (
    get_directory_sync_schedule,
    update_directory_sync_schedule,
)
from app.services.tasks import feishu_sync
from app.services.tasks.records import _serialize_task


class FeishuSyncTaskTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-feishu-sync-")
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
        self.patchers.extend([
            patch.object(settings, "feishu_sso_enabled", True),
            patch.object(settings, "feishu_app_id", "test-app"),
            patch.object(settings, "feishu_app_secret", "test-secret"),
        ])
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        for value in paths.values():
            if isinstance(value, Path) and value.suffix == "":
                value.mkdir(parents=True, exist_ok=True)
        init_db()
        self.db = sqlite3.connect(settings.db_path)
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        ts = now_iso()
        self.admin_id = int(
            self.db.execute(
                "INSERT INTO users (name, username, username_key, password_hash, role, created_at, updated_at) "
                "VALUES ('管理员', 'admin', 'admin', 'x', 'system_admin', ?, ?)",
                (ts, ts),
            ).lastrowid
        )
        self.db.commit()

    def _create_task(self) -> int:
        task_id = feishu_sync.create_feishu_sync_task(self.db, owner_id=self.admin_id)
        self.db.commit()
        return task_id

    def test_schema_contains_new_task_type_and_schedule_table(self):
        sql = self.db.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
        ).fetchone()["sql"]
        self.assertIn("feishu_sync", sql)
        self.assertIsNotNone(
            self.db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='directory_sync_schedule'"
            ).fetchone()
        )

    def test_manual_task_runs_and_serializes_result(self):
        task_id = self._create_task()
        summary = {
            "dry_run": False,
            "departments_created": 2,
            "departments_updated": 1,
            "departments_deactivated": 0,
            "users_created": 3,
            "users_updated": 2,
            "memberships_added": 4,
            "memberships_removed": 0,
            "leaders_set": 1,
            "skipped_users": 0,
            "warnings": [],
        }
        with patch.object(feishu_sync, "sync_feishu_directory", return_value=summary):
            feishu_sync._execute_feishu_sync_task(task_id)
        row = self.db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        self.assertEqual(row["status"], "completed")
        self.assertEqual(row["progress"], 1)
        result = json.loads(row["result_data"])
        self.assertEqual(result["departments_created"], 2)
        serialized = _serialize_task(row, self.db)
        self.assertEqual(serialized["params"]["trigger"], "manual")
        self.assertEqual(serialized["result_data"]["users_created"], 3)

    def test_active_task_is_rejected(self):
        self._create_task()
        with self.assertRaises(HTTPException) as raised:
            feishu_sync.create_feishu_sync_task(self.db, owner_id=self.admin_id)
        self.assertEqual(raised.exception.status_code, 409)

    def test_failed_task_is_recorded(self):
        task_id = self._create_task()
        with patch.object(
            feishu_sync,
            "sync_feishu_directory",
            side_effect=HTTPException(502, "拉取飞书通讯录失败：网络错误"),
        ):
            feishu_sync._execute_feishu_sync_task(task_id)
        row = self.db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        self.assertEqual(row["status"], "failed")
        self.assertIn("拉取飞书通讯录失败", row["error_message"])

    def test_schedule_updates_and_creates_due_task(self):
        schedule = update_directory_sync_schedule(
            self.db, enabled=True, interval_hours=6, owner_id=self.admin_id
        )
        self.db.commit()
        self.assertTrue(schedule["enabled"])
        self.assertEqual(schedule["interval_hours"], 6)
        self.assertIsNotNone(schedule["next_due_at"])
        current = get_directory_sync_schedule(self.db)
        self.assertEqual(current["owner_id"], self.admin_id)
        self.db.execute(
            "UPDATE directory_sync_schedule SET next_due_at = ? WHERE id = 1",
            ("2000-01-01T00:00:00Z",),
        )
        self.db.commit()
        with patch.object(feishu_sync, "_feishu_configured", return_value=True):
            task_id = feishu_sync.prepare_due_directory_sync_task()
        self.assertIsNotNone(task_id)
        row = self.db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        self.assertEqual(row["task_type"], "feishu_sync")
        self.assertEqual(row["status"], "pending")
        self.assertEqual(json.loads(row["params"])["trigger"], "scheduled")
        after = get_directory_sync_schedule(self.db)
        self.assertGreater(after["next_due_at"], "2000-01-01T00:00:00Z")

    def test_schedule_rejects_invalid_interval(self):
        with self.assertRaises(HTTPException):
            update_directory_sync_schedule(
                self.db, enabled=True, interval_hours=2, owner_id=self.admin_id
            )


if __name__ == "__main__":
    unittest.main()
