"""
飞书开放平台 API 封装
处理 OAuth2 授权码流程中的令牌交换和用户信息获取
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)

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
        msg = data.get("msg", "未知错误")
        logger.error("飞书 %s 失败: code=%s msg=%s", action, code, msg)
        raise FeishuAPIError(code, msg)


def get_tenant_access_token(app_id: str, app_secret: str) -> str:
    """获取 tenant_access_token（应用级别令牌）"""
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
    access_token = token_data.get("access_token")
    if not access_token:
        raise FeishuAPIError(-1, "响应中缺少 user_access_token")
    return access_token


def get_user_info(user_access_token: str) -> FeishuUserInfo:
    """获取当前授权用户的基本信息"""
    url = f"{FEISHU_BASE}/authen/v1/user_info"
    headers = {"Authorization": f"Bearer {user_access_token}"}
    resp = httpx.get(url, headers=headers, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    _check_response(data, "get_user_info")
    user_data = data.get("data", {})
    open_id = user_data.get("open_id", "")
    if not open_id:
        raise FeishuAPIError(-1, "响应中缺少 open_id")
    return FeishuUserInfo(
        open_id=open_id,
        name=user_data.get("name", "") or open_id,
        avatar_url=user_data.get("avatar_url", ""),
        tenant_key=user_data.get("tenant_key", ""),
    )
