"""
用户管理路由模块
处理管理员对用户的 CRUD 操作
"""
import sqlite3
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
from app.db import now_iso
from app.routers.dependencies import (
    UserPayload,
    UserDeletePayload,
    db_dep,
    _serialize_user,
    _row_to_dict,
)


router = APIRouter()


@router.get("/admin/users")
def list_users(
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """获取用户列表（管理员）"""
    rows = db.execute("SELECT * FROM users ORDER BY id").fetchall()
    return {"users": [_serialize_user(row) for row in rows]}


@router.get("/users/options")
def user_options(
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
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
    if not payload.password:
        raise HTTPException(400, "新用户需要设置密码")
    
    ts = now_iso()
    try:
        db.execute(
            """
            INSERT INTO users (name, username, password_hash, feishu_id, role, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (payload.name, payload.username, hash_password(payload.password), payload.feishu_id, payload.role, ts, ts),
        )
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "用户名已存在") from None
    
    user = db.execute("SELECT * FROM users WHERE username = ?", (payload.username,)).fetchone()
    return {"user": _serialize_user(user)}


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
    
    db.execute("DELETE FROM users WHERE id = ?", (user_id,))
    db.commit()
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
    db.execute(f"DELETE FROM users WHERE id IN ({placeholders})", user_ids)
    db.commit()
    
    return {"ok": True, "deleted_ids": deleted_ids, "count": len(deleted_ids)}
