"""
飞书 SSO 认证路由
处理飞书 OAuth2 回调和公开配置查询
"""
import logging
import re
import secrets
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from app.config import settings
from app.core.feishu import (
    FeishuAPIError,
    FeishuUserInfo,
    get_tenant_access_token,
    get_user_access_token,
    get_user_info,
)
from app.core.security import create_session_token, hash_password
from app.db import now_iso
from app.routers.dependencies import ApiPayload, SESSION_COOKIE, _serialize_user, db_dep

logger = logging.getLogger(__name__)

router = APIRouter()


class FeishuCallbackPayload(ApiPayload):
    code: str


def _sanitize_username(name: str) -> str:
    """将飞书用户名转为安全的系统用户名（仅保留中英文、数字、下划线）"""
    safe = re.sub(r"[^\w\u4e00-\u9fff]", "", name)
    return safe or "feishu_user"


def _resolve_feishu_username(feishu_user: FeishuUserInfo) -> str:
    """确定飞书用户的系统用户名。

    优先取企业邮箱前缀作为真实账号（如 someone@example.com -> someone），
    未开通邮箱字段权限或邮箱为空时退回姓名清洗后的值。
    """
    if feishu_user.enterprise_email:
        local_part = feishu_user.enterprise_email.split("@")[0].strip()
        if local_part:
            return _sanitize_username(local_part)
        logger.warning("飞书企业邮箱格式异常（%s），降级使用姓名作为用户名: %s",
                       feishu_user.enterprise_email, feishu_user.name)
    else:
        logger.warning("飞书未返回企业邮箱，降级使用姓名作为用户名: %s", feishu_user.name)
    return _sanitize_username(feishu_user.name)


def _unique_username(db: sqlite3.Connection, base: str) -> str:
    """确保用户名不重复，必要时追加数字后缀。

    为避免极端场景下出现无限循环（如同名账号量异常增长、查询错误等），
    限制顺序探测的最大次数，超过后使用随机后缀兑底。
    """
    candidate = base
    suffix = 1
    max_attempts = 1000
    while db.execute("SELECT 1 FROM users WHERE username = ?", (candidate,)).fetchone():
        candidate = f"{base}_{suffix}"
        suffix += 1
        if suffix > max_attempts:
            # 使用随机后缀趋近唯一，防止无限循环
            candidate = f"{base}_{secrets.token_hex(4)}"
            break
    return candidate


@router.get("/auth/feishu/config")
def feishu_sso_config() -> dict[str, Any]:
    """返回飞书 SSO 公开配置（无需登录）"""
    return {
        "enabled": settings.feishu_sso_enabled,
        "app_id": settings.feishu_app_id if settings.feishu_sso_enabled else "",
    }


@router.post("/auth/feishu/callback")
def feishu_sso_callback(
    payload: FeishuCallbackPayload,
    response: Response,
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """飞书 OAuth2 回调：用授权码换取用户信息并完成登录"""
    if not settings.feishu_sso_enabled:
        raise HTTPException(403, "飞书 SSO 未启用")

    app_id = settings.feishu_app_id
    app_secret = settings.feishu_app_secret
    if not app_id or not app_secret:
        raise HTTPException(500, "飞书应用配置不完整，请联系管理员")

    # 1. 获取 tenant_access_token
    try:
        tenant_token = get_tenant_access_token(app_id, app_secret)
    except FeishuAPIError as e:
        logger.warning("获取 tenant_access_token 失败: %s", e)
        raise HTTPException(502, f"飞书认证失败：{e.msg}")

    # 2. 用授权码换取 user_access_token
    try:
        user_token = get_user_access_token(tenant_token, payload.code)
    except FeishuAPIError as e:
        logger.warning("获取 user_access_token 失败: code=%s, msg=%s", e.code, e.msg)
        raise HTTPException(401, f"飞书授权码无效或已过期：[{e.code}] {e.msg}")

    # 3. 获取飞书用户信息
    try:
        feishu_user = get_user_info(user_token)
    except FeishuAPIError as e:
        logger.warning("获取飞书用户信息失败: %s", e)
        raise HTTPException(502, f"获取飞书用户信息失败：{e.msg}")

    # 4. 在数据库中通过 feishu_id（open_id）查找用户
    user = db.execute(
        "SELECT * FROM users WHERE feishu_id = ?", (feishu_user.open_id,)
    ).fetchone()

    if user is None:
        # 5. 未找到则自动创建用户
        ts = now_iso()
        base_username = _resolve_feishu_username(feishu_user)
        username = _unique_username(db, base_username)
        # 使用随机密码（飞书 SSO 用户不通过密码登录）
        random_pwd = hash_password(secrets.token_urlsafe(16))
        try:
            db.execute(
                """
                INSERT INTO users (name, username, password_hash, feishu_id, role, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'user', ?, ?)
                """,
                (feishu_user.name, username, random_pwd, feishu_user.open_id, ts, ts),
            )
            db.commit()
            user = db.execute(
                "SELECT * FROM users WHERE feishu_id = ?", (feishu_user.open_id,)
            ).fetchone()
        except sqlite3.IntegrityError:
            # 并发请求可能同时创建同一个 feishu_id/username 的用户，
            # 被 UNIQUE 约束拦截后重新查询已被其他请求创建的记录
            db.rollback()
            user = db.execute(
                "SELECT * FROM users WHERE feishu_id = ?", (feishu_user.open_id,)
            ).fetchone()
            if user is None:
                raise HTTPException(500, "飞书用户创建失败，请重试")
        # 避免在 INFO 日志中完整记录 open_id，仅保留尾部 8 位以供审计追踪
        masked = feishu_user.open_id[-8:] if feishu_user.open_id else ""
        logger.info("飞书 SSO 自动创建用户: %s (id=...%s)", feishu_user.name, masked)

    # 6. 创建 session cookie
    token = create_session_token(
        int(user["id"]),
        settings.secret_key,
        ttl_seconds=settings.session_ttl_hours * 3600,
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
