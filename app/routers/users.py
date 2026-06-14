"""
用户管理路由模块
处理管理员对用户的 CRUD 操作
"""
import sqlite3
import secrets
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.permissions import (
    ADMIN_ROLES,
    ROLE_ADMIN,
    ROLE_SUPER_ADMIN,
    ROLE_USER,
    require_admin,
    require_super_admin,
    is_super_admin,
)
from app.core.security import hash_password
from app.config import settings
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


@router.get("/admin/users")
def list_users(
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """获取用户列表（管理员）"""
    rows = db.execute("SELECT * FROM users ORDER BY id").fetchall()
    return {"users": [_serialize_user(row) for row in rows]}


@router.get("/users/options")
def user_options(
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """获取用户选项列表（用于下拉选择）"""
    rows = db.execute("SELECT id, name, username, role FROM users ORDER BY role, name").fetchall()
    return {"users": [_row_to_dict(row) for row in rows]}


@router.post("/admin/users")
def create_user(
    payload: UserPayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """创建新用户（管理员）"""
    if payload.role not in {ROLE_SUPER_ADMIN, ROLE_ADMIN, ROLE_USER}:
        raise HTTPException(400, "角色不正确")
    if payload.role == ROLE_SUPER_ADMIN and not is_super_admin(admin):
        raise HTTPException(403, "只有超级管理员能创建超级管理员")

    # 确定密码和是否需要强制修改
    must_change_pwd = 0
    plain_password: str | None = None
    if payload.need_change_pwd:
        # 生成随机密码，首次登录强制修改
        password = secrets.token_urlsafe(16)
        plain_password = password
        must_change_pwd = 1
    elif payload.password:
        password = payload.password
    else:
        password = settings.default_password
    
    ts = now_iso()
    try:
        db.execute(
            """
            INSERT INTO users (name, username, password_hash, feishu_id, role, must_change_pwd, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (payload.name, payload.username, hash_password(password), payload.feishu_id, payload.role, must_change_pwd, ts, ts),
        )
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "用户名已存在") from None
    
    user = db.execute("SELECT * FROM users WHERE username = ?", (payload.username,)).fetchone()
    resp: dict[str, Any] = {"user": _serialize_user(user)}
    if plain_password:
        resp["plain_password"] = plain_password
    return resp


@router.put("/admin/users/{user_id}")
def update_user(
    user_id: int,
    payload: UserPayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """更新用户信息（管理员）"""
    if payload.role not in {ROLE_SUPER_ADMIN, ROLE_ADMIN, ROLE_USER}:
        raise HTTPException(400, "角色不正确")
    
    existing = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if existing is None:
        raise HTTPException(404, "用户不存在")
    
    # 超级管理员的身份只能由超级管理员授予/撤销
    if not is_super_admin(admin):
        if existing["role"] == ROLE_SUPER_ADMIN:
            raise HTTPException(403, "只有超级管理员能修改超级管理员账号")
        if payload.role == ROLE_SUPER_ADMIN:
            raise HTTPException(403, "只有超级管理员能授予超级管理员角色")
    
    if int(existing["id"]) == int(admin["id"]) and payload.role not in ADMIN_ROLES:
        raise HTTPException(400, "不能取消自己的管理员角色")
    
    if (
        int(existing["id"]) == int(admin["id"])
        and existing["role"] == ROLE_SUPER_ADMIN
        and payload.role != ROLE_SUPER_ADMIN
    ):
        raise HTTPException(400, "不能取消自己的超级管理员角色")
    
    fields: list[Any] = [payload.name, payload.username, payload.feishu_id, payload.role, now_iso()]
    sql = "UPDATE users SET name = ?, username = ?, feishu_id = ?, role = ?, updated_at = ?"
    
    if payload.password:
        sql += ", password_hash = ?"
        fields.append(hash_password(payload.password))
    
    sql += " WHERE id = ?"
    fields.append(user_id)
    
    try:
        db.execute(sql, fields)
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "用户名已存在") from None
    
    user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return {"user": _serialize_user(user)}


@router.delete("/admin/users/{user_id}")
def delete_user(
    user_id: int,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, bool]:
    """删除用户（管理员）"""
    if user_id == int(admin["id"]):
        raise HTTPException(400, "不能删除当前登录用户")
    
    target = db.execute("SELECT role FROM users WHERE id = ?", (user_id,)).fetchone()
    if target is not None and target["role"] == ROLE_SUPER_ADMIN and not is_super_admin(admin):
        raise HTTPException(403, "只有超级管理员能删除超级管理员账号")
    
    try:
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "该用户关联了资源、放映、下载记录或任务等数据，无法直接删除。请先转移或删除相关数据后再试。") from None
    return {"ok": True}


@router.post("/admin/users/bulk-delete")
def bulk_delete_users(
    payload: UserDeletePayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """批量删除用户（管理员）"""
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
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "部分用户关联了资源、放映、下载记录或任务等数据，无法直接删除。请先转移或删除相关数据后再试。") from None
    
    return {"ok": True, "deleted_ids": deleted_ids, "count": len(deleted_ids)}


@router.post("/admin/users/{user_id}/transfer-and-delete")
def transfer_and_delete_user(
    user_id: int,
    payload: UserTransferDeletePayload,
    admin: sqlite3.Row = Depends(require_admin),
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
    if source["role"] == ROLE_SUPER_ADMIN and not is_super_admin(admin):
        raise HTTPException(403, "只有超级管理员能删除超级管理员账号")

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
        ("templates", "owner_id"),
        ("fonts", "uploaded_by"),
        ("shows", "owner_id"),
        ("shows", "updated_by"),
        ("links", "owner_id"),
        ("tasks", "owner_id"),
    ]
    for table, col in _transfer_tables:
        db.execute(f"UPDATE {table} SET {col} = ? WHERE {col} = ?", (tid, user_id))

    # 下载记录保留，但解除用户关联
    db.execute("UPDATE download_records SET user_id = NULL WHERE user_id = ?", (user_id,))

    # 删除用户（关联的 visibility/management/preferences/pinned 表会级联删除）
    try:
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "数据转移后仍无法删除用户，请联系技术支持。") from None

    return {"ok": True}
