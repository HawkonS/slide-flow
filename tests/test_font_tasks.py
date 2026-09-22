from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from app.services.resource_import.font_tasks import (
    claim_font_task,
    create_font_task,
    font_sync_status,
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
        claimed = claim_font_task(self.db)
        self.assertEqual(claimed["task_id"], task_id)
        self.assertFalse(font_sync_status(self.db)["ready"])
        update_font_task(self.db, task_id, "completed")
        self.assertTrue(font_sync_status(self.db)["ready"])

    def test_failed_task_is_requeued_before_hard_failure(self):
        task_id = create_font_task(self.db, 1, self.path)
        self.db.commit()
        claim_font_task(self.db)
        update_font_task(self.db, task_id, "failed", "checksum")
        self.assertEqual(self.db.execute("SELECT status FROM renderer_font_tasks").fetchone()[0], "queued")


if __name__ == "__main__":
    unittest.main()
