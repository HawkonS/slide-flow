"""Feishu directory synchronization tests with a mocked contact tree."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.config import settings
from app.core.feishu import FeishuDepartmentInfo, FeishuUserInfo
from app.db import init_db, now_iso
from app.services import departments as department_service
from app.services import directory_sync


class DirectorySyncTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-directory-")
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
        self.root = department_service.get_root_department(self.db)
        self.admin = self._insert_user("管理员", "admin", "admin")
        ts = now_iso()
        # A local user that must remain untouched by sync.
        self.local_user = self._insert_user("本地用户", "local", "user")
        self.db.commit()

    def _insert_user(self, name: str, username: str, role: str) -> int:
        ts = now_iso()
        cursor = self.db.execute(
            "INSERT INTO users (name, username, username_key, password_hash, role, tags, created_at, updated_at) "
            "VALUES (?, ?, ?, 'x', ?, '本地-标签', ?, ?)",
            (name, username, username, role, ts, ts),
        )
        return int(cursor.lastrowid)

    def _tree(self):
        departments = [
            FeishuDepartmentInfo("d1", "0", "研发部", ("u1",), 1, True),
            FeishuDepartmentInfo("d2", "d1", "前端组", (), 1, True),
            FeishuDepartmentInfo("d3", "0", "财务部", ("u2",), 2, True),
        ]
        users = [
            FeishuUserInfo(
                open_id="u1",
                name="张三",
                avatar_url="",
                tenant_key="",
                email="zhangsan@example.com",
                job_title="研发负责人",
                employee_no="E001",
                employment_status="active",
                department_ids=("d1",),
            ),
            FeishuUserInfo(
                open_id="u2",
                name="李四",
                avatar_url="",
                tenant_key="",
                enterprise_email="lisi@example.com",
                job_title="财务",
                employment_status="active",
                department_ids=("d3",),
            ),
            FeishuUserInfo(
                open_id="u3",
                name="王五",
                avatar_url="",
                tenant_key="",
                email="wangwu@example.com",
                job_title="前端",
                employment_status="active",
                department_ids=("d2",),
            ),
        ]
        return departments, users

    def _sync(self):
        with patch.object(directory_sync, "_fetch_directory", return_value=self._tree()):
            result = directory_sync.sync_feishu_directory(self.db, actor_id=self.admin)
        self.db.commit()
        return result

    def _department_by_external(self, external_id: str) -> sqlite3.Row:
        row = self.db.execute(
            "SELECT * FROM departments WHERE external_source = 'feishu' AND external_id = ?",
            (external_id,),
        ).fetchone()
        self.assertIsNotNone(row)
        return row

    def test_sync_creates_departments_users_memberships_and_leaders(self):
        result = self._sync()
        self.assertEqual(result["departments_created"], 3)
        self.assertEqual(result["users_created"], 3)
        self.assertEqual(result["users_updated"], 0)
        frontend = self._department_by_external("d2")
        research = self._department_by_external("d1")
        self.assertEqual(frontend["parent_id"], int(research["id"]))
        wangwu = self.db.execute("SELECT * FROM users WHERE feishu_id = 'u3'").fetchone()
        self.assertEqual(wangwu["email"], "wangwu@example.com")
        self.assertEqual(wangwu["job_title"], "前端")
        member = self.db.execute(
            "SELECT 1 FROM department_members WHERE user_id = ? AND department_id = ?",
            (int(wangwu["id"]), int(frontend["id"])),
        ).fetchone()
        self.assertIsNotNone(member)
        tags = {
            row["tag_name"]
            for row in self.db.execute(
                "SELECT tag_name FROM user_tags WHERE user_id = ?", (int(wangwu["id"]),)
            ).fetchall()
        }
        self.assertIn(department_service.department_tag_name(int(research["id"])), tags)
        self.assertIn(department_service.department_tag_name(int(frontend["id"])), tags)
        leaders = department_service.list_department_leaders(self.db, [int(research["id"])])
        self.assertEqual(leaders[int(research["id"])][0]["user_id"], int(
            self.db.execute("SELECT id FROM users WHERE feishu_id = 'u1'").fetchone()["id"]
        ))

    def test_second_sync_updates_and_deactivates_missing_department(self):
        self._sync()
        frontend = self._department_by_external("d2")
        wangwu = self.db.execute("SELECT id FROM users WHERE feishu_id = 'u3'").fetchone()
        # A manually assigned local membership must survive synchronization.
        local_frontend = self.db.execute(
            "SELECT 1 FROM department_members WHERE user_id = ? AND department_id = ?",
            (int(wangwu["id"]), int(frontend["id"])),
        ).fetchone()
        self.assertIsNotNone(local_frontend)
        departments = [
            FeishuDepartmentInfo("d1", "0", "研发中心", ("u1",), 1, True),
            FeishuDepartmentInfo("d2", "d1", "前端组", (), 1, True),
        ]
        users = self._tree()[1]
        with patch.object(directory_sync, "_fetch_directory", return_value=(departments, users)):
            result = directory_sync.sync_feishu_directory(self.db, actor_id=self.admin)
        self.db.commit()
        self.assertEqual(result["departments_deactivated"], 1)
        self.assertEqual(self._department_by_external("d1")["name"], "研发中心")
        finance = self._department_by_external("d3")
        self.assertEqual(int(finance["is_active"]), 0)
        # Missing department is deactivated, not deleted.
        self.assertIsNotNone(finance)

    def test_dry_run_does_not_write(self):
        before = int(self.db.execute("SELECT COUNT(*) FROM departments").fetchone()[0])
        with patch.object(directory_sync, "_fetch_directory", return_value=self._tree()):
            result = directory_sync.sync_feishu_directory(
                self.db, actor_id=self.admin, dry_run=True
            )
        after = int(self.db.execute("SELECT COUNT(*) FROM departments").fetchone()[0])
        self.assertEqual(before, after)
        self.assertTrue(result["dry_run"])
        self.assertEqual(result["departments_created"], 3)


if __name__ == "__main__":
    unittest.main()
