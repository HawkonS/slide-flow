from __future__ import annotations

import sqlite3
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.core.permissions import require_user
from app.db import init_db, now_iso
from app.routers import tasks as tasks_router
from app.routers import user_center
from app.routers.dependencies import db_dep, db_read_dep
from app.services.activity import record_login_event
from app.services.resources import _serialize_resources_lite
from app.services.tasks.retention import archive_old_tasks


class HomeWorkbenchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-home-")
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
        timestamp = now_iso()
        self.user_id = int(
            self.db.execute(
                """INSERT INTO users (name, username, username_key, password_hash, role, created_at, updated_at)
                   VALUES ('Home User', 'home-user', 'home-user', 'not-used', 'user', ?, ?)""",
                (timestamp, timestamp),
            ).lastrowid
        )
        self.user = self.db.execute("SELECT * FROM users WHERE id = ?", (self.user_id,)).fetchone()
        self.db.commit()

        app = FastAPI()
        app.include_router(user_center.router, prefix="/api")
        app.include_router(tasks_router.router)

        def override_user():
            return self.user

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

    def test_stats_and_activity_track_current_user(self):
        completed_at = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        self.db.execute(
            """INSERT INTO tasks (task_type, status, owner_id, completed_at)
               VALUES ('batch_split_import', 'completed', ?, ?)""",
            (self.user_id, completed_at),
        )
        self.db.execute(
            """INSERT INTO tasks (task_type, status, owner_id)
               VALUES ('download', 'pending', ?)""",
            (self.user_id,),
        )
        self.db.execute(
            """INSERT INTO tasks (task_type, status, owner_id, error_message)
               VALUES ('ai_tagging', 'failed', ?, '模型标注请求超时')""",
            (self.user_id,),
        )
        record_login_event(self.db, self.user_id, "password")
        self.db.commit()

        stats = self.client.get("/api/me/home/stats").json()
        self.assertEqual(stats["resources"]["total"], 0)
        self.assertEqual(stats["standard_shows"], 0)
        self.assertEqual(stats["tasks"]["upload"], 1)
        self.assertEqual(stats["tasks"]["download"], 1)
        self.assertEqual(stats["tasks"]["unfinished"], 2)
        self.assertEqual(stats["tasks"]["failed"], 1)

        scoped = self.client.get(
            "/api/tasks",
            params={"task_types": "batch_split_import,download"},
        ).json()
        self.assertEqual({item["task_type"] for item in scoped["items"]}, {"batch_split_import", "download"})

        activity = self.client.get("/api/me/activity", params={"days": 365}).json()
        today = datetime.now().strftime("%Y-%m-%d")
        self.assertEqual(activity["end"], today)
        self.assertEqual(activity["login"], [{"date": today, "count": 1}])
        self.assertEqual(activity["upload"], [{"date": today, "count": 1}])
        self.assertEqual(activity["download"], [])

    def test_failed_ai_task_can_be_dismissed_from_workbench(self):
        task_id = int(
            self.db.execute(
                """INSERT INTO tasks (task_type, status, owner_id, error_message)
                   VALUES ('ai_tagging', 'failed', ?, '模型标注请求超时')""",
                (self.user_id,),
            ).lastrowid
        )
        self.db.commit()

        response = self.client.post(f"/api/tasks/{task_id}/dismiss")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "cancelled")
        row = self.db.execute("SELECT status, message FROM tasks WHERE id = ?", (task_id,)).fetchone()
        self.assertEqual(row["status"], "cancelled")
        self.assertEqual(row["message"], "已忽略模型识别错误")

    def test_stats_count_show_series_not_versions(self):
        timestamp = now_iso()
        for version in (1, 2):
            self.db.execute(
                """INSERT INTO shows
                   (name, owner_id, visibility_scope, management_scope,
                    is_standard, created_at, series_id, version_no, updated_at)
                   VALUES ('重复版本', ?, 'public', 'public', 1, ?, 'series-one', ?, ?)""",
                (self.user_id, timestamp, version, timestamp),
            )
        self.db.commit()

        stats = self.client.get("/api/me/home/stats").json()
        self.assertEqual(stats["shows"]["total"], 1)
        self.assertEqual(stats["shows"]["mine"], 1)
        self.assertEqual(stats["shows"]["visible"], 1)
        self.assertEqual(stats["shows"]["managed"], 1)
        self.assertEqual(stats["standard_shows"], 1)

    def test_show_pin_follows_series_latest_version(self):
        timestamp = now_iso()
        rows = []
        for version in (1, 2):
            rows.append(
                int(
                    self.db.execute(
                        """INSERT INTO shows
                           (name, owner_id, visibility_scope, management_scope,
                            is_standard, created_at, series_id, version_no, updated_at)
                           VALUES ('系列放映', ?, 'public', 'public', 1, ?, 'pinned-series', ?, ?)""",
                        (self.user_id, timestamp, version, timestamp),
                    ).lastrowid
                )
            )
        self.db.commit()

        response = self.client.post(f"/api/me/pins/shows/{rows[0]}")
        self.assertEqual(response.status_code, 200)
        pins = self.client.get("/api/me/pins").json()["shows"]
        self.assertEqual(len(pins), 1)
        self.assertEqual(pins[0]["id"], rows[1])
        self.assertEqual(pins[0]["version_no"], 2)

        response = self.client.delete(f"/api/me/pins/shows/{rows[0]}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/me/pins").json()["shows"], [])

    def test_failed_upload_or_download_task_can_be_dismissed(self):
        task_id = int(
            self.db.execute(
                """INSERT INTO tasks (task_type, status, owner_id, error_message)
                   VALUES ('download', 'failed', ?, '下载文件生成失败')""",
                (self.user_id,),
            ).lastrowid
        )
        self.db.commit()

        response = self.client.post(f"/api/tasks/{task_id}/dismiss")
        self.assertEqual(response.status_code, 200)
        row = self.db.execute("SELECT status, message FROM tasks WHERE id = ?", (task_id,)).fetchone()
        self.assertEqual(row["status"], "cancelled")
        self.assertEqual(row["message"], "已忽略任务错误")

    def test_old_terminal_tasks_are_hidden_but_keep_activity(self):
        completed_at = "2025-01-01T12:00:00"
        self.db.execute(
            """INSERT INTO tasks (task_type, status, owner_id, completed_at)
               VALUES ('download', 'completed', ?, ?)""",
            (self.user_id, completed_at),
        )
        self.db.commit()
        self.assertEqual(archive_old_tasks(self.db), 1)

        listed = self.client.get("/api/tasks").json()["items"]
        self.assertEqual(listed, [])
        activity = self.client.get("/api/me/activity", params={"days": 730}).json()
        self.assertEqual(activity["download"], [{"date": "2025-01-01", "count": 1}])

    def test_bulk_resource_serialization_supports_non_admins(self):
        timestamp = now_iso()
        admin_id = int(
            self.db.execute(
                "SELECT id FROM users WHERE role = 'system_admin' ORDER BY id LIMIT 1"
            ).fetchone()["id"]
        )
        resource_id = int(
            self.db.execute(
                """INSERT INTO resources
                   (name, owner_id, visibility_scope, management_scope, secrecy_level,
                    current_version, created_at, updated_at)
                   VALUES ('公开素材', ?, 'public', 'private', '', 1, ?, ?)""",
                (admin_id, timestamp, timestamp),
            ).lastrowid
        )
        self.db.execute(
            """INSERT INTO resource_versions
               (resource_id, version_no, ppt_path, png_path, font_names, missing_fonts,
                common_remark_html, change_note, created_by, created_at)
               VALUES (?, 1, '', NULL, '[]', '[]', '', '', ?, ?)""",
            (resource_id, self.user_id, timestamp),
        )
        self.db.commit()
        row = self.db.execute("SELECT * FROM resources WHERE id = ?", (resource_id,)).fetchone()
        payload = _serialize_resources_lite(self.db, [row], self.user)
        self.assertEqual(payload[0]["name"], "公开素材")
        self.assertFalse(payload[0]["can_manage"])
        self.assertFalse(payload[0]["is_pinned"])

    def test_task_type_filter_rejects_unknown_values(self):
        response = self.client.get("/api/tasks", params={"task_types": "unknown"})
        self.assertEqual(response.status_code, 400)

    def test_activity_clamps_out_of_range_days(self):
        response = self.client.get("/api/me/activity", params={"days": 10})
        self.assertEqual(response.status_code, 200)
        self.assertLessEqual(response.json()["start"], response.json()["end"])


if __name__ == "__main__":
    unittest.main()
