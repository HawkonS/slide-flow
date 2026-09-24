from __future__ import annotations

import json
import base64
import hashlib
import hmac
import time
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.core.bootstrap import (
    complete_initial_setup,
    initial_setup_file,
    initial_setup_status,
    prepare_initial_admin,
)
from app.core.security import (
    create_session_token,
    hash_password,
    password_policy_error,
    read_session_claims,
    verify_password,
)
from app.core.permissions import SESSION_COOKIE, _auth_db_dep
from app.core.user_profiles import username_lookup_key
from app.db import now_iso
from app.routers import auth, users
from app.routers.dependencies import db_dep, db_read_dep


def _db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:", check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            username TEXT NOT NULL UNIQUE,
            username_key TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            feishu_id TEXT NOT NULL DEFAULT '',
            avatar_url TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL,
            must_change_pwd INTEGER NOT NULL DEFAULT 0,
            session_version INTEGER NOT NULL DEFAULT 1,
            temporary_password_expires_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            category TEXT NOT NULL DEFAULT '未分类',
            label TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_by INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE user_tags (
            user_id INTEGER NOT NULL,
            tag_name TEXT NOT NULL,
            PRIMARY KEY (user_id, tag_name)
        );
        CREATE TABLE user_tag_definitions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            category TEXT NOT NULL DEFAULT '未分类',
            label TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_by INTEGER,
            created_at TEXT NOT NULL
        );
        CREATE TABLE admin_audit_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_user_id INTEGER,
            subject_user_id INTEGER,
            action TEXT NOT NULL,
            details TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        );
        CREATE TABLE auth_login_attempts (
            key TEXT PRIMARY KEY,
            failure_count INTEGER NOT NULL,
            window_started_at REAL NOT NULL,
            locked_until REAL NOT NULL DEFAULT 0,
            updated_at REAL NOT NULL
        );
        CREATE TABLE runtime_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    return db


def _test_app(db: sqlite3.Connection) -> FastAPI:
    app = FastAPI()
    app.include_router(auth.router, prefix="/api")
    app.include_router(users.router, prefix="/api")

    def override_db():
        yield db

    app.dependency_overrides[db_dep] = override_db
    app.dependency_overrides[db_read_dep] = override_db
    app.dependency_overrides[_auth_db_dep] = override_db
    return app


def _insert_user(
    db: sqlite3.Connection,
    *,
    username: str,
    password: str,
    role: str = "user",
    must_change_pwd: int = 0,
    expires_at: str | None = None,
) -> int:
    cursor = db.execute(
        """
        INSERT INTO users (
            name, username, username_key, password_hash, role, must_change_pwd,
            temporary_password_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            username,
            username,
            username_lookup_key(username),
            hash_password(password),
            role,
            must_change_pwd,
            expires_at,
            now_iso(),
            now_iso(),
        ),
    )
    db.commit()
    return int(cursor.lastrowid)


class PasswordBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="slide-flow-bootstrap-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_empty_database_uses_one_time_setup_instead_of_default_password(self):
        db = _db()
        self.addCleanup(db.close)
        with patch.object(settings, "root_dir", self.root):
            self.assertTrue(prepare_initial_admin(db))
            user = db.execute("SELECT * FROM users").fetchone()
            self.assertEqual(user["role"], "system_admin")
            self.assertTrue(user["must_change_pwd"])
            self.assertFalse(verify_password("123456", user["password_hash"]))
            setup = json.loads(initial_setup_file().read_text(encoding="utf-8"))
            self.assertEqual(initial_setup_file().stat().st_mode & 0o777, 0o600)
            self.assertNotIn(setup["setup_token"], db.execute("SELECT value FROM runtime_state").fetchone()[0])

    def test_setup_token_is_single_use_and_removes_local_file(self):
        db = _db()
        self.addCleanup(db.close)
        with patch.object(settings, "root_dir", self.root):
            prepare_initial_admin(db)
            token = json.loads(initial_setup_file().read_text(encoding="utf-8"))["setup_token"]
            user = complete_initial_setup(
                db,
                token=token,
                name="System Owner",
                username="owner",
                password="correct-horse-battery-staple",
            )
            self.assertFalse(initial_setup_file().exists())
            self.assertEqual(initial_setup_status(db), {"required": False})
            self.assertFalse(user["must_change_pwd"])
            self.assertTrue(verify_password("correct-horse-battery-staple", user["password_hash"]))
            with self.assertRaisesRegex(ValueError, "无效或已使用"):
                complete_initial_setup(
                    db,
                    token=token,
                    name="Again",
                    username="again",
                    password="another-secure-password",
                )

    def test_localhost_setup_uses_http_only_cookie_without_manual_token(self):
        db = _db()
        self.addCleanup(db.close)
        with patch.object(settings, "root_dir", self.root):
            prepare_initial_admin(db)
            app = _test_app(db)
            with TestClient(
                app,
                base_url="http://127.0.0.1",
                client=("127.0.0.1", 50000),
            ) as client:
                status = client.get("/api/auth/setup")
                self.assertEqual(status.status_code, 200, status.text)
                self.assertEqual(status.json(), {"required": True, "automatic": True})
                self.assertNotIn("setup_token", status.text)
                self.assertIn("HttpOnly", status.headers["set-cookie"])
                self.assertIn("SameSite=strict", status.headers["set-cookie"])

                completed = client.post(
                    "/api/auth/setup",
                    headers={"Origin": "http://127.0.0.1"},
                    json={
                        "name": "System Owner",
                        "username": "owner",
                        "password": "correct-horse-battery-staple",
                    },
                )
                self.assertEqual(completed.status_code, 200, completed.text)
                self.assertFalse(initial_setup_file().exists())
                self.assertFalse(completed.json()["user"]["must_change_pwd"])

    def test_remote_setup_still_requires_manual_token(self):
        db = _db()
        self.addCleanup(db.close)
        with patch.object(settings, "root_dir", self.root):
            prepare_initial_admin(db)
            app = _test_app(db)
            with TestClient(app, base_url="http://example.test") as client:
                status = client.get("/api/auth/setup")
                self.assertEqual(status.json(), {"required": True, "automatic": False})
                denied = client.post(
                    "/api/auth/setup",
                    json={
                        "name": "System Owner",
                        "username": "owner",
                        "password": "correct-horse-battery-staple",
                    },
                )
                self.assertEqual(denied.status_code, 400, denied.text)
                self.assertIn("需要一次性令牌", denied.json()["detail"])

    def test_local_setup_cookie_rejects_cross_site_origin(self):
        db = _db()
        self.addCleanup(db.close)
        with patch.object(settings, "root_dir", self.root):
            prepare_initial_admin(db)
            app = _test_app(db)
            with TestClient(
                app,
                base_url="http://127.0.0.1",
                client=("127.0.0.1", 50000),
            ) as client:
                client.get("/api/auth/setup")
                denied = client.post(
                    "/api/auth/setup",
                    headers={"Origin": "https://attacker.example"},
                    json={
                        "name": "System Owner",
                        "username": "owner",
                        "password": "correct-horse-battery-staple",
                    },
                )
                self.assertEqual(denied.status_code, 400, denied.text)
                self.assertIn("需要一次性令牌", denied.json()["detail"])

    def test_legacy_shared_password_is_disabled_and_requires_setup(self):
        db = _db()
        self.addCleanup(db.close)
        db.execute(
            """
            INSERT INTO users (
                name, username, username_key, password_hash, role, created_at, updated_at
            ) VALUES ('Owner', 'owner', 'owner', ?, 'system_admin', 'now', 'now')
            """,
            (hash_password("123456"),),
        )
        db.commit()
        with patch.object(settings, "root_dir", self.root):
            self.assertTrue(prepare_initial_admin(db, ["123456"]))
            user = db.execute("SELECT * FROM users WHERE username = 'owner'").fetchone()
            self.assertFalse(verify_password("123456", user["password_hash"]))
            self.assertTrue(user["must_change_pwd"])
            self.assertGreater(user["session_version"], 1)
            self.assertTrue(initial_setup_file().exists())

    def test_session_version_is_signed_and_tamper_protected(self):
        token = create_session_token(12, "secret", ttl_seconds=60, session_version=7)
        self.assertEqual(read_session_claims(token, "secret"), (12, 7))
        self.assertIsNone(read_session_claims(token, "other-secret"))

    def test_legacy_session_token_maps_to_version_one(self):
        payload = base64.urlsafe_b64encode(f"12:{int(time.time()) + 60}".encode()).decode().rstrip("=")
        signature = hmac.new(b"secret", payload.encode("ascii"), hashlib.sha256).digest()
        signature_b64 = base64.urlsafe_b64encode(signature).decode().rstrip("=")
        self.assertEqual(read_session_claims(f"{payload}.{signature_b64}", "secret"), (12, 1))

    def test_password_policy_rejects_weak_and_username_passwords(self):
        self.assertIsNotNone(password_policy_error("123456"))
        self.assertIsNotNone(password_policy_error("          "))
        self.assertIsNotNone(password_policy_error(" 123456    "))
        self.assertIsNotNone(password_policy_error("owner", username="owner"))
        self.assertIsNone(password_policy_error("correct-horse-battery-staple", username="owner"))

    def test_create_user_returns_an_expiring_temporary_password_once(self):
        db = _db()
        self.addCleanup(db.close)
        admin_id = _insert_user(
            db,
            username="owner",
            password="owner-secure-password",
            role="system_admin",
        )
        app = _test_app(db)
        with TestClient(app) as client:
            client.cookies.set(
                SESSION_COOKIE,
                create_session_token(
                    admin_id,
                    settings.secret_key,
                    ttl_seconds=60,
                ),
            )
            response = client.post(
                "/api/admin/users",
                json={"name": "New User", "username": "new-user", "role": "user"},
            )

            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.headers["cache-control"], "private, no-store")
            temporary_password = response.json()["plain_password"]
            created = db.execute("SELECT * FROM users WHERE username = 'new-user'").fetchone()
            self.assertTrue(created["must_change_pwd"])
            self.assertGreater(created["temporary_password_expires_at"], now_iso())
            self.assertTrue(verify_password(temporary_password, created["password_hash"]))

            listed = client.get("/api/admin/users")
            self.assertEqual(listed.status_code, 200, listed.text)
            self.assertNotIn("plain_password", listed.text)

        with TestClient(app) as new_user_client:
            login = new_user_client.post(
                "/api/auth/login",
                json={"username": "new-user", "password": temporary_password},
            )
            self.assertEqual(login.status_code, 200, login.text)
            self.assertTrue(login.json()["user"]["must_change_pwd"])
            blocked = new_user_client.get("/api/admin/users")
            self.assertEqual(blocked.status_code, 403, blocked.text)
            self.assertIn("修改临时密码", blocked.json()["detail"])

    def test_expired_temporary_password_cannot_log_in(self):
        db = _db()
        self.addCleanup(db.close)
        _insert_user(
            db,
            username="expired-user",
            password="expired-temporary-password",
            must_change_pwd=1,
            expires_at="2000-01-01T00:00:00Z",
        )
        with TestClient(_test_app(db)) as client:
            response = client.post(
                "/api/auth/login",
                json={
                    "username": "expired-user",
                    "password": "expired-temporary-password",
                },
            )
        self.assertEqual(response.status_code, 401, response.text)
        self.assertEqual(response.json()["detail"], "用户名或密码错误")

    def test_password_reset_invalidates_existing_sessions(self):
        db = _db()
        self.addCleanup(db.close)
        admin_id = _insert_user(
            db,
            username="owner",
            password="owner-secure-password",
            role="system_admin",
        )
        target_id = _insert_user(
            db,
            username="target",
            password="target-secure-password",
        )
        app = _test_app(db)
        old_target_token = create_session_token(
            target_id,
            settings.secret_key,
            ttl_seconds=60,
        )

        with TestClient(app) as target_client:
            target_client.cookies.set(SESSION_COOKIE, old_target_token)
            self.assertEqual(target_client.get("/api/me").status_code, 200)

            with TestClient(app) as admin_client:
                admin_client.cookies.set(
                    SESSION_COOKIE,
                    create_session_token(
                        admin_id,
                        settings.secret_key,
                        ttl_seconds=60,
                    ),
                )
                reset = admin_client.post(f"/api/admin/users/{target_id}/reset-password")
                self.assertEqual(reset.status_code, 200, reset.text)
                self.assertEqual(reset.headers["cache-control"], "private, no-store")
                temporary_password = reset.json()["plain_password"]

            self.assertEqual(target_client.get("/api/me").status_code, 401)

        updated = db.execute("SELECT * FROM users WHERE id = ?", (target_id,)).fetchone()
        self.assertEqual(updated["session_version"], 2)
        self.assertTrue(updated["must_change_pwd"])
        self.assertTrue(verify_password(temporary_password, updated["password_hash"]))

        with TestClient(app) as login_client:
            login = login_client.post(
                "/api/auth/login",
                json={"username": "target", "password": temporary_password},
            )
            self.assertEqual(login.status_code, 200, login.text)


if __name__ == "__main__":
    unittest.main()
