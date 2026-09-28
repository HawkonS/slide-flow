"""Dynamic template grants backed by current user-tag membership."""

import sqlite3
import unittest

from fastapi import HTTPException

from app.services.templates import (
    _set_template_scope_users,
    can_manage_template,
    can_view_template,
)


class TemplateTagPermissionTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript(
            """
            CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT NOT NULL);
            INSERT INTO users VALUES (1, 'admin'), (2, 'admin');
            CREATE TABLE templates (
                id INTEGER PRIMARY KEY,
                owner_id INTEGER NOT NULL,
                visibility_scope TEXT NOT NULL,
                management_scope TEXT NOT NULL
            );
            INSERT INTO templates VALUES (10, 1, 'partial', 'partial');
            CREATE TABLE user_tags (
                user_id INTEGER NOT NULL,
                tag_name TEXT NOT NULL,
                PRIMARY KEY (user_id, tag_name)
            );
            CREATE TABLE template_visibility (template_id INTEGER, user_id INTEGER);
            CREATE TABLE template_management (template_id INTEGER, user_id INTEGER);
            CREATE TABLE template_visibility_tags (template_id INTEGER, tag_name TEXT);
            CREATE TABLE template_management_tags (template_id INTEGER, tag_name TEXT);
            INSERT INTO template_visibility_tags VALUES (10, 'company-leader');
            INSERT INTO template_management_tags VALUES (10, 'company-leader');
            """
        )
        self.template = self.db.execute("SELECT * FROM templates WHERE id = 10").fetchone()
        self.user = self.db.execute("SELECT * FROM users WHERE id = 2").fetchone()

    def test_membership_changes_take_effect_without_rewriting_template_grants(self):
        self.assertFalse(can_view_template(self.db, self.template, self.user))
        self.assertFalse(can_manage_template(self.db, self.template, self.user))

        self.db.execute(
            "INSERT INTO user_tags (user_id, tag_name) VALUES (2, 'company-leader')"
        )
        self.assertTrue(can_view_template(self.db, self.template, self.user))
        self.assertTrue(can_manage_template(self.db, self.template, self.user))

        self.db.execute("DELETE FROM user_tags WHERE user_id = 2")
        self.assertFalse(can_view_template(self.db, self.template, self.user))
        self.assertFalse(can_manage_template(self.db, self.template, self.user))

    def test_direct_user_and_tag_grants_can_coexist(self):
        self.db.execute("INSERT INTO template_visibility VALUES (10, 2)")
        self.db.execute("INSERT INTO template_management VALUES (10, 2)")
        self.assertTrue(can_view_template(self.db, self.template, self.user))
        self.assertTrue(can_manage_template(self.db, self.template, self.user))

    def test_scope_user_replacement_rejects_missing_users_before_deleting_existing_grants(self):
        self.db.execute("INSERT INTO template_visibility VALUES (10, 2)")
        with self.assertRaises(HTTPException) as raised:
            _set_template_scope_users(self.db, "template_visibility", 10, [999])
        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(
            [row[0] for row in self.db.execute("SELECT user_id FROM template_visibility")],
            [2],
        )


if __name__ == "__main__":
    unittest.main()
