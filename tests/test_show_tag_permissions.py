"""Dynamic show visibility grants backed by current user-tag membership."""

from __future__ import annotations

import sqlite3
import unittest

from fastapi import HTTPException

from app.core.permissions import can_view_show
from app.services.shows import _set_show_scope_tags


class ShowTagPermissionTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript(
            """
            CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT NOT NULL);
            INSERT INTO users VALUES (1, 'user'), (2, 'user');
            CREATE TABLE user_tag_definitions (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
            );
            INSERT INTO user_tag_definitions VALUES (10, 'company-leader');
            CREATE TABLE user_tags (
                user_id INTEGER NOT NULL,
                tag_name TEXT NOT NULL,
                tag_id INTEGER,
                PRIMARY KEY (user_id, tag_name)
            );
            CREATE TABLE shows (
                id INTEGER PRIMARY KEY,
                owner_id INTEGER NOT NULL,
                visibility_scope TEXT NOT NULL,
                management_scope TEXT NOT NULL
            );
            INSERT INTO shows VALUES (20, 1, 'partial', 'partial');
            CREATE TABLE show_visibility (show_id INTEGER, user_id INTEGER);
            CREATE TABLE show_visibility_tags (
                show_id INTEGER NOT NULL,
                tag_name TEXT NOT NULL,
                tag_id INTEGER,
                PRIMARY KEY (show_id, tag_name)
            );
            CREATE TABLE show_management (show_id INTEGER, user_id INTEGER);
            CREATE TABLE show_management_tags (
                show_id INTEGER NOT NULL,
                tag_name TEXT NOT NULL,
                tag_id INTEGER
            );
            INSERT INTO show_visibility_tags VALUES (20, 'company-leader', 10);
            INSERT INTO show_management_tags VALUES (20, 'company-leader', 10);
            """
        )
        self.show = self.db.execute("SELECT * FROM shows WHERE id = 20").fetchone()
        self.user = self.db.execute("SELECT * FROM users WHERE id = 2").fetchone()

    def test_tag_membership_grants_and_revokes_visibility_dynamically(self):
        self.assertFalse(can_view_show(self.db, self.show, self.user))
        self.db.execute(
            "INSERT INTO user_tags (user_id, tag_name, tag_id) VALUES (2, 'company-leader', 10)"
        )
        self.assertTrue(can_view_show(self.db, self.show, self.user))
        self.db.execute("DELETE FROM user_tags WHERE user_id = 2")
        self.assertFalse(can_view_show(self.db, self.show, self.user))

    def test_direct_user_and_tag_grants_can_coexist(self):
        self.db.execute("INSERT INTO show_visibility VALUES (20, 2)")
        self.assertTrue(can_view_show(self.db, self.show, self.user))

    def test_management_tag_membership_grants_and_revokes_management(self):
        from app.core.permissions import can_manage_show

        self.assertFalse(can_manage_show(self.db, self.show, self.user))
        self.db.execute(
            "INSERT INTO user_tags (user_id, tag_name, tag_id) VALUES (2, 'company-leader', 10)"
        )
        self.assertTrue(can_manage_show(self.db, self.show, self.user))
        self.db.execute("DELETE FROM user_tags WHERE user_id = 2")
        self.assertFalse(can_manage_show(self.db, self.show, self.user))
        self.db.execute("DELETE FROM show_visibility WHERE show_id = 20 AND user_id = 2")
        self.db.execute(
            "INSERT INTO user_tags (user_id, tag_name, tag_id) VALUES (2, 'company-leader', 10)"
        )
        self.assertTrue(can_view_show(self.db, self.show, self.user))

    def test_scope_tag_replacement_rejects_missing_tags_before_deleting_existing(self):
        with self.assertRaises(HTTPException) as raised:
            _set_show_scope_tags(self.db, 20, ["missing-tag"])
        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(
            self.db.execute(
                "SELECT tag_name FROM show_visibility_tags WHERE show_id = 20"
            ).fetchone()["tag_name"],
            "company-leader",
        )


if __name__ == "__main__":
    unittest.main()
