from __future__ import annotations

import sqlite3

from fastapi import Depends, HTTPException, Request

from app.db import get_read_db, release_db
from app.core.security import read_session_token
from app.core.cache import user_cache
from app.config import settings


# 角色常量
ROLE_SYSTEM_ADMIN = "system_admin"   # 系统管理员：可越权访问/管理全部资源
ROLE_OPERATIONS_ADMIN = "admin"     # 运营管理员：拥有运营管理功能，资源/放映需按归属判定
ROLE_USER = "user"                  # 普通用户

ADMIN_ROLES = (ROLE_SYSTEM_ADMIN, ROLE_OPERATIONS_ADMIN)


# ── Session Cookie 名称 ──
SESSION_COOKIE = "slide_flow_session"


def _current_user_from_request(request: Request, db: sqlite3.Connection) -> dict | None:
    """从请求中提取当前登录用户（带缓存）"""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    user_id = read_session_token(token, settings.secret_key)
    if user_id is None:
        return None

    # 尝试从缓存获取
    cache_key = f"user:{int(user_id)}"
    cached = user_cache.get(cache_key)
    if cached is not None:
        return cached

    # 缓存未命中，查库
    row = db.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
    if row is None:
        return None

    # 转为 dict 缓存，确保不依赖数据库连接
    user_dict = dict(row)
    user_cache.set(cache_key, user_dict)
    return user_dict


def _auth_db_dep():
    db = get_read_db()
    try:
        yield db
    finally:
        release_db(db, readonly=True)


def require_user(
    request: Request,
    db: sqlite3.Connection = Depends(_auth_db_dep),
) -> dict:
    """依赖注入：要求用户已登录"""
    user = _current_user_from_request(request, db)
    if user is None:
        raise HTTPException(401, "请先登录")
    return user


def require_admin(user: dict = Depends(require_user)) -> dict:
    """依赖注入：要求运营管理员或系统管理员权限"""
    if user["role"] not in ADMIN_ROLES:
        raise HTTPException(403, "需要运营管理员或系统管理员权限")
    return user


def require_system_admin(user: dict = Depends(require_user)) -> dict:
    """依赖注入：要求系统管理员权限"""
    if user["role"] != ROLE_SYSTEM_ADMIN:
        raise HTTPException(403, "需要系统管理员权限")
    return user


def is_system_admin(user: sqlite3.Row) -> bool:
    return user["role"] == ROLE_SYSTEM_ADMIN


def is_admin(user: sqlite3.Row) -> bool:
    """运营管理员或系统管理员。"""
    return user["role"] in ADMIN_ROLES


def _linked_user_ids(db: sqlite3.Connection, table: str, resource_id: int) -> set[int]:
    rows = db.execute(f"SELECT user_id FROM {table} WHERE resource_id = ?", (resource_id,)).fetchall()
    return {int(row["user_id"]) for row in rows}


def can_view_resource(db: sqlite3.Connection, resource: sqlite3.Row, user: sqlite3.Row) -> bool:
    if is_system_admin(user):
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
    if is_system_admin(user):
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
    if is_system_admin(user):
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
    if is_system_admin(user):
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
