"""Directory and user-list API integration tests."""

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
from app.routers import departments, tags, users
from app.routers.dependencies import db_dep, db_read_dep
from app.services import departments as department_service


class DirectoryApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-directory-api-")
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
        for patcher in [patch.object(settings, name, value) for name, value in paths.items()]:
            patcher.start()
            self.addCleanup(patcher.stop)
        for value in paths.values():
            if isinstance(value, Path) and value.suffix == "":
                value.mkdir(parents=True, exist_ok=True)
        init_db()
        self.db = sqlite3.connect(settings.db_path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.addCleanup(self.db.close)
        self.root = department_service.get_root_department(self.db)
        self.admin_id = self._insert_user("管理员", "admin", "system_admin")
        self.owner_id = self._insert_user("所有者", "owner", "user")
        self.db.commit()
        app = FastAPI()
        app.include_router(departments.router, prefix="/api")
        app.include_router(users.router, prefix="/api")
        app.include_router(tags.router, prefix="/api")

        def override_db():
            yield self.db

        app.dependency_overrides[db_dep] = override_db
        app.dependency_overrides[db_read_dep] = override_db
        app.dependency_overrides[_auth_db_dep] = override_db
        self.app = app
        self.client = TestClient(app)
        token = create_session_token(
            self.admin_id,
            settings.secret_key,
            ttl_seconds=300,
            session_version=1,
        )
        self.client.cookies.set(SESSION_COOKIE, token)

    def _insert_user(self, name: str, username: str, role: str) -> int:
        ts = now_iso()
        cursor = self.db.execute(
            "INSERT INTO users (name, username, username_key, password_hash, role, created_at, updated_at) "
            "VALUES (?, ?, ?, 'x', ?, ?, ?)",
            (name, username, username, role, ts, ts),
        )
        return int(cursor.lastrowid)

    def _create_department(self, name: str, parent_id: int) -> dict:
        response = self.client.post(
            "/api/departments",
            json={"parent_id": parent_id, "name": name},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["department"]

    def _create_user(self, username: str, **extra) -> dict:
        payload = {
            "name": username,
            "username": username,
            "password": "temporary-pass-1234",
            "role": "user",
            **extra,
        }
        response = self.client.post("/api/admin/users", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["user"]

    def test_directory_tree_and_user_filtering(self):
        research = self._create_department("研发部", int(self.root["id"]))
        frontend = self._create_department("前端组", research["id"])
        sales = self._create_department("销售部", int(self.root["id"]))
        member = self._create_user(
            "frontend-member",
            email="frontend@example.com",
            job_title="前端工程师",
            employee_no="E100",
            department_ids=[frontend["id"]],
        )
        outsider = self._create_user(
            "sales-member",
            email="sales@example.com",
            job_title="销售",
            department_ids=[sales["id"]],
        )
        self.db.commit()

        directory = self.client.get("/api/admin/directory")
        self.assertEqual(directory.status_code, 200, directory.text)
        body = directory.json()
        total_users = int(self.db.execute("SELECT COUNT(*) FROM users").fetchone()[0])
        unassigned_count = int(
            self.db.execute(
                "SELECT COUNT(*) FROM users u WHERE NOT EXISTS "
                "(SELECT 1 FROM department_members m WHERE m.user_id = u.id)"
            ).fetchone()[0]
        )
        self.assertEqual(body["stats"]["people_count"], total_users)
        self.assertEqual(body["stats"]["department_count"], 3)
        self.assertEqual(body["stats"]["unassigned_count"], unassigned_count)
        frontend_row = next(item for item in body["departments"] if item["id"] == frontend["id"])
        self.assertEqual(frontend_row["parent_id"], research["id"])
        self.assertEqual(frontend_row["member_count"], 1)

        filtered = self.client.get(
            "/api/admin/users",
            params={
                "department_id": research["id"],
                "include_descendants": "true",
                "sort": "name",
            },
        )
        self.assertEqual(filtered.status_code, 200, filtered.text)
        ids = {item["id"] for item in filtered.json()["users"]}
        self.assertIn(member["id"], ids)
        self.assertNotIn(outsider["id"], ids)

        direct = self.client.get(
            "/api/admin/users",
            params={
                "department_id": research["id"],
                "include_descendants": "false",
            },
        )
        self.assertEqual(direct.status_code, 200, direct.text)
        self.assertEqual(direct.json()["total"], 0)

        unassigned = self.client.get(
            "/api/admin/users",
            params={"department_id": "none"},
        )
        self.assertEqual(unassigned.status_code, 200, unassigned.text)
        expected_unassigned = {
            int(row["id"])
            for row in self.db.execute(
                "SELECT id FROM users u WHERE NOT EXISTS "
                "(SELECT 1 FROM department_members m WHERE m.user_id = u.id)"
            ).fetchall()
        }
        self.assertEqual({item["id"] for item in unassigned.json()["users"]}, expected_unassigned)

        search = self.client.get("/api/admin/users", params={"search": "frontend@example.com"})
        self.assertEqual(search.status_code, 200, search.text)
        self.assertEqual([item["id"] for item in search.json()["users"]], [member["id"]])
        self.assertEqual(search.json()["users"][0]["departments"][0]["path"], frontend["path"])

    def test_leader_sort_and_user_tag_department_metadata(self):
        research = self._create_department("研发部", int(self.root["id"]))
        leader = self._create_user("leader", department_ids=[research["id"]])
        member = self._create_user("member", department_ids=[research["id"]])
        department_service.set_department_leaders(
            self.db, research["id"], [leader["id"]], leader["id"]
        )
        self.db.commit()

        response = self.client.get(
            "/api/admin/users",
            params={"department_id": research["id"], "sort": "name"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["users"][0]["id"], leader["id"])
        self.assertTrue(response.json()["users"][0]["leader_of"][0]["is_primary"])

        user_tags = self.client.get("/api/user-tags", params={"include_departments": "true"})
        self.assertEqual(user_tags.status_code, 200, user_tags.text)
        departments_data = user_tags.json()["departments"]
        self.assertTrue(any(item["department_id"] == research["id"] for item in departments_data))

        tag_id = self.db.execute(
            "SELECT id FROM user_tag_definitions WHERE department_id = ?",
            (research["id"],),
        ).fetchone()["id"]
        protected = self.client.put(
            f"/api/admin/user-tags/{tag_id}",
            json={"name": "改名"},
        )
        self.assertEqual(protected.status_code, 400, protected.text)

    def test_sync_schedule_api(self):
        schedule = self.client.get("/api/departments/sync-schedule")
        self.assertEqual(schedule.status_code, 200, schedule.text)
        self.assertFalse(schedule.json()["enabled"])
        updated = self.client.put(
            "/api/departments/sync-schedule",
            json={"enabled": True, "interval_hours": 6},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertTrue(updated.json()["enabled"])
        self.assertEqual(updated.json()["interval_hours"], 6)
        self.assertIsNotNone(updated.json()["next_due_at"])
        invalid = self.client.put(
            "/api/departments/sync-schedule",
            json={"enabled": True, "interval_hours": 2},
        )
        self.assertEqual(invalid.status_code, 400, invalid.text)

    def test_delete_department_requires_force(self):
        research = self._create_department("研发部", int(self.root["id"]))
        self._create_user("member", department_ids=[research["id"]])
        self.db.commit()
        blocked = self.client.delete(f"/api/departments/{research['id']}")
        self.assertEqual(blocked.status_code, 409, blocked.text)
        forced = self.client.delete(f"/api/departments/{research['id']}?force=true")
        self.assertEqual(forced.status_code, 200, forced.text)
        self.assertIsNone(
            self.db.execute("SELECT 1 FROM departments WHERE id = ?", (research["id"],)).fetchone()
        )


if __name__ == "__main__":
    unittest.main()
