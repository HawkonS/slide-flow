from __future__ import annotations

import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from app.services.resource_import.font_tasks import (
    claim_font_delete_task,
    claim_font_task,
    create_font_task,
    font_sync_status,
    queue_font_deletions,
    update_font_delete_task,
    update_font_task,
)


class FontTaskTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.execute("CREATE TABLE fonts (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT)")
        self.temp = tempfile.TemporaryDirectory(prefix="slideflow-font-task-")
        self.path = Path(self.temp.name) / "font.ttf"
        self.path.write_bytes(b"font-bytes")
        self.db.execute("INSERT INTO fonts VALUES (1, ?, ?)", (str(self.path), "font.ttf"))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_claim_and_complete_makes_global_sync_ready(self):
        task_id = create_font_task(self.db, 1, self.path)
        self.db.commit()
        claimed, token = claim_font_task(self.db)
        self.assertEqual(claimed["task_id"], task_id)
        self.assertFalse(font_sync_status(self.db)["ready"])
        update_font_task(self.db, task_id, token, "completed")
        self.assertTrue(font_sync_status(self.db)["ready"])

    def test_failed_task_is_requeued_before_hard_failure(self):
        task_id = create_font_task(self.db, 1, self.path)
        self.db.commit()
        _, token = claim_font_task(self.db)
        update_font_task(self.db, task_id, token, "failed", "checksum")
        self.assertEqual(self.db.execute("SELECT status FROM renderer_font_tasks").fetchone()[0], "queued")

    def test_only_one_worker_can_claim_an_active_font_task(self):
        create_font_task(self.db, 1, self.path)
        self.db.commit()
        self.assertIsNotNone(claim_font_task(self.db))
        self.assertIsNone(claim_font_task(self.db))

    def test_expired_font_lease_is_reclaimed_and_old_worker_is_rejected(self):
        task_id = create_font_task(self.db, 1, self.path)
        self.db.commit()
        _, old_token = claim_font_task(self.db)
        self.db.execute(
            "UPDATE renderer_font_tasks SET lease_until=? WHERE task_id=?",
            (time.time() - 1, task_id),
        )
        self.db.commit()
        claimed, new_token = claim_font_task(self.db)
        self.assertEqual(claimed["attempts"], 2)
        self.assertNotEqual(old_token, new_token)
        with self.assertRaises(PermissionError):
            update_font_task(self.db, task_id, old_token, "completed")
        update_font_task(self.db, task_id, new_token, "completed")

    def test_legacy_worker_is_accepted_only_for_unreclaimed_first_attempt(self):
        task_id = create_font_task(self.db, 1, self.path)
        self.db.commit()
        claim_font_task(self.db)
        update_font_task(
            self.db, task_id, "", "completed", allow_legacy=True,
        )
        self.assertTrue(font_sync_status(self.db)["ready"])

        self.db.execute(
            "UPDATE renderer_font_tasks SET status='running',attempts=2,lease_until=?,"
            "lease_token_hash=? WHERE task_id=?",
            (time.time() + 60, "not-a-real-token", task_id),
        )
        self.db.commit()
        with self.assertRaises(PermissionError):
            update_font_task(
                self.db, task_id, "", "completed", allow_legacy=True,
            )

    def test_exhausted_expired_font_task_becomes_terminal(self):
        task_id = create_font_task(self.db, 1, self.path)
        self.db.commit()
        _, _token = claim_font_task(self.db)
        self.db.execute(
            "UPDATE renderer_font_tasks SET attempts=5, lease_until=? WHERE task_id=?",
            (time.time() - 1, task_id),
        )
        self.db.commit()
        self.assertIsNone(claim_font_task(self.db))
        row = self.db.execute(
            "SELECT status, error_code FROM renderer_font_tasks WHERE task_id=?", (task_id,),
        ).fetchone()
        self.assertEqual((row["status"], row["error_code"]), ("failed", "lease_exhausted"))

    def test_font_deletion_is_leased_and_blocks_ready_until_completed(self):
        create_font_task(self.db, 1, self.path)
        self.db.commit()
        self.assertEqual(queue_font_deletions(self.db, [1]), 1)
        self.db.execute("DELETE FROM fonts WHERE id=1")
        self.db.commit()
        self.assertFalse(font_sync_status(self.db)["ready"])
        claimed, token = claim_font_delete_task(self.db)
        self.assertEqual(claimed["sha256"], self.db.execute(
            "SELECT sha256 FROM renderer_font_delete_tasks"
        ).fetchone()[0])
        update_font_delete_task(self.db, claimed["task_id"], token, "completed")
        self.assertTrue(font_sync_status(self.db)["ready"])

    def test_deletion_is_not_queued_while_same_hash_is_still_referenced(self):
        first = create_font_task(self.db, 1, self.path)
        self.db.execute("INSERT INTO fonts VALUES (2, ?, ?)", (str(self.path), "copy.ttf"))
        second = create_font_task(self.db, 2, self.path)
        self.db.commit()
        self.assertNotEqual(first, second)
        self.assertEqual(queue_font_deletions(self.db, [1]), 0)

    def test_delete_claim_waits_for_running_render_but_preempts_queued_render(self):
        create_font_task(self.db, 1, self.path)
        queue_font_deletions(self.db, [1])
        self.db.execute(
            "CREATE TABLE renderer_ppt_tasks (task_id TEXT PRIMARY KEY, status TEXT)"
        )
        self.db.execute("INSERT INTO renderer_ppt_tasks VALUES ('rendering', 'queued')")
        self.db.commit()
        claimed = claim_font_delete_task(self.db)
        self.assertIsNotNone(claimed)
        _, token = claimed
        update_font_delete_task(self.db, claimed[0]["task_id"], token, "failed", "retry")
        self.db.execute("UPDATE renderer_ppt_tasks SET status='running'")
        self.db.commit()
        self.assertIsNone(claim_font_delete_task(self.db))


if __name__ == "__main__":
    unittest.main()
