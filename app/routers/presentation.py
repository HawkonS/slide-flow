"""Routers / presentation."""

from __future__ import annotations

from app.config import settings
from app.core.permissions import can_view_resource, can_view_show
from app.core.permissions import SESSION_COOKIE, require_user
from app.core.sanitize import sanitize_html
from app.core.security import create_present_token
from app.core.security import read_session_expiry, verify_present_token
from app.routers.dependencies import (
    db_dep,
    db_read_dep,
)
from app.services.files import (
    _preview_thumb_bytes,
    _resource_file_abs,
    _safe_abs,
    materialization_scope,
)
from app.services.shows import (
    _show_row,
)
from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from fastapi import Query, Request
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.routing import APIRoute
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from starlette.exceptions import HTTPException as StarletteHTTPException
from PIL import Image
from app.core.oss import is_oss_ref, oss_key, storage as oss_storage
from app.services.files import asset_preview_url
from typing import Any, Literal
from datetime import datetime, timezone
from collections import OrderedDict
from dataclasses import dataclass
from threading import Lock
import hashlib
import io
import time
import uuid
import logging
import sqlite3

logger = logging.getLogger(__name__)

router = APIRouter()


class _OfflineNoStoreRoute(APIRoute):
    """Include dependency failures in the private/no-store response policy."""

    def get_route_handler(self):
        handler = super().get_route_handler()

        async def no_store_handler(request: Request):
            try:
                response = await handler(request)
            except StarletteHTTPException as error:
                error.headers = {**(error.headers or {}), "Cache-Control": "private, no-store"}
                raise
            except RequestValidationError as error:
                response = await request_validation_exception_handler(request, error)
            response.headers["Cache-Control"] = "private, no-store"
            response.headers["Vary"] = "Cookie"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response

        return no_store_handler


offline_router = APIRouter(route_class=_OfflineNoStoreRoute)
OFFLINE_AUTH_TTL_SECONDS = 24 * 60 * 60


@offline_router.get("/api/shows/{show_id}/offline-package")
def get_show_offline_package(
    show_id: int,
    auth_mode: str = "none",
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    # Old exports included a reusable login-password hash. Never issue them again.
    raise HTTPException(410, "旧版离线包已停用，请升级页面并使用新的 PWA 离线缓存流程重新下载")


def _offline_show(show_id: int, user: sqlite3.Row, db: sqlite3.Connection) -> sqlite3.Row:
    show = _show_row(db, show_id)
    if not can_view_show(db, show, user):
        raise HTTPException(403, "无放映可见权限")
    return show


def _offline_resource_rows(
    show_id: int,
    user: sqlite3.Row,
    db: sqlite3.Connection,
    resource_id: int | None = None,
) -> list[sqlite3.Row]:
    # LEFT JOIN preserves missing versions; never silently omit broken slides.
    resource_filter = " AND sr.resource_id = ?" if resource_id is not None else ""
    params = [int(user["id"]), int(user["id"]), show_id]
    if resource_id is not None:
        params.append(resource_id)
    rows = db.execute(
        """
        SELECT r.*, sr.resource_id AS show_resource_id,
               sr.version_no AS show_version_no, sr.is_hidden,
               rv.id AS offline_version_id, rv.png_path AS offline_png_path,
               rv.common_remark_html AS offline_common_remark_html,
               pr.content_html AS offline_personal_remark_html,
               shr.content_html AS offline_show_remark_html
        FROM show_resources sr
        LEFT JOIN resources r ON r.id = sr.resource_id
        LEFT JOIN resource_versions rv
          ON rv.resource_id = sr.resource_id AND rv.version_no = sr.version_no
        LEFT JOIN personal_remarks pr
          ON pr.resource_id = sr.resource_id AND pr.version_id = rv.id AND pr.user_id = ?
        LEFT JOIN show_remarks shr
          ON shr.show_id = sr.show_id AND shr.resource_id = sr.resource_id AND shr.user_id = ?
        WHERE sr.show_id = ?
        """ + resource_filter + " ORDER BY sr.sort_order, sr.resource_id",
        params,
    ).fetchall()
    # Preflight every resource before materializing images or exposing notes.
    for row in rows:
        if row["id"] is None:
            raise HTTPException(409, "放映中的素材已不存在，请更新放映后重新下载")
        if not can_view_resource(db, row, user):
            raise HTTPException(403, "放映包含无可见权限的素材，无法下载离线缓存")
        if row["offline_version_id"] is None:
            raise HTTPException(409, "放映中的素材版本不存在，请更新放映后重新下载")
        if not row["offline_png_path"]:
            raise HTTPException(409, "放映中的素材缺少预览图，无法下载离线缓存")
    return rows


def _offline_asset_bytes(row: sqlite3.Row, *, include_thumb: bool = True) -> tuple[bytes, bytes]:
    # Keep one source image in memory and clean each OSS file before the next.
    with materialization_scope():
        path = _resource_file_abs(row["offline_png_path"])
        if path is None or not path.is_file():
            raise HTTPException(409, "素材预览图不可用，请修复后重新下载")
        try:
            image_bytes = path.read_bytes()
            with Image.open(io.BytesIO(image_bytes)) as image:
                if image.format != "PNG":
                    raise ValueError("Offline slide is not a PNG image")
                image.verify()
            thumb_bytes = _preview_thumb_bytes(path) if include_thumb else b""
        except Exception:
            logger.warning("离线素材图片校验失败 resource_id=%s version_no=%s",
                           row["show_resource_id"], row["show_version_no"])
            raise HTTPException(409, "素材预览图不完整或无法生成缩略图，请修复后重新下载")
        return image_bytes, thumb_bytes


@dataclass(frozen=True)
class _OfflineAssetSnapshot:
    image_sha256: str
    thumb_sha256: str
    size_bytes: int
    thumb_bytes: bytes


# Only validated image content is shared; authorization and personal notes are
# always queried anew. Metadata fingerprints invalidate replaced source files.
_offline_cache_lock = Lock()
_offline_snapshots: OrderedDict[tuple, _OfflineAssetSnapshot] = OrderedDict()
_offline_images: OrderedDict[tuple, bytes] = OrderedDict()
_OFFLINE_THUMB_CACHE_BYTES = 16 * 1024 * 1024
_OFFLINE_IMAGE_CACHE_BYTES = 64 * 1024 * 1024


def _offline_source_key(row: sqlite3.Row) -> tuple:
    ref = row["offline_png_path"]
    try:
        if is_oss_ref(ref):
            head = oss_storage._with_endpoint_fallback(
                "offline image metadata", lambda bucket: bucket.head_object(oss_key(ref))
            )
            # Never reuse a validation when the object has no content identity.
            identity = head.etag or head.server_crc or head.headers.get("x-oss-version-id")
            if identity is None:
                raise ValueError("Missing OSS content identity")
            source = (settings.oss_endpoint, settings.oss_bucket, identity,
                      head.content_length, head.last_modified, head.server_crc,
                      head.headers.get("x-oss-version-id"))
        else:
            path = _resource_file_abs(ref)
            if path is None or not path.is_file():
                raise ValueError("Missing source")
            stat = path.stat()
            source = (str(path.resolve()), stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    except Exception:
        raise HTTPException(409, "素材预览图不可用，请修复后重新下载")
    return (ref, int(row["offline_version_id"]), source, settings.image_thumb_width,
            settings.image_thumb_height, settings.image_thumb_quality)


def _remember_offline_image(key: tuple, content: bytes) -> None:
    if len(content) > _OFFLINE_IMAGE_CACHE_BYTES:
        return
    with _offline_cache_lock:
        _offline_images[key] = content
        _offline_images.move_to_end(key)
        while (len(_offline_images) > 512 or
               sum(map(len, _offline_images.values())) > _OFFLINE_IMAGE_CACHE_BYTES):
            _offline_images.popitem(last=False)


def _offline_asset_snapshot(row: sqlite3.Row) -> tuple[tuple, _OfflineAssetSnapshot]:
    key = _offline_source_key(row)
    with _offline_cache_lock:
        cached = _offline_snapshots.get(key)
        if cached is not None:
            _offline_snapshots.move_to_end(key)
            return key, cached
    image_bytes, thumb_bytes = _offline_asset_bytes(row)
    if _offline_source_key(row) != key:
        raise HTTPException(409, "素材在下载期间已变更，请重新下载离线缓存")
    snapshot = _OfflineAssetSnapshot(
        hashlib.sha256(image_bytes).hexdigest(), hashlib.sha256(thumb_bytes).hexdigest(),
        len(image_bytes), thumb_bytes,
    )
    with _offline_cache_lock:
        _offline_snapshots[key] = snapshot
        _offline_snapshots.move_to_end(key)
        while (len(_offline_snapshots) > 512 or
               sum(len(item.thumb_bytes) for item in _offline_snapshots.values()) > _OFFLINE_THUMB_CACHE_BYTES):
            _offline_snapshots.popitem(last=False)
    _remember_offline_image(key, image_bytes)
    return key, snapshot


def _offline_iso_timestamp(value: int) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


@offline_router.get("/api/shows/{show_id}/offline-manifest")
def get_show_offline_manifest(
    show_id: int,
    request: Request,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    issued_at = int(time.time())
    session_expiry = read_session_expiry(request.cookies.get(SESSION_COOKIE), settings.secret_key)
    if session_expiry is None or session_expiry <= issued_at:
        raise HTTPException(401, "登录会话已过期，请重新登录后下载")
    expires_at = min(issued_at + OFFLINE_AUTH_TTL_SECONDS, session_expiry)
    show = _offline_show(show_id, user, db)
    rows = _offline_resource_rows(show_id, user, db)
    resources = []
    for slide_index, row in enumerate(rows):
        _, snapshot = _offline_asset_snapshot(row)
        resource_id = int(row["show_resource_id"])
        version_no = int(row["show_version_no"])
        image_sha256 = snapshot.image_sha256
        thumb_sha256 = snapshot.thumb_sha256
        asset_base = f"/api/shows/{show_id}/offline-assets/{resource_id}"
        resources.append({
            "id": resource_id,
            "name": row["name"],
            "version_no": version_no,
            "slide_index": slide_index,
            "hidden": bool(row["is_hidden"]),
            "image_url": f"{asset_base}/image?version_no={version_no}&sha256={image_sha256}",
            "thumb_url": f"{asset_base}/thumb?version_no={version_no}&sha256={thumb_sha256}",
            "image_sha256": image_sha256,
            "thumb_sha256": thumb_sha256,
            "size_bytes": snapshot.size_bytes,
            "thumb_size_bytes": len(snapshot.thumb_bytes),
            "common_remark_html": sanitize_html(row["offline_common_remark_html"] or ""),
            "personal_remark_html": sanitize_html(row["offline_personal_remark_html"] or ""),
            "show_remark_html": sanitize_html(row["offline_show_remark_html"] or ""),
        })
    if expires_at <= int(time.time()):
        raise HTTPException(401, "登录会话已过期，请重新登录后下载")
    owner = db.execute("SELECT username, name FROM users WHERE id = ?", (show["owner_id"],)).fetchone()
    return {
        "format_version": 3,
        "package_id": uuid.uuid4().hex,
        "user_id": int(user["id"]),
        "session_version": int(user["session_version"]),
        "issued_at": _offline_iso_timestamp(issued_at),
        "expires_at": _offline_iso_timestamp(expires_at),
        "show_id": show_id,
        "name": show["name"],
        "version_no": int(show["version_no"]),
        "series_id": show["series_id"],
        "updated_at": show["updated_at"],
        "subject": show["subject"],
        "tags": [tag.strip() for tag in (show["tags"] or "").split(",") if tag.strip()],
        "status": show["status"],
        "owner_name": (owner["name"] or owner["username"]) if owner else None,
        "resources": resources,
    }


@offline_router.get("/api/shows/{show_id}/offline-assets/{resource_id}/{asset_kind}")
def get_show_offline_asset(
    show_id: int,
    resource_id: int,
    asset_kind: Literal["image", "thumb"],
    version_no: int = Query(..., ge=1),
    sha256: str | None = Query(None, min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$"),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> Response:
    _offline_show(show_id, user, db)
    rows = _offline_resource_rows(show_id, user, db, resource_id)
    if not rows:
        raise HTTPException(403, "该素材不属于此放映")
    row = rows[0]
    if int(row["show_version_no"]) != version_no:
        raise HTTPException(409, "放映素材版本已变更，请重新下载离线缓存")
    key, snapshot = _offline_asset_snapshot(row)
    content = snapshot.thumb_bytes
    if asset_kind == "image":
        with _offline_cache_lock:
            content = _offline_images.get(key)
            if content is not None:
                _offline_images.move_to_end(key)
        if content is None:
            content, _ = _offline_asset_bytes(row, include_thumb=False)
            if (_offline_source_key(row) != key or
                    hashlib.sha256(content).hexdigest() != snapshot.image_sha256):
                raise HTTPException(409, "素材在下载期间已变更，请重新下载离线缓存")
            _remember_offline_image(key, content)
    if sha256 is not None and hashlib.sha256(content).hexdigest() != sha256:
        raise HTTPException(409, "放映素材内容已变更，请重新下载离线缓存")
    return Response(content, media_type="image/png" if asset_kind == "image" else "image/jpeg")


@offline_router.get("/api/shows/{show_id}/offline-version")
def get_show_offline_version(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    # A check is also an authorization check for the package being queried.
    # Validate its fixed resources even when a newer show no longer uses them.
    row = _offline_show(show_id, user, db)
    selected_rows = _offline_resource_rows(show_id, user, db)
    latest_row = row
    series_id = row["series_id"]
    if series_id:
        candidates = db.execute(
            "SELECT * FROM shows WHERE series_id = ? AND version_no > ? "
            "ORDER BY version_no DESC, id DESC",
            (series_id, int(row["version_no"])),
        )
        for candidate in candidates:
            if not can_view_show(db, candidate, user):
                continue
            try:
                candidate_rows = _offline_resource_rows(int(candidate["id"]), user, db)
            except HTTPException as error:
                if error.status_code in {403, 404, 409}:
                    # An inaccessible/broken successor does not revoke the
                    # still-authorized package that the client asked about.
                    continue
                raise
            latest_row, selected_rows = candidate, candidate_rows
            break
    latest_show_id = int(latest_row["id"])
    # Report separately that a resource can be upgraded. The show remains
    # pinned to show_resources.version_no until an explicit show iteration.
    upgrades = db.execute(
        """
        SELECT sr.resource_id, r.current_version
        FROM show_resources sr
        JOIN resources r ON r.id = sr.resource_id
        JOIN resource_versions rv
          ON rv.resource_id = r.id AND rv.version_no = r.current_version
        WHERE sr.show_id = ? AND r.current_version > sr.version_no
          AND rv.png_path IS NOT NULL AND TRIM(rv.png_path) != ''
        """,
        (latest_show_id,),
    ).fetchall()
    return {
        "show_id": latest_show_id,
        "queried_show_id": int(show_id),
        "series_id": series_id,
        "version_no": int(latest_row["version_no"]),
        "updated_at": latest_row["updated_at"],
        "name": latest_row["name"],
        "resource_versions": {
            str(item["show_resource_id"]): int(item["show_version_no"])
            for item in selected_rows
        },
        "resource_updates": {
            str(item["resource_id"]): int(item["current_version"])
            for item in upgrades
        },
    }


router.include_router(offline_router)


@router.post("/api/shows/{show_id}/present-session")
def create_present_session(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    token = create_present_token(
        show_id,
        int(user["id"]),
        settings.secret_key,
        session_version=int(user["session_version"]),
    )
    return {"session_token": token, "expires_in": settings.show_token_ttl_seconds}


@router.get("/api/slides/{resource_id}/image")
def slide_image(
    resource_id: int,
    session_token: str = Query(...),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> FileResponse:
    claims = verify_present_token(session_token, settings.secret_key)
    if claims is None:
        raise HTTPException(401, "会话token无效或已过期")
    user = db.execute(
        "SELECT * FROM users WHERE id = ?",
        (int(claims["user_id"]),),
    ).fetchone()
    if (
        user is None
        or int(user["session_version"]) != int(claims["session_version"])
        or bool(user["must_change_pwd"])
    ):
        raise HTTPException(401, "会话token无效或已过期")
    show_id = int(claims["show_id"])
    show = db.execute("SELECT * FROM shows WHERE id = ?", (show_id,)).fetchone()
    if show is None or not can_view_show(db, show, user):
        raise HTTPException(403, "无可见权限")
    # 验证该 resource_id 属于 token 中的 show_id
    sr = db.execute(
        "SELECT resource_id, version_no FROM show_resources WHERE show_id = ? AND resource_id = ?",
        (show_id, resource_id),
    ).fetchone()
    if sr is None:
        raise HTTPException(403, "该资源不属于此放映")
    resource = db.execute(
        "SELECT * FROM resources WHERE id = ?",
        (resource_id,),
    ).fetchone()
    if resource is None or not can_view_resource(db, resource, user):
        raise HTTPException(403, "无素材可见权限")
    # 使用放映清单固定的版本，资源发布新版本后不能让旧放映悄然漂移。
    version = db.execute(
        "SELECT * FROM resource_versions WHERE resource_id = ? AND version_no = ?",
        (resource_id, int(sr["version_no"])),
    ).fetchone()
    if version is None:
        raise HTTPException(404, "放映中的资源版本不存在")
    if is_oss_ref(version["png_path"]):
        url = asset_preview_url(version["png_path"])
        if not url:
            raise HTTPException(503, "OSS 放映图片地址生成失败")
        return RedirectResponse(url, status_code=307)  # type: ignore[return-value]
    path = _safe_abs(version["png_path"])
    if path is None or not path.exists():
        raise HTTPException(404, "预览图不存在")
    return FileResponse(path, media_type="image/png")
