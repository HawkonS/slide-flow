"""One-time administrator bootstrap without a shared default password."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import stat
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Iterable

from app.config import settings
from app.core.security import hash_password, password_policy_error, verify_password
from app.core.user_profiles import normalise_display_name, normalise_username, username_lookup_key


INITIAL_SETUP_STATE_KEY = "initial_admin_setup"
LEGACY_PASSWORD_MIGRATION_KEY = "legacy_default_passwords_remediated"


def _now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def initial_setup_file() -> Path:
    return settings.root_dir / ".secrets" / "initial-admin-setup.json"


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _write_setup_file(*, token: str, username: str) -> None:
    path = initial_setup_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, stat.S_IRWXU)
    except OSError:
        pass
    payload = {
        "setup_url": "/setup",
        "username": username,
        "setup_token": token,
        "created_at": _now_iso(),
        "notice": "完成初始化后此文件会自动删除。请勿复制到聊天、工单或代码仓库。",
    }
    fd, temp_name = tempfile.mkstemp(prefix=".initial-admin-", suffix=".tmp", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_path, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(temp_path, path)
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    finally:
        temp_path.unlink(missing_ok=True)


def remove_initial_setup_file() -> None:
    initial_setup_file().unlink(missing_ok=True)


def read_initial_setup_token() -> str | None:
    """Read the local-only setup token without exposing it through an API body."""
    path = initial_setup_file()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, TypeError, json.JSONDecodeError):
        return None
    token = payload.get("setup_token") if isinstance(payload, dict) else None
    return token.strip() if isinstance(token, str) and token.strip() else None


def _state(db: sqlite3.Connection) -> dict[str, object] | None:
    row = db.execute("SELECT value FROM runtime_state WHERE key = ?", (INITIAL_SETUP_STATE_KEY,)).fetchone()
    if row is None:
        return None
    try:
        value = json.loads(row["value"])
    except (TypeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def initial_setup_status(db: sqlite3.Connection) -> dict[str, object]:
    state = _state(db)
    if not state:
        return {"required": False}
    user = db.execute(
        "SELECT id, must_change_pwd FROM users WHERE id = ?", (state.get("user_id"),)
    ).fetchone()
    if user is None or not user["must_change_pwd"]:
        return {"required": False}
    return {"required": True}


def _store_setup_state(db: sqlite3.Connection, user_id: int, token: str) -> None:
    value = json.dumps(
        {"user_id": user_id, "token_hash": _token_hash(token), "created_at": _now_iso()},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    db.execute(
        """
        INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """,
        (INITIAL_SETUP_STATE_KEY, value, _now_iso()),
    )


def prepare_initial_admin(db: sqlite3.Connection, legacy_passwords: Iterable[str] = ()) -> bool:
    """Create or remediate the initial admin and issue a one-time setup token.

    Returns ``True`` when administrator setup is pending. The plaintext token is
    never stored in SQLite or logs; it exists only in a mode-0600 local file.
    """
    generated_token: str | None = None
    setup_username = ""
    db.execute("BEGIN IMMEDIATE")
    try:
        state = _state(db)
        if state is not None:
            pending_user = db.execute(
                "SELECT must_change_pwd FROM users WHERE id = ?", (state.get("user_id"),)
            ).fetchone()
            if pending_user is None or not pending_user["must_change_pwd"]:
                db.execute("DELETE FROM runtime_state WHERE key = ?", (INITIAL_SETUP_STATE_KEY,))
                state = None
                remove_initial_setup_file()
        user_count = int(db.execute("SELECT COUNT(*) FROM users").fetchone()[0])
        if user_count == 0:
            generated_token = secrets.token_urlsafe(32)
            setup_username = "Hawkon"
            ts = _now_iso()
            cursor = db.execute(
                """
                INSERT INTO users (
                    name, username, username_key, password_hash, feishu_id, role,
                    must_change_pwd, created_at, updated_at
                ) VALUES (?, ?, ?, ?, '', 'system_admin', 1, ?, ?)
                """,
                (
                    "Hawkon",
                    setup_username,
                    username_lookup_key(setup_username),
                    hash_password(secrets.token_urlsafe(32)),
                    ts,
                    ts,
                ),
            )
            _store_setup_state(db, int(cursor.lastrowid), generated_token)
            state = _state(db)

        migration_done = db.execute(
            "SELECT 1 FROM runtime_state WHERE key = ?", (LEGACY_PASSWORD_MIGRATION_KEY,)
        ).fetchone()
        if migration_done is None:
            candidates = {value for value in legacy_passwords if value}
            candidates.add("123456")
            weak_admin_id: int | None = None
            rows = db.execute("SELECT id, username, password_hash, role FROM users ORDER BY id").fetchall()
            for row in rows:
                if not any(verify_password(candidate, row["password_hash"]) for candidate in candidates):
                    continue
                db.execute(
                    """
                    UPDATE users
                    SET password_hash = ?, must_change_pwd = 1,
                        session_version = session_version + 1, updated_at = ?
                    WHERE id = ?
                    """,
                    (hash_password(secrets.token_urlsafe(32)), _now_iso(), int(row["id"])),
                )
                if weak_admin_id is None and row["role"] == "system_admin":
                    weak_admin_id = int(row["id"])
                    setup_username = row["username"]
            if state is None and weak_admin_id is not None:
                generated_token = secrets.token_urlsafe(32)
                _store_setup_state(db, weak_admin_id, generated_token)
                state = _state(db)
            db.execute(
                "INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)",
                (LEGACY_PASSWORD_MIGRATION_KEY, "1", _now_iso()),
            )

        state = _state(db)
        if state is not None and not initial_setup_file().exists() and generated_token is None:
            user = db.execute("SELECT username FROM users WHERE id = ?", (state.get("user_id"),)).fetchone()
            if user is not None:
                generated_token = secrets.token_urlsafe(32)
                setup_username = user["username"]
                _store_setup_state(db, int(state["user_id"]), generated_token)

        if generated_token is not None:
            _write_setup_file(token=generated_token, username=setup_username)
        db.commit()

        # The setup file is only valid while the database carries a pending
        # bootstrap state.  Older versions of the launcher used the file as
        # their warning signal, so a successful setup could leave an orphaned
        # file behind and make every subsequent startup report a false alarm.
        # Remove that stale artifact after the committed state is visible.
        if _state(db) is None:
            try:
                remove_initial_setup_file()
            except OSError:
                # A deployment may run the application under a different OS
                # user than the one that created an old setup file.  The
                # database is still authoritative, so a cleanup permission
                # error must not prevent the service from starting.
                pass
    except Exception:
        db.rollback()
        if generated_token is not None:
            remove_initial_setup_file()
        raise
    return _state(db) is not None


def complete_initial_setup(
    db: sqlite3.Connection,
    *,
    token: str,
    name: str,
    username: str,
    password: str,
) -> sqlite3.Row:
    try:
        name = normalise_display_name(name)
        username = normalise_username(username)
    except ValueError as exc:
        raise ValueError(str(exc)) from None
    token = token.strip()
    policy_error = password_policy_error(password, username=username)
    if policy_error:
        raise ValueError(policy_error)
    db.execute("BEGIN IMMEDIATE")
    try:
        state = _state(db)
        expected_hash = str((state or {}).get("token_hash") or "")
        if not state or not expected_hash or not hmac.compare_digest(_token_hash(token), expected_hash):
            raise ValueError("初始化令牌无效或已使用")
        user_id = int(state["user_id"])
        existing = db.execute(
            "SELECT id FROM users WHERE username_key = ? AND id <> ?",
            (username_lookup_key(username), user_id),
        ).fetchone()
        if existing is not None:
            raise ValueError("用户名已存在")
        ts = _now_iso()
        db.execute(
            """
            UPDATE users
            SET name = ?, username = ?, username_key = ?, password_hash = ?, must_change_pwd = 0,
                session_version = session_version + 1, updated_at = ?
            WHERE id = ? AND role = 'system_admin'
            """,
            (name, username, username_lookup_key(username), hash_password(password), ts, user_id),
        )
        if db.execute("SELECT changes()").fetchone()[0] != 1:
            raise ValueError("待初始化的系统管理员不存在")
        db.execute("DELETE FROM runtime_state WHERE key = ?", (INITIAL_SETUP_STATE_KEY,))
        db.commit()
    except Exception:
        db.rollback()
        raise
    remove_initial_setup_file()
    return db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
