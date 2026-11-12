"""Automatic database backup tests."""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from app.services import backup


class DatabaseBackupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db_path = self.root / "slide_flow.db"
        connection = sqlite3.connect(self.db_path)
        connection.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)")
        connection.execute("INSERT INTO sample (value) VALUES ('kept')")
        connection.execute("PRAGMA user_version = 30")
        connection.commit()
        connection.close()
        self.backups = self.root / "backups"

    def test_local_backup_is_consistent_and_prunes_old_versions(self) -> None:
        base = datetime(2026, 1, 1, 0, 0, 0)
        first = backup.create_database_backup(
            db_path=self.db_path, local_dir=self.backups, retention=2, storage="local", now=base,
        )
        second = backup.create_database_backup(
            db_path=self.db_path, local_dir=self.backups, retention=2, storage="local", now=base + timedelta(seconds=1),
        )
        third = backup.create_database_backup(
            db_path=self.db_path, local_dir=self.backups, retention=2, storage="local", now=base + timedelta(seconds=2),
        )

        self.assertEqual(third["storage"], "local")
        self.assertEqual(third["removed_local"], [first["filename"]])
        files = sorted(path.name for path in self.backups.glob("slide-flow-backup-*.db"))
        self.assertEqual(files, sorted([second["filename"], third["filename"]]))
        self.assertTrue((self.backups / f"{third['filename']}.json").exists())

        connection = sqlite3.connect(self.backups / third["filename"])
        try:
            self.assertEqual(connection.execute("SELECT value FROM sample").fetchone()[0], "kept")
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 30)
        finally:
            connection.close()

        metadata = json.loads((self.backups / f"{third['filename']}.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["sha256"], third["sha256"])
        self.assertEqual(metadata["schema_version"], 30)

    def test_oss_backup_uploads_and_applies_remote_retention(self) -> None:
        calls: list[tuple[str, str]] = []
        deleted: list[str] = []

        def upload(path, key, content_type=None):
            calls.append((str(path), key))
            return f"oss://bucket/{key}"

        def list_objects(prefix):
            return [
                {"key": f"{prefix}slide-flow-backup-20250101T000000Z.db"},
                {"key": f"{prefix}slide-flow-backup-20260102T030405Z.db"},
            ]

        with patch.object(backup, "oss_storage") as storage:
            storage.upload_file.side_effect = upload
            storage.list_objects.side_effect = list_objects
            storage.delete.side_effect = lambda ref: deleted.append(ref)
            result = backup.create_database_backup(
                db_path=self.db_path,
                local_dir=self.backups,
                retention=1,
                storage="oss",
                oss_prefix="backups/db",
                now=datetime(2026, 1, 2, 3, 4, 5),
            )

        self.assertEqual(result["storage"], "oss")
        self.assertEqual(len(result["oss_keys"]), 2)
        self.assertTrue(result["oss_keys"][0].endswith(".db"))
        self.assertFalse(result["oss_error"])
        self.assertEqual([key for _, key in calls], result["oss_keys"])
        self.assertTrue(deleted)

    def test_claim_is_atomic_across_workers_and_due_again_later(self) -> None:
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.execute(
            """CREATE TABLE backup_state (
                id INTEGER PRIMARY KEY, last_started_at TEXT, last_completed_at TEXT,
                next_due_at TEXT, status TEXT, message TEXT
            )"""
        )
        self.assertTrue(backup._claim_backup(connection, 24))
        self.assertFalse(backup._claim_backup(connection, 24))
        connection.execute("UPDATE backup_state SET next_due_at = '2000-01-01T00:00:00Z' WHERE id = 1")
        connection.commit()
        self.assertTrue(backup._claim_backup(connection, 24))


if __name__ == "__main__":
    unittest.main()
