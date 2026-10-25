from __future__ import annotations

import json
import sqlite3
import unittest
from unittest.mock import patch

from app.services.ai_tagging import apply_tagging_result, create_tagging_tasks


class AiTaggingApplyTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript(
            """
            CREATE TABLE resources (id INTEGER PRIMARY KEY, owner_id INTEGER, tags TEXT);
            INSERT INTO resources VALUES (10, 1, 'keep,remove');
            CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT UNIQUE, category TEXT, label TEXT, sort_order INTEGER, created_by INTEGER, created_at TEXT);
            INSERT INTO tags (id, name) VALUES (1, 'keep'), (2, 'remove'), (3, 'suggested'), (4, 'manual');
            CREATE TABLE resource_tags (resource_id INTEGER, tag_id INTEGER, position INTEGER);
            INSERT INTO resource_tags VALUES (10, 1, 0), (10, 2, 1);
            CREATE TABLE tasks (
                id INTEGER PRIMARY KEY,
                task_type TEXT,
                status TEXT,
                owner_id INTEGER,
                params TEXT DEFAULT '{}',
                progress INTEGER DEFAULT 0,
                total INTEGER DEFAULT 0,
                message TEXT,
                result_data TEXT,
                updated_at TEXT
            );
            INSERT INTO tasks (id, task_type, status, owner_id, result_data, updated_at)
            VALUES (20, 'ai_tagging', 'completed', 1, '{"target_type":"resource","target_id":10,"suggested_tags":["suggested"]}', '');
            """
        )
        self.user = {"id": 1, "role": "user"}

    def current_tags(self) -> list[str]:
        return [
            str(row["name"])
            for row in self.db.execute(
                "SELECT tags.name FROM resource_tags JOIN tags ON tags.id = resource_tags.tag_id WHERE resource_id = 10 ORDER BY position"
            )
        ]

    def test_final_tag_set_supports_removing_existing_and_adding_manual_tags(self):
        response = apply_tagging_result(
            self.db,
            self.user,
            20,
            ["suggested"],
            ["keep", "suggested", "manual"],
        )
        self.assertEqual(self.current_tags(), ["keep", "suggested", "manual"])
        self.assertEqual(response["tags"], ["keep", "suggested", "manual"])
        result = json.loads(self.db.execute("SELECT result_data FROM tasks WHERE id = 20").fetchone()[0])
        self.assertEqual(result["final_tags"], ["keep", "suggested", "manual"])

    def test_unknown_tag_in_final_set_is_rejected_without_changing_tags(self):
        with self.assertRaisesRegex(ValueError, "标签定义不存在"):
            apply_tagging_result(self.db, self.user, 20, [], ["keep", "unknown"])
        self.assertEqual(self.current_tags(), ["keep", "remove"])

    def test_legacy_request_still_appends_selected_suggestions(self):
        response = apply_tagging_result(self.db, self.user, 20, ["suggested"])
        self.assertEqual(response["tags"], ["keep", "remove", "suggested"])

    def test_batch_start_creates_and_schedules_all_tasks_in_one_transaction(self):
        self.db.execute("INSERT INTO resources VALUES (11, 1, '')")
        connection = {"id": 7, "name": "默认连接", "model": "vision-model"}
        with (
            patch("app.services.ai_tagging.validate_resource_for_start") as validate,
            patch("app.services.ai_tagging.default_connection_row", return_value=connection),
            patch("app.services.ai_tagging.schedule_tagging_task") as schedule,
        ):
            items = create_tagging_tasks(self.db, self.user, [10, 11, 10])

        self.assertEqual([item["resource_id"] for item in items], [10, 11])
        self.assertEqual(validate.call_count, 2)
        self.assertEqual(schedule.call_count, 2)
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM tasks WHERE task_type = 'ai_tagging'").fetchone()[0],
            3,
        )


if __name__ == "__main__":
    unittest.main()
