"""System-admin model connection management."""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from app.core.permissions import require_system_admin
from app.routers.dependencies import ApiPayload, db_dep, db_read_dep
from app.services.model_connections import (
    ModelConnectionError,
    connection_credentials,
    connection_row,
    list_remote_models,
    serialize_connection,
    upsert_connection,
)

router = APIRouter()


class ModelConnectionPayload(ApiPayload):
    name: str = Field(..., min_length=1, max_length=100)
    base_url: str = Field(..., min_length=1, max_length=2000)
    api_key: str = Field(default="", max_length=4000)
    model: str = Field(default="", max_length=200)
    is_default: bool = False


class ModelConnectionPatchPayload(ApiPayload):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    base_url: str | None = Field(default=None, min_length=1, max_length=2000)
    api_key: str | None = Field(default=None, max_length=4000)
    model: str | None = Field(default=None, max_length=200)
    is_default: bool | None = None


class ModelConnectionPreviewPayload(ApiPayload):
    base_url: str = Field(..., min_length=1, max_length=2000)
    api_key: str = Field(..., min_length=1, max_length=4000)


def _safe_error(exc: ModelConnectionError) -> HTTPException:
    return HTTPException(404 if str(exc) == "模型连接不存在" else 400, str(exc))


@router.get("/admin/model-connections")
def list_connections(
    _: Any = Depends(require_system_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    rows = db.execute(
        "SELECT * FROM model_connections ORDER BY is_default DESC, name COLLATE NOCASE, id"
    ).fetchall()
    return {"connections": [serialize_connection(row) for row in rows]}


@router.post("/admin/model-connections")
def create_connection(
    payload: ModelConnectionPayload,
    user: sqlite3.Row = Depends(require_system_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    try:
        row = upsert_connection(
            db,
            name=payload.name,
            base_url=payload.base_url,
            api_key=payload.api_key,
            model=payload.model,
            created_by=int(user["id"]),
            is_default=payload.is_default,
        )
    except ModelConnectionError as exc:
        raise _safe_error(exc) from exc
    db.commit()
    return {"connection": serialize_connection(row)}


@router.patch("/admin/model-connections/{connection_id}")
def update_connection(
    connection_id: int,
    payload: ModelConnectionPatchPayload,
    _: Any = Depends(require_system_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    try:
        current = connection_row(db, connection_id)
        row = upsert_connection(
            db,
            name=payload.name if payload.name is not None else str(current["name"]),
            base_url=payload.base_url if payload.base_url is not None else str(current["base_url"]),
            api_key=payload.api_key,
            model=payload.model if payload.model is not None else str(current["model"] or ""),
            created_by=int(current["created_by"] or 0),
            connection_id=connection_id,
            is_default=bool(payload.is_default) if payload.is_default is not None else bool(current["is_default"]),
        )
    except ModelConnectionError as exc:
        raise _safe_error(exc) from exc
    db.commit()
    return {"connection": serialize_connection(row)}


@router.delete("/admin/model-connections/{connection_id}")
def delete_connection(
    connection_id: int,
    _: Any = Depends(require_system_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    try:
        current = connection_row(db, connection_id)
    except ModelConnectionError as exc:
        raise HTTPException(404, str(exc)) from exc
    db.execute("DELETE FROM model_connections WHERE id = ?", (connection_id,))
    if current["is_default"]:
        replacement = db.execute(
            "SELECT id FROM model_connections ORDER BY id LIMIT 1"
        ).fetchone()
        if replacement:
            db.execute("UPDATE model_connections SET is_default = 1 WHERE id = ?", (replacement["id"],))
    db.commit()
    return {"ok": True}


@router.post("/admin/model-connections/{connection_id}/models")
def fetch_models(
    connection_id: int,
    _: Any = Depends(require_system_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    try:
        row = connection_row(db, connection_id)
        base_url, api_key, _ = connection_credentials(row)
        return {"models": list_remote_models(base_url, api_key)}
    except ModelConnectionError as exc:
        raise _safe_error(exc) from exc


@router.post("/admin/model-connections/preview-models")
def preview_models(
    payload: ModelConnectionPreviewPayload,
    _: Any = Depends(require_system_admin),
) -> dict[str, Any]:
    """Fetch models using unsaved credentials without persisting the API key."""
    try:
        return {"models": list_remote_models(payload.base_url, payload.api_key)}
    except ModelConnectionError as exc:
        raise _safe_error(exc) from exc


@router.post("/admin/model-connections/{connection_id}/test")
def test_connection(
    connection_id: int,
    _: Any = Depends(require_system_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    try:
        row = connection_row(db, connection_id)
        base_url, api_key, model = connection_credentials(row)
        models = list_remote_models(base_url, api_key)
        available = {str(item["id"]) for item in models}
        return {"ok": True, "model": model, "model_available": not model or model in available, "model_count": len(models)}
    except ModelConnectionError as exc:
        raise _safe_error(exc) from exc
