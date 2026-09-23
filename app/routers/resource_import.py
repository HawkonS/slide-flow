"""Routers / resource import."""

from __future__ import annotations

from app.core.fonts import missing_fonts
from app.core.permissions import require_user
from app.core.ppt import detect_ppt_fonts
from app.core.ppt import slide_count
from app.db import get_db, known_font_aliases
from app.routers.dependencies import (
    db_dep,
    db_read_dep,
)
from app.services.common import (
    _natural_sort_key,
)
from app.services.files import (
    OFFICE_EXTENSIONS,
    _compress_hd_image,
)
from app.services.resource_import.commit import (
    _commit_resource_import_sync,
)
from app.services.resource_import.jobs import (
    _run_resource_import_job,
)
from app.services.resource_import.previews import (
    _preview_set_is_current,
    _render_and_publish_ppt_previews,
)
from app.services.resource_import.limits import (
    RESOURCE_IMPORT_MAX_IMAGES,
    RESOURCE_IMPORT_MAX_IMAGE_BYTES,
    RESOURCE_IMPORT_MAX_PPT_BYTES,
    RESOURCE_IMPORT_MAX_SLIDES,
    RESOURCE_IMPORT_MAX_TOTAL_BYTES,
    RESOURCE_IMPORT_TTL,
)
from app.services.resource_import.rendering import (
    IMPORT_EXTENSIONS,
    RESOURCE_IMPORT_RENDERER_VERSION,
    _normalize_import_ppt,
    _replace_ppt_fonts,
)
from app.services.resource_import.streaming import preview_stream
from app.services.resource_import.render_tasks import cancel_render_tasks
from app.services.resource_import.sessions import (
    _cleanup_expired_resource_imports,
    _cleanup_resource_import_session,
    _resource_import_file,
    _resource_import_lock,
    _resource_import_locked_session,
    _resource_import_operation,
    _resource_import_receipt,
    _resource_import_root,
    reserve_resource_import_directory,
    _resource_import_session,
    _resource_import_sessions,
    _resource_import_temp_dir,
    _write_resource_import_session,
)
from app.services.resource_import.validation import (
    _require_resource_import_origin,
    _save_resource_import_upload,
    _validate_import_image,
    _validate_import_ppt_package,
    _validate_resource_import_replacements,
)
from fastapi import APIRouter
from fastapi import Body
from fastapi import Depends
from fastapi import File
from fastapi import Form
from fastapi import HTTPException
from fastapi import Response
from fastapi import UploadFile
from fastapi.responses import FileResponse
from pathlib import Path
from typing import Any
import asyncio
import json
import logging
import shutil
import sqlite3
import time
import uuid

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/resource-import/{session_id}/result")
def resource_import_result(
    session_id: str, response: Response, user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    receipt = _resource_import_receipt(db, session_id, int(user["id"]))
    if receipt is not None:
        return {"status": "completed", **receipt}
    _resource_import_session(session_id, user)
    return {"status": "pending"}


@router.post("/api/resource-import/prepare")
async def prepare_resource_import(
    mode: str = Form("ppt"),
    ppt_file: UploadFile = File(...),
    images: list[UploadFile] | None = File(None),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
    _: None = Depends(_require_resource_import_origin),
) -> dict[str, Any]:
    """上传到临时会话并完成页数/字体预检，不创建资源记录。"""
    _cleanup_expired_resource_imports()
    if mode not in {"ppt", "ppt_images"}:
        raise HTTPException(400, "导入模式不正确")
    suffix = Path(ppt_file.filename or "").suffix.lower()
    if suffix not in IMPORT_EXTENSIONS:
        raise HTTPException(400, "请上传 PPTX/POTX/PPSX；旧版 PPT/POT/PPS 请先在 Office/WPS 中另存为 PPTX")
    image_uploads = list(images or [])
    if mode == "ppt_images" and not image_uploads:
        raise HTTPException(400, "请选择图片")
    if mode == "ppt" and image_uploads:
        raise HTTPException(400, "PPT-only 模式不能携带图片")
    if len(image_uploads) > RESOURCE_IMPORT_MAX_IMAGES:
        raise HTTPException(413, f"每批最多导入 {RESOURCE_IMPORT_MAX_IMAGES} 张图片")
    image_names: set[str] = set()
    for image in image_uploads:
        suffix = Path(image.filename or "").suffix.lower()
        if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
            raise HTTPException(400, "图片仅支持 PNG/JPG/JPEG/WEBP")
        image_name = Path((image.filename or "").replace("\\", "/")).name.casefold()
        if image_name in image_names:
            raise HTTPException(400, "图片文件名不能重复，请重命名后重新选择")
        image_names.add(image_name)
    if ppt_file.size is not None and ppt_file.size > RESOURCE_IMPORT_MAX_PPT_BYTES:
        raise HTTPException(413, "PPT 文件不能超过 256 MB")
    if any(image.size is not None and image.size > RESOURCE_IMPORT_MAX_IMAGE_BYTES for image in image_uploads):
        raise HTTPException(413, "单张图片不能超过 64 MB")
    if sum(int(upload.size or 0) for upload in [ppt_file, *image_uploads]) > RESOURCE_IMPORT_MAX_TOTAL_BYTES:
        raise HTTPException(413, "本批导入文件总大小超过 512 MB")

    # Reject before multipart data is copied into a new session when the host
    # is already under pressure. The same guard is repeated by the renderer;
    # this one prevents uploads from filling the volume before rendering starts.
    session_id, temp_dir = reserve_resource_import_directory()
    try:
        source_path, total_bytes = await _save_resource_import_upload(
            ppt_file, temp_dir, "source_", max_bytes=RESOURCE_IMPORT_MAX_PPT_BYTES, total_bytes=0, stage_oss=True,
        )
        if source_path.suffix.lower() in {".pptx", ".potx", ".ppsx"}:
            await _run_resource_import_job(_validate_import_ppt_package, source_path)
        source_path = await _run_resource_import_job(_normalize_import_ppt, source_path, temp_dir)
        if source_path.stat().st_size > RESOURCE_IMPORT_MAX_PPT_BYTES:
            raise HTTPException(413, "转换后的 PPT 文件不能超过 256 MB")
        await _run_resource_import_job(_validate_import_ppt_package, source_path)
        n_slides = await _run_resource_import_job(slide_count, source_path)
        if n_slides <= 0:
            raise HTTPException(400, "无法读取 PPT 页数")
        if n_slides > RESOURCE_IMPORT_MAX_SLIDES:
            raise HTTPException(413, f"PPT 不能超过 {RESOURCE_IMPORT_MAX_SLIDES} 页")
        if image_uploads and len(image_uploads) != n_slides:
            raise HTTPException(400, f"PPT 共 {n_slides} 页，但提供了 {len(image_uploads)} 张图片，数量不一致")
        image_paths: list[str] = []
        image_names_in_order: list[str] = []
        for index, image in enumerate(sorted(image_uploads, key=lambda f: _natural_sort_key(f.filename or "")), start=1):
            image_path, image_bytes = await _save_resource_import_upload(
                image, temp_dir, f"image_{index:04d}_", max_bytes=RESOURCE_IMPORT_MAX_IMAGE_BYTES, total_bytes=total_bytes, stage_oss=True,
            )
            total_bytes += image_bytes
            await _run_resource_import_job(_validate_import_image, image_path)
            # Normalize reviewed uploads once; the committed asset is always
            # one PNG (up to the configured 4K edge), never a second thumbnail.
            image_path = await _run_resource_import_job(_compress_hd_image, image_path)
            image_paths.append(str(image_path))
            image_names_in_order.append(Path((image.filename or "").replace("\\", "/")).name)

        fonts = await _run_resource_import_job(detect_ppt_fonts, source_path)
        missing = missing_fonts(fonts, known_font_aliases(db))
        preview_paths: list[Path]
        if image_paths:
            preview_paths = [Path(p) for p in image_paths]
        else:
            # 预览渲染是独立步骤。预检只负责上传、页数和字体检查，
            # 前端随后调用 /previews，字体替换与 WPS 渲染独立。
            preview_paths = []

        session = {
            "session_id": session_id,
            "owner_id": int(user["id"]),
            "mode": mode,
            "temp_dir": str(temp_dir),
            "source_path": str(source_path),
            "image_paths": image_paths,
            "image_names": image_names_in_order,
            "preview_paths": [str(p) for p in preview_paths],
            "slide_count": n_slides,
            "fonts": fonts,
            "missing_fonts": missing,
            "preview_status": "ready" if image_paths else "pending",
            "preview_error": None,
            "renderer_version": RESOURCE_IMPORT_RENDERER_VERSION if image_paths else None,
            "expires_at": time.time() + RESOURCE_IMPORT_TTL,
        }
        _write_resource_import_session(session)
        with _resource_import_lock:
            _resource_import_sessions[session_id] = session
        return {
            "session_id": session_id,
            "slide_count": n_slides,
            "fonts": fonts,
            "missing_fonts": missing,
            "preview_count": len(preview_paths),
            "preview_status": "ready" if image_paths else "pending",
            "expires_in": RESOURCE_IMPORT_TTL,
            "image_names": image_names_in_order,
        }
    except asyncio.CancelledError:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    except HTTPException:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(400, str(exc) or "PPT 预检失败") from exc


@router.get("/api/resource-import/{session_id}/preview/{index}")
def resource_import_preview(
    session_id: str,
    index: int,
    user: sqlite3.Row = Depends(require_user),
    attempt: str | None = None,
) -> FileResponse:
    session = _resource_import_session(session_id, user)
    if attempt is not None and attempt != session.get("render_attempt"):
        raise HTTPException(409, "该图片属于旧渲染任务，请刷新预览")
    if session.get("mode") == "ppt" and session.get("renderer_version") != RESOURCE_IMPORT_RENDERER_VERSION:
        raise HTTPException(409, "预览已过期，请重新生成图片")
    if index < 0 or index >= int(session["slide_count"]):
        raise HTTPException(404, "预览图不存在")
    previews = session.get("preview_paths", [])
    raw = previews[index] if index < len(previews) else session.get("partial_preview_paths", {}).get(str(index))
    if not raw:
        raise HTTPException(404, "此页尚未完成渲染")
    path = _resource_import_file(session, raw)
    media_type = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "private, no-store"})


@router.post("/api/resource-import/{session_id}/previews")
async def generate_resource_import_previews(
    session_id: str,
    user: sqlite3.Row = Depends(require_user),
    _: None = Depends(_require_resource_import_origin),
) -> Response:
    """单独生成 PPT 预览图；失败不会影响已完成的字体替换。"""
    session = _resource_import_session(session_id, user)
    if session.get("mode") == "ppt_images":
        from fastapi.responses import JSONResponse
        image_paths = [_resource_import_file(session, p) for p in session.get("image_paths", [])]
        return JSONResponse({"preview_count": len(image_paths), "preview_status": "ready"})
    return preview_stream(session_id, user)


@router.post("/api/resource-import/{session_id}/replace-fonts")
async def replace_resource_import_fonts(
    session_id: str,
    replacements: dict[str, str] = Body(...),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
    session: dict[str, Any] = Depends(_resource_import_locked_session),
    _: None = Depends(_require_resource_import_origin),
) -> dict[str, Any]:
    if "commit_result" in session:
        raise HTTPException(410, "导入会话已提交，请勿重复处理")
    known_aliases = known_font_aliases(db)
    replacements = _validate_resource_import_replacements(session, replacements, known_aliases)
    source_path = _resource_import_file(session, session.get("source_path"))
    target = source_path.with_name(f"replaced_{uuid.uuid4().hex[:10]}.pptx")
    old_preview_paths = [_resource_import_file(session, p, required=False) for p in session.get("preview_paths", [])]
    try:
        await _run_resource_import_job(_replace_ppt_fonts, source_path, replacements, target)
        # 先验证候选文件，再原子替换源文件；任何失败都保留原始 PPTX。
        fonts = await _run_resource_import_job(detect_ppt_fonts, target)
        missing = missing_fonts(fonts, known_font_aliases(db))
        # Publish the candidate source and its font/preview state together via
        # one atomic metadata update. A failed write keeps the old source.
        session["source_path"] = str(target)
        preview_paths = old_preview_paths
        preview_status = session.get("preview_status", "ready")
        if session.get("mode") == "ppt":
            # 字体变化后旧预览已经失效，清掉它们；新图由独立的 /previews 请求生成。
            preview_paths = []
            preview_status = "blocked" if missing else "pending"
            cancel_db = get_db()
            try:
                cancel_render_tasks(cancel_db, session_id)
            finally:
                cancel_db.close()
        with _resource_import_lock:
            session["preview_paths"] = [str(p) for p in preview_paths]
            session["fonts"] = fonts
            session["missing_fonts"] = missing
            session["preview_status"] = preview_status
            session["renderer_version"] = None
            session["preview_error"] = None
            session["partial_preview_paths"] = {}
            session["split_paths"] = []
            session["split_hashes"] = []
            session["rendered_source_sha256"] = None
            session["render_attempt"] = None
            session["expires_at"] = time.time() + RESOURCE_IMPORT_TTL
        _write_resource_import_session(session)
        task_id = session.get("task_id")
        if isinstance(task_id, int):
            task_db = get_db()
            try:
                task_row = task_db.execute("SELECT params FROM tasks WHERE id = ?", (task_id,)).fetchone()
                if task_row:
                    task_params = json.loads(task_row["params"] or "{}")
                    task_params.update({
                        "workflow_state": "font_check" if missing else "awaiting_render",
                        "fonts": fonts,
                        "missing_fonts": missing,
                        "preview_status": preview_status,
                    })
                    task_db.execute(
                        "UPDATE tasks SET status = 'pending', message = ?, params = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id = ? AND status <> 'cancelled'",
                        ("等待处理缺失字体" if missing else "等待渲染高清图片", json.dumps(task_params, ensure_ascii=False), task_id),
                    )
                    task_db.commit()
            finally:
                task_db.close()
        try:
            source_path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Old import source will be removed by session cleanup: %s", session_id)
        if session.get("mode") == "ppt":
            for old_dir in {p.parent for p in old_preview_paths if p.parent.name.startswith("previews")}:
                shutil.rmtree(old_dir, ignore_errors=True)
        return {
            "fonts": fonts,
            "missing_fonts": missing,
            "preview_count": len(session.get("preview_paths", [])),
            "preview_status": session.get("preview_status", "pending"),
        }
    except asyncio.CancelledError:
        target.unlink(missing_ok=True)
        raise
    except HTTPException:
        target.unlink(missing_ok=True)
        raise
    except Exception as exc:
        target.unlink(missing_ok=True)
        logger.exception("Resource import font replacement failed session_id=%s", session_id)
        raise HTTPException(400, f"字体替换失败：{exc}") from exc


@router.post("/api/resource-import/{session_id}/commit")
async def commit_resource_import(
    session_id: str,
    payload: dict[str, Any] = Body(...),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
    session: dict[str, Any] = Depends(_resource_import_locked_session),
    _: None = Depends(_require_resource_import_origin),
) -> dict[str, Any]:
    if "commit_result" in session:
        return session["commit_result"]
    return await _run_resource_import_job(_commit_resource_import_sync, session_id, payload, user, db, session)


@router.delete("/api/resource-import/{session_id}")
def cancel_resource_import(
    session_id: str,
    user: sqlite3.Row = Depends(require_user),
    session: dict[str, Any] = Depends(_resource_import_locked_session),
    _: None = Depends(_require_resource_import_origin),
) -> dict[str, Any]:
    cancel_db = get_db()
    try:
        cancel_render_tasks(cancel_db, session_id)
    finally:
        cancel_db.close()
    _cleanup_resource_import_session(session_id, session)
    return {"ok": True}
