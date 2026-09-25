"""Services / tasks / records."""

from __future__ import annotations

from app.config import settings
from app.core.errors import PUBLIC_ERROR_MESSAGES
from app.core.sanitize import sanitize_html
from pathlib import Path
from typing import Any
import json
import shutil
import sqlite3
import tempfile


_TASK_PARAMS_PUBLIC_KEYS = (
    "name_prefix",
    "subject",
    "tags",
    "secrecy_level",
    "visibility_scope",
    "visible_user_ids",
    "visible_user_tags",
    "management_scope",
    "manage_user_ids",
    "manage_user_tags",
    "remark_html",
    "status",
    "owner_id",
    # Resource-import workflow state. Paths remain private; the random session
    # id is owner-scoped and is needed to reopen an unfinished task.
    "task_id",
    "session_id",
    "file_name",
    "workflow_state",
    "slide_count",
    "fonts",
    "missing_fonts",
    "preview_status",
    "preview_error",
    "render_stage",
    "render_completed",
    "render_total",
)


def _owner_brief(db: sqlite3.Connection, owner_id: int) -> dict[str, Any] | None:
    row = db.execute(
        "SELECT id, username, name FROM users WHERE id = ?",
        (owner_id,),
    ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "name": row["name"],
    }


def _serialize_task(row: sqlite3.Row, db: sqlite3.Connection | None = None) -> dict[str, Any]:
    """将任务行序列化为前端可用的字典"""
    raw_params = json.loads(row["params"] or "{}")
    safe_params = {k: raw_params[k] for k in _TASK_PARAMS_PUBLIC_KEYS if k in raw_params}
    if "remark_html" in safe_params:
        safe_params["remark_html"] = sanitize_html(str(safe_params["remark_html"] or ""))
    # 附加图片数量（若存在）但不暴露原始路径
    if isinstance(raw_params.get("image_paths"), list):
        safe_params["image_count"] = len(raw_params["image_paths"])

    try:
        raw_result_data = json.loads(row["result_data"] or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        raw_result_data = {}

    # 任务结果可能包含服务器绝对路径、临时目录等内部信息；只返回前端展示所需字段。
    if isinstance(raw_result_data, dict):
        result_data = {
            key: raw_result_data[key]
            for key in ("total", "created", "resource_ids", "message", "expired")
            if key in raw_result_data
        }
    else:
        result_data = {}

    # 下载任务特殊处理：暴露前端展示所需字段（白名单之外）
    if row["task_type"] == "download":
        for key in ("show_id", "download_type", "with_fonts", "track_code", "client_ip"):
            if key in raw_params:
                safe_params[key] = raw_params[key]
        # 放映名称未存于 params，从 shows 表反查
        show_id = raw_params.get("show_id")
        if db is not None and show_id is not None:
            try:
                show_row = db.execute(
                    "SELECT name FROM shows WHERE id = ?", (int(show_id),)
                ).fetchone()
                if show_row is not None:
                    safe_params["show_name"] = show_row["name"]
            except Exception:
                pass
        # 文件名 / 文件大小来自 result_data
        if isinstance(raw_result_data, dict):
            if "file_name" in raw_result_data:
                safe_params["file_name"] = raw_result_data["file_name"]
            if "file_size" in raw_result_data:
                safe_params["file_size"] = raw_result_data["file_size"]

    owner = _owner_brief(db, int(row["owner_id"])) if db is not None else None
    raw_error = row["error_message"]
    safe_error = None
    if raw_error:
        # 旧任务记录可能保存了异常字符串（包含绝对路径/命令行参数）；接口只返回通用提示。
        safe_error = raw_error if raw_error in ({"服务重启，任务中断", "未能拆分 PPTX"} | PUBLIC_ERROR_MESSAGES) else "任务处理失败，请重试或联系管理员"
    return {
        "id": row["id"],
        "task_type": row["task_type"],
        "status": row["status"],
        "owner_id": row["owner_id"],
        "owner": owner,
        "progress": row["progress"],
        "upload_progress": row["upload_progress"],
        "total": row["total"],
        "message": row["message"],
        "result_data": result_data,
        "error_message": safe_error,
        "params": safe_params,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "completed_at": row["completed_at"],
    }


def _cleanup_task_temp(row: sqlite3.Row) -> None:
    """删除任务参数中记录的临时上传目录（若任务尚未自行清理）。"""
    try:
        params = json.loads(row["params"] or "{}")
        temp_dir = params.get("temp_dir")
        if temp_dir:
            candidate = Path(str(temp_dir)).resolve()
            assets_root = settings.assets_dir.resolve()
            allowed_assets = candidate.is_relative_to(assets_root)
            temp_root = Path(tempfile.gettempdir()).resolve()
            allowed_system_temp = candidate.parent == temp_root and candidate.name.startswith("task_split_")
            if not (allowed_assets or allowed_system_temp):
                return
            shutil.rmtree(candidate, ignore_errors=True)
    except Exception:
        return
