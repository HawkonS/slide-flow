"""Services / tasks / split."""

from __future__ import annotations

from app.core.ppt import split_pptx_to_single_pages
from app.core.errors import storage_public_message
from app.db import get_db
from app.db import now_iso
from app.services.common import (
    _parse_id_list,
)
from app.services.files import (
    _compress_hd_image,
    _delete_resource_files,
    persist_asset,
)
from app.services.resources import (
    _insert_version,
    _set_scope_users,
)
from app.services.tasks.runtime import (
    SPLIT_TASK_TIMEOUT,
    _pending_task_futures,
    _task_cancel_flags,
)
from pathlib import Path
import json
import logging
import shutil
import sqlite3
import threading
import time

logger = logging.getLogger(__name__)


def _task_is_cancelled(
    db: sqlite3.Connection,
    task_id: int,
    cancel_event: threading.Event | None = None,
) -> bool:
    if cancel_event is not None and cancel_event.is_set():
        return True
    row = db.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return row is None or row["status"] == "cancelled"


def _cleanup_split_resources(db: sqlite3.Connection, resource_ids: list[int]) -> None:
    """回滚拆分任务已创建的资源及其文件，防止取消/超时留下半批数据。"""
    ids = sorted({int(x) for x in resource_ids if int(x) > 0})
    if not ids:
        return
    placeholders = ",".join("?" for _ in ids)
    versions = db.execute(
        f"SELECT id, ppt_path, png_path FROM resource_versions WHERE resource_id IN ({placeholders})", ids
    ).fetchall()
    paths = [v["ppt_path"] for v in versions] + [v["png_path"] for v in versions]
    version_ids = [int(v["id"]) for v in versions]
    db.execute(f"DELETE FROM resources WHERE id IN ({placeholders})", ids)
    db.commit()
    _delete_resource_files(paths, version_ids)


def _execute_split_task(
    task_id: int,
    source_path: str,
    image_paths: list[str],
    params: dict,
) -> None:
    """在后台线程中执行拆分导入任务"""
    logger.info("Task %d: starting split import", task_id)
    cancel_event = _task_cancel_flags.get(task_id)
    start_time = time.time()
    db = get_db()
    db.execute("PRAGMA busy_timeout = 30000")  # 后台线程使用更长超时，避免被轮询请求阻塞
    resource_ids: list[int] = []
    pending_refs: list[str] = []
    try:
        if _task_is_cancelled(db, task_id, cancel_event):
            _cleanup_split_resources(db, resource_ids)
            return
        # 更新状态为 processing，附带消息告知用户正在拆分
        started = db.execute(
            "UPDATE tasks SET status = 'processing',"
            " message = '正在拆分 PPT 文件...',"
            " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
            " WHERE id = ? AND status <> 'cancelled'",
            (task_id,),
        )
        db.commit()
        if started.rowcount == 0:
            return

        # 拆分 PPT（带进度回调）
        ppt_path = Path(source_path)
        split_dir = ppt_path.parent / "split"
        logger.info("Task %d: splitting PPT %s (%d bytes)", task_id, ppt_path.name, ppt_path.stat().st_size)

        def on_split_progress(current: int, total: int) -> None:
            db.execute(
                "UPDATE tasks SET message = ? WHERE id = ? AND status <> 'cancelled'",
                (f"正在拆分 PPT 文件... ({current}/{total})", task_id),
            )
            db.commit()

        split_files = split_pptx_to_single_pages(ppt_path, split_dir, progress_callback=on_split_progress)
        if _task_is_cancelled(db, task_id, cancel_event):
            _cleanup_split_resources(db, resource_ids)
            return
        if not split_files:
            db.execute(
                "UPDATE tasks SET status = 'failed', error_message = '未能拆分 PPTX',"
                " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
                " WHERE id = ? AND status <> 'cancelled'",
                (task_id,),
            )
            db.commit()
            return

        total = len(split_files)
        db.execute(
            "UPDATE tasks SET total = ?, message = '正在创建资源...',"
            " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
            " WHERE id = ? AND status <> 'cancelled'",
            (total, task_id),
        )
        db.commit()
        logger.info("Task %d: split complete, %d pages, starting resource creation", task_id, total)

        # 参数提取
        name_prefix = params["name_prefix"]
        subject = params["subject"]
        tags = params["tags"]
        resource_status = params["status"]
        secrecy_level = params["secrecy_level"]
        visibility_scope = params["visibility_scope"]
        visible_user_ids = params["visible_user_ids"]
        management_scope = params["management_scope"]
        manage_user_ids = params["manage_user_ids"]
        remark_html = params["remark_html"]
        owner_id = params["owner_id"]
        has_images = bool(image_paths)

        BATCH_COMMIT = 5
        progress = 0

        for index, split_ppt in enumerate(split_files, start=1):
            pending_refs.clear()
            # 检查超时
            if time.time() - start_time > SPLIT_TASK_TIMEOUT:
                raise TimeoutError("PPT拆分任务超时")

            # 检查取消标志
            if _task_is_cancelled(db, task_id, cancel_event):
                logger.info("Task %d: cancelled by user at progress %d/%d", task_id, progress, total)
                _cleanup_split_resources(db, resource_ids)
                return

            # Split files already live in the task's temporary directory;
            # upload them directly instead of creating a local asset folder.
            v1_path = split_ppt
            png_path: Path | None = None
            if has_images and index <= len(image_paths):
                img_src = Path(image_paths[index - 1])
                if img_src.exists():
                    img_src = _compress_hd_image(img_src)
                    png_path = img_src
            ppt_ref = persist_asset(v1_path, "resources/ppt")
            pending_refs.append(ppt_ref)
            png_ref = persist_asset(png_path, "resources/png") if png_path else None
            if png_ref:
                pending_refs.append(png_ref)

            ts = now_iso()
            db.execute(
                """
                INSERT INTO resources (
                    name, owner_id, subject, tags, status,
                    visibility_scope, management_scope, secrecy_level,
                    current_version, updated_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                """,
                (
                    f"{name_prefix}_{index:02d}",
                    owner_id,
                    subject,
                    tags,
                    resource_status,
                    visibility_scope,
                    management_scope,
                    secrecy_level,
                    owner_id,
                    ts,
                    ts,
                ),
            )
            resource_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
            if resource_id <= 0:
                raise ValueError(f"Failed to insert resource, got invalid id: {resource_id}")
            resource_ids.append(resource_id)
            _set_scope_users(db, "resource_visibility", resource_id, _parse_id_list(visible_user_ids))
            _set_scope_users(db, "resource_management", resource_id, _parse_id_list(manage_user_ids))
            _insert_version(
                db,
                resource_id=resource_id,
                version_no=1,
                ppt_path=v1_path,
                png_path=png_path,
                ppt_ref=ppt_ref,
                png_ref=png_ref,
                common_remark_html=remark_html or "",
                change_note="批量拆分导入",
                created_by=int(owner_id),
            )

            # 每次插入后立即提交，避免长时间持有 SQLite 写锁
            progress = index
            db.commit()
            pending_refs.clear()
            db.execute(
                "UPDATE tasks SET progress = ?,"
                " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
                " WHERE id = ? AND status <> 'cancelled'",
                (progress, task_id),
            )
            db.commit()
            if index == 1 or index % BATCH_COMMIT == 0 or index == total:
                logger.info("Task %d: progress %d/%d", task_id, progress, total)

        # 任务完成
        if _task_is_cancelled(db, task_id, cancel_event):
            _cleanup_split_resources(db, resource_ids)
            return
        result = {"total": total, "created": len(resource_ids), "resource_ids": resource_ids}
        completed = db.execute(
            "UPDATE tasks SET status = 'completed', progress = ?, message = '',"
            " result_data = ?,"
            " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime'),"
            " completed_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
            " WHERE id = ? AND status <> 'cancelled'",
            (total, json.dumps(result, ensure_ascii=False), task_id),
        )
        db.commit()
        if completed.rowcount == 0:
            return
        logger.info("Task %d: completed, created %d resources", task_id, len(resource_ids))

    except Exception as e:
        logger.exception("Task %d failed: %s", task_id, e)
        db.rollback()
        try:
            _cleanup_split_resources(db, resource_ids)
            _delete_resource_files(pending_refs, [])
            if _task_is_cancelled(db, task_id, cancel_event):
                return
            safe_message = storage_public_message(e) or "批量导入任务处理失败，请重试或联系管理员"
            db.execute(
                "UPDATE tasks SET status = 'failed', error_message = ?,"
                " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
                " WHERE id = ? AND status <> 'cancelled'",
                (safe_message, task_id),
            )
            db.commit()
        except Exception as inner_e:
            logger.error("Task %d: failed to update error status: %s", task_id, inner_e)
    finally:
        _task_cancel_flags.pop(task_id, None)
        _pending_task_futures.pop(task_id, None)
        # 清理临时目录
        temp_dir_str = params.get("temp_dir")
        if temp_dir_str:
            shutil.rmtree(Path(temp_dir_str), ignore_errors=True)
        db.close()
