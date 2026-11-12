"""Merge behavior for duplicate single-page resources."""

import json
import sqlite3
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from app.db import now_iso
from app.services import resource_duplicates
from app.services.fingerprints import dhash_hex


class ResourceDuplicateMergeTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.addCleanup(self.db.close)
        self.db.executescript(
            """
            CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, username TEXT);
            INSERT INTO users (id, name, username) VALUES (1, '测试用户', 'tester');
            CREATE TABLE resources (
                id INTEGER PRIMARY KEY, name TEXT, owner_id INTEGER, visibility_scope TEXT,
                management_scope TEXT, current_version INTEGER, created_at TEXT, deleted_at TEXT
            );
            CREATE TABLE resource_versions (
                id INTEGER PRIMARY KEY, resource_id INTEGER, version_no INTEGER, png_path TEXT, ppt_path TEXT, deleted_at TEXT
            );
            CREATE TABLE resource_fingerprints (
                resource_id INTEGER PRIMARY KEY, version_no INTEGER, dhash TEXT, hash_version INTEGER NOT NULL DEFAULT 0, updated_at TEXT
            );
            CREATE TABLE show_management (show_id INTEGER, user_id INTEGER);
            CREATE TABLE show_management_tags (show_id INTEGER, tag_id INTEGER, tag_name TEXT);
            CREATE TABLE resource_management (resource_id INTEGER, user_id INTEGER);
            CREATE TABLE resource_management_tags (resource_id INTEGER, tag_id INTEGER, tag_name TEXT);
            CREATE TABLE user_tags (user_id INTEGER, tag_id INTEGER, tag_name TEXT);
            CREATE TABLE resource_text_fingerprints (
                resource_id INTEGER PRIMARY KEY, version_no INTEGER, text TEXT,
                extractor_version INTEGER NOT NULL DEFAULT 0, updated_at TEXT
            );
            CREATE TABLE shows (
                id INTEGER PRIMARY KEY, name TEXT, owner_id INTEGER, management_scope TEXT,
                updated_at TEXT, updated_by INTEGER, version_no INTEGER
            );
            CREATE TABLE show_resources (
                show_id INTEGER, resource_id INTEGER, version_no INTEGER, sort_order INTEGER, is_hidden INTEGER,
                PRIMARY KEY (show_id, resource_id)
            );
            CREATE TABLE show_remarks (
                show_id INTEGER, resource_id INTEGER, user_id INTEGER, content_html TEXT, updated_at TEXT,
                UNIQUE (show_id, resource_id, user_id)
            );
            CREATE TABLE show_share_pages (share_id INTEGER, version_id INTEGER);
            CREATE TABLE show_share_tokens (id INTEGER PRIMARY KEY, revoked_at TEXT, expires_at TEXT);
            CREATE TABLE resource_duplicate_ignores (
                id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, group_key TEXT,
                resource_ids TEXT, created_at TEXT, UNIQUE(user_id, group_key)
            );
            CREATE TABLE resource_dedup_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, action TEXT,
                resource_id INTEGER, related_resource_id INTEGER, details TEXT, created_at TEXT
            );
            CREATE TABLE resource_duplicate_merges (
                id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, canonical_id INTEGER,
                duplicate_ids TEXT, moved_pages INTEGER, collapsed_pages INTEGER,
                affected_show_ids TEXT, foreign_resource_ids TEXT, foreign_show_ids TEXT, created_at TEXT
            );
            """
        )
        ts = now_iso()
        self.db.executemany(
            "INSERT INTO resources (id, name, owner_id, visibility_scope, management_scope, current_version, created_at, deleted_at) VALUES (?, ?, 1, 'public', 'private', ?, ?, NULL)",
            [(1, "主素材", 2, ts), (2, "重复素材", 1, ts)],
        )
        self.db.executemany(
            "INSERT INTO resource_versions (id, resource_id, version_no, png_path, deleted_at) VALUES (?, ?, ?, '', NULL)",
            [(11, 1, 1), (12, 1, 2), (21, 2, 1)],
        )
        same = dhash_hex(0b1010)
        self.db.executemany(
            "INSERT INTO resource_fingerprints (resource_id, version_no, dhash, hash_version, updated_at) VALUES (?, ?, ?, 2, ?)",
            [(1, 2, same, ts), (2, 1, same, ts)],
        )
        self.db.executemany(
            "INSERT INTO resource_text_fingerprints (resource_id, version_no, text, extractor_version, updated_at) VALUES (?, ?, '同一页', 3, ?)",
            [(1, 2, ts), (2, 1, ts)],
        )
        self.db.executemany(
            "INSERT INTO shows (id, name, owner_id, management_scope, updated_at, updated_by, version_no) VALUES (?, ?, 1, 'private', ?, 1, 1)",
            [(10, "只引用重复页", ts), (11, "两页都引用", ts)],
        )
        self.db.executemany(
            "INSERT INTO show_resources (show_id, resource_id, version_no, sort_order, is_hidden) VALUES (?, ?, ?, ?, 0)",
            [(10, 2, 1, 0), (11, 1, 2, 0), (11, 2, 1, 1)],
        )
        self.db.execute(
            "INSERT INTO show_remarks (show_id, resource_id, user_id, content_html, updated_at) VALUES (10, 2, 1, '备注', ?)",
            (ts,),
        )
        self.db.commit()
        self.user = {"id": 1, "role": "user"}
        self.deleted: list[int] = []

        def fake_delete(db, ids, scope, user, action, token, **kwargs):
            self.deleted.extend(ids)
            return {"ok": True, "deleted": len(ids)}

        patcher = patch.object(resource_duplicates, "delete_resources", side_effect=fake_delete)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_scan_groups_resources_with_matching_fingerprints(self):
        result = resource_duplicates.scan_duplicates(self.db, self.user, limit=10)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(len(result["groups"]), 1)
        group = result["groups"][0]
        self.assertEqual([entry["id"] for entry in group["resources"]], [2, 1])
        self.assertTrue(group["mergeable"])
        self.assertEqual(group["foreign_resource_count"], 0)
        self.assertEqual(group["foreign_show_count"], 0)

    def test_merge_moves_and_collapses_show_pages(self):
        result = resource_duplicates.merge_duplicates(self.db, 1, [2], self.user)

        self.assertEqual(result["moved_pages"], 1)
        self.assertEqual(result["collapsed_pages"], 1)
        self.assertEqual(self.deleted, [2])

        only_duplicate = self.db.execute(
            "SELECT resource_id, version_no FROM show_resources WHERE show_id = 10"
        ).fetchall()
        self.assertEqual([(row["resource_id"], row["version_no"]) for row in only_duplicate], [(1, 2)])

        both = self.db.execute(
            "SELECT resource_id FROM show_resources WHERE show_id = 11"
        ).fetchall()
        self.assertEqual([row["resource_id"] for row in both], [1])

        remark = self.db.execute("SELECT resource_id FROM show_remarks WHERE show_id = 10").fetchone()
        self.assertEqual(remark["resource_id"], 1)

    def test_merge_requires_managed_shows(self):
        self.db.execute("UPDATE shows SET owner_id = 2, management_scope = 'private' WHERE id = 10")
        self.db.commit()
        with self.assertRaises(HTTPException) as caught:
            resource_duplicates.merge_duplicates(self.db, 1, [2], self.user)
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(self.deleted, [])

    def test_merge_rejects_stale_fingerprints(self):
        self.db.execute("UPDATE resource_fingerprints SET dhash = ? WHERE resource_id = 2", (dhash_hex(0xFFFF),))
        self.db.commit()
        with self.assertRaises(HTTPException) as caught:
            resource_duplicates.merge_duplicates(self.db, 1, [2], self.user)
        self.assertEqual(caught.exception.status_code, 409)

    def test_merge_requires_acknowledging_foreign_resources(self):
        self.db.execute("UPDATE resources SET owner_id = 2, management_scope = 'public' WHERE id = 2")
        self.db.commit()
        with self.assertRaises(HTTPException) as caught:
            resource_duplicates.merge_duplicates(self.db, 1, [2], self.user)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.deleted, [])

        result = resource_duplicates.merge_duplicates(self.db, 1, [2], self.user, acknowledge_foreign=True)
        self.assertEqual(result["merged"], 1)
        audit = self.db.execute("SELECT actor_id, canonical_id, foreign_resource_ids FROM resource_duplicate_merges").fetchone()
        self.assertEqual(audit["actor_id"], 1)
        self.assertEqual(audit["canonical_id"], 1)
        self.assertEqual(json.loads(audit["foreign_resource_ids"]), [2])

    def test_scan_handles_partial_shows_owned_by_another_user(self):
        ts = now_iso()
        self.db.execute(
            "INSERT INTO shows (id, name, owner_id, management_scope, updated_at, updated_by, version_no) VALUES (12, '他人部分管理放映', 2, 'partial', ?, 2, 1)",
            (ts,),
        )
        self.db.execute(
            "INSERT INTO show_resources (show_id, resource_id, version_no, sort_order, is_hidden) VALUES (12, 2, 1, 0, 0)"
        )
        self.db.commit()
        result = resource_duplicates.scan_duplicates(self.db, self.user, limit=10)
        self.assertEqual(result["status"], "ready")
        group = next(group for group in result["groups"] if any(entry["id"] == 2 for entry in group["resources"]))
        self.assertFalse(group["mergeable"])
        self.assertIn("无管理权限", group["reason"] or "")

    def test_ignored_group_is_hidden_until_restored(self):
        first = resource_duplicates.scan_duplicates(self.db, self.user, limit=10)
        self.assertEqual(len(first["groups"]), 1)
        ids = [entry["id"] for entry in first["groups"][0]["resources"]]

        ignored = resource_duplicates.ignore_duplicate_group(self.db, self.user, ids)
        self.assertEqual(ignored["ignored_count"], 1)
        hidden = resource_duplicates.scan_duplicates(self.db, self.user, limit=10)
        self.assertEqual(hidden["groups"], [])
        self.assertEqual(hidden["ignored_count"], 1)

        listed = resource_duplicates.list_ignored_duplicate_groups(self.db, self.user)
        self.assertEqual(listed["total"], 1)
        self.assertEqual([resource["id"] for resource in listed["items"][0]["resources"]], sorted(ids))

        resource_duplicates.restore_ignored_duplicate_group(self.db, self.user, ignored["id"])
        restored = resource_duplicates.scan_duplicates(self.db, self.user, limit=10)
        self.assertEqual(len(restored["groups"]), 1)
        self.assertEqual(restored["ignored_count"], 0)

    def test_merge_rejects_different_text_even_when_images_match(self):
        self.db.execute("UPDATE resource_text_fingerprints SET text = '另一页' WHERE resource_id = 2")
        self.db.commit()
        with self.assertRaises(HTTPException) as raised:
            resource_duplicates.merge_duplicates(self.db, 1, [2], self.user)
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("文字内容不同", raised.exception.detail)

    def test_scan_marks_oversized_groups_unmergeable(self):
        ts = now_iso()
        rows = []
        versions = []
        fingerprints = []
        texts = []
        for offset in range(52):
            resource_id = 100 + offset
            rows.append((resource_id, f"批量素材{offset}", 1, 1, ts))
            versions.append((1000 + offset, resource_id, 1, "", None))
            fingerprints.append((resource_id, 1, dhash_hex(0b1111), 2, ts))
            texts.append((resource_id, 1, "同一页", ts))
        self.db.executemany(
            "INSERT INTO resources (id, name, owner_id, visibility_scope, management_scope, current_version, created_at, deleted_at) VALUES (?, ?, 1, 'public', 'private', 1, ?, NULL)",
            [(row[0], row[1], row[4]) for row in rows],
        )
        self.db.executemany(
            "INSERT INTO resource_versions (id, resource_id, version_no, png_path, deleted_at) VALUES (?, ?, ?, ?, ?)",
            versions,
        )
        self.db.executemany(
            "INSERT INTO resource_fingerprints (resource_id, version_no, dhash, hash_version, updated_at) VALUES (?, ?, ?, ?, ?)",
            fingerprints,
        )
        self.db.executemany(
            "INSERT INTO resource_text_fingerprints (resource_id, version_no, text, extractor_version, updated_at) VALUES (?, ?, '同一页', 3, ?)",
            [(row[0], row[1], row[3]) for row in texts],
        )
        self.db.commit()
        result = resource_duplicates.scan_duplicates(self.db, self.user, limit=100)
        oversized = [group for group in result["groups"] if len(group["resources"]) > 50]
        self.assertTrue(oversized)
        self.assertFalse(oversized[0]["mergeable"])
        self.assertIn("超过", oversized[0]["reason"] or "")

    def test_merge_prepares_text_before_opening_the_write_transaction(self):
        actual = resource_duplicates.ensure_text_fingerprints
        inside_transaction: list[bool] = []

        def spy(*args, **kwargs):
            inside_transaction.append(bool(self.db.in_transaction))
            return actual(*args, **kwargs)

        with patch.object(resource_duplicates, "ensure_text_fingerprints", side_effect=spy):
            resource_duplicates.merge_duplicates(self.db, 1, [2], self.user)
        self.assertEqual(inside_transaction, [False])

    def test_merge_rejects_active_share_pages(self):
        self.db.execute("INSERT INTO show_share_pages (share_id, version_id) VALUES (5, 21)")
        self.db.execute("INSERT INTO show_share_tokens (id, revoked_at, expires_at) VALUES (5, NULL, '2999-01-01T00:00:00+08:00')")
        self.db.commit()
        with self.assertRaises(HTTPException) as caught:
            resource_duplicates.merge_duplicates(self.db, 1, [2], self.user)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.deleted, [])


if __name__ == "__main__":
    unittest.main()
