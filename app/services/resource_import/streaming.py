"""NDJSON status stream for durable pull-based preview rendering."""
from __future__ import annotations

import asyncio
import json
import logging
import time

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from app.config import settings
from app.core.errors import RENDERER_GENERIC_MESSAGE, storage_public_message
from app.core.errors import RENDERER_TIMEOUT_MESSAGE
from app.core.oss import StorageConfigurationError, StorageUnavailableError
from app.db import get_db
from app.services.resource_import.previews import _preview_set_is_current
from app.services.resource_import.render_tasks import cancel_render_tasks, ensure_render_task, render_task_state
from app.services.resource_import.sessions import (
    _load_resource_import_session_file,
    _resource_import_operation,
    _resource_import_session,
    _write_resource_import_session,
)

logger = logging.getLogger(__name__)


def _persist_render_error(session: dict, message: str) -> None:
    session.update(preview_status="error", preview_error=message)
    _write_resource_import_session(session)
    task_id = session.get("task_id")
    if not isinstance(task_id, int):
        return
    db = get_db()
    try:
        row = db.execute("SELECT params FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            return
        try:
            params = json.loads(row["params"] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            params = {}
        params.update({
            "workflow_state": "awaiting_render",
            "preview_status": "error",
            "preview_error": message,
        })
        db.execute(
            "UPDATE tasks SET status='pending', message=?, error_message=?, params=?, "
            "updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime') "
            "WHERE id=? AND status<>'cancelled'",
            (message, message, json.dumps(params, ensure_ascii=False), task_id),
        )
        db.commit()
    finally:
        db.close()


def preview_stream(session_id, user):
    session = _resource_import_session(session_id, user)
    if "commit_result" in session:
        raise HTTPException(410, "导入会话已提交")
    if session.get("missing_fonts"):
        raise HTTPException(400, "请先处理不在标准字体库中的字体")
    if not _preview_set_is_current(session):
        # Serialize task creation with font replacement/cancellation and with
        # another browser tab opening the same stream.
        with _resource_import_operation(session, wait=True):
            current = _load_resource_import_session_file(session_id) or session
            if not _preview_set_is_current(current):
                try:
                    ensure_render_task(current)
                except (StorageConfigurationError, StorageUnavailableError) as exc:
                    message = storage_public_message(exc) or "对象存储暂时不可用，请稍后重试"
                    logger.exception("Preview render storage failure session_id=%s", session_id)
                    _persist_render_error(current, message)
                    raise HTTPException(503, message) from exc
                except Exception as exc:
                    logger.exception("Preview render task creation failed session_id=%s", session_id)
                    _persist_render_error(current, RENDERER_GENERIC_MESSAGE)
                    raise HTTPException(400, "图片渲染任务创建失败，请检查 PPT 文件后重试") from exc

    async def body():
        def encode(event):
            return json.dumps(event, ensure_ascii=False) + "\n"

        deadline = time.monotonic() + max(10, int(settings.render_total_timeout))
        yield encode({"type": "started", "total": session["slide_count"], "message": "已提交 Windows 图片渲染任务"})
        last_heartbeat = time.monotonic()
        while True:
            current = _load_resource_import_session_file(session_id) or session
            if _preview_set_is_current(current):
                attempt = current.get("render_attempt", "")
                for index in range(int(current["slide_count"])):
                    yield encode({"type": "page", "index": index, "preview_url": f"/api/resource-import/{session_id}/preview/{index}?attempt={attempt}"})
                yield encode({"type": "completed", "preview_status": "ready", "preview_count": len(current.get("preview_paths", []))})
                return
            state = render_task_state(current)
            if state["status"] == "error":
                yield encode({"type": "error", "message": state.get("message") or current.get("preview_error") or RENDERER_GENERIC_MESSAGE})
                return
            if time.monotonic() >= deadline:
                db = get_db()
                try:
                    cancel_render_tasks(db, session_id)
                finally:
                    db.close()
                _persist_render_error(current, RENDERER_TIMEOUT_MESSAGE)
                yield encode({"type": "error", "message": RENDERER_TIMEOUT_MESSAGE})
                return
            if time.monotonic() - last_heartbeat >= 5:
                message = "等待 Windows 转换节点领取任务" if state["status"] in {"pending", "queued"} else "Windows 正在转换 PPT 为 PNG"
                yield encode({"type": "progress", "message": message})
                last_heartbeat = time.monotonic()
            await asyncio.sleep(1)

    return StreamingResponse(body(), media_type="application/x-ndjson", headers={
        "Content-Encoding": "identity", "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff",
    })
