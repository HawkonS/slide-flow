"""Routers / task events."""

from __future__ import annotations

from app.config import settings
from app.core.permissions import SESSION_COOKIE
from app.core.security import read_session_claims
from app.core.task_events import fetch_task_events
from app.core.task_events import latest_task_event_id
from fastapi import APIRouter
from fastapi import WebSocket
from fastapi import WebSocketDisconnect
import asyncio
import logging

logger = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/ws/tasks")
async def ws_tasks(websocket: WebSocket) -> None:
    """Stream durable task events for the authenticated user."""
    cookie_token = websocket.cookies.get(SESSION_COOKIE)
    claims = read_session_claims(cookie_token, settings.secret_key) if cookie_token else None
    if not claims:
        # 未认证：拒绝握手
        await websocket.close(code=1008)
        return
    user_id, session_version = claims
    from app.db import get_read_db, release_db
    db = get_read_db()
    try:
        user = db.execute(
            "SELECT session_version, must_change_pwd FROM users WHERE id = ?", (int(user_id),)
        ).fetchone()
    finally:
        release_db(db, readonly=True)
    if user is None or int(user["session_version"]) != int(session_version) or user["must_change_pwd"]:
        await websocket.close(code=1008)
        return
    user_id = int(user_id)

    latest_event_id = await asyncio.to_thread(latest_task_event_id, user_id)
    after_raw = websocket.query_params.get("after")
    if after_raw is None:
        event_cursor = latest_event_id
    else:
        try:
            event_cursor = min(max(0, int(after_raw)), latest_event_id)
        except ValueError:
            await websocket.close(code=1008)
            return

    await websocket.accept()
    await websocket.send_json({"type": "event_cursor", "event_id": event_cursor})
    loop = asyncio.get_running_loop()
    next_ping_at = loop.time() + 30.0
    try:
        while True:
            try:
                events = await asyncio.to_thread(
                    fetch_task_events,
                    user_id,
                    event_cursor,
                )
            except Exception:
                logger.warning(
                    "Task event poll failed user_id=%s after=%s",
                    user_id,
                    event_cursor,
                    exc_info=True,
                )
                await asyncio.sleep(1)
                continue

            for event_id, payload in events:
                if payload is not None:
                    await websocket.send_json(payload)
                event_cursor = event_id
            if len(events) >= 100:
                continue

            now = loop.time()
            if now >= next_ping_at:
                await websocket.send_json({"type": "ping"})
                next_ping_at = now + 30.0

            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=0.75)
            except asyncio.TimeoutError:
                pass
            except WebSocketDisconnect:
                break
            except Exception:
                break
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
