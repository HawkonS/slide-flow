"""Adjacent detail navigation uses the full list's filters and permissions."""

import sqlite3
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.permissions import require_user
from app.routers.dependencies import db_read_dep
from app.routers.resources.queries import router
from app.services.resource_queries import resource_neighbors


class ResourceNeighborsTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE resources (
                id INTEGER PRIMARY KEY, name TEXT, detail_token TEXT,
                owner_id INTEGER, subject TEXT, status TEXT DEFAULT 'active',
                visibility_scope TEXT, management_scope TEXT,
                current_version INTEGER DEFAULT 1, deleted_at TEXT,
                created_at TEXT DEFAULT '2026-10-15T10:00:00Z',
                updated_at TEXT DEFAULT '2026-10-15T10:00:00Z'
            );
            CREATE TABLE resource_visibility (resource_id INTEGER, user_id INTEGER);
            CREATE TABLE resource_management (resource_id INTEGER, user_id INTEGER);
            CREATE TABLE resource_visibility_tags (resource_id INTEGER, tag_name TEXT);
            CREATE TABLE resource_management_tags (resource_id INTEGER, tag_name TEXT);
            CREATE TABLE user_tags (user_id INTEGER, tag_name TEXT);
            CREATE TABLE tags (id INTEGER, name TEXT);
            CREATE TABLE resource_tags (resource_id INTEGER, tag_id INTEGER);
            CREATE TABLE resource_versions (resource_id INTEGER, version_no INTEGER, common_remark_html TEXT);
            CREATE TABLE personal_remarks (resource_id INTEGER, user_id INTEGER, content_html TEXT);
            INSERT INTO resources (id, name, detail_token, owner_id, subject, visibility_scope, management_scope) VALUES
                (1, 'alpha_01', 'token-1', 1, '产品', 'public', 'private'),
                (2, 'hidden', 'private-token', 2, '产品', 'private', 'private'),
                (3, 'alpha_02', 'token-3', 2, '产品', 'public', 'public'),
                (4, 'deleted', 'deleted-token', 1, '产品', 'public', 'public'),
                (5, 'other', 'token-5', 2, '市场', 'public', 'private'),
                (6, 'alpha_03', 'token-6', 2, '产品', 'public', 'public'),
                (7, 'alpha_04', 'tag-token', 2, '产品', 'partial', 'partial');
            UPDATE resources SET deleted_at = '2026-10-15T11:00:00Z' WHERE id = 4;
            INSERT INTO tags VALUES (1, '精选');
            INSERT INTO resource_tags VALUES (1, 1), (3, 1), (6, 1);
            INSERT INTO resource_versions VALUES (1, 1, '<p>备注</p>'), (6, 1, '<p>备注</p>');
            INSERT INTO personal_remarks VALUES (3, 1, '<p>个人</p>'), (6, 1, '<p>个人</p>');
            INSERT INTO resource_visibility_tags VALUES (7, 'reviewer');
            INSERT INTO resource_management_tags VALUES (7, 'reviewer');
        """)
        self.user = self.db.execute("SELECT 1 AS id, 'user' AS role").fetchone()

    def neighbors(self, resource_id, **filters):
        return resource_neighbors(self.db, self.user, resource_id, **filters)

    def test_order_spans_the_entire_visible_list_and_excludes_deleted_resources(self):
        middle = self.neighbors(3)
        self.assertEqual(middle["previous"]["id"], 1)
        self.assertEqual(middle["next"]["id"], 5)
        self.assertEqual((middle["position"], middle["total"]), (2, 4))
        self.assertIsNone(self.neighbors(1)["previous"])
        self.assertIsNone(self.neighbors(6)["next"])
        for resource_id in (2, 4, 7, 999):
            self.assertEqual(self.neighbors(resource_id), {
                "previous": None, "next": None, "position": None, "total": 0,
            })

    def test_filters_and_sort_match_the_originating_list(self):
        result = self.neighbors(3, search="alpha", subject="产品", tags="精选", sort="name_desc")
        self.assertEqual(result["previous"]["id"], 6)
        self.assertEqual(result["next"]["id"], 1)
        self.assertEqual((result["position"], result["total"]), (2, 3))
        self.assertEqual(self.neighbors(3, manageable_only=True)["next"]["id"], 6)
        self.assertEqual(self.neighbors(1, remark_common="has")["next"]["id"], 6)
        self.assertEqual(self.neighbors(3, remark_personal="has")["next"]["id"], 6)
        self.assertIsNone(self.neighbors(5, subject="产品")["position"])

    def test_current_tag_membership_controls_adjacent_results(self):
        self.assertIsNone(self.neighbors(6)["next"])
        self.db.execute("INSERT INTO user_tags VALUES (1, 'reviewer')")
        self.assertEqual(self.neighbors(6)["next"]["id"], 7)
        self.db.execute("DELETE FROM user_tags")
        self.assertIsNone(self.neighbors(6)["next"])

    def test_authenticated_endpoint_accepts_list_filters(self):
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[require_user] = lambda: self.user
        app.dependency_overrides[db_read_dep] = lambda: self.db
        with TestClient(app) as client:
            response = client.get("/api/resources/3/neighbors", params={"subject": "产品", "sort": "name_desc"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["next"]["detail_token"], "token-1")
            self.assertNotIn("private-token", response.text)


if __name__ == "__main__":
    unittest.main()
