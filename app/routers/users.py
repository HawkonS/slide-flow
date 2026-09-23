"""
用户管理路由模块
处理管理员对用户的 CRUD 操作
"""
import sqlite3
import secrets
import re
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from app.core.permissions import (
    ADMIN_ROLES,
    ROLE_OPERATIONS_ADMIN,
    ROLE_SYSTEM_ADMIN,
    ROLE_USER,
    require_system_admin,
    require_user,
    is_system_admin,
)
from app.core.security import hash_password, password_policy_error
from app.core.cache import invalidate_user
from app.db import now_iso
from app.routers.dependencies import (
    UserPayload,
    UserDeletePayload,
    UserTransferDeletePayload,
    db_dep,
    db_read_dep,
    _serialize_user,
    _row_to_dict,
)


router = APIRouter()
TEMPORARY_PASSWORD_TTL_HOURS = 24


def _temporary_password_expiry() -> str:
    return (datetime.utcnow() + timedelta(hours=TEMPORARY_PASSWORD_TTL_HOURS)).isoformat(timespec="seconds") + "Z"


def _normalise_user_tags(value: str) -> str:
    """Store user labels as a compact, deterministic comma-separated value."""
    tags: list[str] = []
    seen: set[str] = set()
    for item in re.split(r"[，,\s]+", value or ""):
        tag = item.strip()
        if tag and tag not in seen:
            tags.append(tag[:64])
            seen.add(tag)
    return ",".join(tags)[:1000]


def _validate_avatar_url(value: str) -> str:
    value = (value or "").strip()
    if value and not re.match(r"^https?://", value, re.IGNORECASE):
        raise HTTPException(400, "头像地址必须使用 http:// 或 https://")
    return value


@router.get("/admin/users")
def list_users(
    _: Any = Depends(require_system_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """获取用户列表（系统管理员）"""
    rows = db.execute("SELECT * FROM users ORDER BY id").fetchall()
    return {"users": [_serialize_user(row) for row in rows]}


@router.get("/users/options")
def user_options(
    _: Any = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """获取用户选项列表（用于下拉选择）"""
    # Scope pickers only need display identity; do not expose role, Feishu ID,
    # or administrative user labels to every authenticated user.
    rows = db.execute("SELECT id, name, username, avatar_url FROM users ORDER BY name, id").fetchall()
    return {"users": [_row_to_dict(row) for row in rows]}


@router.post("/admin/users")
def create_user(
    payload: UserPayload,
    response: Response,
    admin: sqlite3.Row = Depends(require_system_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """创建新用户（系统管理员）"""
    if payload.role not in {ROLE_SYSTEM_ADMIN, ROLE_OPERATIONS_ADMIN, ROLE_USER}:
        raise HTTPException(400, "角色不正确")
    if payload.role == ROLE_SYSTEM_ADMIN and not is_system_admin(admin):
        raise HTTPException(403, "只有系统管理员能创建系统管理员")

    if payload.password:
        policy_error = password_policy_error(payload.password, username=payload.username)
        if policy_error:
            raise HTTPException(400, policy_error)
    avatar_url = _validate_avatar_url(payload.avatar_url)
    tags = _normalise_user_tags(payload.tags)

    # 不再使用全局共享默认密码。未指定时生成只展示一次的临时密码；
    # 管理员手工设置的密码同样视为临时密码，用户首次登录必须自行修改。
    must_change_pwd = 1
    plain_password: str | None = None
    if not payload.password:
        password = secrets.token_urlsafe(16)
        plain_password = password
    else:
        password = payload.password
    
    ts = now_iso()
    try:
        db.execute(
            """
            INSERT INTO users (
                name, username, password_hash, feishu_id, avatar_url, tags, role,
                must_change_pwd, temporary_password_expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.name,
                payload.username,
                hash_password(password),
                payload.feishu_id,
                avatar_url,
                tags,
                payload.role,
                must_change_pwd,
                _temporary_password_expiry(),
                ts,
                ts,
            ),
        )
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "用户名已存在") from None
    
    user = db.execute("SELECT * FROM users WHERE username = ?", (payload.username,)).fetchone()
    resp: dict[str, Any] = {"user": _serialize_user(user)}
    if plain_password:
        resp["plain_password"] = plain_password
        response.headers["Cache-Control"] = "private, no-store"
    return resp


@router.put("/admin/users/{user_id}")
def update_user(
    user_id: int,
    payload: UserPayload,
    admin: sqlite3.Row = Depends(require_system_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """更新用户信息（系统管理员）"""
    if payload.role not in {ROLE_SYSTEM_ADMIN, ROLE_OPERATIONS_ADMIN, ROLE_USER}:
        raise HTTPException(400, "角色不正确")
    if payload.password:
        policy_error = password_policy_error(payload.password, username=payload.username)
        if policy_error:
            raise HTTPException(400, policy_error)
    avatar_url = _validate_avatar_url(payload.avatar_url)
    tags = _normalise_user_tags(payload.tags)
    
    existing = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if existing is None:
        raise HTTPException(404, "用户不存在")
    
    # 系统管理员的身份只能由系统管理员授予/撤销
    if not is_system_admin(admin):
        if existing["role"] == ROLE_SYSTEM_ADMIN:
            raise HTTPException(403, "只有系统管理员能修改系统管理员账号")
        if payload.role == ROLE_SYSTEM_ADMIN:
            raise HTTPException(403, "只有系统管理员能授予系统管理员角色")
    
    if int(existing["id"]) == int(admin["id"]) and payload.role not in ADMIN_ROLES:
        raise HTTPException(400, "不能取消自己的管理员角色")
    
    if (
        int(existing["id"]) == int(admin["id"])
        and existing["role"] == ROLE_SYSTEM_ADMIN
        and payload.role != ROLE_SYSTEM_ADMIN
    ):
        raise HTTPException(400, "不能取消自己的系统管理员角色")
    
    fields: list[Any] = [payload.name, payload.username, payload.feishu_id, avatar_url, tags, payload.role, now_iso()]
    sql = "UPDATE users SET name = ?, username = ?, feishu_id = ?, avatar_url = ?, tags = ?, role = ?, updated_at = ?"
    
    if payload.password:
        sql += ", password_hash = ?, must_change_pwd = 1, temporary_password_expires_at = ?, session_version = session_version + 1"
        fields.append(hash_password(payload.password))
        fields.append(_temporary_password_expiry())
    
    sql += " WHERE id = ?"
    fields.append(user_id)
    
    try:
        db.execute(sql, fields)
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "用户名已存在") from None
    
    user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    invalidate_user(user_id)
    return {"user": _serialize_user(user)}


@router.post("/admin/users/{user_id}/reset-password")
def reset_user_password(
    user_id: int,
    response: Response,
    admin: sqlite3.Row = Depends(require_system_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """Generate a one-time temporary password and invalidate old sessions."""
    if int(user_id) == int(admin["id"]):
        raise HTTPException(400, "不能在用户管理中重置当前账号，请使用修改密码功能")
    user = db.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
    if user is None:
        raise HTTPException(404, "用户不存在")
    plain_password = secrets.token_urlsafe(16)
    db.execute(
        """
        UPDATE users
        SET password_hash = ?, must_change_pwd = 1, temporary_password_expires_at = ?,
            session_version = session_version + 1, updated_at = ?
        WHERE id = ?
        """,
        (hash_password(plain_password), _temporary_password_expiry(), now_iso(), user_id),
    )
    db.commit()
    invalidate_user(user_id)
    updated = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    response.headers["Cache-Control"] = "private, no-store"
    return {"user": _serialize_user(updated), "plain_password": plain_password}


@router.delete("/admin/users/{user_id}")
def delete_user(
    user_id: int,
    admin: sqlite3.Row = Depends(require_system_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, bool]:
    """删除用户（系统管理员）"""
    if user_id == int(admin["id"]):
        raise HTTPException(400, "不能删除当前登录用户")
    
    target = db.execute("SELECT role FROM users WHERE id = ?", (user_id,)).fetchone()
    if target is not None and target["role"] == ROLE_SYSTEM_ADMIN and not is_system_admin(admin):
        raise HTTPException(403, "只有系统管理员能删除系统管理员账号")
    
    try:
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        invalidate_user(user_id)
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "该用户关联了资源、放映、下载记录或任务等数据，无法直接删除。请先转移或删除相关数据后再试。") from None
    return {"ok": True}


@router.post("/admin/users/bulk-delete")
def bulk_delete_users(
    payload: UserDeletePayload,
    admin: sqlite3.Row = Depends(require_system_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """批量删除用户（系统管理员）"""
    user_ids = sorted({int(uid) for uid in payload.user_ids if int(uid) > 0})
    if not user_ids:
        raise HTTPException(400, "请选择要删除的用户")
    
    current_user_id = int(admin["id"])
    if current_user_id in user_ids:
        raise HTTPException(400, "不能删除当前登录用户")
    
    placeholders = ",".join("?" for _ in user_ids)
    rows = db.execute(f"SELECT id FROM users WHERE id IN ({placeholders})", user_ids).fetchall()
    
    if not rows:
        raise HTTPException(404, "未找到可删除的用户")
    
    deleted_ids = [int(row["id"]) for row in rows]
    try:
        db.execute(f"DELETE FROM users WHERE id IN ({placeholders})", user_ids)
        for uid in deleted_ids:
            invalidate_user(uid)
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "部分用户关联了资源、放映、下载记录或任务等数据，无法直接删除。请先转移或删除相关数据后再试。") from None
    
    return {"ok": True, "deleted_ids": deleted_ids, "count": len(deleted_ids)}


@router.post("/admin/users/{user_id}/transfer-and-delete")
def transfer_and_delete_user(
    user_id: int,
    payload: UserTransferDeletePayload,
    admin: sqlite3.Row = Depends(require_system_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """将用户关联数据转移给目标用户后删除该用户"""
    if user_id == int(admin["id"]):
        raise HTTPException(400, "不能删除当前登录用户")
    if user_id == payload.target_user_id:
        raise HTTPException(400, "不能将数据转移给自己")

    # 验证源用户存在
    source = db.execute("SELECT role FROM users WHERE id = ?", (user_id,)).fetchone()
    if source is None:
        raise HTTPException(404, "源用户不存在")
    if source["role"] == ROLE_SYSTEM_ADMIN and not is_system_admin(admin):
        raise HTTPException(403, "只有系统管理员能删除系统管理员账号")

    # 验证目标用户存在
    target = db.execute("SELECT id FROM users WHERE id = ?", (payload.target_user_id,)).fetchone()
    if target is None:
        raise HTTPException(404, "目标用户不存在")

    tid = payload.target_user_id

    # 转移所有权字段
    _transfer_tables = [
        ("resources", "owner_id"),
        ("resources", "updated_by"),
        ("resource_versions", "created_by"),
        # Share-link audit ownership must move with the resource owner;
        # otherwise the FK would block transfer-and-delete and active links
        # would be left without an accountable creator.
        ("resource_share_tokens", "created_by"),
        ("templates", "owner_id"),
        ("fonts", "uploaded_by"),
        ("shows", "owner_id"),
        ("shows", "updated_by"),
        ("tasks", "owner_id"),
    ]
    for table, col in _transfer_tables:
        db.execute(f"UPDATE {table} SET {col} = ? WHERE {col} = ?", (tid, user_id))

    # 下载记录保留，但解除用户关联
    db.execute("UPDATE download_records SET user_id = NULL WHERE user_id = ?", (user_id,))

    # 删除用户（关联的 visibility/management/preferences/pinned 表会级联删除）
    try:
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        invalidate_user(user_id)
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "数据转移后仍无法删除用户，请联系技术支持。") from None

    return {"ok": True}
