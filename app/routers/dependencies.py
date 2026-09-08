"""Shared request models and database dependencies for modular routers."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.core.permissions import ROLE_USER, SESSION_COOKIE


class ApiPayload(BaseModel):
    """Current-version API payloads reject fields outside their declared schema."""

    model_config = ConfigDict(extra="forbid")


class LoginPayload(ApiPayload):
    username: str
    password: str


class UserPayload(ApiPayload):
    name: str = Field(..., min_length=1, max_length=100)
    username: str = Field(..., min_length=2, max_length=50)
    password: str | None = Field(default=None, max_length=200)
    feishu_id: str = Field(default="", max_length=100)
    role: str = ROLE_USER
    need_change_pwd: bool = False


class FontDeletePayload(ApiPayload):
    font_ids: list[int]


class UserDeletePayload(ApiPayload):
    user_ids: list[int]


class UserTransferDeletePayload(ApiPayload):
    target_user_id: int


class UserPreferencesPayload(ApiPayload):
    preferences: dict[str, str] = Field(default_factory=dict)


class ChangePasswordPayload(ApiPayload):
    old_password: str
    new_password: str


def db_dep():
    """Provide a pooled read/write database connection."""
    from app.db import get_write_db, release_db

    db = get_write_db()
    try:
        yield db
    finally:
        release_db(db, readonly=False)


def db_read_dep():
    """Provide a pooled read-only database connection."""
    from app.db import get_read_db, release_db

    db = get_read_db()
    try:
        yield db
    finally:
        release_db(db, readonly=True)


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def _serialize_user(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "id": row["id"],
        "name": row["name"],
        "username": row["username"],
        "role": row["role"],
        "feishu_id": row["feishu_id"],
        "must_change_pwd": bool(row["must_change_pwd"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _font_aliases_from_row(row: sqlite3.Row) -> list[str]:
    try:
        parsed = json.loads(row["aliases"] or "[]")
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []

    aliases: list[str] = []
    seen: set[str] = set()
    for value in parsed:
        if not isinstance(value, str):
            continue
        alias = value.strip()
        if alias and alias not in seen:
            aliases.append(alias)
            seen.add(alias)
    return aliases
