"""Routers / shows / downloads."""

from __future__ import annotations

from PIL import Image
from app.core.permissions import can_view_show
from app.core.permissions import require_user
from app.core.storage import safe_filename
from app.core.ppt import _build_watermark_tile
from app.core.ppt import add_watermark_to_image
from app.core.ppt import add_watermark_to_pptx
from app.core.ppt import build_image_pptx
from app.core.ppt import determine_pdf_canvas_size
from app.core.ppt import fit_image_to_canvas
from app.core.ppt import merge_pptx_files
from app.routers.dependencies import (
    db_dep,
    db_read_dep,
)
from app.services.downloads.cache import (
    _get_cached_download,
    _save_to_cache,
    _show_download_cache_key,
)
from app.services.downloads.fonts import (
    _build_fonts_bundle,
    _write_fonts_into_zip,
)
from app.services.downloads.tracking import (
    _compose_watermark_text,
    _record_download,
)
from app.services.files import (
    _content_disposition,
    _resource_file_abs,
    materialization_scope,
)
from app.services.shows import (
    _aggregate_show_fonts,
    _collect_show_accessible_resources,
    _show_row,
)
from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from fastapi import Query
from fastapi import Request
from fastapi.responses import FileResponse
from pathlib import Path
from typing import Any, Callable, TypeVar
from functools import wraps
import json
import logging
import shutil
import sqlite3
import tempfile
import zipfile

logger = logging.getLogger(__name__)

router = APIRouter()

_T = TypeVar("_T")


def _cleanup_oss_materialized(endpoint: Callable[..., _T]) -> Callable[..., _T]:
    """Remove only OSS files materialized while assembling this response."""
    @wraps(endpoint)
    def wrapped(*args: Any, **kwargs: Any) -> _T:
        with materialization_scope():
            response = endpoint(*args, **kwargs)
            if isinstance(response, FileResponse):
                response.headers["Cache-Control"] = "private, no-store"
            return response
    return wrapped


@router.get("/api/shows/{show_id}/download/pdf")
@_cleanup_oss_materialized
def download_show_pdf(
    show_id: int,
    request: Request,
    watermark: str = Query(""),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> FileResponse:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    track_code = _record_download(db, user, request, show_id, "pdf")
    wm_text = _compose_watermark_text(track_code, watermark) if watermark else ""
    items = _collect_show_accessible_resources(db, show_id, user)

    # 无水印时尝试缓存命中
    cache_key = ""
    if not wm_text:
        cache_key = _show_download_cache_key(show_id, "pdf", items)
        cached = _get_cached_download(cache_key, "pdf")
        if cached:
            return FileResponse(
                cached,
                media_type="application/pdf",
                headers={"Content-Disposition": _content_disposition(f"{row['name']}.pdf")},
            )

    # ── 预扫描：收集有效 PNG 路径并动态确定画布尺寸 ──
    valid_paths: list[Path] = []
    for item in items:
        if item["png_path"]:
            path = _resource_file_abs(item["png_path"])
            if path and path.exists():
                valid_paths.append(path)
    if not valid_paths:
        raise HTTPException(404, "没有可下载的预览图")
    canvas_w, canvas_h = determine_pdf_canvas_size(valid_paths)

    images = []
    wm_tile = None
    for path in valid_paths:
        img = Image.open(path).convert("RGB")
        img = fit_image_to_canvas(img, canvas_w, canvas_h)
        if wm_text:
            if wm_tile is None:
                wm_tile = _build_watermark_tile(canvas_w, canvas_h, wm_text)
            img = add_watermark_to_image(img, wm_text, tile=wm_tile).convert("RGB")
        images.append(img)
    if wm_tile is not None:
        wm_tile.close()
    if not images:
        raise HTTPException(404, "没有可下载的预览图")
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    first = images[0]
    rest = images[1:]
    first.save(tmp_path, "PDF", save_all=True, append_images=rest)
    for img in images:
        img.close()

    # 无水印时写入缓存
    if cache_key:
        try:
            _save_to_cache(tmp_path, cache_key, "pdf")
        except Exception:
            logger.warning("写入 PDF 下载缓存失败", exc_info=True)

    return FileResponse(
        tmp_path,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(f"{row['name']}.pdf")},
    )


@router.get("/api/shows/{show_id}/download/pptx-images")
@_cleanup_oss_materialized
def download_show_pptx_images(
    show_id: int,
    request: Request,
    watermark: str = Query(""),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> FileResponse:
    """将放映组中所有可见资源的高清预览图生成为 PPTX，每张图一页。"""
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    track_code = _record_download(db, user, request, show_id, "pptx_images")
    wm_text = _compose_watermark_text(track_code, watermark) if watermark else ""
    items = _collect_show_accessible_resources(db, show_id, user)

    # 无水印时尝试缓存命中
    cache_key = ""
    if not wm_text:
        cache_key = _show_download_cache_key(show_id, "pptx_images", items)
        cached = _get_cached_download(cache_key, "pptx")
        if cached:
            return FileResponse(
                cached,
                media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                headers={"Content-Disposition": _content_disposition(f"{row['name']}_纯图.pptx")},
            )

    image_paths: list[Path] = []
    for item in items:
        if item["png_path"]:
            path = _resource_file_abs(item["png_path"])
            if path and path.exists():
                image_paths.append(path)
    if not image_paths:
        raise HTTPException(404, "没有可下载的预览图")
    tmp = tempfile.NamedTemporaryFile(suffix=".pptx", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    try:
        build_image_pptx(image_paths, tmp_path)
        if wm_text:
            try:
                add_watermark_to_pptx(tmp_path, wm_text)
            except Exception:
                logger.warning("纯图 PPT 水印添加失败，将跳过水印继续生成 show_id=%s", show_id, exc_info=True)
    except Exception as exc:
        tmp_path.unlink(missing_ok=True)
        logger.exception("生成纯图 PPTX 失败 show_id=%s", show_id)
        raise HTTPException(500, f"生成纯图 PPT 失败：{exc}") from exc

    # 无水印时写入缓存
    if cache_key:
        try:
            _save_to_cache(tmp_path, cache_key, "pptx")
        except Exception:
            logger.warning("写入纯图 PPT 下载缓存失败", exc_info=True)

    return FileResponse(
        tmp_path,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": _content_disposition(f"{row['name']}_纯图.pptx")},
    )


@router.get("/api/shows/{show_id}/fonts")
def show_fonts(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    items = _collect_show_accessible_resources(db, show_id, user)
    return _aggregate_show_fonts(db, items)


@router.get("/api/shows/{show_id}/download/pptx")
@_cleanup_oss_materialized
def download_show_pptx(
    show_id: int,
    request: Request,
    with_fonts: bool = Query(False),
    watermark: str = Query(""),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> FileResponse:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    track_code = _record_download(db, user, request, show_id, "pptx_fonts" if with_fonts else "pptx")
    wm_text = _compose_watermark_text(track_code, watermark) if watermark else ""
    dl_type = "pptx_fonts" if with_fonts else "pptx"
    items = _collect_show_accessible_resources(db, show_id, user)

    # 无水印时尝试缓存命中
    cache_key = ""
    if not wm_text:
        cache_key = _show_download_cache_key(show_id, dl_type, items)
        cache_ext = "zip" if with_fonts else "pptx"
        cached = _get_cached_download(cache_key, cache_ext)
        if cached:
            filename = f"{row['name']}_with_fonts.zip" if with_fonts else f"{row['name']}.pptx"
            mime = "application/zip" if with_fonts else "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            return FileResponse(
                cached,
                media_type=mime,
                headers={"Content-Disposition": _content_disposition(filename)},
            )

    input_paths: list[Path] = []
    hidden_flags: list[bool] = []
    for item in items:
        if not item["ppt_path"]:
            continue
        ppt_path = _resource_file_abs(item["ppt_path"])
        if not ppt_path or not ppt_path.exists():
            continue
        input_paths.append(ppt_path)
        hidden_flags.append(item.get("is_hidden", False))
    if not input_paths:
        raise HTTPException(404, "没有可下载的内容")
    tmp = tempfile.NamedTemporaryFile(suffix=".pptx", delete=False)
    merged_path = Path(tmp.name)
    tmp.close()
    merge_pptx_files(input_paths, merged_path, hidden_flags=hidden_flags)
    if wm_text:
        try:
            add_watermark_to_pptx(merged_path, wm_text)
        except Exception:
            logger.warning("PPTX 水印添加失败，生成无水印文件 show_id=%s", show_id, exc_info=True)
    if not with_fonts:
        # 无水印时写入缓存
        if cache_key:
            try:
                _save_to_cache(merged_path, cache_key, "pptx")
            except Exception:
                logger.warning("写入 PPTX 下载缓存失败", exc_info=True)
        return FileResponse(
            merged_path,
            media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            headers={"Content-Disposition": _content_disposition(f"{row['name']}.pptx")},
        )
    agg = _aggregate_show_fonts(db, items)
    fonts, _ = _build_fonts_bundle(db, agg["font_names"])
    zip_tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    zip_path = Path(zip_tmp.name)
    zip_tmp.close()
    try:
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(merged_path, arcname=f"{safe_filename(row['name'])}.pptx")
            _write_fonts_into_zip(zf, fonts, agg["missing_fonts"])
    finally:
        merged_path.unlink(missing_ok=True)

    # 无水印时写入缓存
    if cache_key:
        try:
            _save_to_cache(zip_path, cache_key, "zip")
        except Exception:
            logger.warning("写入 PPTX+字体包下载缓存失败", exc_info=True)

    return FileResponse(
        zip_path,
        media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(f"{row['name']}_with_fonts.zip")},
    )


@router.get("/api/shows/{show_id}/download/zip")
@_cleanup_oss_materialized
def download_show_zip(
    show_id: int,
    request: Request,
    with_fonts: bool = Query(False),
    watermark: str = Query(""),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> FileResponse:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    track_code = _record_download(db, user, request, show_id, "zip_fonts" if with_fonts else "zip")
    wm_text = _compose_watermark_text(track_code, watermark) if watermark else ""
    items = _collect_show_accessible_resources(db, show_id, user)
    written = 0
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in items:
            if not item["ppt_path"]:
                continue
            ppt_path = _resource_file_abs(item["ppt_path"])
            if not ppt_path or not ppt_path.exists():
                continue
            arcname = f"{safe_filename(item['name'])}_v{item['version_no']}.pptx"
            if wm_text:
                # 复制一份并加水印，然后加入 zip
                wm_tmp = tempfile.NamedTemporaryFile(suffix=".pptx", delete=False)
                wm_tmp_path = Path(wm_tmp.name)
                wm_tmp.close()
                try:
                    shutil.copy2(ppt_path, wm_tmp_path)
                    add_watermark_to_pptx(wm_tmp_path, wm_text)
                    zf.write(wm_tmp_path, arcname)
                except Exception:
                    logger.warning("ZIP 中 %s 水印添加失败，使用原始文件", arcname, exc_info=True)
                    zf.write(ppt_path, arcname)
                finally:
                    wm_tmp_path.unlink(missing_ok=True)
            else:
                zf.write(ppt_path, arcname)
            written += 1
        if not written:
            tmp_path.unlink(missing_ok=True)
            raise HTTPException(404, "没有可下载的内容")
        agg = _aggregate_show_fonts(db, items)
        fonts_info = {
            "fonts": sorted(agg["font_names"], key=str.lower),
            "missing_fonts": sorted(agg["missing_fonts"], key=str.lower),
        }
        zf.writestr("fonts.json", json.dumps(fonts_info, ensure_ascii=False, indent=2))
        if with_fonts:
            fonts, _ = _build_fonts_bundle(db, agg["font_names"])
            _write_fonts_into_zip(zf, fonts, agg["missing_fonts"])
    filename = f"{row['name']}_with_fonts.zip" if with_fonts else f"{row['name']}.zip"
    return FileResponse(
        tmp_path,
        media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(filename)},
    )
