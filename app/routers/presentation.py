"""Routers / presentation."""

from __future__ import annotations

from app.config import settings
from app.core.permissions import can_view_resource, can_view_show
from app.core.permissions import require_user
from app.core.sanitize import sanitize_html
from app.core.security import create_present_token
from app.core.security import verify_present_token
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
from fastapi import Query
from fastapi.responses import FileResponse, RedirectResponse
from app.core.oss import is_oss_ref
from app.services.files import asset_preview_url
from typing import Any, Callable, TypeVar
from functools import wraps
import base64
import logging
import sqlite3

logger = logging.getLogger(__name__)

router = APIRouter()

_T = TypeVar("_T")


def _cleanup_oss_materialized(endpoint: Callable[..., _T]) -> Callable[..., _T]:
    @wraps(endpoint)
    def wrapped(*args: Any, **kwargs: Any) -> _T:
        with materialization_scope():
            return endpoint(*args, **kwargs)
    return wrapped


@router.get("/api/shows/{show_id}/offline-package")
@_cleanup_oss_materialized
def get_show_offline_package(
    show_id: int,
    auth_mode: str = "none",
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    if auth_mode not in {"none", "required"}:
        raise HTTPException(400, "auth_mode 必须是 none 或 required")
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    sr_rows = db.execute(
        """
        SELECT sr.resource_id, sr.version_no, sr.is_hidden, rv.png_path, r.name AS resource_name,
               rv.id AS version_id, rv.common_remark_html
        FROM show_resources sr
        JOIN resource_versions rv ON rv.resource_id = sr.resource_id AND rv.version_no = sr.version_no
        JOIN resources r ON r.id = sr.resource_id
        WHERE sr.show_id = ?
        ORDER BY sr.sort_order
        """,
        (show_id,),
    ).fetchall()
    resources = []
    slide_index = 0
    for r in sr_rows:
        if r["is_hidden"]:
            continue
        png_path = r["png_path"]
        if not png_path:
            raise HTTPException(409, f"资源 {r['resource_id']} 缺少预览图，无法生成离线包")
        abs_png = _resource_file_abs(png_path)
        if abs_png is None or not abs_png.exists():
            raise HTTPException(409, f"资源 {r['resource_id']} 的预览图不可用，无法生成离线包")
        png_data = abs_png.read_bytes()
        image_base64 = base64.b64encode(png_data).decode("ascii")
        resource_id = r["resource_id"]
        version_id = r["version_id"]
        try:
            thumb_data = _preview_thumb_bytes(abs_png)
            thumb_base64 = base64.b64encode(thumb_data).decode("ascii")
        except Exception:
            logger.exception(
                "离线缓存：生成资源缩略图失败 show_id=%s resource_id=%s version_id=%s png=%s",
                show_id, resource_id, version_id, abs_png,
            )
            raise HTTPException(500, f"资源 {resource_id} 的缩略图生成失败")
        common_remark_html = sanitize_html(r["common_remark_html"] or "")
        pr = db.execute(
            "SELECT content_html FROM personal_remarks WHERE resource_id = ? AND version_id = ? AND user_id = ?",
            (resource_id, version_id, user["id"]),
        ).fetchone()
        personal_remark_html = sanitize_html(pr["content_html"]) if pr else ""
        sr_remark = db.execute(
            "SELECT content_html FROM show_remarks WHERE show_id = ? AND resource_id = ? AND user_id = ?",
            (show_id, resource_id, user["id"]),
        ).fetchone()
        show_remark_html = sanitize_html(sr_remark["content_html"]) if sr_remark else ""
        resources.append({
            "id": resource_id,
            "name": r["resource_name"],
            "version_no": r["version_no"],
            "slide_index": slide_index,
            "image_base64": image_base64,
            "thumb_base64": thumb_base64,
            "common_remark_html": common_remark_html,
            "personal_remark_html": personal_remark_html,
            "show_remark_html": show_remark_html,
        })
        slide_index += 1
    auth_hash = None
    auth_username = None
    if auth_mode == "required":
        auth_hash = user["password_hash"]
        auth_username = user["username"]

    # --- 元数据字段 ---
    tags_raw = row["tags"] or ""
    tags_list = [t.strip() for t in tags_raw.split(",") if t.strip()] if tags_raw else []

    owner_name = None
    owner_id = row["owner_id"]
    if owner_id:
        owner_row = db.execute("SELECT username, name FROM users WHERE id = ?", (owner_id,)).fetchone()
        if owner_row:
            owner_name = owner_row["name"] if owner_row["name"] else owner_row["username"]

    # --- 封面图片字段 ---
    cover_thumb_base64 = None
    cover_hd_base64 = None
    # 取第一个非 hidden 且有 png_path 的资源
    for r in sr_rows:
        if r["is_hidden"]:
            continue
        png_path = r["png_path"]
        if not png_path:
            continue
        abs_png = _resource_file_abs(png_path)
        if abs_png is None or not abs_png.exists():
            continue
        # HD: 原始 PNG 的 base64
        try:
            cover_hd_base64 = base64.b64encode(abs_png.read_bytes()).decode("ascii")
        except Exception:
            cover_hd_base64 = None
        # Thumb: 640x360 JPEG 的 base64
        try:
            cover_thumb_base64 = base64.b64encode(_preview_thumb_bytes(abs_png)).decode("ascii")
        except Exception:
            cover_thumb_base64 = None
        break

    return {
        "format_version": 2,
        "show_id": show_id,
        "name": row["name"],
        "subject": row["subject"],
        "tags": tags_list,
        "status": row["status"],
        "secrecy_level": row["secrecy_level"],
        "owner_name": owner_name,
        "version_no": row["version_no"],
        "series_id": row["series_id"],
        "updated_at": row["updated_at"],
        "auth_mode": auth_mode,
        "auth_hash": auth_hash,
        "auth_username": auth_username,
        "cover_thumb_base64": cover_thumb_base64,
        "cover_hd_base64": cover_hd_base64,
        "resources": resources,
    }


@router.get("/api/shows/{show_id}/offline-version")
def get_show_offline_version(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    row = db.execute("SELECT * FROM shows WHERE id = ?", (show_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "放映不存在")
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    # 同一 series 的迭代版本是新的 shows 行（新 id、递增 version_no），
    # 需要按 series_id 查找系列中的最新版本，否则离线缓存的旧 show_id
    # 永远无法检测到系列中发布的新版本。
    series_id = row["series_id"]
    latest_row = db.execute(
        "SELECT * FROM shows WHERE series_id = ? ORDER BY version_no DESC LIMIT 1",
        (series_id,),
    ).fetchone()
    if latest_row is None:
        latest_row = row
    if not can_view_show(db, latest_row, user):
        raise HTTPException(403, "无可见权限")
    latest_show_id = int(latest_row["id"])
    sr_rows = db.execute(
        "SELECT resource_id, version_no FROM show_resources WHERE show_id = ?",
        (latest_show_id,),
    ).fetchall()
    return {
        # show_id 始终指向系列中的最新版本，前端据此拉取离线包并更新清单。
        "show_id": latest_show_id,
        "queried_show_id": int(show_id),
        "series_id": series_id,
        "version_no": int(latest_row["version_no"]),
        "updated_at": latest_row["updated_at"],
        "name": latest_row["name"],
        "resource_versions": {str(r["resource_id"]): r["version_no"] for r in sr_rows},
    }


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
