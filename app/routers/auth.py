"""
认证路由模块
处理登录、登出、用户信息等
"""
import sqlite3
import time
import threading
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app.core.permissions import require_user
from app.core.security import create_session_token, hash_password, verify_password
from app.db import now_iso
from app.routers.dependencies import (
    ChangePasswordPayload,
    LoginPayload,
    UserPreferencesPayload,
    SESSION_COOKIE,
    _serialize_user,
    db_dep,
)
from app.config import settings


router = APIRouter()


# ==================== 登录频率限制 ====================

_login_attempts: dict[str, dict] = {}  # {ip: {"fail_count": int, "window_start": float, "ban_until": float}}
_login_lock = threading.Lock()
_LOGIN_MAX_FAILS = 10      # 1 分钟内最多失败次数
_LOGIN_WINDOW = 60         # 秒，失败计数窗口
_LOGIN_BAN_DURATION = 300  # 秒，封禁时长（5 分钟）


def _get_client_ip(request: Request) -> str:
    """提取客户端真实 IP，支持反向代理"""
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_login_rate_limit(ip: str) -> tuple[bool, str]:
    """检查是否被限流。返回 (True=允许, 原因说明)"""
    now = time.time()
    with _login_lock:
        record = _login_attempts.get(ip)
        if record is None:
            return True, ""
        # 封禁期内
        if record.get("ban_until", 0) > now:
            remaining = int(record["ban_until"] - now)
            return False, f"登录失败次数过多，请 {remaining} 秒后重试"
        # 计数窗口已过期，重置
        if now - record.get("window_start", now) > _LOGIN_WINDOW:
            record["fail_count"] = 0
            record["window_start"] = now
        return True, ""


def _record_login_failure(ip: str) -> None:
    """记录一次登录失败"""
    now = time.time()
    with _login_lock:
        record = _login_attempts.get(ip)
        if record is None or now - record.get("window_start", now) > _LOGIN_WINDOW:
            _login_attempts[ip] = {"fail_count": 1, "window_start": now, "ban_until": 0.0}
        else:
            record["fail_count"] += 1
            if record["fail_count"] >= _LOGIN_MAX_FAILS:
                record["ban_until"] = now + _LOGIN_BAN_DURATION


def _clear_login_failures(ip: str) -> None:
    """登录成功后清除失败记录"""
    with _login_lock:
        _login_attempts.pop(ip, None)


@router.post("/auth/login")
def login(
    payload: LoginPayload,
    request: Request,
    response: Response,
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """用户登录"""
    ip = _get_client_ip(request)
    allowed, reason = _check_login_rate_limit(ip)
    if not allowed:
        raise HTTPException(429, reason)

    user = db.execute("SELECT * FROM users WHERE username = ?", (payload.username,)).fetchone()
    if user is None or not verify_password(payload.password, user["password_hash"]):
        _record_login_failure(ip)
        raise HTTPException(401, "用户名或密码错误")
    
    _clear_login_failures(ip)
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
        secure=settings.web_https,
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


@router.put("/auth/change-password")
def change_password(
    payload: ChangePasswordPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """修改当前用户密码"""
    if not verify_password(payload.old_password, user["password_hash"]):
        raise HTTPException(400, "原密码不正确")
    if len(payload.new_password) < 6:
        raise HTTPException(400, "新密码长度不能少于 6 位")
    user_id = int(user["id"])
    ts = now_iso()
    db.execute(
        "UPDATE users SET password_hash = ?, must_change_pwd = 0, updated_at = ? WHERE id = ?",
        (hash_password(payload.new_password), ts, user_id),
    )
    db.commit()
    updated = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return {"user": _serialize_user(updated)}
