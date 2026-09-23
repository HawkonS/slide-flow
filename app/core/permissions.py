from __future__ import annotations

import sqlite3

from fastapi import Depends, HTTPException, Request

from app.db import get_read_db, release_db
from app.core.security import read_session_claims
from app.config import settings


# 角色常量
ROLE_SYSTEM_ADMIN = "system_admin"   # 系统管理员：可越权访问/管理全部资源
ROLE_OPERATIONS_ADMIN = "admin"     # 运营管理员：拥有运营管理功能，资源/放映需按归属判定
ROLE_USER = "user"                  # 普通用户

ADMIN_ROLES = (ROLE_SYSTEM_ADMIN, ROLE_OPERATIONS_ADMIN)


# ── Session Cookie 名称 ──
SESSION_COOKIE = "slide_flow_session"


def _current_user_from_request(request: Request, db: sqlite3.Connection) -> dict | None:
    """从请求中提取当前登录用户。

    角色信息必须从数据库实时读取。应用通常以多个 Gunicorn worker 运行，
    进程内缓存无法在用户角色变更后同步到其它 worker，会导致刚授予系统
    管理员权限的用户在一段时间内仍被旧角色拦截（尤其是用户管理页面）。
    """
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    claims = read_session_claims(token, settings.secret_key)
    if claims is None:
        return None
    user_id, session_version = claims

    # 每次鉴权都查库，确保多 worker 下角色变更立即生效。
    row = db.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()
    if row is None:
        return None
    if int(row["session_version"]) != session_version:
        return None

    return dict(row)


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
    if user.get("must_change_pwd") and request.url.path not in {
        "/api/me",
        "/api/auth/change-password",
        "/api/auth/logout",
    }:
        raise HTTPException(403, "请先修改临时密码后再继续使用")
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
