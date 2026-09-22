"""NDJSON transport with cancellation that outlives the response safely."""
from __future__ import annotations
import asyncio
import json
import logging
import queue
import threading
import time
import anyio
import json
from app.db import get_db
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from app.services.resource_import.jobs import _run_resource_import_job
from app.services.resource_import.previews import _render_and_publish_ppt_previews
from app.services.resource_import.sessions import _resource_import_operation, _resource_import_session

logger = logging.getLogger(__name__)


def preview_stream(session_id, user):
    session = _resource_import_session(session_id, user)
    lease = _resource_import_operation(session)
    lease.__enter__()
    try:
        session = _resource_import_session(session_id, user)
        if "commit_result" in session:
            raise HTTPException(410, "导入会话已提交")
        if session.get("missing_fonts"):
            raise HTTPException(400, "请先处理不在标准字体库中的字体")
    except BaseException:
        lease.__exit__(None, None, None)
        raise
    cancelled = threading.Event()
    events = queue.Queue(maxsize=32)

    def emit(event):
        while not cancelled.is_set():
            try:
                events.put(event, timeout=0.2)
                return
            except queue.Full:
                continue
        from app.services.resource_import.remote_renderer import RenderCancelled
        raise RenderCancelled("客户端已停止接收")

    async def run():
        try:
            paths = await _run_resource_import_job(_render_and_publish_ppt_previews, session, emit, cancelled)
            task_id = session.get("task_id")
            if isinstance(task_id, int):
                db = get_db()
                try:
                    row = db.execute("SELECT params FROM tasks WHERE id = ?", (task_id,)).fetchone()
                    params = json.loads(row["params"] or "{}") if row else {}
                    params.update({"workflow_state": "awaiting_confirmation", "preview_status": "ready"})
                    db.execute(
                        "UPDATE tasks SET status = 'pending', progress = ?, total = ?, message = '图片已渲染，等待确认导入', params = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id = ? AND status <> 'cancelled'",
                        (len(paths), len(paths), json.dumps(params, ensure_ascii=False), task_id),
                    )
                    db.commit()
                finally:
                    db.close()
            return {"type": "completed", "preview_status": "ready", "preview_count": len(paths)}
        except Exception as exc:
            logger.warning("WPS preview failed session=%s: %s", session_id, type(exc).__name__)
            task_id = session.get("task_id")
            if isinstance(task_id, int):
                db = get_db()
                try:
                    db.execute("UPDATE tasks SET status = ?, error_message = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id = ? AND status <> 'cancelled'", ("pending" if cancelled.is_set() else "failed", None if cancelled.is_set() else "图片渲染失败，请重试", task_id))
                    db.commit()
                finally:
                    db.close()
            return {"type": "error", "message": getattr(exc, "detail", None) or str(exc) or "图片渲染失败，可单独重试"}
        finally:
            lease.__exit__(None, None, None)

    worker = asyncio.create_task(run())

    async def body():
        def encode(event):
            return json.dumps(event, ensure_ascii=False) + "\n"
        try:
            yield encode({"type": "started", "total": session["slide_count"], "message": "已开始生成高清预览"})
            heartbeat = time.monotonic()
            while not worker.done() or not events.empty():
                try:
                    yield encode(events.get_nowait())
                except queue.Empty:
                    if time.monotonic() - heartbeat >= 5:
                        yield encode({"type": "heartbeat"})
                        heartbeat = time.monotonic()
                    await asyncio.sleep(0.05)
            yield encode(await worker)
        finally:
            cancelled.set()
            # A disconnect must not release the underlying thread's file lease.
            with anyio.CancelScope(shield=True):
                while not worker.done():
                    try:
                        await asyncio.shield(worker)
                    except asyncio.CancelledError:
                        continue
            if not worker.cancelled():
                worker.exception()

    return StreamingResponse(body(), media_type="application/x-ndjson", headers={
        # Starlette's GZipMiddleware buffers small NDJSON writes until its
        # compressor flushes. Explicit identity keeps each page/heartbeat live.
        "Content-Encoding": "identity", "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff",
    })
