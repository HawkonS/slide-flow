"""Dynamic resource grants backed by current user-tag membership."""

import sqlite3
import unittest

from fastapi import HTTPException

from app.core.permissions import can_manage_resource, can_view_resource
from app.services.resources import _normalise_scope_user_ids
from app.services.resource_queries import _resource_visibility_sql


class ResourceTagPermissionTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript(
            """
            CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT NOT NULL);
            INSERT INTO users VALUES (1, 'user'), (2, 'user');
            CREATE TABLE resources (
                id INTEGER PRIMARY KEY,
                owner_id INTEGER NOT NULL,
                visibility_scope TEXT NOT NULL,
                management_scope TEXT NOT NULL
            );
            INSERT INTO resources VALUES (10, 1, 'partial', 'partial');
            CREATE TABLE user_tags (
                user_id INTEGER NOT NULL,
                tag_name TEXT NOT NULL,
                PRIMARY KEY (user_id, tag_name)
            );
            CREATE TABLE resource_visibility (resource_id INTEGER, user_id INTEGER);
            CREATE TABLE resource_management (resource_id INTEGER, user_id INTEGER);
            CREATE TABLE resource_visibility_tags (resource_id INTEGER, tag_name TEXT);
            CREATE TABLE resource_management_tags (resource_id INTEGER, tag_name TEXT);
            INSERT INTO resource_visibility_tags VALUES (10, 'company-leader');
            INSERT INTO resource_management_tags VALUES (10, 'company-leader');
            """
        )
        self.resource = self.db.execute("SELECT * FROM resources WHERE id = 10").fetchone()
        self.user = self.db.execute("SELECT * FROM users WHERE id = 2").fetchone()

    def visible_ids(self, *, manageable_only=False):
        clause, params = _resource_visibility_sql(
            self.user, "r", manageable_only=manageable_only
        )
        rows = self.db.execute(
            f"SELECT r.id FROM resources r WHERE {clause} ORDER BY r.id", params
        ).fetchall()
        return [int(row["id"]) for row in rows]

    def test_membership_changes_take_effect_without_rewriting_resource_grants(self):
        self.assertFalse(can_view_resource(self.db, self.resource, self.user))
        self.assertFalse(can_manage_resource(self.db, self.resource, self.user))
        self.assertEqual(self.visible_ids(), [])
        self.assertEqual(self.visible_ids(manageable_only=True), [])

        self.db.execute(
            "INSERT INTO user_tags (user_id, tag_name) VALUES (2, 'company-leader')"
        )
        self.assertTrue(can_view_resource(self.db, self.resource, self.user))
        self.assertTrue(can_manage_resource(self.db, self.resource, self.user))
        self.assertEqual(self.visible_ids(), [10])
        self.assertEqual(self.visible_ids(manageable_only=True), [10])

        self.db.execute("DELETE FROM user_tags WHERE user_id = 2")
        self.assertFalse(can_view_resource(self.db, self.resource, self.user))
        self.assertFalse(can_manage_resource(self.db, self.resource, self.user))

    def test_direct_user_and_tag_grants_can_coexist(self):
        self.db.execute("INSERT INTO resource_visibility VALUES (10, 2)")
        self.db.execute("INSERT INTO resource_management VALUES (10, 2)")
        self.assertTrue(can_view_resource(self.db, self.resource, self.user))
        self.assertTrue(can_manage_resource(self.db, self.resource, self.user))
        self.assertEqual(self.visible_ids(manageable_only=True), [10])

    def test_scope_user_validation_rejects_boolean_and_missing_users(self):
        for value in ([True], [999]):
            with self.subTest(value=value), self.assertRaises(HTTPException) as raised:
                _normalise_scope_user_ids(self.db, value)
            self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
