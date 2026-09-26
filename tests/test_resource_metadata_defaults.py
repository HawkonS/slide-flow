import sqlite3
import unittest

from fastapi import HTTPException

from app.db import _maintain_resource_metadata_tags
from app.services.common import _validate_resource_status, _validate_secrecy


class ResourceMetadataDefaultsTests(unittest.TestCase):
    def test_secrecy_and_status_require_explicit_values(self) -> None:
        with self.assertRaisesRegex(HTTPException, "请选择密级"):
            _validate_secrecy("")
        with self.assertRaisesRegex(HTTPException, "请选择状态"):
            _validate_resource_status(None)

        self.assertEqual(_validate_secrecy("内部"), "内部")
        self.assertEqual(_validate_resource_status("草稿"), "草稿")

    def test_generated_metadata_definitions_are_removed(self) -> None:
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        for table in (
            "subject_tag_definitions",
            "secrecy_tag_definitions",
            "status_tag_definitions",
        ):
            db.execute(
                f"""
                CREATE TABLE {table} (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    category TEXT NOT NULL,
                    label TEXT NOT NULL,
                    is_default_filter INTEGER NOT NULL DEFAULT 0,
                    created_by INTEGER
                )
                """
            )

        db.execute(
            "INSERT INTO subject_tag_definitions VALUES (1, '旧主体', '未分类', '旧主体', 0, NULL)"
        )
        db.execute(
            "INSERT INTO secrecy_tag_definitions VALUES (1, 'public', '系统默认', '公开', 0, NULL)"
        )
        db.execute(
            "INSERT INTO secrecy_tag_definitions VALUES (2, '内部', '未分类', '内部', 0, 7)"
        )
        db.execute(
            "INSERT INTO status_tag_definitions VALUES (1, 'active', '历史值', 'active', 0, NULL)"
        )
        db.execute(
            "INSERT INTO status_tag_definitions VALUES (2, '草稿', '流程', '草稿', 0, 7)"
        )

        _maintain_resource_metadata_tags(db)

        self.assertEqual(db.execute("SELECT COUNT(*) FROM subject_tag_definitions").fetchone()[0], 0)
        secrecy = db.execute(
            "SELECT name, category, label FROM secrecy_tag_definitions"
        ).fetchall()
        self.assertEqual(
            [(row["name"], row["category"], row["label"]) for row in secrecy],
            [("内部", "密级", "内部")],
        )
        remaining = db.execute(
            "SELECT name, category, label FROM status_tag_definitions"
        ).fetchall()
        self.assertEqual(
            [(row["name"], row["category"], row["label"]) for row in remaining],
            [("草稿", "状态", "草稿")],
        )


if __name__ == "__main__":
    unittest.main()
