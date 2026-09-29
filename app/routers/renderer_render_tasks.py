"""Pull-based PPT rendering API consumed by Windows workers."""
from __future__ import annotations

import asyncio
import re
import sqlite3
import time

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.db import get_db, is_sqlite_busy_error
from app.core.errors import storage_public_message
from app.core.oss import StorageConfigurationError, StorageUnavailableError
from app.routers.renderer_font_tasks import _renderer_auth
from app.services.resource_import.render_tasks import (
    claim_payload,
    claim_render_task,
    complete_render_task,
    fail_render_task,
    publish_render_task_progress,
    refresh_render_task_source_url,
    refresh_render_task_urls,
    render_queue_status,
    touch_renderer_worker,
    renew_render_task,
)

router = APIRouter(prefix="/api/renderer", tags=["renderer-render-tasks"])
WORKER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class LeaseRequest(BaseModel):
    lease_token: str = Field(..., min_length=32, max_length=256)


class UrlRequest(LeaseRequest):
    page_index: int = Field(..., ge=0, le=100_000)
    include_source: bool = True


class RenderedPage(BaseModel):
    index: int = Field(..., ge=0, le=100_000)
    size: int = Field(..., gt=0, le=64 * 1024 * 1024)
    sha256: str = Field(..., pattern=r"^[0-9a-f]{64}$")


class CompleteRequest(LeaseRequest):
    pages: list[RenderedPage] = Field(..., min_length=1, max_length=500)


class FailedRequest(LeaseRequest):
    error_code: str = Field(default="render_failed", min_length=1, max_length=80)


def _lease_error(exc: Exception) -> HTTPException:
    if isinstance(exc, KeyError):
        return HTTPException(404, "render task not found")
    if isinstance(exc, PermissionError):
        return HTTPException(409, "render task lease is no longer valid")
    if isinstance(exc, ValueError):
        return HTTPException(400, "render task result is invalid")
    if isinstance(exc, (StorageConfigurationError, StorageUnavailableError)):
        return HTTPException(503, storage_public_message(exc) or "对象存储暂时不可用，请稍后重试")
    return HTTPException(500, "render task update failed")


@router.get("/render-tasks/claim")
async def claim(
    worker_id: str = Query(..., min_length=1, max_length=128),
    wait_seconds: int = Query(25, ge=0, le=25),
    _: None = Depends(_renderer_auth),
):
    if not WORKER_ID.fullmatch(worker_id):
        raise HTTPException(400, "worker_id is invalid")
    deadline = time.monotonic() + wait_seconds
    db = get_db()
    try:
        try:
            touch_renderer_worker(db, worker_id, state="polling")
            db.commit()
        except sqlite3.OperationalError as exc:
            if not is_sqlite_busy_error(exc):
                raise
            db.rollback()
    finally:
        db.close()
    while True:
        claimed = None
        db = get_db()
        try:
            try:
                claimed = claim_render_task(db, worker_id)
                if claimed is not None:
                    touch_renderer_worker(db, worker_id, state="running", task_id=str(claimed[0]["task_id"]))
                    db.commit()
            except sqlite3.OperationalError as exc:
                if not is_sqlite_busy_error(exc):
                    raise
                db.rollback()
        finally:
            db.close()
        if claimed is not None:
            row, lease_token = claimed
            return {"task": claim_payload(row, lease_token)}
        if time.monotonic() >= deadline:
            return {"task": None}
        await asyncio.sleep(min(1.0, max(0.05, deadline - time.monotonic())))


@router.get("/render-tasks/status")
def status(_: None = Depends(_renderer_auth)):
    db = get_db()
    try:
        return render_queue_status(db)
    finally:
        db.close()


@router.post("/render-tasks/{task_id}/renew")
def renew(task_id: str, payload: LeaseRequest, _: None = Depends(_renderer_auth)):
    db = get_db()
    try:
        try:
            lease_until = renew_render_task(db, task_id, payload.lease_token)
            row = db.execute("SELECT worker_id FROM renderer_ppt_tasks WHERE task_id=?", (task_id,)).fetchone()
            if row and row["worker_id"]:
                touch_renderer_worker(db, str(row["worker_id"]), state="running", task_id=task_id)
                db.commit()
        except Exception as exc:
            raise _lease_error(exc) from exc
        return {"ok": True, "lease_until": lease_until}
    finally:
        db.close()


@router.post("/render-tasks/{task_id}/urls")
def urls(task_id: str, payload: UrlRequest, _: None = Depends(_renderer_auth)):
    db = get_db()
    try:
        try:
            page = refresh_render_task_urls(
                db, task_id, payload.lease_token, payload.page_index,
                include_source=payload.include_source,
            )
        except Exception as exc:
            raise _lease_error(exc) from exc
        return {"page": page}
    finally:
        db.close()


@router.post("/render-tasks/{task_id}/source-url")
def source_url(task_id: str, payload: LeaseRequest, _: None = Depends(_renderer_auth)):
    db = get_db()
    try:
        try:
            source = refresh_render_task_source_url(db, task_id, payload.lease_token)
        except Exception as exc:
            raise _lease_error(exc) from exc
        return {"source": source}
    finally:
        db.close()


@router.post("/render-tasks/{task_id}/progress")
def progress(task_id: str, payload: CompleteRequest, _: None = Depends(_renderer_auth)):
    db = get_db()
    try:
        try:
            return publish_render_task_progress(
                db, task_id, payload.lease_token,
                [page.model_dump() for page in payload.pages],
            )
        except Exception as exc:
            raise _lease_error(exc) from exc
    finally:
        db.close()


@router.post("/render-tasks/{task_id}/complete")
def complete(task_id: str, payload: CompleteRequest, _: None = Depends(_renderer_auth)):
    db = get_db()
    try:
        try:
            complete_render_task(
                db, task_id, payload.lease_token,
                [page.model_dump() for page in payload.pages],
            )
        except Exception as exc:
            raise _lease_error(exc) from exc
        return {"ok": True, "status": "completed"}
    finally:
        db.close()


@router.post("/render-tasks/{task_id}/failed")
def failed(task_id: str, payload: FailedRequest, _: None = Depends(_renderer_auth)):
    db = get_db()
    try:
        try:
            status = fail_render_task(db, task_id, payload.lease_token, payload.error_code)
        except Exception as exc:
            raise _lease_error(exc) from exc
        return {"ok": True, "status": status}
    finally:
        db.close()
