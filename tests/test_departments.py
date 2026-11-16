"""Department tree, membership and department-tag ACL tests."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from app.config import settings
from app.core.permissions import can_view_resource
from app.db import init_db, now_iso
from app.services import departments as service
from app.services.tag_defaults import delete_tag_defaults


class DepartmentServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-departments-")
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
        self.db = sqlite3.connect(settings.db_path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.addCleanup(self.db.close)
        self.root = service.get_root_department(self.db)
        self.admin = self._insert_user("管理员", "admin", "admin")
        self.owner = self._insert_user("所有者", "owner", "user")
        self.member = self._insert_user("成员", "member", "user")
        self.outsider = self._insert_user("外部", "outsider", "user")
        self.db.commit()

    def _insert_user(self, name: str, username: str, role: str) -> int:
        ts = now_iso()
        cursor = self.db.execute(
            "INSERT INTO users (name, username, username_key, password_hash, role, created_at, updated_at) "
            "VALUES (?, ?, ?, 'x', ?, ?, ?)",
            (name, username, username, role, ts, ts),
        )
        return int(cursor.lastrowid)

    def _create_resource(self, owner_id: int) -> int:
        ts = now_iso()
        cursor = self.db.execute(
            "INSERT INTO resources "
            "(detail_token, name, owner_id, subject, tags, status, visibility_scope, "
            " management_scope, secrecy_level, current_version, created_at, updated_at) "
            "VALUES (?, '资源', ?, '', '', '', 'partial', 'private', 'x', 1, ?, ?)",
            (f"token-{owner_id}-{ts}", owner_id, ts, ts),
        )
        return int(cursor.lastrowid)

    def _grant_view(self, resource_id: int, department: sqlite3.Row) -> None:
        tag = service.ensure_department_tag(self.db, department)
        self.db.execute(
            "INSERT INTO resource_visibility_tags (resource_id, tag_name, tag_id) VALUES (?, ?, ?)",
            (resource_id, tag["name"], tag["id"]),
        )

    def _visible(self, resource_id: int, user_id: int) -> bool:
        resource = self.db.execute("SELECT * FROM resources WHERE id = ?", (resource_id,)).fetchone()
        user = self.db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return can_view_resource(self.db, resource, user)

    def test_parent_grant_covers_descendants_but_not_siblings(self):
        rnd = service.create_department(self.db, name="研发部", parent_id=int(self.root["id"]), created_by=self.admin)
        frontend = service.create_department(self.db, name="前端组", parent_id=int(rnd["id"]), created_by=self.admin)
        sales = service.create_department(self.db, name="销售部", parent_id=int(self.root["id"]), created_by=self.admin)
        service.add_department_members(self.db, int(frontend["id"]), [self.member])
        self.db.commit()

        resource_id = self._create_resource(self.owner)
        self._grant_view(resource_id, rnd)
        self.db.commit()

        self.assertTrue(self._visible(resource_id, self.member))
        self.assertFalse(self._visible(resource_id, self.outsider))
        self.assertTrue(self._visible(resource_id, self.owner))
        tags = {
            str(row["tag_name"])
            for row in self.db.execute(
                "SELECT tag_name FROM user_tags WHERE user_id = ?", (self.member,)
            ).fetchall()
        }
        self.assertIn(service.department_tag_name(int(rnd["id"])), tags)
        self.assertIn(service.department_tag_name(int(frontend["id"])), tags)
        self.assertNotIn(service.department_tag_name(int(sales["id"])), tags)

    def test_move_recomputes_ancestor_tags_and_permissions(self):
        rnd = service.create_department(self.db, name="研发部", parent_id=int(self.root["id"]), created_by=self.admin)
        frontend = service.create_department(self.db, name="前端组", parent_id=int(rnd["id"]), created_by=self.admin)
        market = service.create_department(self.db, name="市场部", parent_id=int(self.root["id"]), created_by=self.admin)
        service.add_department_members(self.db, int(frontend["id"]), [self.member])
        resource_id = self._create_resource(self.owner)
        self._grant_view(resource_id, rnd)
        self.db.commit()
        self.assertTrue(self._visible(resource_id, self.member))

        service.update_department(self.db, int(frontend["id"]), parent_id=int(market["id"]))
        self.db.commit()
        tags = {
            str(row["tag_name"])
            for row in self.db.execute(
                "SELECT tag_name FROM user_tags WHERE user_id = ?", (self.member,)
            ).fetchall()
        }
        self.assertNotIn(service.department_tag_name(int(rnd["id"])), tags)
        self.assertIn(service.department_tag_name(int(market["id"])), tags)
        self.assertIn(service.department_tag_name(int(frontend["id"])), tags)
        self.assertFalse(self._visible(resource_id, self.member))

    def test_cycle_move_and_duplicate_sibling_are_rejected(self):
        rnd = service.create_department(self.db, name="研发部", parent_id=int(self.root["id"]), created_by=self.admin)
        frontend = service.create_department(self.db, name="前端组", parent_id=int(rnd["id"]), created_by=self.admin)
        with self.assertRaises(HTTPException):
            service.update_department(self.db, int(rnd["id"]), parent_id=int(frontend["id"]))
        with self.assertRaises(HTTPException):
            service.create_department(self.db, name="研发部", parent_id=int(self.root["id"]), created_by=self.admin)

    def test_leaders_are_distinct_from_members(self):
        dept = service.create_department(self.db, name="测试组", parent_id=int(self.root["id"]), created_by=self.admin)
        service.set_department_leaders(self.db, int(dept["id"]), [self.outsider], int(self.outsider))
        self.db.commit()
        leaders = service.list_department_leaders(self.db, [int(dept["id"])])
        self.assertEqual(leaders[int(dept["id"])][0]["user_id"], self.outsider)
        self.assertTrue(leaders[int(dept["id"])][0]["is_primary"])
        self.assertEqual(service.department_usage_counts(self.db, int(dept["id"]))["members"], 0)

    def test_delete_requires_force_when_used(self):
        dept = service.create_department(self.db, name="财务部", parent_id=int(self.root["id"]), created_by=self.admin)
        service.add_department_members(self.db, int(dept["id"]), [self.member])
        self.db.commit()
        with self.assertRaises(HTTPException) as raised:
            service.delete_department(self.db, int(dept["id"]))
        self.assertEqual(raised.exception.status_code, 409)
        usage = service.department_usage_counts(self.db, int(dept["id"]))
        self.assertEqual(usage["members"], 1)
        service.delete_department(self.db, int(dept["id"]), force=True)
        self.db.commit()
        self.assertIsNone(
            self.db.execute("SELECT 1 FROM departments WHERE id = ?", (int(dept["id"]),)).fetchone()
        )
        self.assertIsNone(
            self.db.execute("SELECT 1 FROM user_tags WHERE user_id = ?", (self.member,)).fetchone()
        )

    def test_department_tag_cannot_be_deleted_from_tag_admin_helper(self):
        dept = service.create_department(self.db, name="运营部", parent_id=int(self.root["id"]), created_by=self.admin)
        tag = service.ensure_department_tag(self.db, dept)
        # The tag-admin guard itself lives in the router; this confirms the
        # projection is marked as department-owned.
        self.assertEqual(int(tag["department_id"]), int(dept["id"]))
        self.assertIsNotNone(
            self.db.execute(
                "SELECT 1 FROM user_tag_definitions WHERE department_id = ?", (int(dept["id"]),)
            ).fetchone()
        )
        delete_tag_defaults(self.db, "user_tag_definitions", int(tag["id"]))


if __name__ == "__main__":
    unittest.main()
