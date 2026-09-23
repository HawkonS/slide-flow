"""Permission-aware, preview-only share links for single-page resources."""

from __future__ import annotations

from app.core.oss import is_oss_ref
from app.core.permissions import can_manage_resource, require_user
from app.db import now_iso
from app.routers.dependencies import db_dep, db_read_dep
from app.schemas.resources import ShareLinkPayload
from app.services.files import _safe_abs, asset_preview_url
from app.core.sanitize import sanitize_html
from app.services.resources import _resource_row, _version_row
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, RedirectResponse
import hashlib
import re
import secrets
import sqlite3
from datetime import datetime, timedelta
from typing import Any


router = APIRouter()

_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def _share_not_found() -> HTTPException:
    # Do not reveal whether a resource or token ever existed.
    return HTTPException(404, "分享链接不存在或已过期")


def _share_row(db: sqlite3.Connection, token: str) -> sqlite3.Row:
    if not _TOKEN_RE.fullmatch(token):
        raise _share_not_found()
    row = db.execute(
        """
        SELECT st.*, r.name, r.subject, r.tags, r.status, r.secrecy_level,
               r.current_version, r.updated_at
        FROM resource_share_tokens st
        JOIN resources r ON r.id = st.resource_id
        WHERE st.token_hash = ?
        """,
        (_token_hash(token),),
    ).fetchone()
    if row is None:
        raise _share_not_found()
    now = now_iso()
    if row["revoked_at"] or row["expires_at"] <= now or row["status"] != "active":
        raise _share_not_found()
    return row


def _public_share_payload(db: sqlite3.Connection, row: sqlite3.Row, token: str) -> dict[str, Any]:
    version = _version_row(db, int(row["resource_id"]))
    return {
        "resource": {
            "id": int(row["resource_id"]),
            "name": row["name"],
            "subject": row["subject"] or "",
            "tags": row["tags"] or "",
            "secrecy_level": row["secrecy_level"],
            "current_version": int(row["current_version"]),
            "updated_at": row["updated_at"],
            "version": {
                "id": int(version["id"]),
                "version_no": int(version["version_no"]),
                "change_note": version["change_note"],
                "common_remark_html": sanitize_html(version["common_remark_html"] or ""),
                "created_at": version["created_at"],
            },
            "preview_url": f"/api/resource-shares/{token}/preview",
        },
        "expires_at": row["expires_at"],
    }


@router.post("/api/resources/{resource_id}/share-links")
def create_share_link(
    resource_id: int,
    payload: ShareLinkPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _resource_row(db, resource_id)
    if not can_manage_resource(db, row, user):
        raise HTTPException(403, "无管理权限，不能创建分享链接")
    if row["status"] != "active":
        raise HTTPException(400, "已停用素材不能创建分享链接")
    token = secrets.token_urlsafe(32)
    created_at = now_iso()
    expires_at = (datetime.utcnow() + timedelta(days=payload.expires_in_days)).isoformat(timespec="seconds") + "Z"
    db.execute(
        """
        INSERT INTO resource_share_tokens
            (resource_id, token_hash, created_by, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (resource_id, _token_hash(token), int(user["id"]), expires_at, created_at),
    )
    link_id = int(db.execute("SELECT last_insert_rowid()").fetchone()[0])
    db.commit()
    return {
        "id": link_id,
        "token": token,
        "expires_at": expires_at,
        "share_path": f"/share/resources/{token}",
    }


@router.get("/api/resources/{resource_id}/share-links")
def list_share_links(
    resource_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    row = _resource_row(db, resource_id)
    if not can_manage_resource(db, row, user):
        raise HTTPException(403, "无管理权限")
    rows = db.execute(
        """
        SELECT id, created_by, expires_at, revoked_at, created_at
        FROM resource_share_tokens
        WHERE resource_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 20
        """,
        (resource_id,),
    ).fetchall()
    return {"items": [{key: item[key] for key in item.keys()} for item in rows]}


@router.delete("/api/resources/{resource_id}/share-links/{link_id}")
def revoke_share_link(
    resource_id: int,
    link_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, bool]:
    row = _resource_row(db, resource_id)
    if not can_manage_resource(db, row, user):
        raise HTTPException(403, "无管理权限")
    cursor = db.execute(
        """
        UPDATE resource_share_tokens
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ? AND resource_id = ?
        """,
        (now_iso(), link_id, resource_id),
    )
    if cursor.rowcount == 0:
        raise HTTPException(404, "分享链接不存在")
    db.commit()
    return {"ok": True}


@router.get("/api/resource-shares/{token}/preview")
def shared_resource_preview(
    token: str,
    db: sqlite3.Connection = Depends(db_read_dep),
):
    row = _share_row(db, token)
    version = _version_row(db, int(row["resource_id"]))
    if not version["png_path"]:
        raise _share_not_found()
    if is_oss_ref(version["png_path"]):
        url = asset_preview_url(version["png_path"])
        if not url:
            raise HTTPException(503, "预览图暂不可用")
        return RedirectResponse(url, status_code=307, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})
    path = _safe_abs(version["png_path"])
    if path is None or not path.exists():
        raise _share_not_found()
    return FileResponse(path, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@router.get("/api/resource-shares/{token}")
def get_shared_resource(
    token: str,
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    row = _share_row(db, token)
    return _public_share_payload(db, row, token)
