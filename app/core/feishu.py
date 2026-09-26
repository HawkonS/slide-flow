"""
飞书开放平台 API 封装
处理 OAuth2 授权码流程中的令牌交换和用户信息获取
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

logger = logging.getLogger(__name__)


def _ensure_httpx():
    """Import the declared HTTP dependency without mutating the runtime."""
    try:
        import httpx
        return httpx
    except ImportError:
        logger.error("httpx 依赖未安装，飞书 SSO 功能不可用")
        return None


httpx = _ensure_httpx()

FEISHU_BASE = "https://open.feishu.cn/open-apis"
FEISHU_CONTACT_PAGE_SIZE = 50
FEISHU_CONTACT_MAX_PAGES = 1000

# 模块级共享连接池：飞书 API 调用复用 TCP/TLS 连接。
# 顶层 httpx.post/get 每次都会新建连接并重新握手，网络不佳时
# 单次握手可达数百毫秒，登录链路上的多次调用会明显放大耗时。
_client = None
_client_lock = threading.Lock()


def _get_client():
    """获取共享 httpx.Client，httpx 不可用时返回 None"""
    global _client
    if httpx is None:
        return None
    with _client_lock:
        if _client is None:
            _client = httpx.Client(timeout=10)
        return _client


# tenant_access_token 缓存：{app_id: (token, 过期时间戳)}
_tenant_token_cache: dict[str, tuple[str, float]] = {}
# 飞书返回的 expire 通常为 7200s，提前 5 分钟失效，避免用到临界过期 token
_TENANT_TOKEN_MARGIN_SECONDS = 300


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
    # 企业邮箱（如 someone@example.com），邮箱前缀即真实账号，
    # 需应用开通 contact:user.employee:readonly 权限，未开通时为空
    enterprise_email: str = ""


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


def _request(method: str, url: str, retry: bool = False, **kwargs):
    """发送飞书 API 请求；retry=True 时网络错误（超时/断连）自动重试一次。

    注意：retry 仅适用于幂等请求（获取 tenant token、查询用户信息）。
    授权码换 token 是一次性凭证，失败后不能重试。
    """
    _require_httpx()
    client = _get_client()
    attempts = 2 if retry else 1
    last_exc: Exception | None = None
    for attempt in range(attempts):
        try:
            resp = client.request(method, url, **kwargs)
            resp.raise_for_status()
            return resp
        except (httpx.TimeoutException, httpx.TransportError) as e:
            last_exc = e
            logger.warning("飞书 API 请求 %s %s 失败 (第 %d/%d 次): %s",
                           method, url, attempt + 1, attempts, e)
    raise FeishuAPIError(-1, f"连接飞书开放平台超时: {last_exc}")


def get_tenant_access_token(app_id: str, app_secret: str) -> str:
    """获取 tenant_access_token（应用级别令牌），带内存缓存（飞书签发有效期约 2 小时）"""
    cached = _tenant_token_cache.get(app_id)
    if cached and cached[1] > time.time():
        return cached[0]
    url = f"{FEISHU_BASE}/auth/v3/tenant_access_token/internal"
    resp = _request("POST", url, retry=True,
                    json={"app_id": app_id, "app_secret": app_secret})
    data = resp.json()
    _check_response(data, "get_tenant_access_token")
    token = data.get("tenant_access_token")
    if not token:
        raise FeishuAPIError(-1, "响应中缺少 tenant_access_token")
    expire = int(data.get("expire") or 0)
    if expire > _TENANT_TOKEN_MARGIN_SECONDS:
        _tenant_token_cache[app_id] = (token, time.time() + expire - _TENANT_TOKEN_MARGIN_SECONDS)
    return token


def get_user_access_token(app_access_token: str, code: str) -> str:
    """
    用授权码换取 user_access_token。
    此处使用 app_access_token（通过 tenant_access_token 接口获取）来调用。
    """
    url = f"{FEISHU_BASE}/authen/v1/oidc/access_token"
    headers = {"Authorization": f"Bearer {app_access_token}"}
    # 授权码为一次性凭证，网络错误时不可重试
    resp = _request(
        "POST",
        url,
        json={"grant_type": "authorization_code", "code": code},
        headers=headers,
    )
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
    url = f"{FEISHU_BASE}/authen/v1/user_info"
    headers = {"Authorization": f"Bearer {user_access_token}"}
    resp = _request("GET", url, retry=True, headers=headers)
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
        enterprise_email=user_data.get("enterprise_email", "") or "",
    )


def _list_contact_items(
    tenant_access_token: str,
    path: str,
    *,
    params: dict[str, object],
    action: str,
) -> list[dict]:
    """Read every page from a Feishu Contact v3 list endpoint."""
    headers = {"Authorization": f"Bearer {tenant_access_token}"}
    page_token = ""
    items: list[dict] = []
    for _ in range(FEISHU_CONTACT_MAX_PAGES):
        request_params = {**params, "page_size": FEISHU_CONTACT_PAGE_SIZE}
        if page_token:
            request_params["page_token"] = page_token
        resp = _request(
            "GET",
            f"{FEISHU_BASE}{path}",
            retry=True,
            headers=headers,
            params=request_params,
        )
        data = resp.json()
        _check_response(data, action)
        page = data.get("data", {})
        if not isinstance(page, dict):
            raise FeishuAPIError(-1, f"飞书 {action} 返回格式错误：data 字段不是对象")
        page_items = page.get("items", []) or []
        if not isinstance(page_items, list):
            raise FeishuAPIError(-1, f"飞书 {action} 返回格式错误：items 字段不是数组")
        items.extend(item for item in page_items if isinstance(item, dict))
        if not page.get("has_more"):
            return items
        page_token = str(page.get("page_token") or "")
        if not page_token:
            raise FeishuAPIError(-1, f"飞书 {action} 分页响应缺少 page_token")
    raise FeishuAPIError(-1, f"飞书 {action} 分页数量异常，请检查通讯录范围")


def get_directory_users(tenant_access_token: str) -> list[FeishuUserInfo]:
    """Return all users visible to the app across the Feishu directory tree."""
    departments = ["0"]
    department_items = _list_contact_items(
        tenant_access_token,
        "/contact/v3/departments/0/children",
        params={
            "department_id_type": "open_department_id",
            "fetch_child": True,
        },
        action="获取通讯录部门",
    )
    seen_departments = {"0"}
    for item in department_items:
        department_id = str(
            item.get("open_department_id") or item.get("department_id") or ""
        ).strip()
        if department_id and department_id not in seen_departments:
            departments.append(department_id)
            seen_departments.add(department_id)

    users: dict[str, FeishuUserInfo] = {}
    for department_id in departments:
        user_items = _list_contact_items(
            tenant_access_token,
            "/contact/v3/users/find_by_department",
            params={
                "department_id": department_id,
                "department_id_type": "open_department_id",
                "user_id_type": "open_id",
            },
            action="获取通讯录用户",
        )
        for item in user_items:
            open_id = str(item.get("open_id") or item.get("user_id") or "").strip()
            if not open_id:
                continue
            avatar = item.get("avatar")
            avatar_url = ""
            if isinstance(avatar, dict):
                avatar_url = str(
                    avatar.get("avatar_origin")
                    or avatar.get("avatar_240")
                    or avatar.get("avatar_72")
                    or ""
                )
            elif item.get("avatar_url"):
                avatar_url = str(item["avatar_url"])
            candidate = FeishuUserInfo(
                open_id=open_id,
                name=str(item.get("name") or open_id),
                avatar_url=avatar_url,
                tenant_key="",
                enterprise_email=str(item.get("enterprise_email") or ""),
            )
            previous = users.get(open_id)
            if previous is None:
                users[open_id] = candidate
            else:
                users[open_id] = FeishuUserInfo(
                    open_id=open_id,
                    name=candidate.name or previous.name,
                    avatar_url=candidate.avatar_url or previous.avatar_url,
                    tenant_key=candidate.tenant_key or previous.tenant_key,
                    enterprise_email=candidate.enterprise_email or previous.enterprise_email,
                )
    return list(users.values())
