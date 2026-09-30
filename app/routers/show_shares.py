"""Permission-aware, preview-only share links for shows."""

from __future__ import annotations

from app.config import settings
from app.core.oss import is_oss_ref
from app.core.permissions import ROLE_OPERATIONS_ADMIN, can_manage_show, can_view_resource, can_view_show, is_system_admin, require_admin, require_user
from app.db import now_iso
from app.routers.dependencies import db_dep, db_read_dep
from app.schemas.resources import ShareLinkPayload, ShareLinksBulkPayload
from app.services.files import _safe_abs, asset_preview_url
from app.services.shows import _show_row
from app.services.tagging import tag_relation_join
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import FileResponse, RedirectResponse
import base64
import hashlib
import re
import secrets
import sqlite3
from datetime import datetime, timedelta
from typing import Any


def _private_response(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"


router = APIRouter(dependencies=[Depends(_private_response)])

_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def _token_cipher() -> Fernet:
    digest = hashlib.sha256(f"slide-flow-show-share:{settings.secret_key}".encode("utf-8")).digest()
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


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _share_status(row: sqlite3.Row, current_time: str) -> str:
    if row["revoked_at"]:
        return "revoked"
    if row["expires_at"] <= current_time:
        return "expired"
    return "active"


def _show_share_owner_clause(user: sqlite3.Row, db: sqlite3.Connection) -> tuple[str, dict[str, Any]]:
    if is_system_admin(user):
        return "1=1", {}
    user_id = int(user["id"])
    if user["role"] != ROLE_OPERATIONS_ADMIN:
        return "st.created_by = :share_uid", {"share_uid": user_id}
    tag_join = tag_relation_join(db, "show_management_tags", "smt", "ut")
    return (
        "(st.created_by = :share_uid"
        " OR s.owner_id = :manage_uid"
        " OR s.management_scope = 'public'"
        " OR (s.management_scope = 'partial' AND EXISTS ("
        "SELECT 1 FROM show_management sm "
        "WHERE sm.show_id = s.id AND sm.user_id = :manage_uid))"
        " OR (s.management_scope = 'partial' AND EXISTS ("
        "SELECT 1 FROM show_management_tags smt "
        f"JOIN user_tags ut ON {tag_join} "
        "WHERE smt.show_id = s.id AND ut.user_id = :manage_uid)))",
        {"share_uid": user_id, "manage_uid": user_id},
    )


def _managed_show_share_filter(
    user: sqlite3.Row,
    db: sqlite3.Connection,
    search: str,
    status: str,
    current_time: str,
) -> tuple[str, dict[str, Any]]:
    if status not in {"all", "active", "expired", "revoked"}:
        raise HTTPException(400, "分享状态筛选不正确")
    owner_clause, params = _show_share_owner_clause(user, db)
    where_parts = [owner_clause]
    query = search.strip().lower()
    if query:
        where_parts.append(
            "(LOWER(s.name) LIKE :show_share_search ESCAPE '\\' "
            "OR LOWER(COALESCE(s.subject, '')) LIKE :show_share_search ESCAPE '\\' "
            "OR LOWER(COALESCE(u.name, '')) LIKE :show_share_search ESCAPE '\\' "
            "OR LOWER(COALESCE(u.username, '')) LIKE :show_share_search ESCAPE '\\')"
        )
        params["show_share_search"] = f"%{_escape_like(query)}%"
    params["show_share_now"] = current_time
    status_clauses = {
        "active": "st.revoked_at IS NULL AND st.expires_at > :show_share_now",
        "expired": "st.revoked_at IS NULL AND st.expires_at <= :show_share_now",
        "revoked": "st.revoked_at IS NOT NULL",
    }
    if status != "all":
        where_parts.append(status_clauses[status])
    return " AND ".join(where_parts), params


def _share_not_found() -> HTTPException:
    return HTTPException(404, "分享链接不存在或已过期")


def _share_row(db: sqlite3.Connection, token: str) -> sqlite3.Row:
    if not _TOKEN_RE.fullmatch(token):
        raise _share_not_found()
    row = db.execute(
        """
        SELECT st.*, s.name, s.subject, s.tags, s.status, s.version_no,
               s.change_note, s.created_at AS show_created_at, s.updated_at AS show_updated_at
        FROM show_share_tokens st
        JOIN shows s ON s.id = st.show_id
        WHERE st.token_hash = ?
        """,
        (_token_hash(token),),
    ).fetchone()
    if row is None or row["revoked_at"] or row["expires_at"] <= now_iso():
        raise _share_not_found()
    return row


def _show_resources(db: sqlite3.Connection, share_id: int, token: str) -> list[dict[str, Any]]:
    rows = db.execute(
        """
        SELECT v.resource_id, v.version_no, p.sort_order, r.name
        FROM show_share_pages p
        JOIN resource_versions v ON v.id = p.version_id
        JOIN resources r ON r.id = v.resource_id
        WHERE p.share_id = ?
        ORDER BY p.sort_order
        """,
        (share_id,),
    ).fetchall()
    resources: list[dict[str, Any]] = []
    for row in rows:
        resources.append(
            {
                "id": int(row["resource_id"]),
                "name": row["name"],
                "sort_order": int(row["sort_order"]),
                "version_no": int(row["version_no"]),
                "preview_url": f"/api/show-shares/{token}/preview/{int(row['resource_id'])}",
            }
        )
    return resources


def _public_share_payload(db: sqlite3.Connection, row: sqlite3.Row, token: str) -> dict[str, Any]:
    return {
        "show": {
            "id": int(row["show_id"]),
            "name": row["name"],
            "subject": row["subject"] or "",
            "tags": row["tags"] or "",
            "status": row["status"] or "",
            "version_no": int(row["version_no"]),
            "change_note": row["change_note"] or "",
            "created_at": row["show_created_at"],
            "updated_at": row["show_updated_at"],
            "resources": _show_resources(db, int(row["id"]), token),
        },
        "expires_at": row["expires_at"],
    }


@router.post("/api/shows/{show_id}/share-links")
def create_show_share_link(
    show_id: int,
    payload: ShareLinkPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    token = secrets.token_urlsafe(32)
    created_at = now_iso()
    expires_at = (datetime.utcnow() + timedelta(days=payload.expires_in_days)).isoformat(timespec="seconds") + "Z"
    # Capture permissions, page order and versions together. Later edits to the
    # show must never expand what an existing public link can reveal.
    with db:
        db.execute("BEGIN IMMEDIATE")
        row = _show_row(db, show_id)
        if not can_view_show(db, row, user):
            raise _share_not_found()
        pages = db.execute(
            """
            SELECT r.*, v.id AS share_version_id
            FROM show_resources sr
            JOIN resources r ON r.id = sr.resource_id
            JOIN resource_versions v ON v.resource_id = r.id AND v.version_no = sr.version_no
            WHERE sr.show_id = ? AND sr.is_hidden = 0 AND v.png_path IS NOT NULL AND v.png_path != ''
            ORDER BY sr.sort_order, sr.resource_id
            """,
            (show_id,),
        ).fetchall()
        pages = [page for page in pages if can_view_resource(db, page, user)]
        if not pages:
            raise HTTPException(400, "当前放映没有可分享的页面")
        cursor = db.execute(
            """
            INSERT INTO show_share_tokens
                (show_id, token_hash, token_ciphertext, created_by, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (show_id, _token_hash(token), _encrypt_token(token), int(user["id"]), expires_at, created_at),
        )
        link_id = int(cursor.lastrowid)
        db.executemany(
            "INSERT INTO show_share_pages (share_id, version_id, sort_order) VALUES (?, ?, ?)",
            [(link_id, page["share_version_id"], index) for index, page in enumerate(pages)],
        )
    return {
        "id": link_id,
        "token": token,
        "expires_at": expires_at,
        "share_path": f"/share/shows/{token}",
        "page_count": len(pages),
    }


@router.get("/api/shows/{show_id}/share-links")
def list_show_share_links(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, list[dict[str, Any]]]:
    row = _show_row(db, show_id)
    can_manage_all = is_system_admin(user) or can_manage_show(db, row, user)
    if not can_manage_all and not can_view_show(db, row, user):
        raise _share_not_found()
    creator_clause = "" if can_manage_all else " AND created_by = ?"
    params: tuple[Any, ...] = (show_id,) if can_manage_all else (show_id, int(user["id"]))
    rows = db.execute(
        f"""
        SELECT id, token_ciphertext, created_by, expires_at, revoked_at, created_at,
               (SELECT COUNT(*) FROM show_share_pages p WHERE p.share_id = show_share_tokens.id) AS page_count
        FROM show_share_tokens
        WHERE show_id = ?{creator_clause}
        ORDER BY created_at DESC, id DESC
        LIMIT 20
        """,
        params,
    ).fetchall()
    items: list[dict[str, Any]] = []
    for item in rows:
        token = _decrypt_token(item["token_ciphertext"])
        items.append(
            {
                "id": int(item["id"]),
                "created_by": int(item["created_by"]),
                "expires_at": item["expires_at"],
                "revoked_at": item["revoked_at"],
                "created_at": item["created_at"],
                "share_path": f"/share/shows/{token}" if token else None,
                "page_count": int(item["page_count"]),
            }
        )
    return {"items": items}


@router.delete("/api/shows/{show_id}/share-links/{link_id}")
def revoke_show_share_link(
    show_id: int,
    link_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, bool]:
    row = _show_row(db, show_id)
    can_revoke_all = is_system_admin(user) or can_manage_show(db, row, user)
    if not can_revoke_all and not can_view_show(db, row, user):
        raise _share_not_found()
    creator_clause = "" if can_revoke_all else " AND created_by = ?"
    values: tuple[Any, ...] = (now_iso(), link_id, show_id) if can_revoke_all else (now_iso(), link_id, show_id, int(user["id"]))
    cursor = db.execute(
        f"""
        UPDATE show_share_tokens
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ? AND show_id = ?{creator_clause}
        """,
        values,
    )
    if cursor.rowcount == 0:
        raise _share_not_found()
    db.commit()
    return {"ok": True}


@router.get("/api/show-share-links")
def list_managed_show_share_links(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query("", max_length=100),
    status: str = Query("all"),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    current_time = now_iso()
    owner_clause, owner_params = _show_share_owner_clause(user, db)
    where_sql, params = _managed_show_share_filter(user, db, search, status, current_time)

    total = int(
        db.execute(
            f"""
            SELECT COUNT(*)
            FROM show_share_tokens st
            JOIN shows s ON s.id = st.show_id
            LEFT JOIN users u ON u.id = st.created_by
            WHERE {where_sql}
            """,
            params,
        ).fetchone()[0]
    )
    offset = (page - 1) * page_size
    rows = db.execute(
        f"""
        SELECT st.id, st.show_id, st.token_ciphertext, st.created_by,
               st.expires_at, st.revoked_at, st.created_at,
               s.name AS show_name, s.subject AS show_subject,
               s.status AS show_status, s.version_no AS show_version_no,
               u.name AS creator_name, u.username AS creator_username,
               (SELECT COUNT(*) FROM show_share_pages p WHERE p.share_id = st.id) AS page_count
        FROM show_share_tokens st
        JOIN shows s ON s.id = st.show_id
        LEFT JOIN users u ON u.id = st.created_by
        WHERE {where_sql}
        ORDER BY st.created_at DESC, st.id DESC
        LIMIT :show_share_limit OFFSET :show_share_offset
        """,
        {**params, "show_share_limit": page_size, "show_share_offset": offset},
    ).fetchall()

    stats_row = db.execute(
        f"""
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN st.revoked_at IS NULL AND st.expires_at > :stats_now
                         THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN st.revoked_at IS NULL AND st.expires_at <= :stats_now
                         THEN 1 ELSE 0 END) AS expired,
               SUM(CASE WHEN st.revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked
        FROM show_share_tokens st
        JOIN shows s ON s.id = st.show_id
        WHERE {owner_clause}
        """,
        {**owner_params, "stats_now": current_time},
    ).fetchone()

    items = []
    for row in rows:
        token = _decrypt_token(row["token_ciphertext"])
        items.append(
            {
                "id": int(row["id"]),
                "status": _share_status(row, current_time),
                "share_path": f"/share/shows/{token}" if token else None,
                "expires_at": row["expires_at"],
                "revoked_at": row["revoked_at"],
                "created_at": row["created_at"],
                "creator": {
                    "id": int(row["created_by"]),
                    "name": row["creator_name"],
                    "username": row["creator_username"],
                },
                "show": {
                    "id": int(row["show_id"]),
                    "name": row["show_name"],
                    "subject": row["show_subject"] or "",
                    "status": row["show_status"] or "",
                    "version_no": int(row["show_version_no"]),
                    "page_count": int(row["page_count"]),
                    "detail_path": f"/shows/{int(row['show_id'])}",
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


@router.get("/api/show-share-links/ids")
def list_managed_show_share_link_ids(
    search: str = Query("", max_length=100),
    status: str = Query("all"),
    user: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, list[int]]:
    where_sql, params = _managed_show_share_filter(user, db, search, status, now_iso())
    rows = db.execute(
        f"""
        SELECT st.id
        FROM show_share_tokens st
        JOIN shows s ON s.id = st.show_id
        LEFT JOIN users u ON u.id = st.created_by
        WHERE {where_sql}
        ORDER BY st.created_at DESC, st.id DESC
        LIMIT 1001
        """,
        params,
    ).fetchall()
    if len(rows) > 1000:
        raise HTTPException(400, "每次最多选择 1000 条分享记录，请缩小筛选范围")
    return {"ids": [int(row["id"]) for row in rows]}


@router.post("/api/show-share-links/bulk-revoke")
def bulk_revoke_show_share_links(
    payload: ShareLinksBulkPayload,
    user: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, int]:
    link_ids = sorted(set(payload.link_ids))
    params = {f"id_{index}": value for index, value in enumerate(link_ids)}
    placeholders = ",".join(f":{key}" for key in params)
    with db:
        db.execute("BEGIN IMMEDIATE")
        owner_clause, owner_params = _show_share_owner_clause(user, db)
        forbidden = db.execute(
            f"""
            SELECT 1
            FROM show_share_tokens st
            JOIN shows s ON s.id = st.show_id
            WHERE st.id IN ({placeholders}) AND NOT ({owner_clause})
            LIMIT 1
            """,
            {**params, **owner_params},
        ).fetchone()
        if forbidden:
            raise HTTPException(403, "无权撤销部分分享记录，请刷新列表后重试")
        cursor = db.execute(
            f"""
            UPDATE show_share_tokens
            SET revoked_at = COALESCE(revoked_at, :revoked_at)
            WHERE id IN ({placeholders}) AND revoked_at IS NULL
            """,
            {**params, "revoked_at": now_iso()},
        )
        revoked = cursor.rowcount
    return {"revoked": revoked}


@router.get("/api/show-shares/{token}")
def get_shared_show(token: str, db: sqlite3.Connection = Depends(db_read_dep)) -> dict[str, Any]:
    row = _share_row(db, token)
    return _public_share_payload(db, row, token)


@router.get("/api/show-shares/{token}/preview/{resource_id}")
def shared_show_preview(
    token: str,
    resource_id: int,
    db: sqlite3.Connection = Depends(db_read_dep),
):
    row = _share_row(db, token)
    version = db.execute(
        """
        SELECT v.png_path
        FROM show_share_pages p
        JOIN resource_versions v ON v.id = p.version_id
        WHERE p.share_id = ? AND v.resource_id = ?
        """,
        (row["id"], resource_id),
    ).fetchone()
    if version is None or not version["png_path"]:
        raise _share_not_found()
    if is_oss_ref(version["png_path"]):
        url = asset_preview_url(version["png_path"])
        if not url:
            raise _share_not_found()
        return RedirectResponse(url, status_code=307, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})
    path = _safe_abs(version["png_path"])
    if path is None or not path.exists():
        raise _share_not_found()
    return FileResponse(path, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})
