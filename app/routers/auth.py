"""
认证路由模块
处理登录、登出、用户信息等
"""
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response

from app.core.permissions import require_user
from app.core.security import create_session_token, verify_password
from app.db import now_iso
from app.routers.dependencies import (
    LoginPayload,
    UserPreferencesPayload,
    SESSION_COOKIE,
    _serialize_user,
    db_dep,
)
from app.config import settings


router = APIRouter()


@router.post("/auth/login")
def login(
    payload: LoginPayload,
    response: Response,
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """用户登录"""
    user = db.execute("SELECT * FROM users WHERE username = ?", (payload.username,)).fetchone()
    if user is None or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(401, "用户名或密码错误")
    
    token = create_session_token(
        int(user["id"]),
        settings.secret_key,
        ttl_seconds=settings.session_ttl_hours * 3600
    )
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        max_age=settings.session_ttl_hours * 3600,
    )
    return {"user": _serialize_user(user)}


@router.post("/auth/logout")
def logout(response: Response) -> dict[str, bool]:
    """用户登出"""
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


@router.get("/me")
def me(user: sqlite3.Row = Depends(require_user)) -> dict[str, Any]:
    """获取当前登录用户信息"""
    return {"user": _serialize_user(user)}


@router.get("/auth/verify-offline")
def verify_offline_login(
    token: str,
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """验证离线登录 token"""
    from app.core.security import verify_present_token
    
    data = verify_present_token(token, settings.secret_key)
    if not data:
        raise HTTPException(401, "无效的离线 token")
    
    user_id = data.get("user_id")
    if not user_id:
        raise HTTPException(401, "token 中缺少用户 ID")
    
    user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not user:
        raise HTTPException(401, "用户不存在")
    
    return {"user": _serialize_user(user)}


@router.get("/user/preferences")
def get_user_preferences(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """获取用户偏好设置"""
    rows = db.execute(
        "SELECT pref_key, pref_value FROM user_preferences WHERE user_id = ?",
        (int(user["id"]),),
    ).fetchall()
    preferences: dict[str, str] = {}
    for row in rows:
        preferences[row["pref_key"]] = row["pref_value"]
    return {"preferences": preferences}


@router.put("/user/preferences")
def update_user_preferences(
    payload: UserPreferencesPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """更新用户偏好设置"""
    user_id = int(user["id"])
    ts = now_iso()
    for key, value in payload.preferences.items():
        db.execute(
            """
            INSERT INTO user_preferences (user_id, pref_key, pref_value, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, pref_key) DO UPDATE SET
                pref_value = excluded.pref_value,
                updated_at = excluded.updated_at
            """,
            (user_id, key, value, ts),
        )
    db.commit()
    return get_user_preferences(user, db)
