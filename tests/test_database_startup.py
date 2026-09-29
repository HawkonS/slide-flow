from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import db as database
from app.config import settings


class DatabaseStartupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="slideflow-db-startup-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
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
        settings_patch = patch.multiple(settings, **paths)
        settings_patch.start()
        self.addCleanup(settings_patch.stop)
        database.init_db()
        self.db = sqlite3.connect(settings.db_path)
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)

    def concurrent_upgrade_connection(self, target_version: int):
        path = settings.db_path

        class ConcurrentUpgradeConnection(sqlite3.Connection):
            upgrade_applied = False

            def execute(self, sql, parameters=()):
                if sql.strip().upper() == "BEGIN IMMEDIATE" and not self.upgrade_applied:
                    self.upgrade_applied = True
                    # Another worker finishes after the initial version read
                    # but before this worker acquires the migration lock.
                    other = sqlite3.connect(path)
                    try:
                        other.execute(f"PRAGMA user_version = {target_version}")
                        other.commit()
                    finally:
                        other.close()
                return super().execute(sql, parameters)

        connection = sqlite3.connect(path, factory=ConcurrentUpgradeConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        self.addCleanup(connection.close)
        return connection

    def test_waiting_worker_uses_version_observed_under_migration_lock(self):
        self.db.execute("PRAGMA user_version = 23")
        self.db.commit()
        connection = self.concurrent_upgrade_connection(database.DB_SCHEMA_VERSION)

        with patch("app.db.get_db", return_value=connection), patch(
            "app.db._migrate_schema", wraps=database._migrate_schema
        ) as migrate:
            database.init_db()

        self.assertTrue(connection.upgrade_applied)
        migrate.assert_called_once()
        self.assertEqual(migrate.call_args.args[1], database.DB_SCHEMA_VERSION)

    def test_waiting_old_worker_cannot_downgrade_newer_schema_version(self):
        future_version = database.DB_SCHEMA_VERSION + 1
        connection = self.concurrent_upgrade_connection(future_version)

        with patch("app.db.get_db", return_value=connection), patch(
            "app.db._migrate_schema", wraps=database._migrate_schema
        ) as migrate:
            with self.assertRaisesRegex(RuntimeError, "schema"):
                database.init_db()

        migrate.assert_not_called()
        self.assertEqual(
            self.db.execute("PRAGMA user_version").fetchone()[0], future_version
        )

    def test_failed_migration_rolls_back_data_and_schema_version(self):
        self.db.execute("PRAGMA user_version = 23")
        self.db.commit()
        original_users = [
            tuple(row)
            for row in self.db.execute("SELECT id, name FROM users ORDER BY id")
        ]
        self.assertTrue(original_users)

        def fail_after_writing(connection, schema_version):
            connection.execute("UPDATE users SET name = 'must-roll-back'")
            connection.execute(f"PRAGMA user_version = {database.DB_SCHEMA_VERSION}")
            raise RuntimeError("simulated migration failure")

        with patch("app.db._migrate_schema", side_effect=fail_after_writing):
            with self.assertRaisesRegex(RuntimeError, "simulated migration failure"):
                database.init_db()

        self.assertEqual(self.db.execute("PRAGMA user_version").fetchone()[0], 23)
        self.assertEqual(
            [tuple(row) for row in self.db.execute("SELECT id, name FROM users ORDER BY id")],
            original_users,
        )


if __name__ == "__main__":
    unittest.main()
