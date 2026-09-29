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


    @staticmethod
    def partial_receipt(worker_attempt=3):
        return {
            "worker_attempt": worker_attempt,
            "pages": [{"index": 0, "size": 10, "sha256": "a" * 64}],
            "partial_preview_paths": {"0": "/unused/previews/page_0000.png"},
            "partial_preview_hashes": {"0": "b" * 64},
        }

    def attach_receipt(self, child_id, receipt, *, attempts=3):
        raw = receipt if isinstance(receipt, str) else json.dumps(receipt)
        self.db.execute(
            "UPDATE renderer_ppt_tasks SET attempts=?, result_manifest=? WHERE task_id=?",
            (attempts, raw, child_id),
        )

    def seed_parent_progress(self, parent_id, child_id, *, completed=99, worker_attempt=1):
        params = {
            "workflow_state": "rendering", "render_task_id": child_id,
            "render_attempt": "attempt-" + child_id, "render_completed": completed,
            "render_worker_attempt": worker_attempt, "operator_note": "keep this value",
        }
        self.db.execute("UPDATE tasks SET params=?, progress=?, total=2 WHERE id=?",
                        (json.dumps(params), completed, parent_id))

    def test_active_matching_partial_receipt_restores_progress_and_worker_attempt(self):
        for parent_id, status in enumerate(("queued", "running"), start=20):
            child_id = "matching-" + status
            self.add_parent(parent_id, state="rendering")
            self.add_child(child_id, parent_id, status=status)
            self.seed_parent_progress(parent_id, child_id)
            self.attach_receipt(child_id, self.partial_receipt())
        self.recover()
        for parent_id, status in enumerate(("queued", "running"), start=20):
            with self.subTest(status=status):
                parent = self.db.execute("SELECT * FROM tasks WHERE id=?", (parent_id,)).fetchone()
                params = json.loads(parent["params"])
                self.assertEqual((parent["status"], parent["progress"], parent["total"]), ("pending", 1, 2))
                self.assertEqual((params["render_completed"], params["render_worker_attempt"]), (1, 3))
                self.assertEqual((params["workflow_state"], params["preview_status"]), ("rendering", "rendering"))
                self.assertEqual(params["operator_note"], "keep this value")

    def test_active_stale_worker_receipt_resets_progress(self):
        for parent_id, status in enumerate(("queued", "running"), start=30):
            child_id = "stale-" + status
            self.add_parent(parent_id, state="rendering")
            self.add_child(child_id, parent_id, status=status)
            self.seed_parent_progress(parent_id, child_id, completed=1, worker_attempt=2)
            self.attach_receipt(child_id, self.partial_receipt(worker_attempt=2), attempts=3)
        self.recover()
        for parent_id in (30, 31):
            parent = self.db.execute("SELECT * FROM tasks WHERE id=?", (parent_id,)).fetchone()
            params = json.loads(parent["params"])
            self.assertEqual(parent["progress"], 0)
            self.assertEqual((params["render_completed"], params["render_worker_attempt"]), (0, 3))
            self.assertEqual(params["preview_status"], "rendering")

    def test_malformed_receipts_reset_progress_for_queued_and_running_children(self):
        good = self.partial_receipt()
        cases = [
            ("invalid-json", "{"), ("array", "[]"), ("null", "null"), ("primitive", "false"),
            ("missing-generation", {key: value for key, value in good.items() if key != "worker_attempt"}),
            ("boolean-generation", {**good, "worker_attempt": True}),
            ("string-generation", {**good, "worker_attempt": "3"}),
            ("pages-object", {**good, "pages": {}}),
            ("unknown-index", {**good, "pages": [{"index": 9, "size": 10, "sha256": "a" * 64}]}),
            ("duplicate-index", {**good, "pages": good["pages"] * 2}),
            ("boolean-size", {**good, "pages": [{"index": 0, "size": True, "sha256": "a" * 64}]}),
            ("invalid-hash", {**good, "partial_preview_hashes": {"0": "invalid"}}),
            ("paths-array", {**good, "partial_preview_paths": []}),
            ("missing-hash", {**good, "partial_preview_hashes": {}}),
            ("extra-path", {**good, "partial_preview_paths": {"0": "/one.png", "1": "/two.png"}}),
        ]
        parents = []
        for status in ("queued", "running"):
            for label, receipt in cases:
                parent_id = 100 + len(parents)
                child_id = status + "-" + label
                attempts = 1 if label == "boolean-generation" else 3
                self.add_parent(parent_id, state="rendering")
                self.add_child(child_id, parent_id, status=status)
                self.seed_parent_progress(parent_id, child_id)
                self.attach_receipt(child_id, receipt, attempts=attempts)
                parents.append((parent_id, status, label, attempts))
        self.recover()
        for parent_id, status, label, attempts in parents:
            with self.subTest(status=status, receipt=label):
                parent = self.db.execute("SELECT * FROM tasks WHERE id=?", (parent_id,)).fetchone()
                params = json.loads(parent["params"])
                self.assertEqual((parent["status"], parent["progress"]), ("pending", 0))
                self.assertEqual((params["render_completed"], params["render_worker_attempt"]), (0, attempts))
                self.assertEqual(params["preview_status"], "rendering")

    def test_older_generation_partial_does_not_contaminate_current_parent(self):
        self.add_parent(40, state="rendering")
        self.add_child("old-partial", 40, status="running", created_at="2026-09-27T01:00:00Z")
        self.attach_receipt("old-partial", self.partial_receipt(worker_attempt=4), attempts=4)
        self.add_child("new-current", 40, status="queued", created_at="2026-09-27T02:00:00Z")
        self.seed_parent_progress(40, "new-current", completed=0, worker_attempt=0)
        self.recover()
        parent = self.db.execute("SELECT * FROM tasks WHERE id=40").fetchone()
        params = json.loads(parent["params"])
        self.assertEqual((parent["progress"], params["render_completed"], params["render_worker_attempt"]), (0, 0, 0))
        self.assertEqual((params["render_task_id"], params["render_attempt"]), ("new-current", "attempt-new-current"))
        old = self.db.execute("SELECT * FROM renderer_ppt_tasks WHERE task_id='old-partial'").fetchone()
        self.assertEqual(old["status"], "cancelled")
        self.assertIsNone(old["lease_token_hash"])

    def test_terminal_parent_snapshot_is_unchanged_by_partial_receipts(self):
        snapshots = []
        for parent_id, status in enumerate(("completed", "failed", "cancelled"), start=50):
            child_id = "terminal-partial-" + status
            self.add_parent(parent_id, status=status, state="rendering")
            self.add_child(child_id, parent_id, status="running")
            self.attach_receipt(child_id, self.partial_receipt())
            self.seed_parent_progress(parent_id, child_id, completed=7, worker_attempt=8)
            snapshots.append((parent_id, child_id, dict(self.db.execute("SELECT * FROM tasks WHERE id=?", (parent_id,)).fetchone())))
        self.recover()
        for parent_id, child_id, before in snapshots:
            with self.subTest(status=before["status"]):
                after = dict(self.db.execute("SELECT * FROM tasks WHERE id=?", (parent_id,)).fetchone())
                self.assertEqual(after, before)
                child = self.db.execute("SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (child_id,)).fetchone()
                self.assertEqual(child["status"], "cancelled")
                self.assertIsNone(child["lease_token_hash"])
                self.assertIsNone(child["lease_until"])


if __name__ == "__main__":
    unittest.main()
