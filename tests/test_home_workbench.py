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
from app.routers import user_center
from app.routers.dependencies import db_dep, db_read_dep
from app.services.activity import record_login_event


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
        record_login_event(self.db, self.user_id, "password")
        self.db.commit()

        stats = self.client.get("/api/me/home/stats").json()
        self.assertEqual(stats["resources"]["total"], 0)
        self.assertEqual(stats["standard_shows"], 0)
        self.assertEqual(stats["tasks"]["upload"], 1)
        self.assertEqual(stats["tasks"]["download"], 1)
        self.assertEqual(stats["tasks"]["unfinished"], 1)
        self.assertEqual(stats["tasks"]["failed"], 0)

        activity = self.client.get("/api/me/activity", params={"days": 365}).json()
        today = datetime.now().strftime("%Y-%m-%d")
        self.assertEqual(activity["end"], today)
        self.assertEqual(activity["login"], [{"date": today, "count": 1}])
        self.assertEqual(activity["upload"], [{"date": today, "count": 1}])
        self.assertEqual(activity["download"], [])

    def test_activity_clamps_out_of_range_days(self):
        response = self.client.get("/api/me/activity", params={"days": 10})
        self.assertEqual(response.status_code, 200)
        self.assertLessEqual(response.json()["start"], response.json()["end"])


if __name__ == "__main__":
    unittest.main()
