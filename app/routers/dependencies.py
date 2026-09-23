"""Shared request models and database dependencies for modular routers."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Optional

from pydantic import Field

from app.core.permissions import ROLE_USER, SESSION_COOKIE
from app.schemas.base import ApiPayload


class LoginPayload(ApiPayload):
    username: str = Field(..., min_length=1, max_length=50)
    password: str = Field(..., min_length=1, max_length=200)


class OfflineVerifyPayload(ApiPayload):
    username: str = Field(..., min_length=1, max_length=50)
    password: str = Field(..., min_length=1, max_length=200)
    show_id: int = Field(..., ge=1)


class UserPayload(ApiPayload):
    name: str = Field(..., min_length=1, max_length=100)
    username: str = Field(..., min_length=2, max_length=50)
    # 空字符串表示编辑用户时不修改密码；非空密码由路由统一执行密码策略校验。
    password: Optional[str] = Field(default=None, max_length=200)
    feishu_id: str = Field(default="", max_length=100)
    avatar_url: str = Field(default="", max_length=2000)
    tags: str = Field(default="", max_length=1000)
    role: str = ROLE_USER
    # 兼容旧客户端；新建本地密码账号始终要求首次登录修改密码。
    need_change_pwd: bool = False


class FontDeletePayload(ApiPayload):
    font_ids: list[int]


class FontDownloadPayload(ApiPayload):
    font_ids: list[int] = Field(..., min_length=1, max_length=500)


class UserDeletePayload(ApiPayload):
    user_ids: list[int]


class UserTransferDeletePayload(ApiPayload):
    target_user_id: int


class UserPreferencesPayload(ApiPayload):
    preferences: dict[str, str] = Field(default_factory=dict)


class ChangePasswordPayload(ApiPayload):
    old_password: str = Field(..., min_length=1, max_length=200)
    new_password: str = Field(..., min_length=10, max_length=200)


class InitialSetupPayload(ApiPayload):
    token: str = Field(..., min_length=32, max_length=200)
    name: str = Field(..., min_length=1, max_length=100)
    username: str = Field(..., min_length=2, max_length=50)
    password: str = Field(..., min_length=10, max_length=200)


def db_dep():
    from app.services.db import db_dep as _db_dep
    yield from _db_dep()


def db_read_dep():
    from app.services.db import db_read_dep as _db_read_dep
    yield from _db_read_dep()


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
        "avatar_url": row["avatar_url"] if "avatar_url" in row.keys() else "",
        "tags": row["tags"] if "tags" in row.keys() else "",
        "must_change_pwd": bool(row["must_change_pwd"]),
        "temporary_password_expires_at": (
            row["temporary_password_expires_at"]
            if "temporary_password_expires_at" in row.keys()
            else None
        ),
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
