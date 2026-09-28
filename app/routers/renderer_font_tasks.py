"""Pull-based font synchronization API for the Windows renderer."""
from __future__ import annotations

import hmac
import sqlite3
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.db import get_db, is_sqlite_busy_error
from app.services.resource_import.font_tasks import (
    FONT_LEASE_SECONDS,
    claim_font_delete_task,
    claim_font_task,
    ensure_all_font_tasks,
    font_sync_status,
    get_leased_font_task,
    update_font_delete_task,
    update_font_task,
)
from app.routers.fonts import _uploaded_font_abs, _content_disposition

router = APIRouter(prefix="/api/renderer", tags=["renderer-font-tasks"])


def _renderer_auth(authorization: str = Header(default="")) -> None:
    expected = "Bearer " + settings.render_token
    if not settings.render_token or not hmac.compare_digest(authorization, expected):
        raise HTTPException(401, "renderer authentication required")


class FontTaskResult(BaseModel):
    status: str = Field(..., pattern="^(completed|failed)$")
    error_code: str | None = Field(default=None, max_length=80)


def _font_lease_error(exc: Exception) -> HTTPException:
    if isinstance(exc, KeyError):
        return HTTPException(404, "font task not found")
    if isinstance(exc, PermissionError):
        return HTTPException(409, "font task lease is no longer valid")
    return HTTPException(500, "font task update failed")


@router.get("/font-tasks/claim")
def claim(request: Request, _: None = Depends(_renderer_auth)):
    db = get_db()
    try:
        try:
            ensure_all_font_tasks(db)
            db.commit()
            claimed = claim_font_task(db)
            if claimed is None:
                if request.query_params.get("delete_tasks") != "1":
                    return {"task": None}
                deletion = claim_font_delete_task(db)
                if deletion is None:
                    return {"task": None}
                row, lease_token = deletion
                return {"task": {
                    "action": "delete",
                    "task_id": row["task_id"],
                    "lease_token": lease_token,
                    "lease_seconds": FONT_LEASE_SECONDS,
                    "sha256": row["sha256"],
                    "file_name": row["file_name"],
                    "attempts": int(row["attempts"]),
                }}
            row, lease_token = claimed
            path = _uploaded_font_abs(row["file_path"])
            if path is None or not path.is_file():
                try:
                    update_font_task(db, row["task_id"], lease_token, "failed", "font_file_missing")
                except Exception:
                    pass
                return {"task": None}
            return {"task": {
                "action": "install",
                "task_id": row["task_id"],
                "lease_token": lease_token,
                "lease_seconds": FONT_LEASE_SECONDS,
                "font_id": int(row["font_id"]),
                "sha256": row["sha256"],
                "size": path.stat().st_size,
                "file_name": row["file_name"],
                "download_url": f"/api/renderer/font-tasks/{row['task_id']}/file",
                "attempts": int(row["attempts"]),
            }}
        except sqlite3.OperationalError as exc:
            if not is_sqlite_busy_error(exc):
                raise
            db.rollback()
            return {"task": None}
    finally:
        db.close()


@router.get("/font-tasks/{task_id}/file")
def download(
    task_id: str,
    request: Request,
    _: None = Depends(_renderer_auth),
):
    db = get_db()
    try:
        try:
            lease_token = request.headers.get("x-render-lease", "")
            row = get_leased_font_task(
                db, task_id, lease_token, allow_legacy=not lease_token,
            )
        except Exception as exc:
            raise _font_lease_error(exc) from exc
        path = _uploaded_font_abs(row["file_path"])
        if path is None or not path.is_file():
            raise HTTPException(404, "font file not found")
        return FileResponse(path, media_type="application/octet-stream",
                            headers={"Content-Disposition": _content_disposition(row["file_name"])})
    finally:
        db.close()


@router.post("/font-tasks/{task_id}/result")
def result(
    task_id: str, payload: FontTaskResult, request: Request,
    _: None = Depends(_renderer_auth),
):
    db = get_db()
    try:
        try:
            is_deletion = db.execute(
                "SELECT 1 FROM renderer_font_delete_tasks WHERE task_id=?", (task_id,),
            ).fetchone() is not None
            lease_token = request.headers.get("x-render-lease", "")
            if is_deletion:
                status = update_font_delete_task(
                    db, task_id, lease_token, payload.status, payload.error_code,
                )
            else:
                status = update_font_task(
                    db, task_id, lease_token, payload.status, payload.error_code,
                    allow_legacy=not lease_token,
                )
        except Exception as exc:
            raise _font_lease_error(exc) from exc
        return {"ok": True, "status": status}
    finally:
        db.close()


@router.get("/font-sync/status")
def status(_: None = Depends(_renderer_auth)):
    db = get_db()
    try:
        return font_sync_status(db)
    finally:
        db.close()
