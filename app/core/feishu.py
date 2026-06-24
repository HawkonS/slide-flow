"""
飞书开放平台 API 封装
处理 OAuth2 授权码流程中的令牌交换和用户信息获取
"""
from __future__ import annotations

import logging
import subprocess
import sys
from dataclasses import dataclass

logger = logging.getLogger(__name__)


def _ensure_httpx():
    """确保 httpx 已安装，缺失时自动安装"""
    try:
        import httpx
        return httpx
    except ImportError:
        logger.info("httpx 未安装，正在自动安装...")
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "httpx>=0.27"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            import httpx
            logger.info("httpx 自动安装成功")
            return httpx
        except Exception as e:
            logger.warning("httpx 自动安装失败: %s，飞书 SSO 功能不可用", e)
            return None


httpx = _ensure_httpx()

FEISHU_BASE = "https://open.feishu.cn/open-apis"


class FeishuAPIError(Exception):
    """飞书 API 调用异常"""
    def __init__(self, code: int, msg: str):
        self.code = code
        self.msg = msg
        super().__init__(f"飞书 API 错误 [{code}]: {msg}")


@dataclass
class FeishuUserInfo:
    """飞书用户信息"""
    open_id: str
    name: str
    avatar_url: str
    tenant_key: str


def _check_response(data: dict, action: str) -> None:
    """检查飞书 API 响应的 code 字段"""
    code = data.get("code", -1)
    if code != 0:
        msg = data.get("msg", "") or data.get("error_description", "") or "未知错误"
        error = data.get("error", "")
        detail = f"{msg}" + (f" (error={error})" if error else "")
        logger.error("飞书 %s 失败: code=%s detail=%s response=%s", action, code, detail, data)
        raise FeishuAPIError(code, detail)


def _require_httpx() -> None:
    """确保 httpx 可用，不可用时抛出明确异常"""
    if httpx is None:
        raise FeishuAPIError(-1, "httpx 依赖未安装，飞书 SSO 功能不可用。请运行: pip install httpx")


def get_tenant_access_token(app_id: str, app_secret: str) -> str:
    """获取 tenant_access_token（应用级别令牌）"""
    _require_httpx()
    url = f"{FEISHU_BASE}/auth/v3/tenant_access_token/internal"
    resp = httpx.post(url, json={"app_id": app_id, "app_secret": app_secret}, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    _check_response(data, "get_tenant_access_token")
    token = data.get("tenant_access_token")
    if not token:
        raise FeishuAPIError(-1, "响应中缺少 tenant_access_token")
    return token


def get_user_access_token(app_access_token: str, code: str) -> str:
    """
    用授权码换取 user_access_token。
    此处使用 app_access_token（通过 tenant_access_token 接口获取）来调用。
    """
    _require_httpx()
    url = f"{FEISHU_BASE}/authen/v1/oidc/access_token"
    headers = {"Authorization": f"Bearer {app_access_token}"}
    resp = httpx.post(
        url,
        json={"grant_type": "authorization_code", "code": code},
        headers=headers,
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    _check_response(data, "get_user_access_token")
    token_data = data.get("data", {})
    if not isinstance(token_data, dict):
        raise FeishuAPIError(-1, "飞书 API 返回格式错误：data 字段不是对象")
    access_token = token_data.get("access_token")
    if not access_token:
        raise FeishuAPIError(-1, "响应中缺少 user_access_token")
    return access_token


def get_user_info(user_access_token: str) -> FeishuUserInfo:
    """获取当前授权用户的基本信息"""
    _require_httpx()
    url = f"{FEISHU_BASE}/authen/v1/user_info"
    headers = {"Authorization": f"Bearer {user_access_token}"}
    resp = httpx.get(url, headers=headers, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    _check_response(data, "get_user_info")
    user_data = data.get("data", {})
    if not isinstance(user_data, dict):
        raise FeishuAPIError(-1, "飞书 API 返回格式错误：data 字段不是对象")
    open_id = user_data.get("open_id", "")
    if not open_id:
        raise FeishuAPIError(-1, "响应中缺少 open_id")
    return FeishuUserInfo(
        open_id=open_id,
        name=user_data.get("name", "") or open_id,
        avatar_url=user_data.get("avatar_url", ""),
        tenant_key=user_data.get("tenant_key", ""),
    )
