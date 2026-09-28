"""Routers / resources / files."""

from __future__ import annotations

from app.core.permissions import can_manage_resource
from app.core.permissions import can_view_resource
from app.core.permissions import require_user
from app.routers.dependencies import (
    db_read_dep,
)
from app.services.common import (
    _json_loads,
)
from app.services.downloads.fonts import (
    _build_fonts_bundle,
    _write_fonts_into_zip,
)
from app.services.downloads.embed_fonts import FontEmbeddingError, embed_fonts_in_pptx
from app.services.files import (
    asset_preview_url,
    cleanup_materialized,
    _content_disposition,
    defer_materialized_cleanup,
    _ensure_preview_thumb,
    _resource_file_abs,
    _safe_abs,
    materialization_scope,
)
from app.core.oss import is_oss_ref
from app.core.oss import storage as oss_storage
from app.services.resources import (
    _resource_row,
    _version_row,
)
from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from fastapi import Query
from fastapi import Response
from fastapi.responses import FileResponse, RedirectResponse
from functools import wraps
import io
import sqlite3
import zipfile
from io import BytesIO
from PIL import Image
from starlette.background import BackgroundTask
from typing import Any, Callable, TypeVar

router = APIRouter()

_T = TypeVar("_T")


def _cleanup_oss_materialized(endpoint: Callable[..., _T]) -> Callable[..., _T]:
    @wraps(endpoint)
    def wrapped(*args: Any, **kwargs: Any) -> _T:
        with materialization_scope():
            return endpoint(*args, **kwargs)
    return wrapped


@router.get("/api/resources/{resource_id}/preview")
def resource_preview(
    resource_id: int,
    version_id: int | None = Query(None),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> FileResponse:
    row = _resource_row(db, resource_id)
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无可见权限")
    version = _version_row(db, resource_id, version_id)
    if is_oss_ref(version["png_path"]):
        url = asset_preview_url(version["png_path"])
        if not url:
            raise HTTPException(503, "OSS 预览地址生成失败")
        return RedirectResponse(url, status_code=307)  # type: ignore[return-value]
    path = _safe_abs(version["png_path"])
    if path is None or not path.exists():
        raise HTTPException(404, "预览图不存在")
    return FileResponse(path)


@router.get("/api/resources/{resource_id}/preview-thumb")
def resource_preview_thumb(
    resource_id: int,
    version_id: int | None = Query(None),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> FileResponse:
    row = _resource_row(db, resource_id)
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无可见权限")
    version = _version_row(db, resource_id, version_id)
    if is_oss_ref(version["png_path"]):
        url = asset_preview_url(version["png_path"], thumb=True)
        if not url:
            raise HTTPException(503, "OSS 小图地址生成失败")
        return RedirectResponse(url, status_code=307)  # type: ignore[return-value]
    path = _safe_abs(version["png_path"])
    if path is None or not path.exists():
        raise HTTPException(404, "预览图不存在")
    try:
        thumb = _ensure_preview_thumb(path, int(version["id"]))
    except Exception:
        return FileResponse(path, headers={"Cache-Control": "private, max-age=3600"})
    return FileResponse(thumb, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@router.get("/api/resources/{resource_id}/download")
@_cleanup_oss_materialized
def download_resource(
    resource_id: int,
    with_fonts: bool = Query(False),
    version_id: int | None = Query(None),
    format: str | None = Query(None, pattern="^(pptx-embedded|pptx|zip|png)$"),
    resolution: str = Query("4k", pattern="^(4k|2k|1080p|720p)$"),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
):
    row = _resource_row(db, resource_id)
    if not can_manage_resource(db, row, user):
        raise HTTPException(403, "无管理权限，不能下载素材")
    version = _version_row(db, resource_id, version_id)

    download_format = format or ("zip" if with_fonts else "pptx")
    filename_base = f"{row['name']}_v{version['version_no']}"
    if download_format == "png":
        png_path = _resource_file_abs(version["png_path"])
        if png_path is None or not png_path.exists():
            raise HTTPException(404, "预览 PNG 不存在")
        max_edge = {"4k": 4096, "2k": 2048, "1080p": 1920, "720p": 1280}[resolution]
        try:
            with Image.open(png_path) as image:
                image.load()
                if max(image.size) > max_edge:
                    if image.mode not in {"RGB", "RGBA", "L", "LA"}:
                        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
                    image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
                    output = BytesIO()
                    image.save(output, format="PNG", optimize=True)
                    content = output.getvalue()
                else:
                    content = png_path.read_bytes()
        except (OSError, ValueError) as exc:
            raise HTTPException(422, "预览图无法转换为 PNG") from exc
        return Response(
            content=content,
            media_type="image/png",
            headers={"Content-Disposition": _content_disposition(f"{filename_base}_{resolution}.png")},
        )

    ppt_path = _resource_file_abs(version["ppt_path"])
    if ppt_path is None or not ppt_path.exists():
        raise HTTPException(404, "PPT 文件不存在")
    if download_format == "pptx":
        background = None
        if is_oss_ref(version["ppt_path"]):
            # Progress downloads use fetch(), which cannot reliably read a
            # cross-origin OSS redirect without bucket CORS configuration.
            # Proxy the original PPT through this same-origin response and
            # remove the materialized temp file only after streaming finishes.
            defer_materialized_cleanup(ppt_path)
            background = BackgroundTask(cleanup_materialized, [ppt_path])
        return FileResponse(
            ppt_path,
            media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            headers={"Content-Disposition": _content_disposition(f"{filename_base}.pptx")},
            background=background,
        )

    if download_format == "pptx-embedded":
        font_names = _json_loads(version["font_names"], [])
        try:
            content = embed_fonts_in_pptx(ppt_path, db, font_names)
        except FontEmbeddingError as exc:
            raise HTTPException(422, str(exc)) from exc
        return Response(
            content=content,
            media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            headers={"Content-Disposition": _content_disposition(f"{filename_base}_embedded_fonts.pptx")},
        )

    font_names = _json_loads(version["font_names"], [])
    fonts, _ = _build_fonts_bundle(db, font_names)
    missing = _json_loads(version["missing_fonts"], [])
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as package:
        package.write(ppt_path, arcname=ppt_path.name)
        _write_fonts_into_zip(package, fonts, missing)
    content = buffer.getvalue()
    return Response(
        content=content,
        media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(f"{filename_base}_with_fonts.zip")},
    )
