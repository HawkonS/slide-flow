"""Routers / resources / remarks."""

from __future__ import annotations

from app.core.permissions import can_manage_resource
from app.core.permissions import can_view_resource
from app.core.permissions import require_user
from app.core.sanitize import sanitize_html
from app.db import now_iso
from app.routers.dependencies import (
    db_dep,
    db_read_dep,
)
from app.schemas.resources import (
    CommonRemarkPayload,
    PersonalRemarkPayload,
)
from app.services.resources import (
    _resource_row,
    _serialize_resource,
    _version_row,
)
from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from fastapi import Query
from typing import Any
import sqlite3

router = APIRouter()


@router.post("/api/resources/{resource_id}/common-remark")
def update_common_remark(
    resource_id: int,
    payload: CommonRemarkPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _resource_row(db, resource_id)
    if not can_manage_resource(db, row, user):
        raise HTTPException(403, "无管理权限")
    if payload.apply_scope not in {"latest", "all", "selected"}:
        raise HTTPException(400, "应用范围不正确")
    if payload.apply_scope == "all":
        db.execute(
            "UPDATE resource_versions SET common_remark_html = ? WHERE resource_id = ?",
            (sanitize_html(payload.content_html), resource_id),
        )
    elif payload.apply_scope == "selected":
        if payload.version_id is None:
            raise HTTPException(400, "请选择版本")
        version = _version_row(db, resource_id, payload.version_id)
        db.execute(
            "UPDATE resource_versions SET common_remark_html = ? WHERE id = ?",
            (sanitize_html(payload.content_html), version["id"]),
        )
    else:
        latest = _version_row(db, resource_id)
        db.execute(
            "UPDATE resource_versions SET common_remark_html = ? WHERE id = ?",
            (sanitize_html(payload.content_html), latest["id"]),
        )
    db.execute("UPDATE resources SET updated_at = ? WHERE id = ?", (now_iso(), resource_id))
    db.commit()
    return {"resource": _serialize_resource(db, row, user)}


@router.get("/api/resources/{resource_id}/personal-remark")
def get_personal_remark(
    resource_id: int,
    version_id: int | None = Query(None),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    row = _resource_row(db, resource_id)
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无可见权限")
    version = _version_row(db, resource_id, version_id)
    remark = db.execute(
        """
        SELECT * FROM personal_remarks
        WHERE resource_id = ? AND version_id = ? AND user_id = ?
        """,
        (resource_id, version["id"], user["id"]),
    ).fetchone()
    return {
        "content_html": sanitize_html(remark["content_html"]) if remark else "",
        "version_id": version["id"],
    }


@router.put("/api/resources/{resource_id}/personal-remark")
def update_personal_remark(
    resource_id: int,
    payload: PersonalRemarkPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, bool]:
    row = _resource_row(db, resource_id)
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无可见权限")
    version = _version_row(db, resource_id, payload.version_id)
    db.execute(
        """
        INSERT INTO personal_remarks (resource_id, version_id, user_id, content_html, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(resource_id, version_id, user_id)
        DO UPDATE SET content_html = excluded.content_html, updated_at = excluded.updated_at
        """,
        (resource_id, version["id"], user["id"], sanitize_html(payload.content_html), now_iso()),
    )
    db.commit()
    return {"ok": True}
