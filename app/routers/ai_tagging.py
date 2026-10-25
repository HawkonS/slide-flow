"""Routes for starting and confirming AI tag suggestions."""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field

from app.core.permissions import require_user
from app.routers.dependencies import ApiPayload, db_dep
from app.services.ai_tagging import (
    apply_tagging_result,
    create_tagging_task,
    create_tagging_tasks,
)
from app.services.model_connections import ModelConnectionError

router = APIRouter()


class ApplyTaggingPayload(ApiPayload):
    tags: list[str] = Field(default_factory=list, max_length=8)
    final_tags: list[str] | None = Field(default=None, max_length=1000)


class BatchTaggingPayload(ApiPayload):
    resource_ids: list[int] = Field(..., min_length=1, max_length=1000)


def _start_error(exc: Exception) -> HTTPException:
    if isinstance(exc, HTTPException):
        return exc
    if isinstance(exc, PermissionError):
        return HTTPException(403, str(exc))
    if isinstance(exc, ModelConnectionError):
        return HTTPException(400, str(exc))
    if isinstance(exc, LookupError):
        return HTTPException(404, str(exc))
    if isinstance(exc, ValueError):
        return HTTPException(400, str(exc))
    return HTTPException(400, "无法开始智能标注")


@router.post("/api/ai-tagging/resources/batch")
async def tag_resources_batch(
    payload: BatchTaggingPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    try:
        tasks = create_tagging_tasks(db, user, payload.resource_ids)
    except Exception as exc:
        raise _start_error(exc) from exc
    return {"tasks": tasks, "status": "pending"}


@router.post("/api/ai-tagging/resources/{resource_id}")
async def tag_resource(
    resource_id: int,
    version_id: int | None = Query(default=None, ge=1),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    try:
        task_id = create_tagging_task(db, user, resource_id, version_id)
    except Exception as exc:
        raise _start_error(exc) from exc
    return {"task_id": task_id, "status": "pending"}


@router.post("/api/ai-tagging/tasks/{task_id}/apply")
def apply_tags(
    task_id: int,
    payload: ApplyTaggingPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    try:
        result = apply_tagging_result(db, user, task_id, payload.tags, payload.final_tags)
    except Exception as exc:
        raise _start_error(exc) from exc
    return {"ok": True, **result}
