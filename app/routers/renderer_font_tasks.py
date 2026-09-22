"""Pull-based font synchronization API for the Windows renderer."""
from __future__ import annotations

import hmac
import sqlite3
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.db import get_db
from app.services.resource_import.font_tasks import (
    claim_font_task,
    ensure_all_font_tasks,
    font_sync_status,
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


@router.get("/font-tasks/claim")
def claim(_: None = Depends(_renderer_auth)):
    db = get_db()
    try:
        ensure_all_font_tasks(db)
        row = claim_font_task(db)
        if row is None:
            return {"task": None}
        return {"task": {
            "task_id": row["task_id"],
            "font_id": int(row["font_id"]),
            "sha256": row["sha256"],
            "file_name": row["file_name"],
            "download_url": f"/api/renderer/font-tasks/{row['task_id']}/file",
            "attempts": int(row["attempts"]),
        }}
    finally:
        db.close()


@router.get("/font-tasks/{task_id}/file")
def download(task_id: str, _: None = Depends(_renderer_auth)):
    db = get_db()
    try:
        row = db.execute("SELECT t.*, f.file_name, f.file_path FROM renderer_font_tasks t JOIN fonts f ON f.id=t.font_id WHERE t.task_id=?", (task_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "font task not found")
        path = _uploaded_font_abs(row["file_path"])
        if path is None or not path.is_file():
            raise HTTPException(404, "font file not found")
        return FileResponse(path, media_type="application/octet-stream",
                            headers={"Content-Disposition": _content_disposition(row["file_name"])})
    finally:
        db.close()


@router.post("/font-tasks/{task_id}/result")
def result(task_id: str, payload: FontTaskResult, _: None = Depends(_renderer_auth)):
    db = get_db()
    try:
        exists = db.execute("SELECT 1 FROM renderer_font_tasks WHERE task_id=?", (task_id,)).fetchone()
        if exists is None:
            raise HTTPException(404, "font task not found")
        update_font_task(db, task_id, payload.status, payload.error_code)
        return {"ok": True, "status": payload.status}
    finally:
        db.close()


@router.get("/font-sync/status")
def status(_: None = Depends(_renderer_auth)):
    db = get_db()
    try:
        return font_sync_status(db)
    finally:
        db.close()
