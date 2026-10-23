"""Asynchronous image tagging with an OpenAI-compatible vision model."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import re
import sqlite3
import threading
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError

from app.core.permissions import can_manage_resource
from app.core.task_events import append_task_event
from app.db import get_db, now_iso
from app.services.files import _resource_file_abs, materialization_scope
from app.services.model_connections import (
    ModelConnectionError,
    call_chat_completion,
    connection_credentials,
    default_connection_row,
)
from app.services.resources import _resource_row, _version_row
from app.services.tagging import entity_tag_names, parse_tag_names, set_entity_tags
from app.services.tasks.runtime import _heavy_executor, _pending_task_futures, _task_cancel_flags

logger = logging.getLogger(__name__)

_AI_TAGGING_SEMAPHORE = asyncio.Semaphore(2)
_MODEL_RESPONSE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.IGNORECASE | re.DOTALL)


def _safe_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _task_update(
    db: sqlite3.Connection,
    task_id: int,
    owner_id: int,
    *,
    status: str | None = None,
    message: str | None = None,
    progress: int | None = None,
    total: int | None = None,
    result_data: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
    error_message: str | None = None,
) -> None:
    fields = ["updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"]
    values: list[Any] = []
    if status is not None:
        fields.append("status = ?")
        values.append(status)
    if message is not None:
        fields.append("message = ?")
        values.append(message)
    if progress is not None:
        fields.append("progress = ?")
        values.append(progress)
    if total is not None:
        fields.append("total = ?")
        values.append(total)
    if result_data is not None:
        fields.append("result_data = ?")
        values.append(_safe_json(result_data))
    if params is not None:
        fields.append("params = ?")
        values.append(_safe_json(params))
    if error_message is not None:
        fields.append("error_message = ?")
        values.append(error_message)
    if status in {"completed", "failed", "cancelled"}:
        fields.append("completed_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')")
    values.append(task_id)
    db.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id = ?", values)
    payload: dict[str, Any] = {"type": "ai_tagging_progress", "task_id": task_id}
    if status is not None:
        payload["status"] = status
    if message is not None:
        payload["message"] = message
    if progress is not None:
        payload["progress"] = progress
    if total is not None:
        payload["total"] = total
    append_task_event(db, owner_id, payload)
    db.commit()


def _image_data_url(image: Image.Image, *, max_edge: int = 2200) -> str:
    image = image.convert("RGB")
    if max(image.size) > max_edge:
        image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=86, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def _load_image(path: Path) -> Image.Image:
    try:
        with Image.open(path) as image:
            image.load()
            return image.convert("RGB")
    except (FileNotFoundError, OSError, UnidentifiedImageError) as exc:
        raise ModelConnectionError("素材预览图不可用，请先确认该页面有有效预览图") from exc


def _tag_prompt(db: sqlite3.Connection, *, context: str) -> str:
    rows = db.execute(
        "SELECT name, category, label FROM tags ORDER BY category, sort_order, id"
    ).fetchall()
    if not rows:
        raise ModelConnectionError("系统中尚未配置分类标签")
    options = [
        {"name": str(row["name"]), "category": str(row["category"]), "label": str(row["label"])}
        for row in rows
    ]
    return (
        "你是幻灯片素材标签助手。请根据图片内容，从给定的系统分类标签中选择最相关的标签。"
        "只能选择列表中的 name，不要创造新标签。最多返回 8 个标签；没有合适标签时返回空数组。"
        "只返回严格 JSON，格式为 {\"tags\":[\"标签name\"]}，不要 Markdown、解释或其他字段。\n"
        f"标注对象：{context}\n可选标签：{_safe_json(options)}"
    )


def _parse_model_tags(content: str, allowed: set[str]) -> list[str]:
    candidate = content.strip()
    fenced = _MODEL_RESPONSE_RE.search(candidate)
    if fenced:
        candidate = fenced.group(1).strip()
    try:
        data = json.loads(candidate)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ModelConnectionError("模型返回的标签结果不是有效 JSON") from exc
    raw = data.get("tags") if isinstance(data, dict) else data
    if not isinstance(raw, list):
        raise ModelConnectionError("模型返回中缺少 tags 数组")
    result: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        tag = item.strip()
        if tag in allowed and tag not in result:
            result.append(tag)
        if len(result) >= 8:
            break
    return result


def _resource_input(db: sqlite3.Connection, resource_id: int, version_id: int | None) -> tuple[Image.Image, str, list[str]]:
    row = _resource_row(db, resource_id)
    version = _version_row(db, resource_id, version_id) if version_id else db.execute(
        "SELECT * FROM resource_versions WHERE resource_id = ? AND version_no = ?",
        (resource_id, row["current_version"]),
    ).fetchone()
    if version is None or not version["png_path"]:
        raise ModelConnectionError("素材当前版本没有预览图")
    path = _resource_file_abs(version["png_path"])
    if path is None or not path.exists():
        raise ModelConnectionError("素材预览图不存在")
    return _load_image(path), str(row["name"]), entity_tag_names(
        db, relation_table="resource_tags", entity_column="resource_id", entity_id=resource_id, fallback=row["tags"] or ""
    )


def _execute_tagging_task(task_id: int) -> None:
    db = get_db()
    cancel_event = _task_cancel_flags.get(task_id)
    try:
        row = db.execute("SELECT * FROM tasks WHERE id = ? AND task_type = 'ai_tagging'", (task_id,)).fetchone()
        if row is None:
            return
        params = json.loads(row["params"] or "{}")
        owner_id = int(row["owner_id"])
        if cancel_event and cancel_event.is_set():
            _task_update(db, task_id, owner_id, status="cancelled", message="任务已取消")
            return
        _task_update(db, task_id, owner_id, status="processing", message="正在准备图片…", progress=0, total=1)
        connection = db.execute("SELECT * FROM model_connections WHERE id = ?", (params["connection_id"],)).fetchone()
        if connection is None:
            raise ModelConnectionError("模型连接已被删除")
        base_url, api_key, model = connection_credentials(connection)
        with materialization_scope():
            image, context, existing_tags = _resource_input(db, int(params["target_id"]), params.get("version_id"))
            prompt = _tag_prompt(db, context=context)
            allowed = {str(item["name"]) for item in db.execute("SELECT name FROM tags").fetchall()}
            _task_update(db, task_id, owner_id, message="正在请求视觉模型…", progress=0, total=1)
            current = db.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if (cancel_event and cancel_event.is_set()) or (current and current["status"] == "cancelled"):
                if current and current["status"] != "cancelled":
                    _task_update(db, task_id, owner_id, status="cancelled", message="任务已取消")
                return
            content = call_chat_completion(base_url, api_key, model, _image_data_url(image), prompt)
            current = db.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if (cancel_event and cancel_event.is_set()) or (current and current["status"] == "cancelled"):
                if current and current["status"] != "cancelled":
                    _task_update(db, task_id, owner_id, status="cancelled", message="任务已取消")
                return
            suggestions = _parse_model_tags(content, allowed)
        result = {
            "target_type": "resource",
            "target_id": int(params["target_id"]),
            "connection_id": int(connection["id"]),
            "connection_name": str(connection["name"]),
            "model": model,
            "suggested_tags": suggestions,
            "existing_tags": existing_tags,
            "tags_applied": False,
        }
        _task_update(db, task_id, owner_id, status="completed", message="已生成标签建议", progress=1, total=1, result_data=result)
    except ModelConnectionError as exc:
        row = db.execute("SELECT owner_id FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row:
            _task_update(db, task_id, int(row["owner_id"]), status="failed", message="智能标注失败", error_message=str(exc))
    except Exception:
        logger.exception("AI tagging task failed: %s", task_id)
        row = db.execute("SELECT owner_id FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row:
            _task_update(db, task_id, int(row["owner_id"]), status="failed", message="智能标注失败", error_message="智能标注失败，请稍后重试")
    finally:
        _task_cancel_flags.pop(task_id, None)
        _pending_task_futures.pop(task_id, None)
        db.close()


def schedule_tagging_task(task_id: int) -> None:
    async def run() -> None:
        async with _AI_TAGGING_SEMAPHORE:
            await asyncio.get_running_loop().run_in_executor(_heavy_executor, _execute_tagging_task, task_id)

    future = asyncio.ensure_future(run())
    future.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
    _pending_task_futures[task_id] = future


def validate_resource_for_start(
    db: sqlite3.Connection,
    user: sqlite3.Row,
    resource_id: int,
    version_id: int | None = None,
) -> None:
    row = _resource_row(db, resource_id)
    if not can_manage_resource(db, row, user):
        raise PermissionError("无素材管理权限")
    if version_id is not None:
        _version_row(db, resource_id, version_id)


def create_tagging_task(db: sqlite3.Connection, user: sqlite3.Row, resource_id: int, version_id: int | None = None) -> int:
    validate_resource_for_start(db, user, resource_id, version_id)
    connection = default_connection_row(db)
    params = {
        "target_type": "resource",
        "target_id": int(resource_id),
        "version_id": int(version_id) if version_id else None,
        "connection_id": int(connection["id"]),
        "connection_name": str(connection["name"]),
        "model": str(connection["model"]),
        "owner_id": int(user["id"]),
    }
    db.execute(
        "INSERT INTO tasks (task_type, status, owner_id, params, progress, total, message) VALUES ('ai_tagging', 'pending', ?, ?, 0, 1, '等待智能标注…')",
        (int(user["id"]), _safe_json(params)),
    )
    task_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    db.commit()
    _task_cancel_flags[task_id] = threading.Event()
    schedule_tagging_task(task_id)
    return task_id


def apply_tagging_result(db: sqlite3.Connection, user: sqlite3.Row, task_id: int, selected_tags: list[str]) -> dict[str, Any]:
    row = db.execute("SELECT * FROM tasks WHERE id = ? AND task_type = 'ai_tagging'", (task_id,)).fetchone()
    if row is None:
        raise LookupError("标注任务不存在")
    if int(row["owner_id"]) != int(user["id"]) and str(user["role"]) not in {"admin", "system_admin"}:
        raise PermissionError("无权操作此标注任务")
    if row["status"] != "completed":
        raise ValueError("标注任务尚未完成")
    result = json.loads(row["result_data"] or "{}")
    target_type = str(result.get("target_type") or "")
    target_id = int(result.get("target_id") or 0)
    if target_type != "resource":
        raise ValueError("当前仅支持单页素材智能标注")
    validate_resource_for_start(db, user, target_id)
    suggestions = set(result.get("suggested_tags") or [])
    current_definitions = {
        str(item["name"]) for item in db.execute("SELECT name FROM tags").fetchall()
    }
    selected = [
        tag
        for tag in parse_tag_names(selected_tags)
        if tag in suggestions and tag in current_definitions
    ]
    relation_table, entity_column, cache_table = "resource_tags", "resource_id", "resources"
    existing = entity_tag_names(db, relation_table=relation_table, entity_column=entity_column, entity_id=target_id)
    merged = list(dict.fromkeys([*existing, *selected]))
    set_entity_tags(db, relation_table=relation_table, entity_column=entity_column, entity_id=target_id, names=merged, cache_table=cache_table, created_by=int(user["id"]))
    result.update({"tags_applied": True, "applied_tags": selected, "final_tags": merged})
    db.execute("UPDATE tasks SET result_data = ?, updated_at = ? WHERE id = ?", (_safe_json(result), now_iso(), task_id))
    db.commit()
    return {"tags": merged, "applied_tags": selected}
