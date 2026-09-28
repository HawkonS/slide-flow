from __future__ import annotations

import json
import os
import sqlite3
import unittest
from unittest.mock import patch

from app.db import _recover_interrupted_tasks


class TaskRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            CREATE TABLE runtime_state (
                key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT
            );
            CREATE TABLE tasks (
                id INTEGER PRIMARY KEY, task_type TEXT NOT NULL, status TEXT NOT NULL,
                params TEXT, progress INTEGER DEFAULT 0, total INTEGER DEFAULT 0,
                message TEXT DEFAULT '', error_message TEXT, updated_at TEXT
            );
            CREATE TABLE renderer_ppt_tasks (
                task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                render_attempt TEXT NOT NULL, parent_task_id INTEGER,
                status TEXT NOT NULL, lease_token_hash TEXT, lease_until REAL,
                worker_id TEXT, attempts INTEGER DEFAULT 0,
                source_manifest TEXT NOT NULL, result_manifest TEXT,
                error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
        """)

    def tearDown(self) -> None:
        self.db.close()

    def add_parent(self, task_id: int, *, status: str = "processing", state: str = "font_check") -> None:
        self.db.execute(
            "INSERT INTO tasks (id,task_type,status,params) VALUES (?,?,?,?)",
            (task_id, "batch_split_import", status, json.dumps({"workflow_state": state})),
        )

    def add_child(
        self,
        task_id: str,
        parent_id: int | None,
        *,
        status: str,
        created_at: str = "2026-09-27T01:00:00Z",
        error_code: str | None = None,
    ) -> None:
        manifest = {"pages": [{"index": 0}, {"index": 1}]}
        self.db.execute(
            "INSERT INTO renderer_ppt_tasks "
            "(task_id,session_id,render_attempt,parent_task_id,status,lease_token_hash,"
            "lease_until,source_manifest,error_code,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                task_id, "session-" + task_id, "attempt-" + task_id, parent_id,
                status, "lease" if status == "running" else None,
                9999999999 if status == "running" else None,
                json.dumps(manifest), error_code, created_at, created_at,
            ),
        )

    def recover(self) -> None:
        self.db.commit()
        with patch.dict(os.environ, {"SLIDEFLOW_BOOT_ID": self.id()}, clear=False):
            _recover_interrupted_tasks(self.db)

    def test_active_child_repairs_stale_parent_snapshot(self) -> None:
        self.add_parent(1)
        self.add_child("active", 1, status="running")

        self.recover()

        parent = self.db.execute("SELECT * FROM tasks WHERE id=1").fetchone()
        params = json.loads(parent["params"])
        self.assertEqual(parent["status"], "pending")
        self.assertEqual(parent["total"], 2)
        self.assertEqual(params["workflow_state"], "rendering")
        self.assertEqual(params["preview_status"], "rendering")
        self.assertEqual(params["render_task_id"], "active")
        child = self.db.execute(
            "SELECT status FROM renderer_ppt_tasks WHERE task_id='active'"
        ).fetchone()
        self.assertEqual(child["status"], "running")

    def test_completed_child_repairs_parent_completion_receipt(self) -> None:
        self.add_parent(2, state="rendering")
        self.add_child("completed", 2, status="completed")

        self.recover()

        parent = self.db.execute("SELECT * FROM tasks WHERE id=2").fetchone()
        params = json.loads(parent["params"])
        self.assertEqual(parent["status"], "pending")
        self.assertEqual((parent["progress"], parent["total"]), (2, 2))
        self.assertEqual(params["workflow_state"], "awaiting_confirmation")
        self.assertEqual(params["preview_status"], "ready")

    def test_newest_generation_cancels_older_active_child(self) -> None:
        self.add_parent(6, state="rendering")
        self.add_child(
            "older-running", 6, status="running",
            created_at="2026-09-27T01:00:00Z",
        )
        self.add_child(
            "newer-queued", 6, status="queued",
            created_at="2026-09-27T02:00:00Z",
        )

        self.recover()

        children = self.db.execute(
            "SELECT task_id,status,lease_token_hash,lease_until "
            "FROM renderer_ppt_tasks ORDER BY created_at"
        ).fetchall()
        self.assertEqual(
            [(row["task_id"], row["status"]) for row in children],
            [("older-running", "cancelled"), ("newer-queued", "queued")],
        )
        self.assertIsNone(children[0]["lease_token_hash"])
        self.assertIsNone(children[0]["lease_until"])
        parent = self.db.execute("SELECT params FROM tasks WHERE id=6").fetchone()
        self.assertEqual(json.loads(parent["params"])["render_task_id"], "newer-queued")

    def test_terminal_parent_and_orphan_cancel_active_children(self) -> None:
        self.add_parent(3, status="failed", state="rendering")
        self.add_child("terminal-parent", 3, status="running")
        self.add_child("orphan", None, status="queued")

        self.recover()

        rows = self.db.execute(
            "SELECT task_id,status,lease_token_hash,lease_until FROM renderer_ppt_tasks ORDER BY task_id"
        ).fetchall()
        self.assertEqual([(row["task_id"], row["status"]) for row in rows], [
            ("orphan", "cancelled"), ("terminal-parent", "cancelled"),
        ])
        self.assertTrue(all(row["lease_token_hash"] is None for row in rows))
        self.assertTrue(all(row["lease_until"] is None for row in rows))
        self.assertEqual(
            self.db.execute("SELECT status FROM tasks WHERE id=3").fetchone()["status"],
            "failed",
        )

    def test_failed_child_is_retryable_but_task_without_child_is_interrupted(self) -> None:
        self.add_parent(4, state="rendering")
        self.add_child("failed", 4, status="failed", error_code="render_timeout")
        self.db.execute(
            "INSERT INTO tasks (id,task_type,status,params) VALUES (5,'download','processing','{}')"
        )

        self.recover()

        failed_parent = self.db.execute("SELECT * FROM tasks WHERE id=4").fetchone()
        params = json.loads(failed_parent["params"])
        self.assertEqual(failed_parent["status"], "pending")
        self.assertEqual(params["workflow_state"], "awaiting_render")
        self.assertEqual(params["preview_status"], "error")
        interrupted = self.db.execute("SELECT * FROM tasks WHERE id=5").fetchone()
        self.assertEqual(interrupted["status"], "failed")
        self.assertEqual(interrupted["error_message"], "服务重启，任务中断")


if __name__ == "__main__":
    unittest.main()
