"""
认证路由模块
处理登录、登出、用户信息等
"""
import sqlite3
import time
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response

from app.core.permissions import can_view_show, require_user
from app.core.security import create_session_token, hash_password, verify_password
from app.db import now_iso
from app.routers.dependencies import (
    ChangePasswordPayload,
    LoginPayload,
    OfflineVerifyPayload,
    UserPreferencesPayload,
    SESSION_COOKIE,
    _serialize_user,
    db_dep,
)
from app.config import settings


router = APIRouter()


# ==================== 登录频率限制 ====================

_LOGIN_MAX_FAILS = 10      # 1 分钟内最多失败次数
_LOGIN_WINDOW = 60         # 秒，失败计数窗口
_LOGIN_BAN_DURATION = 300  # 秒，封禁时长（5 分钟）
_DUMMY_PASSWORD_HASH = hash_password("slide-flow-invalid-login-password")


def _get_client_ip(request: Request) -> str:
    """获取连接对端 IP。

    不直接信任客户端提交的 X-Forwarded-For，否则攻击者可伪造来源 IP 绕过限流。
    若部署在反向代理之后，应在代理层限制并覆盖来源地址。
    """
    return request.client.host if request.client else "unknown"


def _normalise_username(username: str) -> str:
    return username.strip().casefold()


def _check_login_rate_limit(
    db: sqlite3.Connection, ip: str, username_key: str
) -> tuple[bool, int]:
    """检查 IP 和用户名是否处于临时封禁中，返回 (允许, 最大剩余秒数)。"""
    now = time.time()
    remaining = 0
    for key in (f"ip:{ip}", f"user:{username_key}"):
        record = db.execute(
            "SELECT locked_until, window_started_at FROM auth_login_attempts WHERE key = ?",
            (key,),
        ).fetchone()
        if record is None:
            continue
        locked_until = float(record["locked_until"] or 0)
        if locked_until > now:
            remaining = max(remaining, int(locked_until - now + 0.999))
    return remaining == 0, remaining


def _record_login_failure(db: sqlite3.Connection, ip: str, username_key: str) -> None:
    """在 SQLite 中原子记录一次 IP 和用户名失败。"""
    now = time.time()
    if db.in_transaction:
        db.commit()
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute(
            "DELETE FROM auth_login_attempts WHERE updated_at < ?",
            (now - _LOGIN_BAN_DURATION - _LOGIN_WINDOW,),
        )
        for key in (f"ip:{ip}", f"user:{username_key}"):
            record = db.execute(
                "SELECT failure_count, window_started_at, locked_until FROM auth_login_attempts WHERE key = ?",
                (key,),
            ).fetchone()
            if record is None or now - float(record["window_started_at"]) > _LOGIN_WINDOW:
                count = 1
                locked_until = 0.0
                window_started = now
            else:
                count = int(record["failure_count"]) + 1
                window_started = float(record["window_started_at"])
                locked_until = float(record["locked_until"] or 0)
                if count >= _LOGIN_MAX_FAILS:
                    locked_until = max(locked_until, now + _LOGIN_BAN_DURATION)
            db.execute(
                """
                INSERT INTO auth_login_attempts
                    (key, failure_count, window_started_at, locked_until, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    failure_count = excluded.failure_count,
                    window_started_at = excluded.window_started_at,
                    locked_until = excluded.locked_until,
                    updated_at = excluded.updated_at
                """,
                (key, count, window_started, locked_until, now),
            )
        db.commit()
    except Exception:
        db.rollback()
        raise


def _clear_login_failures(db: sqlite3.Connection, username_key: str) -> None:
    """登录成功后只清除该用户名的失败记录，不重置 IP 全局计数。"""
    db.execute("DELETE FROM auth_login_attempts WHERE key = ?", (f"user:{username_key}",))
    db.commit()


@router.post("/auth/login")
def login(
    payload: LoginPayload,
    request: Request,
    response: Response,
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """用户登录"""
    ip = _get_client_ip(request)
    username = payload.username.strip()
    username_key = _normalise_username(username)
    allowed, retry_after = _check_login_rate_limit(db, ip, username_key)
    if not allowed:
        raise HTTPException(
            429,
            "登录失败次数过多，请稍后重试",
            headers={"Retry-After": str(max(1, retry_after))},
        )

    user = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    # 即使用户名不存在也执行一次 PBKDF2，降低用户名枚举的时间差异。
    password_hash = user["password_hash"] if user is not None else _DUMMY_PASSWORD_HASH
    password_ok = verify_password(payload.password, password_hash)
    if user is None or not password_ok:
        _record_login_failure(db, ip, username_key)
        raise HTTPException(401, "用户名或密码错误")
    
    _clear_login_failures(db, username_key)
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
@router.post("/auth/verify-offline")
def verify_offline_login(
    request: Request,
    token: str | None = Query(None),
    payload: OfflineVerifyPayload | None = Body(None),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """验证离线 token，或验证在线用户对放映的访问密码。"""
    from app.core.security import verify_present_token

    if payload is not None:
        ip = _get_client_ip(request)
        username = payload.username.strip()
        username_key = _normalise_username(username)
        allowed, retry_after = _check_login_rate_limit(db, ip, username_key)
        if not allowed:
            raise HTTPException(429, "验证失败次数过多，请稍后重试", headers={"Retry-After": str(max(1, retry_after))})
        user = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        password_hash = user["password_hash"] if user is not None else _DUMMY_PASSWORD_HASH
        password_ok = verify_password(payload.password, password_hash)
        show = db.execute("SELECT * FROM shows WHERE id = ?", (payload.show_id,)).fetchone()
        if user is None or not password_ok or show is None or not can_view_show(db, show, user):
            _record_login_failure(db, ip, username_key)
            return {"success": False}
        _clear_login_failures(db, username_key)
        return {"success": True}
    
    data = verify_present_token(token or "", settings.secret_key)
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
