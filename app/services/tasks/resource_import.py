"""Durable PPT resource-import workflow.

The interactive import page is only a view over this workflow.  The upload
task owns the temporary import session, so font inspection and rendering can
continue after the browser tab is closed.
"""

from __future__ import annotations

from app.core.fonts import missing_fonts
from app.core.errors import import_public_message
from app.core.ppt import detect_ppt_fonts, slide_count
from app.db import get_db, known_font_aliases
from app.services.resource_import.render_tasks import ensure_render_task
from app.services.resource_import.rendering import _normalize_import_ppt
from app.services.resource_import.sessions import (
    _resource_import_file,
    _resource_import_operation,
    _resource_import_temp_dir,
    _write_resource_import_session,
    _load_resource_import_session_file,
)
from app.services.resource_import.validation import _validate_import_ppt_package
from app.services.tasks.runtime import _pending_task_futures, _task_cancel_flags
from pathlib import Path
import asyncio
import json
import logging
import threading
import time

logger = logging.getLogger(__name__)


def _task_update(db, task_id: int, *, status: str | None = None,
                 message: str | None = None, progress: int | None = None,
                 total: int | None = None, params: dict | None = None,
                 error_message: str | None = None) -> None:
    fields: list[str] = []
    values: list[object] = []
    if status is not None:
        fields.append("status = ?")
        values.append(status)
    if message is not None:
        fields.append("message = ?")
        values.append(message)
    if progress is not None:
        fields.append("progress = ?")
        values.append(int(progress))
    if total is not None:
        fields.append("total = ?")
        values.append(int(total))
    if params is not None:
        fields.append("params = ?")
        values.append(json.dumps(params, ensure_ascii=False))
    if error_message is not None:
        fields.append("error_message = ?")
        values.append(error_message)
    if not fields:
        return
    fields.append("updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')")
    values.append(task_id)
    db.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id = ? AND status <> 'cancelled'", values)
    db.commit()


def _session_for_task(session_id: str) -> dict:
    session = _load_resource_import_session_file(session_id)
    if not session:
        raise RuntimeError("导入会话已过期，请重新上传")
    return session


def _execute_resource_import_task(task_id: int, session_id: str) -> None:
    """Run font detection and automatic rendering for an upload task."""
    cancel_event = _task_cancel_flags.get(task_id)
    db = get_db()
    db.execute("PRAGMA busy_timeout = 30000")
    session: dict | None = None
    try:
        row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None or row["status"] == "cancelled":
            return
        session = _session_for_task(session_id)
        source = _resource_import_file(session, session.get("source_path"))
        temp_dir = _resource_import_temp_dir(session)
        _task_update(db, task_id, status="processing", message="正在检测 PPT 页数和字体…",
                     params={**json.loads(row["params"] or "{}"), "workflow_state": "font_check"})
        if cancel_event and cancel_event.is_set():
            return

        # Conversion/validation happens here, after the upload task already
        # exists.  This is what makes a large upload resumable from Tasks.
        _validate_import_ppt_package(source)
        source = _normalize_import_ppt(source, temp_dir)
        _validate_import_ppt_package(source)
        count = int(slide_count(source))
        if count <= 0:
            raise RuntimeError("无法读取 PPT 页数")
        fonts = detect_ppt_fonts(source)
        missing = missing_fonts(fonts, known_font_aliases(db))
        session.update(
            source_path=str(source), slide_count=count, fonts=fonts,
            missing_fonts=missing, mode="ppt", preview_status="blocked" if missing else "pending",
            preview_error=None, task_id=task_id, expires_at=time.time() + 7 * 24 * 3600,
        )
        _write_resource_import_session(session)
        params = json.loads(row["params"] or "{}")
        params.update({
            "workflow_state": "font_check" if missing else "rendering",
            "slide_count": count,
            "fonts": fonts,
            "missing_fonts": missing,
            "preview_status": session["preview_status"],
        })
        _task_update(db, task_id, total=count, progress=0, params=params)
        if missing:
            _task_update(db, task_id, status="pending", message="等待处理缺失字体")
            return

        if cancel_event and cancel_event.is_set():
            return
        _task_update(db, task_id, status="pending", message="等待 Windows 转换节点领取任务…")
        with _resource_import_operation(session, wait=True):
            session = _session_for_task(session_id)
            ensure_render_task(session)
        params.update({"workflow_state": "rendering", "preview_status": "rendering"})
        _task_update(db, task_id, status="pending", message="等待 Windows 转换节点领取任务…", progress=0, total=count, params=params)
    except Exception as exc:
        logger.exception("Resource import task %s failed", task_id)
        row = db.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()
        safe_message = import_public_message(exc, rendering=True)
        if row is not None and row["status"] != "cancelled":
            try:
                failed_params = json.loads(row["params"] or "{}")
            except (TypeError, ValueError, json.JSONDecodeError):
                failed_params = {}
            failed_params.update({
                "workflow_state": "awaiting_render",
                "preview_status": "error",
                "preview_error": safe_message,
            })
            _task_update(
                db, task_id, status="failed", message="", error_message=safe_message,
                params=failed_params,
            )
        if session is not None:
            try:
                session["preview_status"] = "error"
                session["preview_error"] = safe_message
                session["expires_at"] = time.time() + 7 * 24 * 3600
                _write_resource_import_session(session)
            except Exception:
                logger.exception("Failed to persist resource import task error %s", task_id)
    finally:
        _pending_task_futures.pop(task_id, None)
        _task_cancel_flags.pop(task_id, None)
        db.close()


def schedule_resource_import_task(task_id: int, session_id: str, semaphore, executor) -> None:
    """Start a durable task without tying it to the request lifetime."""
    async def runner() -> None:
        db = get_db()
        try:
            row = db.execute("SELECT params FROM tasks WHERE id = ?", (task_id,)).fetchone()
            params = json.loads(row["params"] or "{}") if row else {}
            params["workflow_state"] = "queued"
            _task_update(db, task_id, status="pending", message="排队等待处理…", params=params)
        finally:
            db.close()
        async with semaphore:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(executor, _execute_resource_import_task, task_id, session_id)

    future = asyncio.ensure_future(runner())
    _pending_task_futures[task_id] = future

    def done(completed) -> None:
        try:
            completed.result()
        except Exception:
            logger.exception("Resource import task %s stopped unexpectedly", task_id)

    future.add_done_callback(done)


def schedule_resource_import_render(task_id: int, session_id: str, semaphore, executor) -> None:
    """Resume a task after font replacement and render it in the background."""
    schedule_resource_import_task(task_id, session_id, semaphore, executor)
