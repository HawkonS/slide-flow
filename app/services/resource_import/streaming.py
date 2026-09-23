"""NDJSON status stream for durable pull-based preview rendering."""
from __future__ import annotations

import asyncio
import json
import time

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from app.services.resource_import.previews import _preview_set_is_current
from app.services.resource_import.render_tasks import ensure_render_task, render_task_state
from app.services.resource_import.sessions import (
    _load_resource_import_session_file,
    _resource_import_operation,
    _resource_import_session,
)


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
                ensure_render_task(current)

    async def body():
        def encode(event):
            return json.dumps(event, ensure_ascii=False) + "\n"

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
                yield encode({"type": "error", "message": state.get("message") or "Windows 图片渲染失败，请重试"})
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
