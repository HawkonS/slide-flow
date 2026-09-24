"""Routers / tasks."""

from __future__ import annotations

from app.core.permissions import is_admin
from app.core.permissions import require_admin
from app.core.permissions import require_user
from app.core.ppt import slide_count
from app.core.sanitize import sanitize_html
from app.core.storage import save_upload
from app.core.oss import storage as oss_storage
from app.core.errors import storage_public_message
from app.core.oss import StorageConfigurationError, StorageUnavailableError
from app.db import get_db
from app.routers.dependencies import (
    db_dep,
    db_read_dep,
)
from app.schemas.tasks import (
    TaskDeletePayload,
)
from app.services.common import (
    DEFAULT_RESOURCE_SUBJECT,
    _natural_sort_key,
    _reject_removed_form_fields,
    _validate_required_scope,
    _validate_resource_subject,
    _validate_secrecy,
)
from app.services.files import (
    _compress_hd_image,
    _validate_ppt_upload,
)
from app.services.resource_import.limits import (
    RESOURCE_IMPORT_MAX_PPT_BYTES,
)
from app.services.resource_import.sessions import (
    _write_resource_import_session,
    reserve_resource_import_directory,
)
from app.services.resource_import.validation import (
    _require_resource_import_origin,
    _save_resource_import_upload,
    _validate_import_ppt_package,
)
from app.services.resource_import.render_tasks import cancel_render_tasks, cancel_render_tasks_for_parent
from app.services.tasks.resource_import import schedule_resource_import_task
from app.services.tasks.records import (
    _cleanup_task_temp,
    _serialize_task,
)
from app.services.tasks.runtime import (
    _heavy_executor,
    _pending_task_futures,
    _split_semaphore,
    _task_cancel_flags,
)
from app.services.tasks.split import (
    _execute_split_task,
)
from fastapi import APIRouter
from fastapi import Depends
from fastapi import File
from fastapi import Form
from fastapi import HTTPException
from fastapi import Query
from fastapi import Request
from fastapi import UploadFile
from pathlib import Path
from typing import Any
import asyncio
import json
import logging
import shutil
import sqlite3
import tempfile
import threading
import time

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/tasks")
def list_tasks(
    status: str | None = Query(None),
    task_type: str | None = Query(None),
    owner_id: int | None = Query(None),
    search: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """获取任务列表，支持 status / task_type / owner_id 过滤、追踪码搜索及分页。

    权限规则：
    - 管理员：可传任意 owner_id（不传则返回所有用户的任务）
    - 非管理员：忽略 owner_id 参数，强制只看自己的任务

    分页：page 从 1 开始，page_size 默认 20、上限 100。
    搜索：search 仅在 task_type=download 时对 params.track_code 字段做模糊匹配。
    """
    where_clauses: list[str] = []
    params_list: list[Any] = []

    if is_admin(user):
        if owner_id is not None:
            where_clauses.append("owner_id = ?")
            params_list.append(int(owner_id))
    else:
        where_clauses.append("owner_id = ?")
        params_list.append(int(user["id"]))

    if status and status in {"uploading", "pending", "processing", "completed", "failed", "cancelled"}:
        where_clauses.append("status = ?")
        params_list.append(status)
    if task_type is not None:
        where_clauses.append("task_type = ?")
        params_list.append(task_type)

    # 追踪码搜索：仅在筛选下载任务时生效（上传任务无 track_code 字段）
    search_kw = (search or "").strip()
    if search_kw and task_type == "download":
        where_clauses.append("json_extract(params, '$.track_code') LIKE ?")
        params_list.append(f"%{search_kw}%")

    where_sql = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    total_row = db.execute(
        f"SELECT COUNT(*) AS c FROM tasks{where_sql}",
        params_list,
    ).fetchone()
    total = int(total_row["c"]) if total_row is not None else 0

    offset = (page - 1) * page_size
    sql = f"SELECT * FROM tasks{where_sql} ORDER BY created_at DESC LIMIT ? OFFSET ?"
    rows = db.execute(sql, [*params_list, page_size, offset]).fetchall()
    items = [_serialize_task(row, db) for row in rows]

    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/api/tasks/{task_id}")
def get_task(
    task_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """获取单个任务详情。只能查看自己的任务（管理员可查看所有）"""
    row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "任务不存在")
    if not is_admin(user) and int(row["owner_id"]) != int(user["id"]):
        raise HTTPException(403, "无权查看此任务")
    return _serialize_task(row, db)


@router.post("/api/tasks/split-import")
async def create_split_import_task(
    request: Request,
    name_prefix: str = Form(...),
    subject: str = Form(DEFAULT_RESOURCE_SUBJECT),
    tags: str = Form(""),
    secrecy_level: str = Form("public"),
    visibility_scope: str = Form(""),
    visible_user_ids: str = Form(""),
    management_scope: str = Form(""),
    manage_user_ids: str = Form(""),
    remark_html: str = Form(""),
    ppt_file: UploadFile = File(...),
    images: list[UploadFile] = File(...),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """异步批量拆分导入：创建任务记录后立即返回，后台线程执行拆分"""
    await _reject_removed_form_fields(
        request, "resource_type", "visible_to_users", "managed_by_users"
    )
    # The current UI sends a zero-byte platform marker in the legacy multipart
    # slot so the public route/OpenAPI contract remains compatible. It is not
    # an image upload; the platform renders every page from the PPT itself.
    platform_marker = (images[0].filename or "") if len(images) == 1 else ""
    if platform_marker.startswith("__slide_flow_platform__"):
        _require_resource_import_origin(request)
        return await create_resource_import_task(
            request=request,
            name_prefix=name_prefix,
            subject=subject,
            tags=tags,
            secrecy_level=secrecy_level,
            status="disabled" if platform_marker.endswith("-disabled.bin") else "active",
            visibility_scope=visibility_scope,
            visible_user_ids=visible_user_ids,
            management_scope=management_scope,
            manage_user_ids=manage_user_ids,
            remark_html=remark_html,
            ppt_file=ppt_file,
            user=user,
            db=db,
            _=None,
        )
    _validate_ppt_upload(ppt_file)
    visibility_scope = _validate_required_scope(visibility_scope, "可见范围")
    management_scope = _validate_required_scope(management_scope, "管理范围")
    secrecy_level = _validate_secrecy(secrecy_level)
    subject = _validate_resource_subject(subject)

    images = sorted(images, key=lambda f: _natural_sort_key(f.filename or ""))
    temp_dir = Path(tempfile.mkdtemp(prefix="task_split_"))

    # 保存上传文件到临时目录
    source_path = await save_upload(ppt_file, temp_dir, "source_", stage_oss=True)
    image_paths: list[str] = []
    for img in images:
        img_path = await save_upload(img, temp_dir, "img_", stage_oss=True)
        img_path = _compress_hd_image(img_path)
        image_paths.append(str(img_path))

    # 校验 PPT 页数与图片数量
    n_slides = slide_count(source_path)
    if n_slides == 0:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(400, "无法读取 PPT 页数")
    if len(image_paths) != 0 and len(image_paths) != n_slides:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(400, f"PPT 共 {n_slides} 页，但提供了 {len(image_paths)} 张图片，数量不一致")

    # 创建 task 记录
    params = {
        "name_prefix": name_prefix,
        "subject": subject,
        "tags": tags,
        "secrecy_level": secrecy_level,
        "visibility_scope": visibility_scope,
        "visible_user_ids": visible_user_ids,
        "management_scope": management_scope,
        "manage_user_ids": manage_user_ids,
        "remark_html": sanitize_html(remark_html),
        "owner_id": int(user["id"]),
        "source_path": str(source_path),
        "image_paths": image_paths,
        "temp_dir": str(temp_dir),
        "status": "active",
    }
    db.execute(
        """
        INSERT INTO tasks (task_type, status, owner_id, params, progress, total)
        VALUES ('batch_split_import', 'pending', ?, ?, 0, 0)
        """,
        (int(user["id"]), json.dumps(params, ensure_ascii=False)),
    )
    task_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    db.commit()

    # 注册取消标志
    cancel_event = threading.Event()
    _task_cancel_flags[task_id] = cancel_event

    # 启动后台任务（带信号量控制）
    async def _run_with_semaphore() -> None:
        # 等待信号量前更新状态为排队中
        db_q = get_db()
        db_q.execute(
            "UPDATE tasks SET message = '排队中...', updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
            " WHERE id = ? AND status <> 'cancelled'",
            (task_id,),
        )
        db_q.commit()
        db_q.close()

        async with _split_semaphore:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(
                _heavy_executor,
                _execute_split_task,
                task_id,
                str(source_path),
                image_paths,
                params,
            )

    future = asyncio.ensure_future(_run_with_semaphore())

    # 保留引用防止GC，并记录未捕获的异常
    def _on_task_done(f: asyncio.Future) -> None:  # type: ignore[type-arg]
        try:
            f.result()
        except Exception as e:
            logger.error("Background task %d failed with unhandled error: %s", task_id, e)

    future.add_done_callback(_on_task_done)
    _pending_task_futures[task_id] = future

    return {"task_id": task_id, "status": "pending"}


async def create_resource_import_task(
    request: Request,
    name_prefix: str = Form(...),
    subject: str = Form(DEFAULT_RESOURCE_SUBJECT),
    tags: str = Form(""),
    secrecy_level: str = Form("public"),
    status: str = Form("active"),
    visibility_scope: str = Form(""),
    visible_user_ids: str = Form(""),
    management_scope: str = Form(""),
    manage_user_ids: str = Form(""),
    remark_html: str = Form(""),
    ppt_file: UploadFile = File(...),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
    _: None = Depends(_require_resource_import_origin),
) -> dict[str, Any]:
    """Create a durable PPT upload task and return before conversion/rendering."""
    await _reject_removed_form_fields(
        request, "resource_type", "visible_to_users", "managed_by_users"
    )
    if Path(ppt_file.filename or "").suffix.lower() not in {".pptx", ".potx", ".ppsx"}:
        raise HTTPException(400, "请上传 PPTX/POTX/PPSX 文件；旧版 PPT 请先另存为 PPTX")
    visibility_scope = _validate_required_scope(visibility_scope, "可见范围")
    management_scope = _validate_required_scope(management_scope, "管理范围")
    secrecy_level = _validate_secrecy(secrecy_level)
    status = status if status in {"active", "disabled"} else "active"
    subject = _validate_resource_subject(subject)
    # OSS is the configured persistence backend for this workflow. Validate it
    # before creating a task so a missing OSS setup gets a clear 503 instead
    # of a task that can never process its upload.
    oss_storage.ensure_configured()
    session_id, temp_dir = reserve_resource_import_directory()
    params = {
        "name_prefix": name_prefix,
        "subject": subject,
        "tags": tags,
        "secrecy_level": secrecy_level,
        "status": status,
        "visibility_scope": visibility_scope,
        "visible_user_ids": visible_user_ids,
        "management_scope": management_scope,
        "manage_user_ids": manage_user_ids,
        "remark_html": sanitize_html(remark_html),
        "owner_id": int(user["id"]),
        "session_id": session_id,
        "temp_dir": str(temp_dir),
        "file_name": Path(ppt_file.filename or "presentation.pptx").name,
        "workflow_state": "uploading",
    }
    task_id: int | None = None
    try:
        db.execute(
            "INSERT INTO tasks (task_type, status, owner_id, params, progress, upload_progress, total, message) "
            "VALUES ('batch_split_import', 'uploading', ?, ?, 0, 0, 0, '正在上传 PPT 文件…')",
            (int(user["id"]), json.dumps(params, ensure_ascii=False)),
        )
        task_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        db.commit()
        source_path, _ = await _save_resource_import_upload(
            ppt_file, temp_dir, "source_", max_bytes=RESOURCE_IMPORT_MAX_PPT_BYTES,
            total_bytes=0, stage_oss=True,
        )
        # Validate the package before placing it in the background queue. The
        # expensive conversion, font check and rendering still happen later.
        _validate_import_ppt_package(source_path)
        params.update({"task_id": task_id, "source_path": str(source_path), "workflow_state": "queued"})
        session = {
            "session_id": session_id,
            "task_id": task_id,
            "owner_id": int(user["id"]),
            "mode": "ppt",
            "temp_dir": str(temp_dir),
            "source_path": str(source_path),
            "image_paths": [],
            "image_names": [],
            "preview_paths": [],
            "slide_count": 0,
            "fonts": [],
            "missing_fonts": [],
            "preview_status": "pending",
            "preview_error": None,
            "expires_at": time.time() + 7 * 24 * 3600,
        }
        _write_resource_import_session(session)
        db.execute(
            "UPDATE tasks SET params = ?, upload_progress = 100, message = '已上传，排队检测字体…', "
            "updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id = ?",
            (json.dumps(params, ensure_ascii=False), task_id),
        )
        db.commit()
        _task_cancel_flags[task_id] = threading.Event()
        schedule_resource_import_task(task_id, session_id, _split_semaphore, _heavy_executor)
        return {"task_id": task_id, "session_id": session_id, "status": "pending"}
    except (StorageConfigurationError, StorageUnavailableError) as exc:
        db.rollback()
        message = storage_public_message(exc) or "对象存储暂时不可用，请稍后重试"
        if task_id is not None:
            db.execute(
                "UPDATE tasks SET status = 'failed', error_message = ?, message = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id = ?",
                (message, message, task_id),
            )
            db.commit()
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.exception("Resource import upload storage failure")
        raise HTTPException(503, message) from exc
    except Exception as exc:
        db.rollback()
        if task_id is not None:
            db.execute(
                "UPDATE tasks SET status = 'failed', error_message = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id = ?",
                ("PPT 上传失败，请重新选择文件", task_id),
            )
            db.commit()
        shutil.rmtree(temp_dir, ignore_errors=True)
        if isinstance(exc, HTTPException):
            raise
        logger.exception("Resource import upload failed")
        raise HTTPException(400, "PPT 上传失败，请检查文件后重试") from exc


@router.post("/api/tasks/{task_id}/cancel")
def cancel_task(
    task_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """取消正在执行的任务"""
    row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "任务不存在")
    # 仅运营管理员/系统管理员可维护（取消）任务
    if not is_admin(user):
        raise HTTPException(403, "仅运营管理员或系统管理员可取消任务")
    if row["status"] not in {"uploading", "pending", "processing"}:
        raise HTTPException(400, f"任务状态为 {row['status']}，无法取消")

    # 设置取消标志
    cancel_event = _task_cancel_flags.get(task_id)
    if cancel_event:
        cancel_event.set()

    # uploading 状态时清理临时上传目录
    if row["status"] == "uploading":
        try:
            params = json.loads(row["params"] or "{}")
            temp_dir_str = params.get("temp_dir")
            if temp_dir_str:
                shutil.rmtree(Path(temp_dir_str), ignore_errors=True)
        except Exception:
            pass
    try:
        params = json.loads(row["params"] or "{}")
        session_id = params.get("session_id")
        if isinstance(session_id, str):
            cancel_render_tasks(db, session_id)
        else:
            cancel_render_tasks_for_parent(db, task_id)
    except Exception:
        logger.exception("Failed to cancel renderer task for parent task %s", task_id)

    # 更新数据库状态
    db.execute(
        "UPDATE tasks SET status = 'cancelled',"
        " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
        " WHERE id = ?",
        (task_id,),
    )
    db.commit()
    return {"task_id": task_id, "status": "cancelled"}


@router.post("/api/admin/tasks/bulk-delete")
def bulk_delete_tasks(
    payload: TaskDeletePayload,
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """批量删除任务记录，并清理任务遗留的临时上传目录。"""
    task_ids = sorted({int(tid) for tid in payload.task_ids if int(tid) > 0})
    if not task_ids:
        raise HTTPException(400, "请选择要删除的任务")
    placeholders = ",".join("?" for _ in task_ids)
    rows = db.execute(f"SELECT * FROM tasks WHERE id IN ({placeholders})", task_ids).fetchall()
    for task_id in task_ids:
        cancel_render_tasks_for_parent(db, task_id)
    cur = db.execute(f"DELETE FROM tasks WHERE id IN ({placeholders})", task_ids)
    db.commit()
    for row in rows:
        _cleanup_task_temp(row)
    return {"ok": True, "deleted": cur.rowcount}


@router.delete("/api/admin/tasks/{task_id}")
def delete_task(
    task_id: int,
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """删除单个任务记录，并清理任务遗留的临时上传目录。"""
    row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "任务不存在")
    cancel_render_tasks_for_parent(db, task_id)
    db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    db.commit()
    _cleanup_task_temp(row)
    return {"ok": True}
