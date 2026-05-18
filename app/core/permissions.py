from __future__ import annotations

import sqlite3

from fastapi import Depends, HTTPException, Request

from app.db import get_db
from app.core.security import read_session_token
from app.config import settings


# 角色常量
ROLE_SUPER_ADMIN = "super_admin"   # 超级管理员：可越权访问/管理全部资源
ROLE_ADMIN = "admin"               # 系统管理员：拥有管理端功能，但资源/放映需按归属判定
ROLE_USER = "user"                 # 系统用户

ADMIN_ROLES = (ROLE_SUPER_ADMIN, ROLE_ADMIN)


# ── Session Cookie 名称 ──
SESSION_COOKIE = "slide_flow_session"


def _current_user_from_request(request: Request, db: sqlite3.Connection) -> sqlite3.Row | None:
    """从请求中提取当前登录用户"""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    user_id = read_session_token(token, settings.secret_key)
    if user_id is None:
        return None
    return db.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()


def require_user(request: Request, db: sqlite3.Connection = Depends(get_db)) -> sqlite3.Row:
    """依赖注入：要求用户已登录"""
    user = _current_user_from_request(request, db)
    if user is None:
        raise HTTPException(401, "请先登录")
    return user


def require_admin(user: sqlite3.Row = Depends(require_user)) -> sqlite3.Row:
    """依赖注入：要求管理员权限"""
    if user["role"] not in ADMIN_ROLES:
        raise HTTPException(403, "需要管理员权限")
    return user


def require_super_admin(user: sqlite3.Row = Depends(require_user)) -> sqlite3.Row:
    """依赖注入：要求超级管理员权限"""
    if user["role"] != ROLE_SUPER_ADMIN:
        raise HTTPException(403, "需要超级管理员权限")
    return user


def is_super_admin(user: sqlite3.Row) -> bool:
    return user["role"] == ROLE_SUPER_ADMIN


def is_admin(user: sqlite3.Row) -> bool:
    """系统管理员或超级管理员。"""
    return user["role"] in ADMIN_ROLES


def _linked_user_ids(db: sqlite3.Connection, table: str, resource_id: int) -> set[int]:
    rows = db.execute(f"SELECT user_id FROM {table} WHERE resource_id = ?", (resource_id,)).fetchall()
    return {int(row["user_id"]) for row in rows}


def can_view_resource(db: sqlite3.Connection, resource: sqlite3.Row, user: sqlite3.Row) -> bool:
    if is_super_admin(user):
        return True
    if int(resource["owner_id"]) == int(user["id"]):
        return True
    scope = resource["visibility_scope"]
    if scope == "public":
        return True
    if scope == "private":
        return False
    if scope == "partial":
        return int(user["id"]) in _linked_user_ids(db, "resource_visibility", int(resource["id"]))
    return False


def can_manage_resource(db: sqlite3.Connection, resource: sqlite3.Row, user: sqlite3.Row) -> bool:
    if is_super_admin(user):
        return True
    if int(resource["owner_id"]) == int(user["id"]):
        return True
    scope = resource["management_scope"]
    if scope == "public":
        return True
    if scope == "private":
        return False
    if scope == "partial":
        return int(user["id"]) in _linked_user_ids(db, "resource_management", int(resource["id"]))
    return False


def _linked_show_user_ids(db: sqlite3.Connection, table: str, show_id: int) -> set[int]:
    rows = db.execute(f"SELECT user_id FROM {table} WHERE show_id = ?", (show_id,)).fetchall()
    return {int(row["user_id"]) for row in rows}


def can_view_show(db: sqlite3.Connection, show: sqlite3.Row, user: sqlite3.Row) -> bool:
    if is_super_admin(user):
        return True
    if int(show["owner_id"]) == int(user["id"]):
        return True
    scope = show["visibility_scope"]
    if scope == "public":
        return True
    if scope == "private":
        return False
    if scope == "partial":
        return int(user["id"]) in _linked_show_user_ids(db, "show_visibility", int(show["id"]))
    return False


def can_manage_show(db: sqlite3.Connection, show: sqlite3.Row, user: sqlite3.Row) -> bool:
    if is_super_admin(user):
        return True
    if int(show["owner_id"]) == int(user["id"]):
        return True
    scope = show["management_scope"]
    if scope == "public":
        return True
    if scope == "private":
        return False
    if scope == "partial":
        return int(user["id"]) in _linked_show_user_ids(db, "show_management", int(show["id"]))
    return False


def _linked_link_user_ids(db: sqlite3.Connection, table: str, link_id: int) -> set[int]:
    rows = db.execute(f"SELECT user_id FROM {table} WHERE link_id = ?", (link_id,)).fetchall()
    return {int(row["user_id"]) for row in rows}


def can_view_link(db: sqlite3.Connection, link: sqlite3.Row, user: sqlite3.Row) -> bool:
    if is_super_admin(user):
        return True
    if int(link["owner_id"]) == int(user["id"]):
        return True
    scope = link["visibility_scope"]
    if scope == "public":
        return True
    if scope == "private":
        return False
    if scope == "partial":
        return int(user["id"]) in _linked_link_user_ids(db, "link_visibility", int(link["id"]))
    return False


def can_manage_link(db: sqlite3.Connection, link: sqlite3.Row, user: sqlite3.Row) -> bool:
    if is_super_admin(user):
        return True
    if int(link["owner_id"]) == int(user["id"]):
        return True
    scope = link["management_scope"]
    if scope == "public":
        return True
    if scope == "private":
        return False
    if scope == "partial":
        return int(user["id"]) in _linked_link_user_ids(db, "link_management", int(link["id"]))
    return False
