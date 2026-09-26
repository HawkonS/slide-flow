"""Services / common."""

from __future__ import annotations

from app.config import settings
from fastapi import HTTPException
from fastapi import Request
from typing import Any
import json
import re
import sqlite3


DEFAULT_RESOURCE_SUBJECT = settings.default_resource_subject


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def _json_loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except Exception:
        return default


def _parse_id_list(raw: str | None) -> list[int]:
    if not raw:
        return []
    raw = raw.strip()
    if not raw:
        return []
    try:
        value = json.loads(raw)
        if isinstance(value, list) and all(isinstance(item, int) for item in value):
            return [int(item) for item in value]
    except (json.JSONDecodeError, TypeError):
        pass
    raise HTTPException(400, "用户 ID 列表必须是 JSON 整数数组")


def _parse_string_list(raw: str | None, *, label: str = "字符串列表") -> list[str]:
    if not raw:
        return []
    raw = raw.strip()
    if not raw:
        return []
    try:
        value = json.loads(raw)
        if isinstance(value, list) and all(isinstance(item, str) for item in value):
            return [item for item in value]
    except (json.JSONDecodeError, TypeError):
        pass
    raise HTTPException(400, f"{label}必须是 JSON 字符串数组")


def _reject_removed_query_params(request: Request, *names: str) -> None:
    removed = sorted(name for name in names if name in request.query_params)
    if removed:
        raise HTTPException(400, f"当前版本已移除查询参数: {', '.join(removed)}")


async def _reject_removed_form_fields(request: Request, *names: str) -> None:
    form = await request.form()
    removed = sorted(name for name in names if name in form)
    if removed:
        raise HTTPException(400, f"当前版本已移除表单字段: {', '.join(removed)}")


def _validate_scope(scope: str) -> str:
    if scope not in {"public", "partial", "private"}:
        raise HTTPException(400, "权限范围不正确")
    return scope


def _validate_required_scope(scope: str | None, label: str) -> str:
    """Require an explicit scope selection for new resource imports."""
    value = (scope or "").strip()
    if not value:
        raise HTTPException(400, f"请选择{label}")
    return _validate_scope(value)


def _validate_secrecy(level: str) -> str:
    value = (level or "").strip()
    if not value:
        raise HTTPException(400, "请选择密级")
    if len(value) > 64:
        raise HTTPException(400, "密级标签不正确")
    return value


def _validate_resource_status(status: str | None) -> str:
    value = (status or "").strip()
    if not value:
        raise HTTPException(400, "请选择状态")
    if len(value) > 64:
        raise HTTPException(400, "状态标签不正确")
    return value


def _validate_resource_subject(subject: str | None, *, allow_empty: bool = False) -> str:
    value = (subject or "").strip()
    if not value:
        if allow_empty:
            return ""
        value = DEFAULT_RESOURCE_SUBJECT
    if not value:
        raise HTTPException(400, "请填写主体")
    if any(separator in value for separator in [",", "，", ";", "；", "\n", "\r"]):
        raise HTTPException(400, "主体只能填写一个")
    if len(value) > 80:
        raise HTTPException(400, "主体不能超过 80 个字符")
    return value


def _serialize_user(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "username": row["username"],
        "feishu_id": row["feishu_id"],
        "role": row["role"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _natural_sort_key(filename: str) -> list:
    """将文件名转换为自然排序的key，正确处理数字序列。"""
    return [int(part) if part.isdigit() else part.lower()
            for part in re.split(r'(\d+)', filename)]
