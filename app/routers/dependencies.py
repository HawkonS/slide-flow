"""
SlideFlow 路由模块公共依赖
包含所有 Pydantic 模型、常量、工具函数等
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from typing import Any

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel

from app.core.permissions import ROLE_USER, SESSION_COOKIE, require_user, require_admin, require_super_admin
from app.config import settings


# ==================== 常量 ====================

SESSION_COOKIE = "slide_flow_session"
PPT_EXTENSIONS = {".pptx"}
OFFICE_EXTENSIONS = {".ppt", ".pptx", ".pot", ".potx", ".pps", ".ppsx"}
DEFAULT_RESOURCE_SUBJECT = settings.default_resource_subject

# ── 任务取消标志: task_id -> threading.Event ──
task_cancel_flags: dict[int, threading.Event] = {}
_pending_task_futures: dict[int, asyncio.Future] = {}  # type: ignore[type-arg]

# ── 并发控制：最多同时执行 N 个拆分任务 ──
_split_semaphore = asyncio.Semaphore(settings.max_concurrent_splits)

# ── 拆分任务超时（秒）──
SPLIT_TASK_TIMEOUT = settings.split_task_timeout


# ==================== Pydantic 模型 ====================

class LoginPayload(BaseModel):
    username: str
    password: str


class UserPayload(BaseModel):
    name: str
    username: str
    password: str | None = None
    feishu_id: str = ""
    role: str = "user"


class MetadataPayload(BaseModel):
    name: str
    subject: str = ""
    tags: str = ""
    status: str = "active"
    visibility_scope: str
    visible_user_ids: list[int] = []
    management_scope: str
    manage_user_ids: list[int] = []
    secrecy_level: str


class CommonRemarkPayload(BaseModel):
    content_html: str
    apply_scope: str = "latest"
    version_id: int | None = None


class PersonalRemarkPayload(BaseModel):
    content_html: str
    version_id: int | None = None


class SplitUploadPayload(BaseModel):
    name_prefix: str = "拆分页"
    subject: str = ""
    tags: str = ""
    status: str = "active"
    visibility_scope: str = "private"
    visible_user_ids: list[int] = []
    management_scope: str = "private"
    manage_user_ids: list[int] = []
    secrecy_level: str = "public"


class FontDeletePayload(BaseModel):
    font_ids: list[int]


class UserDeletePayload(BaseModel):
    user_ids: list[int]


class TaskDeletePayload(BaseModel):
    task_ids: list[int]


class TemplateDeletePayload(BaseModel):
    template_ids: list[int]


class LinkDeletePayload(BaseModel):
    link_ids: list[int]


class TemplatePayload(BaseModel):
    name: str = ""
    series: str
    subject: str
    platform: str
    ratio: str
    template_type: str
    visibility_scope: str
    visible_user_ids: list[int] = []
    management_scope: str
    manage_user_ids: list[int] = []


class TemplateSeriesOrderPayload(BaseModel):
    series: str
    template_ids: list[int]


class TemplateSubjectOrderPayload(BaseModel):
    subject: str
    series: list[TemplateSeriesOrderPayload]


class TemplateOrderPayload(BaseModel):
    template_ids: list[int] = []
    subjects: list[TemplateSubjectOrderPayload] = []


class ShowCreatePayload(BaseModel):
    name: str
    subject: str = ""
    tags: str = ""
    status: str = "active"
    secrecy_level: str = "public"
    visibility_scope: str = "private"
    management_scope: str = "private"
    visible_user_ids: list[int] = []
    manage_user_ids: list[int] = []
    resource_ids: list[int] = []
    change_note: str = ""


class ShowUpdatePayload(BaseModel):
    name: str
    subject: str = ""
    tags: str = ""
    status: str = "active"
    secrecy_level: str = "public"
    visibility_scope: str = "private"
    management_scope: str = "private"
    visible_user_ids: list[int] = []
    manage_user_ids: list[int] = []


class ShowResourcesPayload(BaseModel):
    resource_ids: list[int] = []


class ShowResourceHiddenPayload(BaseModel):
    hidden: bool


class ShowDuplicatePayload(BaseModel):
    name: str


class ShowIteratePayload(BaseModel):
    change_note: str = ""
    name: str | None = None
    resource_ids: list[int] | None = None


class ShowUpgradePayload(BaseModel):
    resource_ids: list[int] = []


class ShowIterateUpgradePayload(BaseModel):
    resource_ids: list[int] = []
    remarks: dict[str, str] = {}
    change_note: str = ""


class ShowRemarkPayload(BaseModel):
    content_html: str = ""


class LinkCreatePayload(BaseModel):
    name: str
    url: str
    memo: str = ""
    visibility_scope: str = "public"
    management_scope: str = "private"
    visible_user_ids: list[int] = []
    manage_user_ids: list[int] = []
    is_enabled: bool = True
    network_env: str = "public_net"


class LinkUpdatePayload(BaseModel):
    name: str
    url: str
    memo: str = ""
    visibility_scope: str = "public"
    management_scope: str = "private"
    visible_user_ids: list[int] = []
    manage_user_ids: list[int] = []
    is_enabled: bool = True
    network_env: str = "public_net"


class LinkSelectionPayload(BaseModel):
    link_ids: list[int] = []


class LinkOrderPayload(BaseModel):
    link_ids: list[int] = []


class UserPreferencesPayload(BaseModel):
    preferences: dict[str, str] = {}


# ==================== 工具函数 ====================

def db_dep():
    """数据库依赖注入"""
    from app.db import get_db
    db = get_db()
    try:
        yield db
    finally:
        db.close()


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    """将 sqlite3.Row 转换为字典"""
    return {key: row[key] for key in row.keys()}


def _serialize_user(row: sqlite3.Row | None) -> dict[str, Any] | None:
    """序列化用户数据"""
    if row is None:
        return None
    return {
        "id": row["id"],
        "name": row["name"],
        "username": row["username"],
        "role": row["role"],
        "feishu_id": row["feishu_id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _json_loads(value: str | None, default: Any) -> Any:
    """安全地解析 JSON 字符串"""
    if not value:
        return default
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return default


def _parse_id_list(raw: str | None) -> list[int]:
    """解析 ID 列表字符串"""
    if not raw:
        return []
    try:
        result = json.loads(raw)
        if isinstance(result, list):
            return [int(x) for x in result]
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    return []


def _validate_resource_status(status: str | None) -> str:
    """验证资源状态"""
    if status not in ("active", "disabled"):
        return "active"
    return status


def _validate_scope(scope: str) -> str:
    """验证权限范围"""
    if scope not in {"public", "partial", "private"}:
        raise HTTPException(400, "权限范围不正确")
    return scope


def _validate_secrecy(level: str) -> str:
    """验证涉密等级"""
    if level not in {"public", "confidential", "secret"}:
        raise HTTPException(400, "涉密等级不正确")
    return level


def _validate_template_type(resource_type: str, template_type: str | None) -> str | None:
    """验证模板类型"""
    if resource_type != "template":
        return None
    if template_type not in ("content", "cover"):
        return "content"
    return template_type


def _validate_template_subject(resource_type: str, subject: str | None) -> str:
    """验证模板主题"""
    if resource_type == "template" and not subject:
        return "通用"
    return subject or ""


def _validate_standalone_template_subject(subject: str | None) -> str:
    """验证独立模板主题"""
    return subject or "通用"


def _validate_template_series(series: str | None) -> str:
    """验证模板系列"""
    return series or ""


def _font_aliases_from_row(row: sqlite3.Row) -> list[str]:
    """从 fonts 表行读取别名 JSON 列表，兼容早期 ' / ' 分隔格式。"""
    raw = row["aliases"] if "aliases" in row.keys() else ""
    aliases: list[str] = []
    seen: set[str] = set()
    try:
        parsed = json.loads(raw) if raw else []
    except (ValueError, TypeError):
        parsed = []
    if isinstance(parsed, list):
        for item in parsed:
            if isinstance(item, str):
                for name in item.split(" / "):
                    name = name.strip()
                    if name and name not in seen:
                        aliases.append(name)
                        seen.add(name)
    else:
        for name in str(parsed).split(" / "):
            name = name.strip()
            if name and name not in seen:
                aliases.append(name)
                seen.add(name)
    return aliases
