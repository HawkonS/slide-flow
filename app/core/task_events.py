"""SQLite-backed task event stream used by WebSocket workers."""

from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any


logger = logging.getLogger(__name__)

TASK_EVENT_BATCH_SIZE = 100


def append_task_event(
    db: sqlite3.Connection,
    owner_id: int,
    message: dict[str, Any],
) -> int:
    """Append an event using the caller's transaction."""
    event_type = str(message.get("type") or "").strip()
    if not event_type:
        raise ValueError("task event requires a non-empty type")

    payload = dict(message)
    payload.pop("event_id", None)
    raw_task_id = payload.get("task_id")
    task_id = int(raw_task_id) if raw_task_id is not None else None
    cursor = db.execute(
        """
        INSERT INTO task_events (owner_id, task_id, event_type, payload)
        VALUES (?, ?, ?, ?)
        """,
        (
            int(owner_id),
            task_id,
            event_type,
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        ),
    )
    return int(cursor.lastrowid)


def latest_task_event_id(owner_id: int) -> int:
    """Return the newest event id visible to one user."""
    from app.db import get_read_db, release_db

    db = get_read_db()
    try:
        row = db.execute(
            "SELECT COALESCE(MAX(id), 0) AS event_id FROM task_events WHERE owner_id = ?",
            (int(owner_id),),
        ).fetchone()
        return int(row["event_id"] if row else 0)
    finally:
        release_db(db, readonly=True)


def fetch_task_events(
    owner_id: int,
    after_event_id: int,
    limit: int = TASK_EVENT_BATCH_SIZE,
) -> list[tuple[int, dict[str, Any] | None]]:
    """Read ordered events without consuming them.

    Invalid payloads are returned as ``None`` so callers can still advance the
    cursor and avoid retrying a corrupt row forever.
    """
    from app.db import get_read_db, release_db

    safe_limit = max(1, min(int(limit), 500))
    db = get_read_db()
    try:
        rows = db.execute(
            """
            SELECT id, payload
            FROM task_events
            WHERE owner_id = ? AND id > ?
            ORDER BY id
            LIMIT ?
            """,
            (int(owner_id), max(0, int(after_event_id)), safe_limit),
        ).fetchall()
    finally:
        release_db(db, readonly=True)

    events: list[tuple[int, dict[str, Any] | None]] = []
    for row in rows:
        event_id = int(row["id"])
        try:
            payload = json.loads(row["payload"])
            if not isinstance(payload, dict):
                raise TypeError("event payload is not an object")
            payload["event_id"] = event_id
        except (json.JSONDecodeError, TypeError, ValueError):
            logger.warning("Ignoring invalid task event payload event_id=%s", event_id)
            payload = None
        events.append((event_id, payload))
    return events
