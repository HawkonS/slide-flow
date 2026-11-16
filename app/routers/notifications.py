"""Current-user notification feed endpoints."""

from __future__ import annotations

import sqlite3
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query

from app.core.permissions import require_user
from app.routers.dependencies import db_dep, db_read_dep
from app.services.notifications import (
    list_task_notifications,
    mark_all_task_notifications_read,
    mark_task_notification_read,
    mark_task_notification_unread,
    parse_cursor,
    parse_notification_id,
    unread_task_notification_count,
)

router = APIRouter()


@router.get("/me/notifications")
def list_my_notifications(
    box: Literal["all", "unread", "read"] = Query("all", alias="filter"),
    limit: int = Query(20, ge=1, le=50),
    cursor: str | None = Query(None, max_length=80),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """List the current user's derived task notifications.

    ``filter`` selects the unread/read box; ``cursor`` is the opaque value from
    the previous page's ``next_cursor``.  Terminal archived tasks stay in the
    feed so "all history" is not silently truncated by task-list retention.
    """
    if cursor is not None and parse_cursor(cursor) is None:
        raise HTTPException(400, "分页游标无效")
    return list_task_notifications(
        db,
        int(user["id"]),
        box=box,
        limit=limit,
        cursor=cursor,
    )


@router.get("/me/notifications/unread-count")
def my_notifications_unread_count(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, int]:
    """Return the current user's server-side unread notification count."""
    return {"count": unread_task_notification_count(db, int(user["id"]))}


@router.post("/me/notifications/{notification_id}/read")
def read_notification(
    notification_id: str = Path(..., max_length=64),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """Mark one own task notification as read (idempotent)."""
    if parse_notification_id(notification_id) is None:
        raise HTTPException(400, "通知标识无效")
    result = mark_task_notification_read(db, int(user["id"]), notification_id)
    if result is None:
        # Do not reveal whether another user's task exists.
        raise HTTPException(404, "通知不存在")
    return {
        "ok": True,
        **result,
        "unread_count": unread_task_notification_count(db, int(user["id"])),
    }


@router.delete("/me/notifications/{notification_id}/read")
def unread_notification(
    notification_id: str = Path(..., max_length=64),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """Move one own task notification back to unread (idempotent)."""
    if parse_notification_id(notification_id) is None:
        raise HTTPException(400, "通知标识无效")
    result = mark_task_notification_unread(db, int(user["id"]), notification_id)
    if result is None:
        raise HTTPException(404, "通知不存在")
    return {
        "ok": True,
        **result,
        "unread_count": unread_task_notification_count(db, int(user["id"])),
    }


@router.post("/me/notifications/read-all")
def read_all_notifications(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """Mark every unread own task notification as read."""
    marked = mark_all_task_notifications_read(db, int(user["id"]))
    return {
        "ok": True,
        "marked": marked,
        "unread_count": unread_task_notification_count(db, int(user["id"])),
    }
