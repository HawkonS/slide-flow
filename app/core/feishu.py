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
    union_id: str = ""
    user_id: str = ""
    email: str = ""
    job_title: str = ""
    employee_no: str = ""
    employment_status: str = "active"
    department_ids: tuple[str, ...] = ()


@dataclass
class FeishuDepartmentInfo:
    """飞书部门信息（组织架构同步用）。"""
    open_department_id: str
    parent_department_id: str
    name: str
    leader_open_ids: tuple[str, ...] = ()
    order: int = 0
    is_active: bool = True


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


def _pick_avatar(item: dict) -> str:
    avatar = item.get("avatar")
    if isinstance(avatar, dict):
        return str(
            avatar.get("avatar_origin")
            or avatar.get("avatar_640")
            or avatar.get("avatar_240")
            or avatar.get("avatar_72")
            or ""
        )
    return str(item.get("avatar_url") or item.get("avatar_thumb") or "")


def _user_employment_status(item: dict) -> str:
    status = item.get("status")
    if not isinstance(status, dict):
        return "active"
    if status.get("is_resigned") or status.get("is_exited"):
        return "resigned"
    if status.get("is_frozen"):
        return "frozen"
    return "active"


def _merge_directory_user(
    existing: FeishuUserInfo | None,
    item: dict,
    fallback_department_id: str,
) -> FeishuUserInfo | None:
    open_id = str(item.get("open_id") or item.get("user_id") or "").strip()
    if not open_id:
        return None
    department_ids = {
        str(value).strip()
        for value in (item.get("department_ids") or [])
        if str(value).strip()
    }
    if fallback_department_id and fallback_department_id != "0":
        department_ids.add(fallback_department_id)
    if existing is not None:
        department_ids.update(existing.department_ids)
    return FeishuUserInfo(
        open_id=open_id,
        name=str(item.get("name") or (existing.name if existing else open_id)),
        avatar_url=_pick_avatar(item) or (existing.avatar_url if existing else ""),
        tenant_key=existing.tenant_key if existing else "",
        enterprise_email=str(
            item.get("enterprise_email")
            or (existing.enterprise_email if existing else "")
            or ""
        ),
        union_id=str(item.get("union_id") or (existing.union_id if existing else "") or ""),
        user_id=str(item.get("user_id") or (existing.user_id if existing else "") or ""),
        email=str(item.get("email") or (existing.email if existing else "") or ""),
        job_title=str(item.get("job_title") or (existing.job_title if existing else "") or ""),
        employee_no=str(
            item.get("employee_no") or (existing.employee_no if existing else "") or ""
        ),
        employment_status=_user_employment_status(item),
        department_ids=tuple(sorted(department_ids)),
    )


def _department_leader_ids(item: dict) -> tuple[str, ...]:
    leader_ids: list[str] = []
    primary = str(item.get("leader_user_id") or "").strip()
    if primary:
        leader_ids.append(primary)
    leaders = item.get("leaders")
    if isinstance(leaders, list):
        for leader in leaders:
            if not isinstance(leader, dict):
                continue
            value = str(leader.get("leaderID") or leader.get("leader_id") or "").strip()
            if value and value not in leader_ids:
                leader_ids.append(value)
    return tuple(leader_ids)


def get_directory_tree(
    tenant_access_token: str,
) -> tuple[list[FeishuDepartmentInfo], list[FeishuUserInfo]]:
    """Return the full department tree and all visible users.

    Departments are walked breadth-first so every child's parent is known even
    when the tenant does not populate ``parent_department_id`` on the
    ``fetch_child`` response.
    """
    max_departments = 1000
    max_users = 50_000
    departments: dict[str, FeishuDepartmentInfo] = {}
    queue: list[str] = ["0"]
    seen: set[str] = set()
    while queue:
        parent_id = queue.pop(0)
        if parent_id in seen:
            continue
        seen.add(parent_id)
        items = _list_contact_items(
            tenant_access_token,
            f"/contact/v3/departments/{parent_id}/children",
            params={"department_id_type": "open_department_id"},
            action="获取通讯录部门",
        )
        for item in items:
            department_id = str(
                item.get("open_department_id") or item.get("department_id") or ""
            ).strip()
            if not department_id or department_id in departments:
                continue
            parent_value = str(
                item.get("parent_department_id") or parent_id or "0"
            ).strip() or "0"
            status = item.get("status")
            is_active = not (
                isinstance(status, dict) and bool(status.get("is_deleted"))
            )
            departments[department_id] = FeishuDepartmentInfo(
                open_department_id=department_id,
                parent_department_id=parent_value,
                name=str(item.get("name") or department_id),
                leader_open_ids=_department_leader_ids(item),
                order=int(item.get("order") or 0),
                is_active=is_active,
            )
            if len(departments) > max_departments:
                raise FeishuAPIError(-1, f"通讯录部门数量超过上限 {max_departments}")
            queue.append(department_id)

    users: dict[str, FeishuUserInfo] = {}
    for department_id in ["0", *departments.keys()]:
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
            open_id = str(item.get("open_id") or "").strip()
            if not open_id:
                continue
            merged = _merge_directory_user(users.get(open_id), item, department_id)
            if merged is not None:
                users[open_id] = merged
            if len(users) > max_users:
                raise FeishuAPIError(-1, f"通讯录用户数量超过上限 {max_users}")
    return list(departments.values()), list(users.values())


def get_directory_users(tenant_access_token: str) -> list[FeishuUserInfo]:
    """Return all users visible to the app across the Feishu directory tree."""
    _, users = get_directory_tree(tenant_access_token)
    return users
