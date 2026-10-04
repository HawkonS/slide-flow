"""Routers / shows / remarks."""

from __future__ import annotations

from app.core.permissions import can_view_show, can_view_resource
from app.core.permissions import require_user
from app.core.sanitize import sanitize_html
from app.db import now_iso
from app.routers.dependencies import (
    db_dep,
    db_read_dep,
)
from app.schemas.shows import (
    ShowRemarkPayload,
)
from app.services.shows import (
    _show_row,
)
from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from typing import Any
import sqlite3

router = APIRouter()


def _require_show_page(db: sqlite3.Connection, show_id: int, resource_id: int, user: sqlite3.Row) -> None:
    show = _show_row(db, show_id)
    if not can_view_show(db, show, user):
        raise HTTPException(403, "无可见权限")
    # Archived versions remain usable while a show still pins them.
    resource = db.execute(
        "SELECT r.* FROM show_resources sr "
        "JOIN resources r ON r.id = sr.resource_id "
        "JOIN resource_versions v ON v.resource_id = sr.resource_id AND v.version_no = sr.version_no "
        "WHERE sr.show_id = ? AND sr.resource_id = ?",
        (show_id, resource_id),
    ).fetchone()
    if resource is None:
        raise HTTPException(404, "放映中未找到有效的素材页面，请刷新后重试")
    if not can_view_resource(db, resource, user):
        raise HTTPException(403, "无素材可见权限")


@router.get("/api/shows/{show_id}/remarks/{resource_id}")
def get_show_remark(
    show_id: int,
    resource_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    _require_show_page(db, show_id, resource_id, user)
    remark_row = db.execute(
        "SELECT content_html FROM show_remarks WHERE show_id = ? AND resource_id = ? AND user_id = ?",
        (show_id, resource_id, user["id"]),
    ).fetchone()
    return {"content_html": sanitize_html(remark_row["content_html"]) if remark_row else ""}


@router.put("/api/shows/{show_id}/remarks/{resource_id}")
def update_show_remark(
    show_id: int,
    resource_id: int,
    payload: ShowRemarkPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    _require_show_page(db, show_id, resource_id, user)
    ts = now_iso()
    db.execute(
        """
        INSERT INTO show_remarks (show_id, resource_id, user_id, content_html, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(show_id, resource_id, user_id) DO UPDATE SET content_html = excluded.content_html, updated_at = excluded.updated_at
        """,
        (show_id, resource_id, user["id"], sanitize_html(payload.content_html), ts),
    )
    db.commit()
    return {"content_html": sanitize_html(payload.content_html)}
