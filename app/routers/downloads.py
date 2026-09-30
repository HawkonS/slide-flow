"""Routers / downloads."""

from __future__ import annotations

from app.config import settings
from app.core.permissions import can_view_show
from app.core.permissions import is_system_admin
from app.core.permissions import require_user
from app.routers.dependencies import (
    db_dep,
    db_read_dep,
)
from app.services.tasks.runtime import _pending_task_futures, _task_cancel_flags
from app.services.downloads.tracking import (
    _record_download,
)
from app.services.downloads.access import _validate_download_result_access
from app.services.files import (
    _content_disposition,
)
from app.services.shows import (
    _collect_show_accessible_resources,
    _show_row,
)
from app.services.tasks.runtime import (
    _pending_task_futures,
)
from fastapi import APIRouter
from fastapi import Body
from fastapi import Depends
from fastapi import HTTPException
from fastapi import Request
from fastapi.responses import FileResponse
from pathlib import Path
from typing import Any
import asyncio
import json
import logging
import sqlite3
import threading

logger = logging.getLogger(__name__)

router = APIRouter()


_ALLOWED_DOWNLOAD_TYPES = {"pdf", "pptx_images", "pptx", "pptx_pages", "zip"}


@router.post("/api/downloads/create")
async def create_download_task(
    request: Request,
    show_id: int = Body(..., embed=True),
    download_type: str = Body(..., embed=True),
    watermark: str = Body("", embed=True),
    with_fonts: bool = Body(False, embed=True),
    embed_fonts: bool = Body(False, embed=True),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """创建一个异步下载任务。返回 task_id，后台生成文件并通过 WebSocket 推送进度。"""
    if download_type not in _ALLOWED_DOWNLOAD_TYPES:
        raise HTTPException(400, f"不支持的 download_type: {download_type}")
    if embed_fonts and (download_type != "pptx" or with_fonts):
        raise HTTPException(400, "内嵌字体仅支持普通 PPT 下载")
    show_row = _show_row(db, show_id)
    if not can_view_show(db, show_row, user):
        raise HTTPException(403, "无可见权限")
    if not _collect_show_accessible_resources(db, show_id, user):
        raise HTTPException(404, "放映组没有可下载的资源")

    # 生成追踪码 + 记录下载（与同步 API 保持一致）
    record_type = download_type
    if download_type == "pptx" and with_fonts:
        record_type = "pptx_fonts"
    elif download_type == "zip" and with_fonts:
        record_type = "zip_fonts"
    track_code = _record_download(db, user, request, show_id, record_type)
    client_ip = request.headers.get("X-Forwarded-For", "").split(",")[0].strip() or (request.client.host if request.client else "")

    params = {
        "show_id": int(show_id),
        "download_type": download_type,
        "with_fonts": bool(with_fonts),
        "user_watermark": watermark or "",
        "embed_fonts": bool(embed_fonts),
        "track_code": track_code,
        "client_ip": client_ip,
        "session_version": int(user["session_version"]),
    }
    db.execute(
        """
        INSERT INTO tasks (task_type, status, owner_id, params, progress, total)
        VALUES ('download', 'pending', ?, ?, 0, 0)
        """,
        (int(user["id"]), json.dumps(params, ensure_ascii=False)),
    )
    task_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    db.commit()

    # Register cancellation before the coroutine can queue behind its semaphore.
    from app.core.download_tasks import execute_download_task

    _task_cancel_flags[task_id] = threading.Event()
    future = asyncio.ensure_future(execute_download_task(task_id, int(user["id"])))

    def _on_done(f: asyncio.Future) -> None:  # type: ignore[type-arg]
        try:
            f.result()
        except Exception as e:
            logger.error("Download task %d failed with unhandled error: %s", task_id, e)
        except asyncio.CancelledError:
            pass
        finally:
            _pending_task_futures.pop(task_id, None)
            _task_cancel_flags.pop(task_id, None)

    future.add_done_callback(_on_done)
    _pending_task_futures[task_id] = future

    return {
        "task_id": task_id,
        "track_code": track_code,
        "message": "下载任务已创建，请等待生成...",
    }


@router.get("/api/downloads/{task_id}/file")
def get_download_file(
    task_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> FileResponse:
    """下载已完成任务生成的文件。仅任务创建者可访问；文件过期返回 410。"""
    row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "任务不存在")
    if int(row["owner_id"]) != int(user["id"]) and not is_system_admin(user):
        raise HTTPException(403, "无权访问此任务")
    if row["task_type"] != "download":
        raise HTTPException(400, "任务类型不匹配")
    if row["status"] != "completed":
        raise HTTPException(400, f"任务状态为 {row['status']}，文件尚未生成")
    try:
        result = json.loads(row["result_data"] or "{}")
    except (ValueError, TypeError):
        result = {}
    if not isinstance(result, dict):
        result = {}
    if result.get("expired"):
        raise HTTPException(410, "下载文件已过期，请重新发起下载")
    _validate_download_result_access(db, row, user, result)
    fp = result.get("file_path")
    if not fp:
        raise HTTPException(410, "下载文件不可用")
    try:
        file_path = Path(fp).resolve(strict=False)
        downloads_root = settings.downloads_dir.resolve(strict=False)
        file_path.relative_to(downloads_root)
    except (TypeError, ValueError, OSError):
        logger.warning("拒绝访问下载目录外的任务文件 task_id=%s", task_id)
        raise HTTPException(410, "下载文件不可用") from None
    if not file_path.exists():
        raise HTTPException(410, "下载文件已过期或被清理")
    file_name = result.get("file_name") or file_path.name
    suffix = file_path.suffix.lower()
    media_type_map = {
        ".pdf": "application/pdf",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".zip": "application/zip",
    }
    media_type = media_type_map.get(suffix, "application/octet-stream")
    return FileResponse(
        file_path,
        media_type=media_type,
        headers={"Content-Disposition": _content_disposition(file_name), "Cache-Control": "private, no-store"},
    )
