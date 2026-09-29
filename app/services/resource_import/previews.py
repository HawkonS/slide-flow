"""Create and observe durable PPT preview tasks pulled by Windows."""
from __future__ import annotations

import time
from pathlib import Path

from app.config import settings
from app.services.resource_import.render_tasks import ensure_render_task, render_task_state
from app.services.resource_import.rendering import RESOURCE_IMPORT_RENDERER_VERSION
from app.services.resource_import.sessions import (
    _load_resource_import_session_file,
    _resource_import_file,
    _resource_import_operation,
    _write_resource_import_session,
)


def _preview_set_is_current(session: dict) -> bool:
    return session.get("mode") != "ppt" or (
        session.get("renderer_version") == RESOURCE_IMPORT_RENDERER_VERSION
        and session.get("preview_status") == "ready"
        and len(session.get("preview_paths", [])) == session.get("slide_count")
    )


def _preview_page_events(session: dict, state: dict, sent: set):
    """Emit each accepted page once per worker attempt on this connection."""
    indexes = state.get("ready_indexes")
    if not isinstance(indexes, list):
        indexes = list(range(int(session["slide_count"]))) if _preview_set_is_current(session) else []
    attempt = state.get("render_attempt", session.get("render_attempt", ""))
    worker = state.get("attempts", session.get("render_worker_attempt"))
    for index in sorted(set(indexes)):
        if type(index) is not int or not 0 <= index < int(session["slide_count"]):
            continue
        key = (attempt, worker, index)
        if key in sent:
            continue
        sent.add(key)
        url = f"/api/resource-import/{session['session_id']}/preview/{index}?attempt={attempt}"
        if type(worker) is int and worker > 0:
            url += f"&worker_attempt={worker}"
        yield {"type": "page", "index": index, "preview_url": url}


def _render_and_publish_ppt_previews(session: dict, emit=None, cancel=None) -> list[Path]:
    """Compatibility wrapper that waits for a durable Windows pull task."""
    emit = emit or (lambda _event: None)
    expected = int(session["slide_count"])
    sent: set = set()
    if _preview_set_is_current(session) and not isinstance(session.get("render_task_id"), str):
        paths = [_resource_import_file(session, path) for path in session["preview_paths"]]
        for event in _preview_page_events(session, {"ready_indexes": list(range(expected))}, sent):
            emit(event)
        return paths
    with _resource_import_operation(session, wait=True):
        current = _load_resource_import_session_file(session["session_id"]) or session
        if not _preview_set_is_current(current):
            ensure_render_task(current)
            session.clear()
            session.update(current)
    emit({"type": "progress", "message": "已提交，等待 Windows 转换节点领取任务"})
    deadline = time.monotonic() + max(10, int(settings.render_total_timeout))
    while time.monotonic() < deadline:
        state = render_task_state(session)
        refreshed = _load_resource_import_session_file(session["session_id"])
        if refreshed:
            session.clear()
            session.update(refreshed)
        if state["status"] == "error":
            raise RuntimeError(state.get("message") or "Windows 图片渲染失败")
        for event in _preview_page_events(session, state, sent):
            emit(event)
        if state["status"] == "completed" and _preview_set_is_current(session):
            paths = [_resource_import_file(session, path) for path in session["preview_paths"]]
            return paths
        count = int(state.get("preview_count", 0))
        emit({"type": "progress", "message": f"已完成 {count} / {expected} 页图片渲染" if count else "Windows 正在领取或转换 PPT，请稍候"})
        time.sleep(1)
    session.update(preview_status="error", preview_error="等待 Windows 转换超时，可稍后重试")
    _write_resource_import_session(session)
    raise RuntimeError(session["preview_error"])
