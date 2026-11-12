"""Find and merge duplicate single-page resources."""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Body, Depends

from app.core.permissions import require_user
from app.routers.dependencies import db_dep
from app.services.resource_duplicates import merge_duplicates, scan_duplicates

router = APIRouter()


@router.post("/api/resources/duplicates/scan")
def scan_resource_duplicates(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    return scan_duplicates(db, user)


@router.post("/api/resources/duplicates/merge")
def merge_resource_duplicates(
    payload: dict[str, Any] = Body(...),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    return merge_duplicates(
        db,
        payload.get("canonical_id"),
        payload.get("duplicate_ids"),
        user,
        acknowledge_foreign=payload.get("acknowledge_foreign") is True,
    )
