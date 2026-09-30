"""异步放映下载任务执行框架。

与 ``app.routers.shows.downloads`` 中现有的同步下载 API 共存：
- 同步 API（``/api/shows/{id}/download/...``）用于直接返回 FileResponse 的小文件场景
- 本模块提供基于 tasks 表 + asyncio.Semaphore 的异步执行框架，
  通过 WebSocket 推送进度，前端可在生成期间继续操作。

缓存、字体打包和水印追踪通过 services 层的正向依赖共享，避免业务代码
反向导入应用入口。
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import sqlite3
import tempfile
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from PIL import Image
from fastapi import HTTPException

from app.config import settings
from app.core.permissions import can_view_show
from app.core.storage import safe_filename
from app.core.ppt import (
    _build_watermark_tile,
    add_watermark_to_image,
    add_watermark_to_pptx,
    build_image_pptx,
    determine_pdf_canvas_size,
    fit_image_to_canvas,
    merge_pptx_files,
    split_pptx_to_single_pages,
)
from app.db import get_db
from app.core.task_events import append_task_event
from app.services.tasks.runtime import _task_cancel_flags
from app.services.downloads.cache import _get_cached_download, _save_to_cache, _show_download_cache_key
from app.services.downloads.access import _download_task_owner
from app.services.downloads.embed_fonts import FontEmbeddingError, embed_fonts_in_pptx
from app.services.downloads.fonts import _build_fonts_bundle, _write_fonts_into_zip
from app.services.downloads.tracking import _compose_watermark_text
from app.services.files import materialization_scope, _resource_file_abs
from app.services.shows import _collect_show_accessible_resources, _show_row


logger = logging.getLogger(__name__)


# ── 并发控制：最多同时执行 3 个下载任务 ──
_download_semaphore = asyncio.Semaphore(3)

# 异步任务的最终产物存放目录（与缓存目录平级，便于清理逻辑统一）
_DOWNLOAD_TASKS_DIR = settings.downloads_dir / "tasks"

# 允许的 download_type
ALLOWED_DOWNLOAD_TYPES = {"pdf", "pptx_images", "pptx", "pptx_pages", "zip"}


class DownloadTaskCancelled(Exception):
    """Raised between page operations after a user or administrator cancels a download."""


def cleanup_download_task_output(task_id: int) -> None:
    """Remove only generated output files for this task, never shared cache entries."""
    try:
        root = _DOWNLOAD_TASKS_DIR.resolve()
        for path in root.glob(f"task_{int(task_id)}.*"):
            if path.resolve(strict=False).parent == root:
                path.unlink(missing_ok=True)
    except (OSError, ValueError):
        logger.warning("Could not remove temporary output for download task %s", task_id, exc_info=True)


def request_download_cancel(task_id: int) -> None:
    event = _task_cancel_flags.get(int(task_id))
    if event is not None:
        event.set()


def _check_download_cancelled(event: threading.Event) -> None:
    if event.is_set():
        raise DownloadTaskCancelled()


def _now_db_ts() -> str:
    """与现有 tasks 表 created_at 一致的本地时间戳格式。"""
    from datetime import datetime
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _update_task(
    db: sqlite3.Connection,
    task_id: int,
    *,
    status: str | None = None,
    message: str | None = None,
    progress: int | None = None,
    result_data: dict | None = None,
    error_message: str | None = None,
    mark_completed: bool = False,
    total: int | None = None,
    event_owner_id: int | None = None,
    event_message: dict[str, Any] | None = None,
) -> bool:
    """Update task state and its outbound event in one transaction."""
    fields: list[str] = ["updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"]
    args: list[Any] = []
    if status is not None:
        fields.append("status = ?")
        args.append(status)
    if message is not None:
        fields.append("message = ?")
        args.append(message)
    if progress is not None:
        fields.append("progress = ?")
        args.append(int(progress))
    if total is not None:
        fields.append("total = ?")
        args.append(int(total))
    if result_data is not None:
        fields.append("result_data = ?")
        args.append(json.dumps(result_data, ensure_ascii=False))
    if error_message is not None:
        fields.append("error_message = ?")
        args.append(str(error_message)[:500])
    if mark_completed:
        fields.append("completed_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')")
    args.append(task_id)
    try:
        cursor = db.execute(
            f"UPDATE tasks SET {', '.join(fields)}"
            " WHERE id = ? AND status <> 'cancelled'",
            args,
        )
        updated = cursor.rowcount > 0
        if updated and event_message is not None:
            if event_owner_id is None:
                raise ValueError("event_owner_id is required with event_message")
            append_task_event(db, event_owner_id, event_message)
        db.commit()
        return updated
    except Exception:
        db.rollback()
        raise


def _safe_abs(stored_path: str | None) -> Path | None:
    """解析存储路径并保持下载任务与同步下载 API 的安全边界一致。"""
    return _resource_file_abs(stored_path)


def _output_path(task_id: int, ext: str) -> Path:
    """生成任务最终产物的固定路径（重复执行会覆盖）。"""
    _DOWNLOAD_TASKS_DIR.mkdir(parents=True, exist_ok=True)
    return _DOWNLOAD_TASKS_DIR / f"task_{task_id}.{ext}"


def _generate_pdf(
    db: sqlite3.Connection,
    show_id: int,
    show_name: str,
    items: list[dict[str, Any]],
    wm_text: str,
    out_path: Path,
    *,
    progress_callback: "Callable[[int, int], None] | None" = None,
) -> tuple[Path, str, bool]:
    # ── 预扫描：收集有效 PNG 路径并动态确定画布尺寸 ──
    valid_paths: list[Path] = []
    for item in items:
        png = _safe_abs(item.get("png_path"))
        if png and png.exists():
            valid_paths.append(png)
    if not valid_paths:
        raise RuntimeError("没有可下载的预览图")
    canvas_w, canvas_h = determine_pdf_canvas_size(valid_paths)

    images: list[Image.Image] = []
    watermark_ok = bool(wm_text)
    if wm_text and items:
        # ── 优化：预渲染 tile + 并行水印 ──
        # 使用动态画布尺寸构建水印 tile，确保各页水印位置一致
        tile = _build_watermark_tile(canvas_w, canvas_h, wm_text)

        def _wm_pdf_item(png: Path) -> Image.Image | None:
            if not png.exists():
                return None
            img = Image.open(png).convert("RGB")
            img = fit_image_to_canvas(img, canvas_w, canvas_h)
            try:
                return add_watermark_to_image(img, wm_text, tile=tile).convert("RGB")
            except Exception:
                logger.warning("PDF 图片水印添加失败，使用原图", exc_info=True)
                return img

        try:
            workers = min(4, len(valid_paths))
            with ThreadPoolExecutor(max_workers=workers) as pool:
                # Materialize in the parent scope: thread-pool workers do not
                # inherit the ContextVar that owns temporary OSS downloads.
                results = list(pool.map(_wm_pdf_item, valid_paths))
            images = [img for img in results if img is not None]
        finally:
            if tile is not None:
                tile.close()
        if any(img is None for img in results):
            watermark_ok = False
        for i, img in enumerate(images):
            if progress_callback:
                progress_callback(10 + int(80 * (i + 1) / len(valid_paths)), f"处理图片 {i + 1}/{len(valid_paths)}")
    else:
        for png in valid_paths:
            img = Image.open(png).convert("RGB")
            img = fit_image_to_canvas(img, canvas_w, canvas_h)
            images.append(img)
            if progress_callback:
                progress_callback(10 + int(80 * len(images) / len(valid_paths)), f"处理图片 {len(images)}/{len(valid_paths)}")
    if not images:
        raise RuntimeError("没有可下载的预览图")
    first = images[0]
    rest = images[1:]
    first.save(out_path, "PDF", save_all=True, append_images=rest)
    for img in images:
        img.close()
    return out_path, f"{show_name}.pdf", watermark_ok


def _generate_pptx_images(
    db: sqlite3.Connection,
    show_id: int,
    show_name: str,
    items: list[dict[str, Any]],
    wm_text: str,
    out_path: Path,
    *,
    progress_callback: "Callable[[int, int], None] | None" = None,
) -> tuple[Path, str, bool]:
    image_paths: list[Path] = []
    for item in items:
        png = _safe_abs(item.get("png_path"))
        if png and png.exists():
            image_paths.append(png)
    if not image_paths:
        raise RuntimeError("没有可下载的预览图")

    watermark_ok = True
    if wm_text:
        # ── 优化：预渲染 tile + 并行水印 + JPEG 临时文件 ──
        watermarked_paths: list[Path] = []
        tile = None
        try:
            with Image.open(image_paths[0]) as probe:
                tile = _build_watermark_tile(probe.size[0], probe.size[1], wm_text)

            def _wm_img_item(idx_path: tuple[int, Path]) -> Path | None:
                idx, img_path = idx_path
                img = Image.open(img_path)
                try:
                    img_wm = add_watermark_to_image(img, wm_text, tile=tile).convert("RGB")
                finally:
                    img.close()
                tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
                tmp_path = Path(tmp.name)
                tmp.close()
                img_wm.save(tmp_path, "JPEG", quality=95)
                img_wm.close()
                if progress_callback:
                    progress_callback(10 + int(60 * (idx + 1) / len(image_paths)), f"处理图片 {idx + 1}/{len(image_paths)}")
                return tmp_path

            workers = min(4, len(image_paths))
            with ThreadPoolExecutor(max_workers=workers) as pool:
                watermarked_paths = [p for p in pool.map(_wm_img_item, enumerate(image_paths)) if p is not None]
            build_image_pptx(watermarked_paths, out_path)
        except (OSError, IOError) as e:
            logger.error("纯图 PPT 水印处理 I/O 错误 show_id=%s: %s", show_id, e, exc_info=True)
            build_image_pptx(image_paths, out_path)
            watermark_ok = False
        except Exception as e:
            logger.warning("纯图 PPT 图片水印添加失败，使用原图生成 show_id=%s: %s", show_id, e, exc_info=True)
            build_image_pptx(image_paths, out_path)
            watermark_ok = False
        finally:
            if tile is not None:
                tile.close()
            if progress_callback:
                progress_callback(80, "生成 PPT 文件...")
            for p in watermarked_paths:
                p.unlink(missing_ok=True)
    else:
        build_image_pptx(image_paths, out_path)
        watermark_ok = False

    if progress_callback:
        progress_callback(90, "完成")
    return out_path, f"{show_name}_纯图.pptx", watermark_ok


def _generate_pptx_pages(
    db: sqlite3.Connection,
    show_id: int,
    show_name: str,
    items: list[dict[str, Any]],
    wm_text: str,
    out_path: Path,
    *,
    progress_callback: "Callable[[int, int], None] | None" = None,
) -> tuple[Path, str, bool]:
    """将每个资源的 PPTX 拆分为单页，全部打包进一个 ZIP。"""
    all_single_pages: list[Path] = []
    tmp_dirs: list[tuple[int, Path]] = []  # (items 中的索引, 临时目录)
    watermark_ok = bool(wm_text)

    for idx, item in enumerate(items):
        ppt_path = _safe_abs(item.get("ppt_path"))
        if not ppt_path or not ppt_path.exists():
            continue
        # 每份资源用独立临时目录存放拆分结果，目录名格式：pptx_pages_{idx:04d}
        tmp_dir = Path(tempfile.mkdtemp(prefix=f"pptx_pages_{idx:04d}_"))
        tmp_dirs.append((idx, tmp_dir))
        try:
            pages = split_pptx_to_single_pages(ppt_path, tmp_dir)
        except Exception:
            logger.warning("拆分 PPTX 为单页失败 resource_id=%s", item.get("resource_id"), exc_info=True)
            continue
        # 可选：对每个单页 PPTX 并行添加水印
        if wm_text:
            def _wm_page(page_path: Path) -> None:
                try:
                    add_watermark_to_pptx(page_path, wm_text)
                except Exception:
                    logger.warning("逐页 PPT 水印添加失败，跳过该页", exc_info=True)
            workers = min(4, len(pages))
            with ThreadPoolExecutor(max_workers=workers) as pool:
                list(pool.map(_wm_page, pages))
        all_single_pages.extend(pages)
        if progress_callback:
            progress_callback(10 + int(80 * (idx + 1) / len(items)), f"处理 {idx + 1}/{len(items)}")

    if not all_single_pages:
        raise RuntimeError("没有可下载的幻灯片")

    # 打包为 ZIP，文件名格式：001_资源名_pageN.pptx
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # 建立 tmp_dir 名称 -> items 索引的映射
        dir_to_item_idx: dict[str, int] = {}
        for item_idx, tmp_dir in tmp_dirs:
            dir_to_item_idx[tmp_dir.name] = item_idx
        for i, page_path in enumerate(all_single_pages, start=1):
            parent_name = page_path.parent.name
            res_idx = dir_to_item_idx.get(parent_name, 0)
            resource_name = items[res_idx]["name"] if res_idx < len(items) else "slide"
            safe_name = safe_filename(resource_name)
            # 从 page_path.stem 提取页号（split_pptx_to_single_pages 输出形如 slide_N.pptx）
            page_suffix = page_path.stem.split("_")[-1] if "_" in page_path.stem else page_path.stem
            arc_name = f"{i:03d}_{safe_name}_page{page_suffix}.pptx"
            zf.write(page_path, arc_name)

    # 清理临时目录
    for _, tmp_dir in tmp_dirs:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return out_path, f"{show_name}_逐页.zip", watermark_ok


def _aggregate_fonts(items: list[dict[str, Any]]) -> dict[str, list[str]]:
    names: list[str] = []
    seen_names: set[str] = set()
    missing: list[str] = []
    seen_missing: set[str] = set()
    for item in items:
        for n in item["font_names"]:
            cleaned = (n or "").strip()
            if not cleaned:
                continue
            key = cleaned.lower()
            if key not in seen_names:
                names.append(cleaned)
                seen_names.add(key)
        for n in item["missing_fonts"]:
            cleaned = (n or "").strip()
            if not cleaned:
                continue
            key = cleaned.lower()
            if key not in seen_missing:
                missing.append(cleaned)
                seen_missing.add(key)
    return {"font_names": names, "missing_fonts": missing}


def _generate_pptx(
    db: sqlite3.Connection,
    show_id: int,
    show_name: str,
    items: list[dict[str, Any]],
    wm_text: str,
    with_fonts: bool,
    embed_fonts: bool,
    out_path: Path,
    *,
    progress_callback: "Callable[[int, int], None] | None" = None,
) -> tuple[Path, str, bool]:
    input_paths: list[Path] = []
    hidden_flags: list[bool] = []
    for item in items:
        ppt_path = _safe_abs(item.get("ppt_path"))
        if not ppt_path or not ppt_path.exists():
            continue
        input_paths.append(ppt_path)
        hidden_flags.append(bool(item.get("is_hidden", False)))
    if not input_paths:
        raise RuntimeError("没有可下载的内容")

    merged_tmp = tempfile.NamedTemporaryFile(suffix=".pptx", delete=False)
    merged_path = Path(merged_tmp.name)
    merged_tmp.close()
    try:
        merge_pptx_files(input_paths, merged_path, hidden_flags=hidden_flags)
        if progress_callback:
            progress_callback(40, "合并完成，处理水印...")
        watermark_ok = bool(wm_text)
        if wm_text:
            try:
                add_watermark_to_pptx(merged_path, wm_text)
            except Exception:
                logger.warning("合并 PPT 水印添加失败，将跳过水印继续生成 show_id=%s", show_id, exc_info=True)
                watermark_ok = False
        if progress_callback:
            progress_callback(70, "生成文件...")
        if embed_fonts:
            agg = _aggregate_fonts(items)
            try:
                content = embed_fonts_in_pptx(merged_path, db, agg["font_names"])
            except FontEmbeddingError as exc:
                raise RuntimeError(str(exc)) from exc
            out_path.write_bytes(content)
            return out_path, f"{show_name}_embedded_fonts.pptx", watermark_ok
        if not with_fonts:
            shutil.move(str(merged_path), str(out_path))
            return out_path, f"{show_name}.pptx", watermark_ok
        # 打包字体
        agg = _aggregate_fonts(items)
        fonts, _ = _build_fonts_bundle(db, agg["font_names"])
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(merged_path, arcname=f"{safe_filename(show_name)}.pptx")
            _write_fonts_into_zip(zf, fonts, agg["missing_fonts"])
        return out_path, f"{show_name}_with_fonts.zip", watermark_ok
    finally:
        merged_path.unlink(missing_ok=True)


def _generate_zip(
    db: sqlite3.Connection,
    show_id: int,
    show_name: str,
    items: list[dict[str, Any]],
    wm_text: str,
    with_fonts: bool,
    out_path: Path,
    *,
    progress_callback: "Callable[[int, int], None] | None" = None,
) -> tuple[Path, str, bool]:
    # ── 收集有效资源 ──
    valid_items: list[tuple[dict, Path, str]] = []  # (item, ppt_path, arcname)
    for item in items:
        ppt_path = _safe_abs(item.get("ppt_path"))
        if not ppt_path or not ppt_path.exists():
            continue
        arcname = f"{safe_filename(item['name'])}_v{item['version_no']}.pptx"
        valid_items.append((item, ppt_path, arcname))
    if not valid_items:
        raise RuntimeError("没有可下载的内容")

    watermark_ok = bool(wm_text)

    # ── 并行水印：先并行处理所有 PPTX，再顺序写入 ZIP ──
    wm_paths: dict[int, Path] = {}  # index -> watermarked temp path
    if wm_text:
        def _wm_zip_item(idx_item: tuple[int, tuple]) -> tuple[int, Path | None]:
            idx, (_, ppt_path, _) = idx_item
            wm_tmp = tempfile.NamedTemporaryFile(suffix=".pptx", delete=False)
            wm_tmp_path = Path(wm_tmp.name)
            wm_tmp.close()
            shutil.copy2(ppt_path, wm_tmp_path)
            try:
                add_watermark_to_pptx(wm_tmp_path, wm_text)
                return idx, wm_tmp_path
            except Exception:
                logger.warning("ZIP 水印添加失败，使用原始文件", exc_info=True)
                wm_tmp_path.unlink(missing_ok=True)
                return idx, None

        workers = min(4, len(valid_items))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for idx, wm_path in pool.map(_wm_zip_item, enumerate(valid_items)):
                if wm_path is not None:
                    wm_paths[idx] = wm_path
        if len(wm_paths) < len(valid_items):
            watermark_ok = False

    # ── 写入 ZIP ──
    try:
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for idx, (item, ppt_path, arcname) in enumerate(valid_items):
                src = wm_paths.get(idx, ppt_path)
                zf.write(src, arcname)
                if progress_callback:
                    progress_callback(10 + int(80 * (idx + 1) / len(valid_items)), f"打包 {idx + 1}/{len(valid_items)}")
            agg = _aggregate_fonts(items)
            fonts_info = {
                "fonts": sorted(agg["font_names"], key=str.lower),
                "missing_fonts": sorted(agg["missing_fonts"], key=str.lower),
            }
            zf.writestr("fonts.json", json.dumps(fonts_info, ensure_ascii=False, indent=2))
            if with_fonts:
                fonts, _ = _build_fonts_bundle(db, agg["font_names"])
                _write_fonts_into_zip(zf, fonts, agg["missing_fonts"])
    finally:
        for p in wm_paths.values():
            p.unlink(missing_ok=True)

    suffix = "_with_fonts.zip" if with_fonts else ".zip"
    return out_path, f"{show_name}{suffix}", watermark_ok


def _generate_download_file_sync(
    task_id: int,
    params: dict[str, Any],
    *,
    progress_callback: "Callable[[int, int], None] | None" = None,
) -> dict[str, Any]:
    """工作线程中执行：生成下载文件并返回结果数据。

    返回字典：``{"file_path": str, "file_name": str, "file_size": int}``
    """
    show_id = int(params["show_id"])
    download_type = params["download_type"]
    user_watermark = params.get("user_watermark", "") or ""
    track_code = params.get("track_code", "")
    with_fonts = bool(params.get("with_fonts", False))
    embed_fonts = bool(params.get("embed_fonts", False))

    # 是否需要嵌入水印（用户传入了水印 → 嵌入；否则纯净版本可缓存）
    wm_text = ""
    if user_watermark:  # 前端传了非空值就启用水印（追踪码总包含）
        wm_text = _compose_watermark_text(track_code, user_watermark)

    db = get_db()
    materialization = materialization_scope()
    materialization.__enter__()
    try:
        db.execute("PRAGMA busy_timeout = 30000")
        task = db.execute("SELECT * FROM tasks WHERE id = ? AND task_type = 'download'", (task_id,)).fetchone()
        if task is None:
            raise HTTPException(404, "下载任务不存在")
        user = _download_task_owner(db, task)
        show_row = _show_row(db, show_id)
        if not can_view_show(db, show_row, user):
            raise HTTPException(403, "无可见权限")
        show_name = show_row["name"]
        items = _collect_show_accessible_resources(db, show_id, user)
        if not items:
            raise HTTPException(404, "放映组没有可下载的资源")
        resource_refs = [[int(item["resource_id"]), int(item["version_no"])] for item in items]

        # 计算缓存键 / 扩展名
        cache_key_type = download_type
        if download_type == "pptx" and with_fonts:
            cache_key_type = "pptx_fonts"
        elif download_type == "pptx" and embed_fonts:
            cache_key_type = "pptx_embedded"
        elif download_type == "zip" and with_fonts:
            cache_key_type = "zip_fonts"
        ext_map = {
            "pdf": "pdf",
            "pptx_images": "pptx",
            "pptx": "zip" if with_fonts else "pptx",
            "pptx_pages": "zip",
            "zip": "zip",
        }
        ext = ext_map[download_type]

        # 无水印时尝试缓存命中
        cache_key = ""
        if not wm_text:
            cache_key = _show_download_cache_key(show_id, cache_key_type, items)
            cached = _get_cached_download(cache_key, ext)
            if cached and cached.exists():
                # 复制到任务输出目录，避免后续清理误删缓存文件
                out_path = _output_path(task_id, ext)
                shutil.copy2(cached, out_path)
                file_name = _suggest_filename(show_name, download_type, with_fonts, embed_fonts)
                if progress_callback:
                    progress_callback(90, "缓存命中")
                return {
                    "file_path": str(out_path),
                    "file_name": file_name,
                    "file_size": out_path.stat().st_size,
                    "watermark_applied": False,
                    "resource_refs": resource_refs,
                }

        out_path = _output_path(task_id, ext)
        if out_path.exists():
            out_path.unlink(missing_ok=True)

        if download_type == "pdf":
            out_path, file_name, watermark_applied = _generate_pdf(db, show_id, show_name, items, wm_text, out_path, progress_callback=progress_callback)
        elif download_type == "pptx_images":
            out_path, file_name, watermark_applied = _generate_pptx_images(db, show_id, show_name, items, wm_text, out_path, progress_callback=progress_callback)
        elif download_type == "pptx_pages":
            out_path, file_name, watermark_applied = _generate_pptx_pages(db, show_id, show_name, items, wm_text, out_path, progress_callback=progress_callback)
        elif download_type == "pptx":
            out_path, file_name, watermark_applied = _generate_pptx(db, show_id, show_name, items, wm_text, with_fonts, embed_fonts, out_path, progress_callback=progress_callback)
        elif download_type == "zip":
            out_path, file_name, watermark_applied = _generate_zip(db, show_id, show_name, items, wm_text, with_fonts, out_path, progress_callback=progress_callback)
        else:
            raise RuntimeError(f"不支持的 download_type: {download_type}")

        # 无水印时写入缓存
        if cache_key and out_path.exists():
            try:
                _save_to_cache(out_path, cache_key, ext)
            except Exception:
                logger.warning("写入下载缓存失败 task_id=%s type=%s", task_id, download_type, exc_info=True)

        return {
            "file_path": str(out_path),
            "file_name": file_name,
            "file_size": out_path.stat().st_size,
            "watermark_applied": watermark_applied,
            "resource_refs": resource_refs,
        }
    finally:
        try:
            db.close()
        except Exception:
            pass
        materialization.__exit__(None, None, None)


def _suggest_filename(show_name: str, download_type: str, with_fonts: bool, embed_fonts: bool = False) -> str:
    if download_type == "pdf":
        return f"{show_name}.pdf"
    if download_type == "pptx_images":
        return f"{show_name}_纯图.pptx"
    if download_type == "pptx_pages":
        return f"{show_name}_逐页.zip"
    if download_type == "pptx":
        if embed_fonts:
            return f"{show_name}_embedded_fonts.pptx"
        return f"{show_name}_with_fonts.zip" if with_fonts else f"{show_name}.pptx"
    if download_type == "zip":
        return f"{show_name}_with_fonts.zip" if with_fonts else f"{show_name}.zip"
    return show_name


async def execute_download_task(task_id: int, owner_id: int) -> None:
    """异步入口：在 Semaphore 控制下调度下载任务。

    - 先把 status 更新为 ``processing`` 并写入事件流
    - 在线程池中执行真正的文件生成
    - 成功/失败时原子更新 DB 状态与待推送事件
    """
    cancel_event = _task_cancel_flags.setdefault(task_id, threading.Event())
    try:
        await _execute_download_task(task_id, owner_id, cancel_event)
    finally:
        _task_cancel_flags.pop(task_id, None)


async def _execute_download_task(task_id: int, owner_id: int, cancel_event: threading.Event) -> None:
    async with _download_semaphore:
        # 读取任务参数
        db = get_db()
        try:
            row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if row is None:
                logger.error("Download task %d not found", task_id)
                return
            if row["status"] == "cancelled":
                return
            params = json.loads(row["params"] or "{}")
            started = _update_task(
                db,
                task_id,
                status="processing",
                message="正在生成文件...",
                progress=10,
                total=100,
                event_owner_id=owner_id,
                event_message={
                    "type": "download_progress",
                    "task_id": task_id,
                    "status": "processing",
                    "progress": 10,
                    "message": "正在生成文件...",
                },
            )
        finally:
            db.close()
        if not started:
            return

        # 进度追踪：工作线程写入，asyncio 任务读取并广播
        _progress_broadcast: dict[str, Any] = {"progress": 10, "message": "正在生成文件..."}

        def _progress_cb(progress: int, message: str) -> None:
            _check_download_cancelled(cancel_event)
            _progress_broadcast["progress"] = progress
            _progress_broadcast["message"] = message

        async def _broadcast_progress_loop() -> None:
            """Persist progress and notice cancellations issued by another worker."""
            last_progress = 10
            while not _progress_broadcast.get("done"):
                try:
                    cur = _progress_broadcast.get("progress", 10)
                    msg = _progress_broadcast.get("message", "")
                    _db = get_db()
                    try:
                        state = _db.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()
                        if state is None or state["status"] == "cancelled":
                            cancel_event.set()
                            _progress_broadcast["done"] = True
                            return
                        if cur != last_progress:
                            updated = _update_task(
                                _db,
                                task_id,
                                progress=cur,
                                message=msg,
                                total=100,
                                event_owner_id=owner_id,
                                event_message={
                                    "type": "download_progress",
                                    "task_id": task_id,
                                    "status": "processing",
                                    "progress": cur,
                                    "message": msg,
                                },
                            )
                            if not updated:
                                cancel_event.set()
                                _progress_broadcast["done"] = True
                                return
                            last_progress = cur
                    finally:
                        _db.close()
                    await asyncio.sleep(1)
                except asyncio.CancelledError:
                    return
                except Exception:
                    logger.warning("Download task %d progress event persist failed", task_id, exc_info=True)
                    await asyncio.sleep(1)

        progress_task = asyncio.create_task(_broadcast_progress_loop())

        try:
            result = await asyncio.to_thread(
                _generate_download_file_sync, task_id, params, progress_callback=_progress_cb
            )
            _check_download_cancelled(cancel_event)
        except DownloadTaskCancelled:
            _progress_broadcast["done"] = True
            progress_task.cancel()
            try:
                await progress_task
            except (asyncio.CancelledError, Exception):
                pass
            cleanup_download_task_output(task_id)
            logger.info("Download task %d cancelled", task_id)
            return
        except Exception as exc:
            logger.exception("Download task %d failed", task_id)
            _progress_broadcast["done"] = True
            progress_task.cancel()
            try:
                await progress_task
            except (asyncio.CancelledError, Exception):
                pass
            cleanup_download_task_output(task_id)
            if cancel_event.is_set():
                return
            db = get_db()
            try:
                _update_task(
                    db,
                    task_id,
                    status="failed",
                    # 原始异常可能包含服务器路径、命令行参数或凭据；详情只写服务日志。
                    error_message="下载任务处理失败，请重试或联系管理员",
                    event_owner_id=owner_id,
                    event_message={
                        "type": "download_failed",
                        "task_id": task_id,
                        "error": "下载任务处理失败",
                    },
                )
            finally:
                db.close()
            return

        # 标记进度广播循环结束
        _progress_broadcast["done"] = True
        progress_task.cancel()
        try:
            await progress_task
        except (asyncio.CancelledError, Exception):
            pass

        db = get_db()
        try:
            completed = _update_task(
                db,
                task_id,
                status="completed",
                progress=100,
                total=100,
                message="",
                result_data=result,
                mark_completed=True,
                event_owner_id=owner_id,
                event_message={
                    "type": "download_completed",
                    "task_id": task_id,
                    "file_name": result.get("file_name", ""),
                    "file_size": int(result.get("file_size", 0)),
                    "watermark_applied": bool(result.get("watermark_applied", False)),
                    "watermark_requested": bool((params.get("user_watermark", "") or "").strip()),
                },
            )
        finally:
            db.close()
        if not completed:
            cleanup_download_task_output(task_id)
            logger.info("Download task %d was cancelled before completion", task_id)
            return

        logger.info(
            "Download task %d completed file=%s size=%s; event persisted for owner_id=%s",
            task_id,
            result.get("file_name"),
            result.get("file_size"),
            owner_id,
        )
