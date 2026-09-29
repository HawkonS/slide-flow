"""Resource list ordering regression tests."""

import sqlite3
import unittest

from app.services.resource_queries import _build_resource_query_sql


class ResourceQueryOrderingTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript(
            """
            CREATE TABLE resources (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                owner_id INTEGER NOT NULL,
                subject TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                visibility_scope TEXT NOT NULL,
                management_scope TEXT NOT NULL,
                secrecy_level TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO resources (
                id, name, owner_id, visibility_scope, management_scope,
                created_at, updated_at
            ) VALUES
                (1, 'deck_01', 1, 'private', 'private', '2026-09-28T10:00:00Z', '2026-09-28T10:00:00Z'),
                (2, 'deck_02', 1, 'private', 'private', '2026-09-28T10:00:00Z', '2026-09-28T10:00:00Z'),
                (3, 'deck_03', 1, 'private', 'private', '2026-09-28T10:00:00Z', '2026-09-28T10:00:00Z'),
                (4, 'deck_100', 1, 'private', 'private', '2026-09-28T09:00:00Z', '2026-09-28T09:00:00Z'),
                (5, 'deck_11', 1, 'private', 'private', '2026-09-28T09:00:00Z', '2026-09-28T09:00:00Z'),
                (6, 'second_01', 1, 'private', 'private', '2026-09-28T10:00:00.125Z', '2026-09-28T10:00:00.125Z'),
                (7, 'second_02', 1, 'private', 'private', '2026-09-28T10:00:00.125Z', '2026-09-28T10:00:00.125Z');
            """
        )
        self.user = self.db.execute(
            "SELECT 1 AS id, 'system_admin' AS role"
        ).fetchone()

    def resource_ids(self, sort):
        _, order_sql, params = _build_resource_query_sql(self.user, sort=sort)
        rows = self.db.execute(
            f"SELECT r.id FROM resources r ORDER BY {order_sql}", params
        ).fetchall()
        return [int(row["id"]) for row in rows]

    def test_updated_desc_keeps_pages_in_import_order_when_timestamps_match(self):
        self.assertEqual(self.resource_ids("updated_desc"), [6, 7, 1, 2, 3, 4, 5])

    def test_created_desc_keeps_pages_in_import_order_when_timestamps_match(self):
        self.assertEqual(self.resource_ids("created_desc"), [6, 7, 1, 2, 3, 4, 5])

    def test_name_sort_has_stable_id_tie_breaker(self):
        self.assertEqual(self.resource_ids("name_asc"), [1, 2, 3, 4, 5, 6, 7])


if __name__ == "__main__":
    unittest.main()
