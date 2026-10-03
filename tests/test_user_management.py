from __future__ import annotations

import io
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.config import settings
from app.core.feishu import FeishuUserInfo
from app.core.permissions import SESSION_COOKIE, _auth_db_dep
from app.core.security import create_present_token, create_session_token, hash_password
from app.core.user_profiles import (
    delete_managed_avatar,
    is_managed_avatar_ref,
    username_lookup_key,
    validate_avatar_url,
)
from app.db import DB_SCHEMA_VERSION, init_db, now_iso
from app.routers import auth, config as config_router, feishu_auth, presentation, tags, users
from app.routers.dependencies import db_dep, db_read_dep
from app.services.files import _init_allowed_file_dirs


def _test_app(db: sqlite3.Connection) -> FastAPI:
    app = FastAPI()
    app.include_router(auth.router, prefix="/api")
    app.include_router(feishu_auth.router, prefix="/api")
    app.include_router(users.router, prefix="/api")
    app.include_router(tags.router, prefix="/api")
    app.include_router(config_router.router, prefix="/api")
    app.include_router(presentation.router)

    def override_db():
        yield db

    app.dependency_overrides[db_dep] = override_db
    app.dependency_overrides[db_read_dep] = override_db
    app.dependency_overrides[_auth_db_dep] = override_db
    return app


class UserManagementTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-users-")
        root = Path(self.temporary.name)
        self.paths = {
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
        self.patchers = [patch.object(settings, name, value) for name, value in self.paths.items()]
        self.patchers.extend(
            [
                patch.object(settings, "storage_backend", "local"),
                patch.object(settings, "user_custom_tags", False),
                patch.object(settings, "user_custom_user_tags", False),
                patch.object(settings, "user_custom_status_tags", False),
            ]
        )
        for patcher in self.patchers:
            patcher.start()
        init_db()
        _init_allowed_file_dirs()
        self.db = sqlite3.connect(settings.db_path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("DELETE FROM runtime_state")
        self.db.execute("DELETE FROM users")
        self.db.commit()
        self.app = _test_app(self.db)

    def tearDown(self):
        self.db.close()
        for patcher in reversed(self.patchers):
            patcher.stop()
        _init_allowed_file_dirs()
        self.temporary.cleanup()

    def insert_user(
        self,
        username: str,
        *,
        role: str = "user",
        name: str | None = None,
        password: str = "correct-horse-battery-staple",
        feishu_id: str = "",
        tags_value: str = "",
        must_change_pwd: int = 0,
        expires_at: str | None = None,
        last_login_at: str | None = None,
    ) -> int:
        timestamp = now_iso()
        cursor = self.db.execute(
            """
            INSERT INTO users (
                name, username, username_key, password_hash, feishu_id, tags, role,
                must_change_pwd, temporary_password_expires_at, last_login_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                name or username,
                username,
                username_lookup_key(username),
                hash_password(password),
                feishu_id,
                tags_value,
                role,
                must_change_pwd,
                expires_at,
                last_login_at,
                timestamp,
                timestamp,
            ),
        )
        user_id = int(cursor.lastrowid)
        for tag_name in filter(None, tags_value.split(",")):
            self.db.execute(
                "INSERT INTO user_tags (user_id, tag_name) VALUES (?, ?)",
                (user_id, tag_name),
            )
        self.db.commit()
        return user_id

    def client_for(self, user_id: int) -> TestClient:
        client = TestClient(self.app)
        client.cookies.set(
            SESSION_COOKIE,
            create_session_token(user_id, settings.secret_key, ttl_seconds=300),
        )
        return client

    def create_tag(self, name: str, creator_id: int) -> int:
        category, _, label = name.partition("-")
        if not label:
            category, label = "未分类", category
        cursor = self.db.execute(
            """
            INSERT INTO tags (name, category, label, sort_order, created_by, created_at)
            VALUES (?, ?, ?, 0, ?, ?)
            """,
            (name, category, label, creator_id, now_iso()),
        )
        self.db.commit()
        return int(cursor.lastrowid)

    def create_user_tag(self, name: str, creator_id: int) -> int:
        category, _, label = name.partition("-")
        if not label:
            category, label = "未分类", category
        cursor = self.db.execute(
            """
            INSERT INTO user_tag_definitions
                (name, category, label, sort_order, created_by, created_at)
            VALUES (?, ?, ?, 0, ?, ?)
            """,
            (name, category, label, creator_id, now_iso()),
        )
        self.db.commit()
        return int(cursor.lastrowid)

    def test_operations_admin_can_manage_regular_users_but_not_system_admin(self):
        operations_admin = self.insert_user("operator", role="admin")
        system_admin = self.insert_user("root-admin", role="system_admin")
        with self.client_for(operations_admin) as client:
            created = client.post(
                "/api/admin/users",
                json={
                    "name": "Regular User",
                    "username": "regular-user",
                    "password": "regular-user-secure-password",
                    "role": "user",
                },
            )
            self.assertEqual(created.status_code, 200, created.text)
            user_id = created.json()["user"]["id"]
            updated = client.put(
                f"/api/admin/users/{user_id}",
                json={
                    "name": "Operations User",
                    "username": "regular-user",
                    "role": "admin",
                },
            )
            self.assertEqual(updated.status_code, 200, updated.text)
            self.assertEqual(updated.json()["user"]["role"], "admin")

            forbidden_update = client.put(
                f"/api/admin/users/{system_admin}",
                json={"name": "Nope", "username": "root-admin", "role": "system_admin"},
            )
            self.assertEqual(forbidden_update.status_code, 403, forbidden_update.text)
            forbidden_create = client.post(
                "/api/admin/users",
                json={"name": "Another Root", "username": "another-root", "role": "system_admin"},
            )
            self.assertEqual(forbidden_create.status_code, 403, forbidden_create.text)

            selection = client.get("/api/admin/users/selection-ids")
            self.assertEqual(selection.status_code, 200, selection.text)
            self.assertIn(user_id, selection.json()["user_ids"])
            self.assertNotIn(operations_admin, selection.json()["user_ids"])
            self.assertNotIn(system_admin, selection.json()["user_ids"])

        audit_actions = {
            row["action"]
            for row in self.db.execute("SELECT action FROM admin_audit_events").fetchall()
        }
        self.assertTrue({"user.create", "user.update"}.issubset(audit_actions))

    def test_server_side_pagination_search_tag_filter_and_bounded_options(self):
        admin_id = self.insert_user("root", role="system_admin")
        self.create_user_tag("department-sales", admin_id)
        tagged_ids: list[int] = []
        for index in range(125):
            tags_value = "department-sales" if index % 10 == 0 else ""
            user_id = self.insert_user(
                f"member-{index:03d}",
                name=f"Member {index:03d}",
                tags_value=tags_value,
            )
            if tags_value:
                tagged_ids.append(user_id)

        with self.client_for(admin_id) as client:
            page = client.get("/api/admin/users?page=2&page_size=10")
            self.assertEqual(page.status_code, 200, page.text)
            self.assertEqual(page.json()["page"], 2)
            self.assertEqual(page.json()["page_size"], 10)
            self.assertEqual(len(page.json()["users"]), 10)
            self.assertEqual(page.json()["total"], 126)

            searched = client.get("/api/admin/users?search=Member%20124&page_size=10")
            self.assertEqual(searched.json()["total"], 1)
            self.assertEqual(searched.json()["users"][0]["username"], "member-124")
            escaped = client.get("/api/admin/users?search=%25&page_size=10")
            self.assertEqual(escaped.json()["total"], 0)

            filtered = client.get("/api/admin/users?tag=department-sales&page_size=100")
            self.assertEqual(filtered.status_code, 200, filtered.text)
            self.assertEqual(filtered.json()["total"], len(tagged_ids))
            self.assertIn("department-sales", filtered.json()["available_tags"])
            filtered_multi = client.get(
                "/api/admin/users",
                params={
                    "tags": "department-sales,missing-tag",
                    "tags_mode": "any",
                    "page_size": 100,
                },
            )
            self.assertEqual(filtered_multi.status_code, 200, filtered_multi.text)
            self.assertEqual(filtered_multi.json()["total"], len(tagged_ids))

            both_id = self.insert_user(
                "member-both",
                tags_value="department-sales,department-rd",
            )
            tagged_ids.append(both_id)
            self.create_user_tag("department-rd", admin_id)
            filtered_all = client.get(
                "/api/admin/users",
                params={
                    "tags": "department-sales,department-rd",
                    "tags_mode": "all",
                    "page_size": 100,
                },
            )
            self.assertEqual(filtered_all.status_code, 200, filtered_all.text)
            self.assertEqual(filtered_all.json()["total"], 1)
            self.assertEqual(filtered_all.json()["users"][0]["id"], both_id)

            selection = client.get(
                "/api/admin/users/selection-ids",
                params={
                    "tags": "department-sales,department-rd",
                    "tags_mode": "all",
                },
            )
            self.assertEqual(selection.status_code, 200, selection.text)
            self.assertEqual(selection.json()["user_ids"], [both_id])
            self.assertEqual(selection.json()["total"], 1)

            options = client.get(
                "/api/users/options",
                params={"limit": 5, "ids": str(tagged_ids[-1])},
            )
            self.assertEqual(options.status_code, 200, options.text)
            self.assertLessEqual(len(options.json()["users"]), 6)
            self.assertIn(tagged_ids[-1], {item["id"] for item in options.json()["users"]})

            selected_only = client.get(
                "/api/users/options",
                params={"limit": 0, "ids": str(tagged_ids[-1])},
            )
            self.assertEqual(
                [item["id"] for item in selected_only.json()["users"]],
                [tagged_ids[-1]],
            )
            tagged_options = client.get(
                "/api/users/options",
                params={"tag": "department-sales", "limit": 500},
            )
            self.assertEqual(tagged_options.status_code, 200, tagged_options.text)
            self.assertEqual(tagged_options.json()["total"], len(tagged_ids))
            self.assertEqual(
                {item["id"] for item in tagged_options.json()["users"]},
                set(tagged_ids),
            )
            unknown_tag = client.get(
                "/api/users/options",
                params={"tag": "deleted-history-tag", "limit": 500},
            )
            self.assertEqual(unknown_tag.status_code, 200, unknown_tag.text)
            self.assertEqual(unknown_tag.json(), {"users": [], "total": 0})

    def test_user_list_can_sort_by_last_login_time(self):
        admin_id = self.insert_user("root", role="system_admin")
        older_id = self.insert_user("older-login")
        newer_id = self.insert_user("newer-login")
        never_id = self.insert_user("never-login")
        self.db.execute(
            "UPDATE users SET last_login_at = ? WHERE id = ?",
            ("2025-01-01T00:00:00+00:00", older_id),
        )
        self.db.execute(
            "UPDATE users SET last_login_at = ? WHERE id = ?",
            ("2025-02-01T00:00:00+00:00", newer_id),
        )
        self.db.commit()

        with self.client_for(admin_id) as client:
            ascending = client.get("/api/admin/users", params={"login_sort": "asc"})
            descending = client.get("/api/admin/users", params={"login_sort": "desc"})
            invalid = client.get("/api/admin/users", params={"login_sort": "sideways"})

        self.assertEqual(ascending.status_code, 200, ascending.text)
        self.assertEqual(descending.status_code, 200, descending.text)
        self.assertEqual(invalid.status_code, 400)
        ascending_ids = [user["id"] for user in ascending.json()["users"]]
        descending_ids = [user["id"] for user in descending.json()["users"]]
        self.assertLess(ascending_ids.index(older_id), ascending_ids.index(newer_id))
        self.assertLess(ascending_ids.index(newer_id), ascending_ids.index(never_id))
        self.assertLess(descending_ids.index(newer_id), descending_ids.index(older_id))
        self.assertLess(descending_ids.index(older_id), descending_ids.index(never_id))

    def test_login_updates_last_login_without_touching_profile_timestamp(self):
        user_id = self.insert_user("login-user")
        before = self.db.execute(
            "SELECT updated_at, last_login_at FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        self.assertIsNone(before["last_login_at"])

        with TestClient(self.app) as client:
            response = client.post(
                "/api/auth/login",
                json={"username": "login-user", "password": "correct-horse-battery-staple"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        recorded = self.db.execute(
            "SELECT updated_at, last_login_at FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        self.assertIsNotNone(recorded["last_login_at"])
        self.assertEqual(recorded["updated_at"], before["updated_at"])
        self.assertEqual(response.json()["user"]["last_login_at"], recorded["last_login_at"])

    def test_user_stats_use_last_login_and_ignore_active_filters(self):
        admin_id = self.insert_user("stats-admin", role="system_admin")
        local_now = datetime.now().astimezone()
        today_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
        week_start = today_start - timedelta(days=today_start.weekday())

        def utc_iso(value: datetime) -> str:
            return value.astimezone(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds") + "Z"

        self.insert_user("active-today", last_login_at=utc_iso(local_now))
        self.insert_user("inactive-old", last_login_at=utc_iso(week_start - timedelta(seconds=1)))

        with self.client_for(admin_id) as client:
            response = client.get(
                "/api/admin/users",
                params={"search": "stats-admin", "page_size": 10},
            )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["total"], 1)
        self.assertEqual(
            payload["stats"],
            {"total_users": 3, "active_week": 1, "active_today": 1},
        )

    def test_username_feishu_uniqueness_and_case_insensitive_login(self):
        admin_id = self.insert_user("root", role="system_admin")
        password = "alice-correct-horse-battery-staple"
        with self.client_for(admin_id) as client:
            created = client.post(
                "/api/admin/users",
                json={
                    "name": "Alice",
                    "username": "  Alice  ",
                    "password": password,
                    "feishu_id": "ou_alice",
                    "role": "user",
                },
            )
            self.assertEqual(created.status_code, 200, created.text)
            self.assertEqual(created.json()["user"]["username"], "Alice")

            duplicate_username = client.post(
                "/api/admin/users",
                json={"name": "Other", "username": "alice", "role": "user"},
            )
            self.assertEqual(duplicate_username.status_code, 400, duplicate_username.text)
            unicode_duplicate = client.post(
                "/api/admin/users",
                json={"name": "Unicode Other", "username": "ＡＬＩＣＥ", "role": "user"},
            )
            self.assertEqual(unicode_duplicate.status_code, 400, unicode_duplicate.text)
            whitespace_username = client.post(
                "/api/admin/users",
                json={"name": "Spaced", "username": "alice smith", "role": "user"},
            )
            self.assertEqual(whitespace_username.status_code, 400, whitespace_username.text)
            duplicate_feishu = client.post(
                "/api/admin/users",
                json={
                    "name": "Other",
                    "username": "other-user",
                    "feishu_id": "ou_alice",
                    "role": "user",
                },
            )
            self.assertEqual(duplicate_feishu.status_code, 400, duplicate_feishu.text)

        with TestClient(self.app) as login_client:
            login = login_client.post(
                "/api/auth/login",
                json={"username": "ＡＬＩＣＥ", "password": password},
            )
            self.assertEqual(login.status_code, 200, login.text)
            self.assertEqual(login.json()["user"]["username"], "Alice")

    def test_user_tag_definitions_reject_new_values_but_preserve_history(self):
        admin_id = self.insert_user("root", role="system_admin")
        self.create_user_tag("department-sales", admin_id)
        historical_id = self.insert_user("historical", tags_value="legacy-deleted-tag")
        with self.client_for(admin_id) as client:
            rejected = client.post(
                "/api/admin/users",
                json={
                    "name": "Unknown Tag",
                    "username": "unknown-tag",
                    "tags": "not-a-preset",
                    "role": "user",
                },
            )
            self.assertEqual(rejected.status_code, 400, rejected.text)

            preserved = client.put(
                f"/api/admin/users/{historical_id}",
                json={
                    "name": "Historical",
                    "username": "historical",
                    "tags": "legacy-deleted-tag,department-sales",
                    "role": "user",
                },
            )
            self.assertEqual(preserved.status_code, 200, preserved.text)
            self.assertEqual(
                preserved.json()["user"]["tags"],
                "legacy-deleted-tag,department-sales",
            )

            rejected_new = client.put(
                f"/api/admin/users/{historical_id}",
                json={
                    "name": "Historical",
                    "username": "historical",
                    "tags": "legacy-deleted-tag,new-unapproved-tag",
                    "role": "user",
                },
            )
            self.assertEqual(rejected_new.status_code, 400, rejected_new.text)

    def test_custom_user_tags_can_be_enabled_and_are_promoted_to_definitions(self):
        admin_id = self.insert_user("root", role="system_admin")
        with patch.object(settings, "user_custom_user_tags", True), self.client_for(admin_id) as client:
            created = client.post(
                "/api/admin/users",
                json={
                    "name": "Custom Tagged",
                    "username": "custom-tagged",
                    "tags": "department-growth",
                    "role": "user",
                },
            )
            self.assertEqual(created.status_code, 200, created.text)
            listed = client.get("/api/user-tags")
            self.assertEqual(listed.status_code, 200, listed.text)
            names = {
                tag["name"]
                for group in listed.json()["groups"]
                for tag in group["tags"]
            }
            self.assertIn("department-growth", names)

    def test_resource_metadata_tag_definitions_are_independent_and_rename_usage(self):
        admin_id = self.insert_user("root", role="system_admin")
        timestamp = now_iso()
        resource_id = int(
            self.db.execute(
                """
                INSERT INTO resources (
                    detail_token, name, owner_id, subject, tags, status,
                    visibility_scope, management_scope, secrecy_level,
                    created_at, updated_at
                ) VALUES ('metadata-tag-resource-token-000001', 'Resource', ?, '集团', '',
                          'active', 'public', 'private', 'public', ?, ?)
                """,
                (admin_id, timestamp, timestamp),
            ).lastrowid
        )
        self.db.execute(
            """
            INSERT INTO subject_tag_definitions
                (name, category, label, sort_order, created_by, created_at)
            VALUES ('集团', '未分类', '集团', 10, ?, ?)
            """,
            (admin_id, timestamp),
        )
        self.db.commit()

        with self.client_for(admin_id) as client:
            for domain in ("subject", "status"):
                public_list = client.get(f"/api/{domain}-tags")
                admin_list = client.get(f"/api/admin/{domain}-tags")
                self.assertEqual(public_list.status_code, 200, public_list.text)
                self.assertEqual(admin_list.status_code, 200, admin_list.text)

            self.assertEqual(client.get("/api/secrecy-tags").status_code, 405)
            self.assertEqual(client.get("/api/admin/secrecy-tags").status_code, 404)

            subject_groups = client.get("/api/subject-tags").json()["groups"]
            self.assertEqual([group["category"] for group in subject_groups], ["主体"])
            self.assertEqual(subject_groups[0]["tags"][0]["label"], "集团")

            created_subject = client.post(
                "/api/admin/subject-tags", json={"tags": ["集团-产品线"]}
            )
            self.assertEqual(created_subject.status_code, 200, created_subject.text)
            self.assertEqual(created_subject.json()["created"][0]["category"], "主体")
            self.assertEqual(created_subject.json()["created"][0]["label"], "集团-产品线")

            subject_tags = client.get("/api/admin/subject-tags").json()["tags"]
            subject = next(item for item in subject_tags if item["name"] == "集团")
            self.assertEqual(subject["usage_count"], 1)

            created_status = client.post("/api/admin/status-tags", json={"tags": ["草稿"]})
            self.assertEqual(created_status.status_code, 200, created_status.text)
            self.assertEqual(created_status.json()["created"][0]["category"], "状态")
            self.assertEqual(created_status.json()["created"][0]["label"], "草稿")

            status_groups = client.get("/api/status-tags").json()["groups"]
            self.assertEqual([group["category"] for group in status_groups], ["状态"])

            renamed = client.put(
                f"/api/admin/subject-tags/{subject['id']}",
                json={"name": "集团总部"},
            )
            self.assertEqual(renamed.status_code, 200, renamed.text)
            self.assertEqual(renamed.json()["name"], "集团总部")

        stored = self.db.execute(
            "SELECT subject FROM resources WHERE id = ?", (resource_id,)
        ).fetchone()[0]
        self.assertEqual(stored, "集团总部")

    def test_metadata_custom_creation_respects_domain_settings(self):
        admin_id = self.insert_user("root", role="system_admin")
        user_id = self.insert_user("member")

        with self.client_for(user_id) as client:
            status_list = client.get("/api/status-tags")
            self.assertFalse(status_list.json()["can_create"])
            self.assertEqual(
                client.post("/api/status-tags", json={"tags": ["草稿"]}).status_code,
                403,
            )

        with (
            patch.object(settings, "user_custom_status_tags", True),
            self.client_for(user_id) as client,
        ):
            self.assertTrue(client.get("/api/status-tags").json()["can_create"])
            status = client.post("/api/status-tags", json={"tags": ["草稿"]})
            self.assertEqual(status.status_code, 200, status.text)

        with self.client_for(admin_id) as client:
            created = client.post("/api/status-tags", json={"tags": ["已发布"]})
            self.assertEqual(created.status_code, 200, created.text)

    def test_user_and_resource_tags_reject_control_characters(self):
        admin_id = self.insert_user("root", role="system_admin")
        with patch.object(settings, "user_custom_tags", True), self.client_for(admin_id) as client:
            user_response = client.post(
                "/api/admin/users",
                json={
                    "name": "Bad Tag",
                    "username": "bad-tag-user",
                    "tags": "team\u0000hidden",
                    "role": "user",
                },
            )
            self.assertEqual(user_response.status_code, 400, user_response.text)

            preset_response = client.post(
                "/api/admin/tags",
                json={"tags": ["team\u0000hidden"]},
            )
            self.assertEqual(preset_response.status_code, 400, preset_response.text)

            user_tag_response = client.post(
                "/api/admin/user-tags",
                json={"tags": ["team\u0000hidden"]},
            )
            self.assertEqual(user_tag_response.status_code, 400, user_tag_response.text)

    def test_resource_tag_usage_and_rename_do_not_touch_user_tags(self):
        admin_id = self.insert_user("root", role="system_admin")
        tagged_user = self.insert_user("tagged", tags_value="team-red")
        tag_id = self.create_tag("team-red", admin_id)
        timestamp = now_iso()
        resource_id = int(
            self.db.execute(
                """
                INSERT INTO resources (
                    name, owner_id, subject, tags, status, visibility_scope,
                    management_scope, secrecy_level, created_at, updated_at
                ) VALUES ('Resource', ?, '', 'team-red,team-redwood', 'active',
                          'public', 'private', 'public', ?, ?)
                """,
                (admin_id, timestamp, timestamp),
            ).lastrowid
        )
        show_id = int(
            self.db.execute(
                """
                INSERT INTO shows (
                    name, owner_id, tags, status, visibility_scope, management_scope,
                    secrecy_level, created_at, updated_at
                ) VALUES ('Show', ?, 'team-red,team-redwood', 'active', 'public',
                          'private', 'public', ?, ?)
                """,
                (admin_id, timestamp, timestamp),
            ).lastrowid
        )
        self.db.commit()

        with self.client_for(admin_id) as client:
            listed = client.get("/api/admin/tags")
            self.assertEqual(listed.status_code, 200, listed.text)
            item = next(item for item in listed.json()["tags"] if item["id"] == tag_id)
            self.assertEqual(item["usage_count"], 2)

            renamed = client.put(f"/api/admin/tags/{tag_id}", json={"name": "team-blue"})
            self.assertEqual(renamed.status_code, 200, renamed.text)
            self.assertEqual(renamed.json()["name"], "team-blue")

        self.assertEqual(
            self.db.execute("SELECT tags FROM users WHERE id = ?", (tagged_user,)).fetchone()[0],
            "team-red",
        )
        self.assertEqual(
            self.db.execute("SELECT tags FROM resources WHERE id = ?", (resource_id,)).fetchone()[0],
            "team-blue,team-redwood",
        )
        self.assertEqual(
            self.db.execute("SELECT tags FROM shows WHERE id = ?", (show_id,)).fetchone()[0],
            "team-blue,team-redwood",
        )
        self.assertEqual(
            self.db.execute("SELECT tag_name FROM user_tags WHERE user_id = ?", (tagged_user,)).fetchone()[0],
            "team-red",
        )

    def test_user_tags_are_independent_and_rename_only_assigned_users(self):
        admin_id = self.insert_user("root", role="system_admin")
        regular_user = self.insert_user("member", tags_value="team-red")
        resource_tag_id = self.create_tag("team-red", admin_id)
        user_tag_id = self.create_user_tag("team-red", admin_id)
        timestamp = now_iso()
        resource_id = int(
            self.db.execute(
                """
                INSERT INTO resources (
                    name, owner_id, subject, tags, status, visibility_scope,
                    management_scope, secrecy_level, created_at, updated_at
                ) VALUES ('Resource', ?, '', 'team-red', 'active', 'public',
                          'private', 'public', ?, ?)
                """,
                (admin_id, timestamp, timestamp),
            ).lastrowid
        )
        self.db.commit()

        with self.client_for(admin_id) as client:
            resource_tags = client.get("/api/admin/tags")
            user_tags = client.get("/api/admin/user-tags")
            self.assertEqual(resource_tags.status_code, 200, resource_tags.text)
            self.assertEqual(user_tags.status_code, 200, user_tags.text)
            self.assertEqual(
                next(item for item in resource_tags.json()["tags"] if item["id"] == resource_tag_id)["usage_count"],
                1,
            )
            self.assertEqual(
                next(item for item in user_tags.json()["tags"] if item["id"] == user_tag_id)["usage_count"],
                1,
            )

            renamed = client.put(
                f"/api/admin/user-tags/{user_tag_id}",
                json={"name": "team-blue"},
            )
            self.assertEqual(renamed.status_code, 200, renamed.text)

        self.assertEqual(
            self.db.execute("SELECT tags FROM users WHERE id = ?", (regular_user,)).fetchone()[0],
            "team-blue",
        )
        self.assertEqual(
            self.db.execute("SELECT tag_name FROM user_tags WHERE user_id = ?", (regular_user,)).fetchone()[0],
            "team-blue",
        )
        self.assertEqual(
            self.db.execute("SELECT tags FROM resources WHERE id = ?", (resource_id,)).fetchone()[0],
            "team-red",
        )
        self.assertEqual(
            self.db.execute("SELECT name FROM tags WHERE id = ?", (resource_tag_id,)).fetchone()[0],
            "team-red",
        )

    def test_non_admin_can_read_but_cannot_manage_user_tag_definitions(self):
        admin_id = self.insert_user("root", role="system_admin")
        regular_id = self.insert_user("member")
        tag_id = self.create_user_tag("department-sales", admin_id)
        with self.client_for(regular_id) as client:
            readable = client.get("/api/user-tags")
            self.assertEqual(readable.status_code, 200, readable.text)
            self.assertEqual(readable.json()["groups"][0]["tags"][0]["name"], "department-sales")
            for method, path, body in (
                ("get", "/api/admin/user-tags", None),
                ("post", "/api/admin/user-tags", {"tags": ["department-rd"]}),
                ("put", f"/api/admin/user-tags/{tag_id}", {"name": "department-growth"}),
                ("delete", f"/api/admin/user-tags/{tag_id}", None),
            ):
                response = getattr(client, method)(path, json=body) if body is not None else getattr(client, method)(path)
                self.assertEqual(response.status_code, 403, (method, path, response.text))

    def test_admin_can_manage_default_filters_from_tag_definitions(self):
        admin_id = self.insert_user("root", role="system_admin")
        resource_tag_ids = [
            self.create_tag("industry-a", admin_id),
            self.create_tag("industry-b", admin_id),
        ]
        user_tag_ids = [
            self.create_user_tag("team-a", admin_id),
            self.create_user_tag("team-b", admin_id),
        ]
        timestamp = now_iso()
        metadata_ids: dict[str, list[int]] = {}
        for domain, table, names in (
            ("subject", "subject_tag_definitions", ("subject-a", "subject-b")),
            ("status", "status_tag_definitions", ("active", "disabled")),
        ):
            metadata_ids[domain] = []
            for sort_order, name in enumerate(names):
                cursor = self.db.execute(
                    f"INSERT INTO {table} "
                    "(name, category, label, sort_order, created_by, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (name, domain, name, sort_order, admin_id, timestamp),
                )
                metadata_ids[domain].append(int(cursor.lastrowid))
        self.db.commit()

        with self.client_for(admin_id) as client:
            for tag_id in resource_tag_ids:
                response = client.put(
                    f"/api/admin/tags/{tag_id}/default-filter",
                    json={"enabled": True},
                )
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(response.json()["default_filter"])
            for tag_id in user_tag_ids:
                response = client.put(
                    f"/api/admin/user-tags/{tag_id}/default-filter",
                    json={"enabled": True},
                )
                self.assertEqual(response.status_code, 200, response.text)

            for domain in ("subject", "status"):
                first_id, second_id = metadata_ids[domain]
                self.assertEqual(
                    client.put(
                        f"/api/admin/{domain}-tags/{first_id}/default-filter",
                        json={"enabled": True},
                    ).status_code,
                    200,
                )
                self.assertEqual(
                    client.put(
                        f"/api/admin/{domain}-tags/{second_id}/default-filter",
                        json={"enabled": True},
                    ).status_code,
                    200,
                )

            public_config = client.get("/api/config")
            self.assertEqual(public_config.status_code, 200, public_config.text)
            self.assertEqual(
                public_config.json()["default_filters"],
                {
                    "resource_tags": ["industry-a", "industry-b"],
                    "subject": "subject-b",
                    "status": "disabled",
                    "user_tags": ["team-a", "team-b"],
                },
            )

        for domain, table in (
            ("subject", "subject_tag_definitions"),
            ("status", "status_tag_definitions"),
        ):
            enabled = self.db.execute(
                f"SELECT name FROM {table} WHERE is_default_filter = 1"
            ).fetchall()
            self.assertEqual([row["name"] for row in enabled], {
                "subject": ["subject-b"],
                "status": ["disabled"],
            }[domain])

    def test_transfer_delete_moves_all_user_scoped_data_and_records_audit(self):
        admin_id = self.insert_user("root", role="system_admin")
        source_id = self.insert_user("source")
        target_id = self.insert_user("target")
        timestamp = now_iso()
        resource_id = int(
            self.db.execute(
                """
                INSERT INTO resources (
                    name, owner_id, subject, status, visibility_scope, management_scope,
                    secrecy_level, updated_by, created_at, updated_at
                ) VALUES ('Resource', ?, '', 'active', 'partial', 'partial',
                          'public', ?, ?, ?)
                """,
                (source_id, source_id, timestamp, timestamp),
            ).lastrowid
        )
        version_one = int(
            self.db.execute(
                """
                INSERT INTO resource_versions (
                    resource_id, version_no, ppt_path, created_by, created_at
                ) VALUES (?, 1, 'resource.pptx', ?, ?)
                """,
                (resource_id, source_id, timestamp),
            ).lastrowid
        )
        version_two = int(
            self.db.execute(
                """
                INSERT INTO resource_versions (
                    resource_id, version_no, ppt_path, created_by, created_at
                ) VALUES (?, 2, 'resource-v2.pptx', ?, ?)
                """,
                (resource_id, source_id, timestamp),
            ).lastrowid
        )
        self.db.execute(
            """
            INSERT INTO resource_share_tokens
                (resource_id, token_hash, created_by, expires_at, created_at)
            VALUES (?, 'share-token', ?, '2999-01-01T00:00:00Z', ?)
            """,
            (resource_id, source_id, timestamp),
        )
        template_id = int(
            self.db.execute(
                """
                INSERT INTO templates (
                    name, subject, platform, ratio, template_type, office_file_name,
                    office_path, visibility_scope, management_scope, owner_id,
                    created_at, updated_at
                ) VALUES ('Template', '', 'wps', '16:9', 'content', 'a.pptx',
                          'a.pptx', 'partial', 'partial', ?, ?, ?)
                """,
                (source_id, timestamp, timestamp),
            ).lastrowid
        )
        self.db.execute(
            """
            INSERT INTO fonts (family_name, file_name, file_path, uploaded_by, created_at)
            VALUES ('Font', 'font.ttf', 'font.ttf', ?, ?)
            """,
            (source_id, timestamp),
        )
        show_id = int(
            self.db.execute(
                """
                INSERT INTO shows (
                    name, owner_id, status, visibility_scope, management_scope,
                    secrecy_level, updated_by, created_at, updated_at
                ) VALUES ('Show', ?, 'active', 'partial', 'partial', 'public', ?, ?, ?)
                """,
                (source_id, source_id, timestamp, timestamp),
            ).lastrowid
        )
        self.db.execute(
            "INSERT INTO show_resources (show_id, resource_id, version_no) VALUES (?, ?, 1)",
            (show_id, resource_id),
        )
        task_id = int(
            self.db.execute(
                "INSERT INTO tasks (task_type, owner_id) VALUES ('batch_split_import', ?)",
                (source_id,),
            ).lastrowid
        )
        self.db.execute(
            "INSERT INTO task_events (owner_id, task_id, event_type, payload) VALUES (?, ?, 'progress', '{}')",
            (source_id, task_id),
        )
        self.db.execute(
            "INSERT INTO resource_import_commits VALUES ('session-1', ?, '{}', ?)",
            (source_id, timestamp),
        )
        self.create_tag("created-by-source", source_id)

        for table, entity_column, entity_id in (
            ("resource_visibility", "resource_id", resource_id),
            ("resource_management", "resource_id", resource_id),
            ("show_visibility", "show_id", show_id),
            ("show_management", "show_id", show_id),
            ("template_visibility", "template_id", template_id),
            ("template_management", "template_id", template_id),
        ):
            self.db.execute(
                f"INSERT INTO {table} ({entity_column}, user_id) VALUES (?, ?)",
                (entity_id, source_id),
            )
        self.db.execute(
            "INSERT INTO resource_visibility (resource_id, user_id) VALUES (?, ?)",
            (resource_id, target_id),
        )
        self.db.execute(
            "INSERT INTO user_preferences VALUES (?, 'theme', 'dark', ?)",
            (source_id, timestamp),
        )
        self.db.execute(
            "INSERT INTO user_preferences VALUES (?, 'theme', 'light', ?)",
            (target_id, timestamp),
        )
        self.db.execute(
            "INSERT INTO user_preferences VALUES (?, 'locale', 'zh-CN', ?)",
            (source_id, timestamp),
        )
        self.db.execute(
            "INSERT INTO user_pinned_resources VALUES (?, ?, ?)",
            (source_id, resource_id, timestamp),
        )
        self.db.execute(
            "INSERT INTO user_pinned_shows VALUES (?, ?, ?)",
            (source_id, show_id, timestamp),
        )
        self.db.execute(
            "INSERT INTO personal_remarks (resource_id, version_id, user_id, content_html, updated_at) VALUES (?, ?, ?, 'source remark', ?)",
            (resource_id, version_two, source_id, timestamp),
        )
        self.db.execute(
            "INSERT INTO personal_remarks (resource_id, version_id, user_id, content_html, updated_at) VALUES (?, ?, ?, 'target wins', ?)",
            (resource_id, version_one, target_id, timestamp),
        )
        self.db.execute(
            "INSERT INTO personal_remarks (resource_id, version_id, user_id, content_html, updated_at) VALUES (?, ?, ?, 'source loses', ?)",
            (resource_id, version_one, source_id, timestamp),
        )
        self.db.execute(
            "INSERT INTO show_remarks (show_id, resource_id, user_id, content_html, updated_at) VALUES (?, ?, ?, 'show note', ?)",
            (show_id, resource_id, source_id, timestamp),
        )
        self.db.execute(
            """
            INSERT INTO download_records
                (track_code, user_id, show_id, download_type, downloaded_at)
            VALUES ('track-1', ?, ?, 'pdf', ?)
            """,
            (source_id, show_id, timestamp),
        )
        self.db.commit()

        with self.client_for(admin_id) as client:
            response = client.post(
                f"/api/admin/users/{source_id}/transfer-and-delete",
                json={"target_user_id": target_id},
            )
            self.assertEqual(response.status_code, 200, response.text)

        self.assertIsNone(self.db.execute("SELECT 1 FROM users WHERE id = ?", (source_id,)).fetchone())
        for table, column in (
            ("resources", "owner_id"),
            ("resources", "updated_by"),
            ("resource_versions", "created_by"),
            ("resource_share_tokens", "created_by"),
            ("templates", "owner_id"),
            ("fonts", "uploaded_by"),
            ("shows", "owner_id"),
            ("shows", "updated_by"),
            ("tasks", "owner_id"),
            ("task_events", "owner_id"),
            ("resource_import_commits", "owner_id"),
            ("tags", "created_by"),
        ):
            remaining = self.db.execute(
                f"SELECT COUNT(*) FROM {table} WHERE {column} = ?",
                (source_id,),
            ).fetchone()[0]
            self.assertEqual(remaining, 0, f"{table}.{column} was not transferred")

        self.assertEqual(
            self.db.execute(
                "SELECT pref_value FROM user_preferences WHERE user_id = ? AND pref_key = 'theme'",
                (target_id,),
            ).fetchone()[0],
            "light",
        )
        self.assertEqual(
            self.db.execute(
                "SELECT pref_value FROM user_preferences WHERE user_id = ? AND pref_key = 'locale'",
                (target_id,),
            ).fetchone()[0],
            "zh-CN",
        )
        self.assertEqual(
            self.db.execute(
                "SELECT content_html FROM personal_remarks WHERE user_id = ? AND version_id = ?",
                (target_id, version_one),
            ).fetchone()[0],
            "target wins",
        )
        self.assertEqual(
            self.db.execute(
                "SELECT content_html FROM personal_remarks WHERE user_id = ? AND version_id = ?",
                (target_id, version_two),
            ).fetchone()[0],
            "source remark",
        )
        self.assertEqual(
            self.db.execute("SELECT user_id FROM download_records WHERE track_code = 'track-1'").fetchone()[0],
            None,
        )
        audit = self.db.execute(
            "SELECT actor_user_id, subject_user_id, details FROM admin_audit_events WHERE action = 'user.transfer_delete'"
        ).fetchone()
        self.assertEqual(audit["actor_user_id"], admin_id)
        self.assertEqual(audit["subject_user_id"], source_id)
        self.assertEqual(json.loads(audit["details"])["transferred_to"], target_id)

    def test_avatar_url_expands_only_aliyun_endpoint_hosts(self):
        for endpoint_setting in ("oss_endpoint", "oss_public_endpoint"):
            for hostname, allow_bucket_host in (
                ("aliyuncs.com", True),
                ("oss-cn-hangzhou.aliyuncs.com", True),
                ("OSS-CN-HANGZHOU.ALIYUNCS.COM.", True),
                ("notaliyuncs.com", False),
                ("cdn.notaliyuncs.com", False),
                ("aliyuncs.com.example.com", False),
                ("cdn.example.com", False),
            ):
                endpoint = f"https://{hostname}"
                configured = {"oss_endpoint": "", "oss_public_endpoint": ""}
                configured[endpoint_setting] = endpoint
                with (
                    self.subTest(setting=endpoint_setting, hostname=hostname),
                    patch.multiple(settings, oss_bucket="slides", **configured),
                ):
                    direct_url = f"{endpoint}/avatar.png"
                    self.assertEqual(validate_avatar_url(direct_url), direct_url)
                    bucket_url = f"https://slides.{hostname}/avatar.png"
                    if allow_bucket_host:
                        self.assertEqual(validate_avatar_url(bucket_url), bucket_url)
                    else:
                        with self.assertRaises(ValueError):
                            validate_avatar_url(bucket_url)
                    with self.assertRaises(ValueError):
                        validate_avatar_url(f"https://unconfigured.{hostname}/avatar.png")

    def test_avatar_upload_round_trip_delete_and_url_validation(self):
        admin_id = self.insert_user("root", role="system_admin")
        user_id = self.insert_user("avatar-user", name="Avatar User")
        buffer = io.BytesIO()
        Image.new("RGB", (900, 600), color=(20, 100, 180)).save(buffer, format="PNG")
        image_bytes = buffer.getvalue()

        with self.client_for(admin_id) as client:
            invalid_url = client.post(
                "/api/admin/users",
                json={
                    "name": "Unsafe Avatar",
                    "username": "unsafe-avatar",
                    "avatar_url": "http://127.0.0.1/private.png",
                    "role": "user",
                },
            )
            self.assertEqual(invalid_url.status_code, 400, invalid_url.text)

            invalid_file = client.post(
                f"/api/admin/users/{user_id}/avatar",
                files={"avatar": ("avatar.png", b"not-an-image", "image/png")},
            )
            self.assertEqual(invalid_file.status_code, 400, invalid_file.text)

            uploaded = client.post(
                f"/api/admin/users/{user_id}/avatar",
                files={"avatar": ("avatar.txt", image_bytes, "application/octet-stream")},
            )
            self.assertEqual(uploaded.status_code, 200, uploaded.text)
            public_url = uploaded.json()["user"]["avatar_url"]
            self.assertTrue(public_url.startswith(f"/api/users/{user_id}/avatar?v="), public_url)
            stored_ref = self.db.execute(
                "SELECT avatar_url FROM users WHERE id = ?", (user_id,)
            ).fetchone()[0]
            stored_path = settings.abs_path(stored_ref)
            self.assertTrue(stored_path and stored_path.is_file())

            downloaded = client.get(public_url)
            self.assertEqual(downloaded.status_code, 200, downloaded.text)
            self.assertEqual(downloaded.headers["content-type"], "image/png")

            second_buffer = io.BytesIO()
            Image.new("RGB", (200, 200), color=(180, 40, 20)).save(second_buffer, format="PNG")
            replaced = client.post(
                f"/api/admin/users/{user_id}/avatar",
                files={"avatar": ("avatar.png", second_buffer.getvalue(), "image/png")},
            )
            self.assertEqual(replaced.status_code, 200, replaced.text)
            replacement_url = replaced.json()["user"]["avatar_url"]
            self.assertNotEqual(replacement_url, public_url)
            self.assertFalse(stored_path.exists())
            stored_ref = self.db.execute(
                "SELECT avatar_url FROM users WHERE id = ?", (user_id,)
            ).fetchone()[0]
            stored_path = settings.abs_path(stored_ref)
            self.assertTrue(stored_path and stored_path.is_file())

            updated = client.put(
                f"/api/admin/users/{user_id}",
                json={
                    "name": "Avatar User Renamed",
                    "username": "avatar-user",
                    "avatar_url": replacement_url,
                    "role": "user",
                },
            )
            self.assertEqual(updated.status_code, 200, updated.text)
            self.assertEqual(
                self.db.execute("SELECT avatar_url FROM users WHERE id = ?", (user_id,)).fetchone()[0],
                stored_ref,
            )

            deleted = client.delete(f"/api/admin/users/{user_id}/avatar")
            self.assertEqual(deleted.status_code, 200, deleted.text)
            self.assertEqual(deleted.json()["user"]["avatar_url"], "")
            self.assertFalse(stored_path.exists())

    def test_avatar_cleanup_is_best_effort_and_only_targets_avatar_directory(self):
        avatar_path = settings.assets_dir / "avatars" / "user.png"
        avatar_path.parent.mkdir(parents=True, exist_ok=True)
        avatar_path.write_bytes(b"avatar")
        resource_path = settings.resources_dir / "avatars" / "resource.png"
        resource_path.parent.mkdir(parents=True, exist_ok=True)
        resource_path.write_bytes(b"resource")

        with patch("pathlib.Path.unlink", side_effect=OSError("busy")):
            delete_managed_avatar(settings.store_path(avatar_path))
        self.assertTrue(avatar_path.exists())

        delete_managed_avatar(settings.store_path(resource_path))
        self.assertTrue(resource_path.exists())

    def test_legacy_untrusted_avatar_url_is_not_exposed(self):
        admin_id = self.insert_user("root", role="system_admin")
        user_id = self.insert_user("legacy-avatar")
        self.db.execute(
            "UPDATE users SET avatar_url = ? WHERE id = ?",
            ("https://tracking.example.test/pixel.png", user_id),
        )
        self.db.commit()

        with self.client_for(admin_id) as client:
            response = client.get("/api/admin/users", params={"search": "legacy-avatar"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["users"][0]["avatar_url"], "")

    def test_oss_avatar_reference_must_stay_inside_configured_prefix(self):
        with patch.multiple(settings, oss_bucket="bucket", oss_prefix="prod/slide-flow"):
            self.assertTrue(
                is_managed_avatar_ref(
                    "oss://bucket/prod/slide-flow/avatars/123/avatar.png",
                    user_id=123,
                )
            )
            self.assertFalse(
                is_managed_avatar_ref(
                    "oss://bucket/prod/slide-flow/avatars/123/avatar.png",
                    user_id=456,
                )
            )
            self.assertFalse(
                is_managed_avatar_ref("oss://bucket/avatars/123/avatar.png")
            )
            self.assertFalse(
                is_managed_avatar_ref(
                    "oss://bucket/prod/slide-flow/avatars/not-a-user/avatar.png"
                )
            )
            self.assertFalse(
                is_managed_avatar_ref(
                    "oss://bucket/prod/slide-flow/resources/avatars/file.png"
                )
            )

    def test_feishu_callback_requires_server_state_and_preserves_uploaded_avatar(self):
        user_id = self.insert_user("feishu-user", name="Before", feishu_id="ou_user")
        avatar_path = settings.assets_dir / "avatars" / "managed.png"
        avatar_path.parent.mkdir(parents=True, exist_ok=True)
        avatar_path.write_bytes(b"managed")
        managed_ref = settings.store_path(avatar_path)
        self.db.execute("UPDATE users SET avatar_url = ? WHERE id = ?", (managed_ref, user_id))
        self.db.commit()

        provider_user = FeishuUserInfo(
            open_id="ou_user",
            name="After",
            avatar_url="https://example.feishucdn.com/avatar.png",
            tenant_key="tenant",
            enterprise_email="after@example.com",
        )
        with (
            patch.multiple(
                settings,
                feishu_sso_enabled=True,
                feishu_app_id="cli_test",
                feishu_app_secret="secret",
            ),
            patch.object(feishu_auth, "get_tenant_access_token", return_value="tenant-token"),
            patch.object(feishu_auth, "get_user_access_token", return_value="user-token"),
            patch.object(feishu_auth, "get_user_info", return_value=provider_user),
            TestClient(self.app) as client,
        ):
            config = client.get("/api/auth/feishu/config")
            self.assertEqual(config.status_code, 200, config.text)
            state = config.json()["state"]
            rejected = client.post(
                "/api/auth/feishu/callback",
                json={"code": "code", "state": "x" * 32},
            )
            self.assertEqual(rejected.status_code, 400, rejected.text)

            callback = client.post(
                "/api/auth/feishu/callback",
                json={"code": "code", "state": state},
            )
            self.assertEqual(callback.status_code, 200, callback.text)
            replay = client.post(
                "/api/auth/feishu/callback",
                json={"code": "code", "state": state},
            )
            self.assertEqual(replay.status_code, 400, replay.text)

        updated = self.db.execute(
            "SELECT name, avatar_url, last_login_at FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        self.assertEqual(updated["name"], "After")
        self.assertEqual(updated["avatar_url"], managed_ref)
        self.assertIsNotNone(updated["last_login_at"])

    def test_admin_can_import_all_visible_feishu_directory_users(self):
        admin_id = self.insert_user("root", role="system_admin")
        existing_id = self.insert_user(
            "existing-feishu",
            name="Old Name",
            feishu_id="ou_existing",
        )
        avatar_path = settings.assets_dir / "avatars" / "existing.png"
        avatar_path.parent.mkdir(parents=True, exist_ok=True)
        avatar_path.write_bytes(b"managed")
        managed_ref = settings.store_path(avatar_path)
        self.db.execute(
            "UPDATE users SET avatar_url = ? WHERE id = ?",
            (managed_ref, existing_id),
        )
        self.db.commit()

        directory_users = [
            FeishuUserInfo(
                open_id="ou_existing",
                name="Updated Name",
                avatar_url="https://example.feishucdn.com/existing.png",
                tenant_key="tenant",
                enterprise_email="existing@example.com",
            ),
            FeishuUserInfo(
                open_id="ou_new",
                name="New User",
                avatar_url="https://example.feishucdn.com/new.png",
                tenant_key="tenant",
                enterprise_email="new.user@example.com",
            ),
        ]
        with (
            patch.multiple(
                settings,
                feishu_sso_enabled=True,
                feishu_app_id="cli_test",
                feishu_app_secret="secret",
            ),
            patch.object(feishu_auth, "get_tenant_access_token", return_value="tenant-token"),
            patch.object(feishu_auth, "get_directory_users", return_value=directory_users),
            self.client_for(admin_id) as client,
        ):
            response = client.post("/api/admin/users/import-feishu")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json(),
            {"total": 2, "created": 1, "updated": 1, "unchanged": 0},
        )
        existing = self.db.execute(
            "SELECT name, avatar_url FROM users WHERE id = ?",
            (existing_id,),
        ).fetchone()
        self.assertEqual(existing["name"], "Updated Name")
        self.assertEqual(existing["avatar_url"], managed_ref)
        created = self.db.execute(
            "SELECT username, name, role, feishu_id, avatar_url "
            "FROM users WHERE feishu_id = 'ou_new'"
        ).fetchone()
        self.assertIsNotNone(created)
        self.assertEqual(created["username"], "newuser")
        self.assertEqual(created["name"], "New User")
        self.assertEqual(created["role"], "user")
        self.assertEqual(created["avatar_url"], "https://example.feishucdn.com/new.png")
        audit = self.db.execute(
            "SELECT details FROM admin_audit_events WHERE action = 'user.feishu_import'"
        ).fetchone()
        self.assertEqual(json.loads(audit["details"])["created"], 1)

    def test_feishu_directory_import_requires_enabled_complete_configuration(self):
        admin_id = self.insert_user("root", role="system_admin")
        with (
            patch.multiple(
                settings,
                feishu_sso_enabled=False,
                feishu_app_id="",
                feishu_app_secret="",
            ),
            self.client_for(admin_id) as client,
        ):
            response = client.post("/api/admin/users/import-feishu")
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("启用飞书 SSO", response.json()["detail"])

    def test_feishu_state_is_consumed_when_upstream_rejects_code(self):
        with (
            patch.multiple(
                settings,
                feishu_sso_enabled=True,
                feishu_app_id="cli_test",
                feishu_app_secret="secret",
            ),
            patch.object(feishu_auth, "get_tenant_access_token", return_value="tenant-token"),
            patch.object(
                feishu_auth,
                "get_user_access_token",
                side_effect=feishu_auth.FeishuAPIError(10003, "invalid code"),
            ),
            TestClient(self.app) as client,
        ):
            state = client.get("/api/auth/feishu/config").json()["state"]
            failed = client.post(
                "/api/auth/feishu/callback",
                json={"code": "bad-code", "state": state},
            )
            self.assertEqual(failed.status_code, 401, failed.text)
            replay = client.post(
                "/api/auth/feishu/callback",
                json={"code": "bad-code", "state": state},
            )
            self.assertEqual(replay.status_code, 400, replay.text)

    def test_user_list_and_selection_ids_support_role_filter(self):
        admin_id = self.insert_user("root", role="system_admin")
        operations_id = self.insert_user("operator", role="admin")
        regular_id = self.insert_user("regular", role="user")
        with self.client_for(admin_id) as client:
            listed = client.get("/api/admin/users", params={"role": "admin"})
            self.assertEqual(listed.status_code, 200, listed.text)
            self.assertEqual([item["id"] for item in listed.json()["users"]], [operations_id])

            selection = client.get("/api/admin/users/selection-ids", params={"role": "user"})
            self.assertEqual(selection.status_code, 200, selection.text)
            self.assertEqual(selection.json()["user_ids"], [regular_id])

            invalid = client.get("/api/admin/users", params={"role": "owner"})
            self.assertEqual(invalid.status_code, 400, invalid.text)

    def test_bulk_user_tags_support_add_remove_and_replace(self):
        admin_id = self.insert_user("root", role="system_admin")
        first_id = self.insert_user("tag-first", tags_value="部门-销售")
        second_id = self.insert_user("tag-second")
        timestamp = now_iso()
        self.db.executemany(
            """
            INSERT INTO user_tag_definitions
                (name, category, label, sort_order, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                ("部门-销售", "部门", "销售", 0, admin_id, timestamp),
                ("部门-研发", "部门", "研发", 1, admin_id, timestamp),
                ("人员-外部", "人员", "外部", 2, admin_id, timestamp),
            ],
        )
        self.db.commit()

        with self.client_for(admin_id) as client:
            added = client.post(
                "/api/admin/users/bulk-tags",
                json={"user_ids": [first_id, second_id], "tags": "部门-研发", "mode": "add"},
            )
            self.assertEqual(added.status_code, 200, added.text)
            self.assertEqual(added.json()["updated"], 2)

            removed = client.post(
                "/api/admin/users/bulk-tags",
                json={"user_ids": [first_id, second_id], "tags": "部门-销售", "mode": "remove"},
            )
            self.assertEqual(removed.status_code, 200, removed.text)
            self.assertEqual(removed.json()["updated"], 1)

            replaced = client.post(
                "/api/admin/users/bulk-tags",
                json={"user_ids": [first_id, second_id], "tags": "人员-外部", "mode": "replace"},
            )
            self.assertEqual(replaced.status_code, 200, replaced.text)
            self.assertEqual(replaced.json()["updated"], 2)

        stored = self.db.execute(
            "SELECT id, tags FROM users WHERE id IN (?, ?) ORDER BY id",
            (first_id, second_id),
        ).fetchall()
        self.assertEqual([row["tags"] for row in stored], ["人员-外部", "人员-外部"])
        synced = self.db.execute(
            "SELECT user_id, tag_name FROM user_tags WHERE user_id IN (?, ?) ORDER BY user_id",
            (first_id, second_id),
        ).fetchall()
        self.assertEqual(
            [(row["user_id"], row["tag_name"]) for row in synced],
            [(first_id, "人员-外部"), (second_id, "人员-外部")],
        )

    def test_bulk_delete_is_atomic_when_any_user_is_missing(self):
        admin_id = self.insert_user("root", role="system_admin")
        user_id = self.insert_user("bulk-user")
        with self.client_for(admin_id) as client:
            response = client.post(
                "/api/admin/users/bulk-delete",
                json={"user_ids": [user_id, 999999]},
            )
        self.assertEqual(response.status_code, 404, response.text)
        self.assertIsNotNone(self.db.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone())

    def test_bulk_delete_supports_full_portable_limit(self):
        admin_id = self.insert_user("root", role="system_admin")
        password_hash = hash_password("bulk-delete-secure-password")
        timestamp = now_iso()
        self.db.executemany(
            """
            INSERT INTO users (
                name, username, username_key, password_hash, role, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'user', ?, ?)
            """,
            [
                (
                    f"Bulk {index}",
                    f"bulk-{index}",
                    username_lookup_key(f"bulk-{index}"),
                    password_hash,
                    timestamp,
                    timestamp,
                )
                for index in range(1000)
            ],
        )
        self.db.commit()
        user_ids = [
            int(row["id"])
            for row in self.db.execute(
                "SELECT id FROM users WHERE username LIKE 'bulk-%' ORDER BY id"
            ).fetchall()
        ]
        with self.client_for(admin_id) as client:
            response = client.post(
                "/api/admin/users/bulk-delete",
                json={"user_ids": user_ids},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["deleted"], 1000)
        self.assertEqual(
            self.db.execute(
                "SELECT COUNT(*) FROM users WHERE username LIKE 'bulk-%'"
            ).fetchone()[0],
            0,
        )

    def test_bulk_limit_and_expired_temporary_session(self):
        admin_id = self.insert_user("root", role="system_admin")
        expired_id = self.insert_user(
            "expired",
            must_change_pwd=1,
            expires_at="2000-01-01T00:00:00Z",
        )
        with self.client_for(admin_id) as client:
            too_many = client.post(
                "/api/admin/users/bulk-delete",
                json={"user_ids": list(range(1, 1002))},
            )
            self.assertEqual(too_many.status_code, 422, too_many.text)

        with self.client_for(expired_id) as client:
            change = client.put(
                "/api/auth/change-password",
                json={
                    "old_password": "correct-horse-battery-staple",
                    "new_password": "new-correct-horse-battery-staple",
                },
            )
            self.assertEqual(change.status_code, 403, change.text)
            self.assertIn("已过期", change.json()["detail"])

    def test_present_token_rechecks_user_access_and_pins_resource_version(self):
        admin_id = self.insert_user("root", role="system_admin")
        user_id = self.insert_user("present-user")
        timestamp = now_iso()
        version_one_path = settings.resources_dir / "present-v1.png"
        version_two_path = settings.resources_dir / "present-v2.png"
        version_one_path.parent.mkdir(parents=True, exist_ok=True)
        version_one_path.write_bytes(b"version-one")
        version_two_path.write_bytes(b"version-two")
        resource_id = int(
            self.db.execute(
                """
                INSERT INTO resources (
                    name, owner_id, subject, tags, status, visibility_scope,
                    management_scope, secrecy_level, current_version,
                    created_at, updated_at
                ) VALUES ('Pinned Resource', ?, '', '', 'active', 'partial',
                          'private', 'public', 2, ?, ?)
                """,
                (admin_id, timestamp, timestamp),
            ).lastrowid
        )
        for version_no, path in ((1, version_one_path), (2, version_two_path)):
            self.db.execute(
                """
                INSERT INTO resource_versions (
                    resource_id, version_no, ppt_path, png_path, created_by, created_at
                ) VALUES (?, ?, '', ?, ?, ?)
                """,
                (
                    resource_id,
                    version_no,
                    settings.store_path(path),
                    admin_id,
                    timestamp,
                ),
            )
        show_id = int(
            self.db.execute(
                """
                INSERT INTO shows (
                    name, owner_id, subject, tags, status, visibility_scope,
                    management_scope, secrecy_level, created_at, series_id,
                    version_no, updated_at
                ) VALUES ('Private Show', ?, '', '', 'active', 'partial',
                          'private', 'public', ?, 'series-present', 1, ?)
                """,
                (admin_id, timestamp, timestamp),
            ).lastrowid
        )
        self.db.execute(
            "INSERT INTO show_visibility (show_id, user_id) VALUES (?, ?)",
            (show_id, user_id),
        )
        self.db.execute(
            "INSERT INTO resource_visibility (resource_id, user_id) VALUES (?, ?)",
            (resource_id, user_id),
        )
        self.db.execute(
            "INSERT INTO show_resources (show_id, resource_id, version_no) VALUES (?, ?, 1)",
            (show_id, resource_id),
        )
        session_version = int(
            self.db.execute(
                "SELECT session_version FROM users WHERE id = ?",
                (user_id,),
            ).fetchone()[0]
        )
        token = create_present_token(
            show_id,
            user_id,
            settings.secret_key,
            session_version=session_version,
        )
        self.db.commit()

        with TestClient(self.app) as client:
            image = client.get(
                f"/api/slides/{resource_id}/image",
                params={"session_token": token},
            )
            self.assertEqual(image.status_code, 200, image.text)
            self.assertEqual(image.content, b"version-one")

            self.db.execute(
                "DELETE FROM resource_visibility WHERE resource_id = ? AND user_id = ?",
                (resource_id, user_id),
            )
            self.db.commit()
            resource_revoked = client.get(
                f"/api/slides/{resource_id}/image",
                params={"session_token": token},
            )
            self.assertEqual(resource_revoked.status_code, 403, resource_revoked.text)
            self.db.execute(
                "INSERT INTO resource_visibility (resource_id, user_id) VALUES (?, ?)",
                (resource_id, user_id),
            )

            self.db.execute(
                "DELETE FROM show_visibility WHERE show_id = ? AND user_id = ?",
                (show_id, user_id),
            )
            self.db.commit()
            revoked = client.get(
                f"/api/slides/{resource_id}/image",
                params={"session_token": token},
            )
            self.assertEqual(revoked.status_code, 403, revoked.text)

            self.db.execute(
                "INSERT INTO show_visibility (show_id, user_id) VALUES (?, ?)",
                (show_id, user_id),
            )
            self.db.execute(
                "UPDATE users SET session_version = session_version + 1 WHERE id = ?",
                (user_id,),
            )
            self.db.commit()
            invalidated = client.get(
                f"/api/slides/{resource_id}/image",
                params={"session_token": token},
            )
            self.assertEqual(invalidated.status_code, 401, invalidated.text)


class UserSchemaMigrationTests(unittest.TestCase):
    def test_upgrade_normalises_case_duplicates_feishu_ids_and_user_tags(self):
        with tempfile.TemporaryDirectory(prefix="slideflow-user-migration-") as temporary:
            root = Path(temporary)
            db_path = root / "data" / "db" / "slide_flow.db"
            db_path.parent.mkdir(parents=True)
            db = sqlite3.connect(db_path)
            db.executescript(
                """
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    feishu_id TEXT NOT NULL DEFAULT '',
                    tags TEXT NOT NULL DEFAULT '',
                    role TEXT NOT NULL,
                    must_change_pwd INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                PRAGMA user_version = 8;
                """
            )
            password_hash = hash_password("migration-secure-password")
            db.execute(
                "INSERT INTO users VALUES (1, 'Alice', ' Alice ', ?, 'ou_same', 'team-a, team-b', 'user', 0, 'now', 'now')",
                (password_hash,),
            )
            db.execute(
                "INSERT INTO users VALUES (2, 'Alice 2', 'Alice', ?, 'ou_same', 'team-a', 'user', 0, 'now', 'now')",
                (password_hash,),
            )
            db.execute(
                "INSERT INTO users VALUES (3, 'Alice 3', 'ＡＬＩＣＥ', ?, '', '', 'user', 0, 'now', 'now')",
                (password_hash,),
            )
            db.commit()
            db.close()

            paths = {
                "root_dir": root,
                "data_dir": root / "data",
                "db_dir": db_path.parent,
                "assets_dir": root / "data" / "assets",
                "resources_dir": root / "data" / "assets" / "resources",
                "templates_dir": root / "data" / "assets" / "templates",
                "fonts_dir": root / "data" / "assets" / "fonts",
                "thumbs_dir": root / "data" / "assets" / "thumbs",
                "downloads_dir": root / "data" / "assets" / "downloads",
                "log_dir": root / "data" / "logs",
                "db_path": db_path,
            }
            with patch.multiple(settings, **paths):
                init_db()

            migrated = sqlite3.connect(db_path)
            migrated.row_factory = sqlite3.Row
            self.addCleanup(migrated.close)
            self.assertEqual(migrated.execute("PRAGMA user_version").fetchone()[0], DB_SCHEMA_VERSION)
            rows = migrated.execute(
                "SELECT id, username, feishu_id FROM users ORDER BY id"
            ).fetchall()
            self.assertEqual(len({username_lookup_key(row["username"]) for row in rows}), 3)
            self.assertEqual(rows[0]["username"], "Alice")
            self.assertEqual(rows[0]["feishu_id"], "ou_same")
            self.assertEqual(rows[1]["feishu_id"], "")
            self.assertEqual(
                {
                    row["tag_name"]
                    for row in migrated.execute(
                        "SELECT tag_name FROM user_tags WHERE user_id = 1"
                    ).fetchall()
                },
                {"team-a", "team-b"},
            )
            self.assertEqual(
                {
                    row["name"]
                    for row in migrated.execute(
                        "SELECT name FROM user_tag_definitions"
                    ).fetchall()
                },
                {"team-a", "team-b"},
            )

    def test_upgrade_resolves_generated_username_collisions(self):
        with tempfile.TemporaryDirectory(prefix="slideflow-user-collision-") as temporary:
            root = Path(temporary)
            db_path = root / "data" / "db" / "slide_flow.db"
            db_path.parent.mkdir(parents=True)
            db = sqlite3.connect(db_path)
            db.executescript(
                """
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    feishu_id TEXT NOT NULL DEFAULT '',
                    tags TEXT NOT NULL DEFAULT '',
                    role TEXT NOT NULL,
                    must_change_pwd INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                PRAGMA user_version = 8;
                """
            )
            password_hash = hash_password("migration-secure-password")
            for user_id, username in (
                (1, "dup"),
                (2, "dup-4"),
                (3, "dup-4-2"),
                (4, "DUP"),
            ):
                db.execute(
                    "INSERT INTO users VALUES (?, ?, ?, ?, '', '', 'user', 0, 'now', 'now')",
                    (user_id, username, username, password_hash),
                )
            db.commit()
            db.close()

            paths = {
                "root_dir": root,
                "data_dir": root / "data",
                "db_dir": db_path.parent,
                "assets_dir": root / "data" / "assets",
                "resources_dir": root / "data" / "assets" / "resources",
                "templates_dir": root / "data" / "assets" / "templates",
                "fonts_dir": root / "data" / "assets" / "fonts",
                "thumbs_dir": root / "data" / "assets" / "thumbs",
                "downloads_dir": root / "data" / "assets" / "downloads",
                "log_dir": root / "data" / "logs",
                "db_path": db_path,
            }
            with patch.multiple(settings, **paths):
                init_db()

            migrated = sqlite3.connect(db_path)
            migrated.row_factory = sqlite3.Row
            self.addCleanup(migrated.close)
            usernames = [
                row["username"]
                for row in migrated.execute(
                    "SELECT username FROM users ORDER BY id"
                ).fetchall()
            ]
            self.assertEqual(len({username_lookup_key(value) for value in usernames}), 4)
            self.assertEqual(usernames[3], "DUP-4-3")


if __name__ == "__main__":
    unittest.main()
