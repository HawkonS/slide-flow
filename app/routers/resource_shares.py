"""Permission-aware, preview-only share links for single-page resources."""

from __future__ import annotations

from app.config import settings
from app.core.oss import is_oss_ref
from app.core.permissions import can_view_resource, is_system_admin, require_user
from app.db import now_iso
from app.routers.dependencies import db_dep, db_read_dep
from app.schemas.resources import ShareLinkPayload
from app.services.files import _safe_abs, asset_preview_url
from app.core.sanitize import sanitize_html
from app.services.resources import _resource_row, _version_row
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, RedirectResponse
import base64
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


def _token_cipher() -> Fernet:
    digest = hashlib.sha256(
        f"slide-flow-resource-share:{settings.secret_key}".encode("utf-8")
    ).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _encrypt_token(token: str) -> str:
    return _token_cipher().encrypt(token.encode("ascii")).decode("ascii")


def _decrypt_token(value: str | None) -> str | None:
    if not value:
        return None
    try:
        token = _token_cipher().decrypt(value.encode("ascii")).decode("ascii")
    except (InvalidToken, UnicodeError, ValueError):
        return None
    return token if _TOKEN_RE.fullmatch(token) else None


def _share_not_found() -> HTTPException:
    # Do not reveal whether a resource or token ever existed.
    return HTTPException(404, "分享链接不存在或已过期")


def _share_row(db: sqlite3.Connection, token: str) -> sqlite3.Row:
    if not _TOKEN_RE.fullmatch(token):
        raise _share_not_found()
    row = db.execute(
        """
        SELECT st.*, r.name, r.subject, r.tags, r.status, r.secrecy_level,
               r.current_version, r.updated_at, r.detail_token
        FROM resource_share_tokens st
        JOIN resources r ON r.id = st.resource_id
        WHERE st.token_hash = ?
        """,
        (_token_hash(token),),
    ).fetchone()
    if row is None:
        raise _share_not_found()
    now = now_iso()
    if row["revoked_at"] or row["expires_at"] <= now:
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
            "detail_path": f"/resources/{row['detail_token']}",
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
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无权查看该素材")
    token = secrets.token_urlsafe(32)
    created_at = now_iso()
    expires_at = (datetime.utcnow() + timedelta(days=payload.expires_in_days)).isoformat(timespec="seconds") + "Z"
    db.execute(
        """
        INSERT INTO resource_share_tokens
            (resource_id, token_hash, token_ciphertext, created_by, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            resource_id,
            _token_hash(token),
            _encrypt_token(token),
            int(user["id"]),
            expires_at,
            created_at,
        ),
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
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无权查看该素材")
    owner_clause = "" if is_system_admin(user) else " AND created_by = :share_creator"
    params: dict[str, Any] = {"resource_id": resource_id}
    if not is_system_admin(user):
        params["share_creator"] = int(user["id"])
    rows = db.execute(
        f"""
        SELECT id, token_ciphertext, created_by, expires_at, revoked_at, created_at
        FROM resource_share_tokens
        WHERE resource_id = :resource_id{owner_clause}
        ORDER BY created_at DESC, id DESC
        LIMIT 20
        """,
        params,
    ).fetchall()
    items = []
    for item in rows:
        payload = {key: item[key] for key in item.keys() if key != "token_ciphertext"}
        token = _decrypt_token(item["token_ciphertext"])
        payload["share_path"] = f"/share/resources/{token}" if token else None
        items.append(payload)
    return {"items": items}


def _share_owner_clause(user: sqlite3.Row) -> tuple[str, dict[str, Any]]:
    if is_system_admin(user):
        return "1=1", {}
    return "st.created_by = :share_uid", {"share_uid": int(user["id"])}


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _share_status(row: sqlite3.Row, current_time: str) -> str:
    if row["revoked_at"]:
        return "revoked"
    if row["expires_at"] <= current_time:
        return "expired"
    return "active"


@router.get("/api/resource-share-links")
def list_managed_share_links(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query("", max_length=100),
    status: str = Query("all"),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    if status not in {"all", "active", "expired", "revoked"}:
        raise HTTPException(400, "分享状态筛选不正确")

    current_time = now_iso()
    owner_clause, params = _share_owner_clause(user)
    where_parts = [owner_clause]
    query = search.strip().lower()
    if query:
        where_parts.append(
            "(LOWER(r.name) LIKE :share_search ESCAPE '\\' "
            "OR LOWER(COALESCE(u.name, '')) LIKE :share_search ESCAPE '\\' "
            "OR LOWER(COALESCE(u.username, '')) LIKE :share_search ESCAPE '\\')"
        )
        params["share_search"] = f"%{_escape_like(query)}%"
    status_clauses = {
        "active": "st.revoked_at IS NULL AND st.expires_at > :share_now",
        "expired": "st.revoked_at IS NULL AND st.expires_at <= :share_now",
        "revoked": "st.revoked_at IS NOT NULL",
    }
    params["share_now"] = current_time
    if status != "all":
        where_parts.append(status_clauses[status])
    where_sql = " AND ".join(where_parts)

    total = int(
        db.execute(
            f"""
            SELECT COUNT(*)
            FROM resource_share_tokens st
            JOIN resources r ON r.id = st.resource_id
            LEFT JOIN users u ON u.id = st.created_by
            WHERE {where_sql}
            """,
            params,
        ).fetchone()[0]
    )
    offset = (page - 1) * page_size
    rows = db.execute(
        f"""
        SELECT st.id, st.resource_id, st.token_ciphertext, st.created_by,
               st.expires_at, st.revoked_at, st.created_at,
               r.name AS resource_name, r.subject AS resource_subject,
               r.status AS resource_status, r.secrecy_level, r.detail_token,
               u.name AS creator_name, u.username AS creator_username
        FROM resource_share_tokens st
        JOIN resources r ON r.id = st.resource_id
        LEFT JOIN users u ON u.id = st.created_by
        WHERE {where_sql}
        ORDER BY st.created_at DESC, st.id DESC
        LIMIT :share_limit OFFSET :share_offset
        """,
        {**params, "share_limit": page_size, "share_offset": offset},
    ).fetchall()

    stats_row = db.execute(
        f"""
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN st.revoked_at IS NULL AND st.expires_at > :stats_now
                         THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN st.revoked_at IS NULL AND st.expires_at <= :stats_now
                         THEN 1 ELSE 0 END) AS expired,
               SUM(CASE WHEN st.revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked
        FROM resource_share_tokens st
        JOIN resources r ON r.id = st.resource_id
        WHERE {owner_clause}
        """,
        {**_share_owner_clause(user)[1], "stats_now": current_time},
    ).fetchone()

    items = []
    for row in rows:
        token = _decrypt_token(row["token_ciphertext"])
        items.append(
            {
                "id": int(row["id"]),
                "status": _share_status(row, current_time),
                "share_path": f"/share/resources/{token}" if token else None,
                "expires_at": row["expires_at"],
                "revoked_at": row["revoked_at"],
                "created_at": row["created_at"],
                "creator": {
                    "id": int(row["created_by"]),
                    "name": row["creator_name"],
                    "username": row["creator_username"],
                },
                "resource": {
                    "id": int(row["resource_id"]),
                    "name": row["resource_name"],
                    "subject": row["resource_subject"] or "",
                    "status": row["resource_status"],
                    "secrecy_level": row["secrecy_level"],
                    "detail_path": f"/resources/{row['detail_token']}",
                },
            }
        )
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "stats": {
            "total": int(stats_row["total"] or 0),
            "active": int(stats_row["active"] or 0),
            "expired": int(stats_row["expired"] or 0),
            "revoked": int(stats_row["revoked"] or 0),
        },
    }


@router.delete("/api/resources/{resource_id}/share-links/{link_id}")
def revoke_share_link(
    resource_id: int,
    link_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, bool]:
    row = _resource_row(db, resource_id)
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无权查看该素材")
    creator_clause = "" if is_system_admin(user) else " AND created_by = ?"
    values: tuple[Any, ...] = (
        (now_iso(), link_id, resource_id)
        if is_system_admin(user)
        else (now_iso(), link_id, resource_id, int(user["id"]))
    )
    cursor = db.execute(
        f"""
        UPDATE resource_share_tokens
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ? AND resource_id = ?{creator_clause}
        """,
        values,
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
