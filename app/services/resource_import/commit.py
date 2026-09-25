"""Services / resource import / commit."""

from __future__ import annotations

from app.config import settings
from app.core.errors import storage_public_message
from app.core.ppt import split_pptx_to_single_pages
from app.core.sanitize import sanitize_html
from app.core.storage import copy_into
from app.db import new_resource_detail_token, now_iso
from app.services.common import (
    DEFAULT_RESOURCE_SUBJECT,
    _validate_resource_status,
    _validate_resource_subject,
    _validate_required_scope,
    _validate_secrecy,
)
from app.services.files import _delete_resource_files, persist_asset
from app.services.resource_import.limits import (
    RESOURCE_IMPORT_MAX_NAME_LENGTH,
    RESOURCE_IMPORT_TTL,
)
from app.services.resource_import.sessions import (
    _cleanup_resource_import_session,
    _resource_import_file,
    _resource_import_temp_dir,
    _write_resource_import_session,
)
from app.services.resource_import.validation import (
    _validate_resource_import_payload,
)
from app.services.resource_import.remote_fonts import sha256_file
from app.services.resource_import.rendering import RESOURCE_IMPORT_RENDERER_VERSION
from app.services.resources import (
    _insert_version,
    _set_scope_tags,
    _set_scope_users,
)
from fastapi import HTTPException
from pathlib import Path
from typing import Any
import json
import logging
import shutil
import sqlite3
import time
import uuid

logger = logging.getLogger(__name__)


def _commit_resource_import_sync(
    session_id: str, payload: dict[str, Any], user: sqlite3.Row, db: sqlite3.Connection, session: dict[str, Any],
) -> dict[str, Any]:
    payload = _validate_resource_import_payload(payload, db)
    if session.get("missing_fonts"):
        raise HTTPException(400, "请先替换所有不在标准字体库中的字体")
    if session.get("preview_status") != "ready" or len(session.get("preview_paths", [])) != int(session["slide_count"]):
        raise HTTPException(400, "请先生成 PPT 预览图")
    name_prefix = str(payload.get("name_prefix", "")).strip()
    if not name_prefix:
        raise HTTPException(400, "请填写名称前缀")
    if len(name_prefix) > RESOURCE_IMPORT_MAX_NAME_LENGTH or any(ord(char) < 32 for char in name_prefix):
        raise HTTPException(400, f"名称前缀不能超过 {RESOURCE_IMPORT_MAX_NAME_LENGTH} 个字符且不能包含控制字符")
    subject = _validate_resource_subject(str(payload.get("subject", DEFAULT_RESOURCE_SUBJECT)))
    tags = str(payload.get("tags", ""))
    secrecy_level = _validate_secrecy(str(payload.get("secrecy_level", "public")))
    status = _validate_resource_status(str(payload.get("status", "active")))
    visibility_scope = _validate_required_scope(payload.get("visibility_scope"), "可见范围")
    management_scope = _validate_required_scope(payload.get("management_scope"), "管理范围")
    visible_user_ids = payload.get("visible_user_ids") or []
    manage_user_ids = payload.get("manage_user_ids") or []
    visible_user_tags = payload.get("visible_user_tags") or []
    manage_user_tags = payload.get("manage_user_tags") or []
    if visibility_scope == "partial" and not visible_user_ids and not visible_user_tags:
        raise HTTPException(400, "可见范围为部分时请至少选择一位用户或一个用户标签")
    if management_scope == "partial" and not manage_user_ids and not manage_user_tags:
        raise HTTPException(400, "管理范围为部分时请至少选择一位用户或一个用户标签")
    source_path = _resource_import_file(session, session.get("source_path"))
    if session.get("mode") == "ppt":
        if session.get("renderer_version") != RESOURCE_IMPORT_RENDERER_VERSION or not session.get("split_paths"):
            raise HTTPException(400, "预览版本已过期，请重新渲染")
        if sha256_file(source_path) != session.get("rendered_source_sha256"):
            raise HTTPException(409, "PPT 源文件与确认预览不一致，请重新渲染")
        if [sha256_file(_resource_import_file(session, p)) for p in session["preview_paths"]] != session.get("preview_hashes"):
            raise HTTPException(409, "高清图片完整性校验失败，请重新渲染")
    temp_dir = _resource_import_temp_dir(session)
    created_dirs: list[Path] = []
    uploaded_refs: list[str] = []
    resource_ids: list[int] = []
    try:
        if session.get("mode") == "ppt":
            split_files = [_resource_import_file(session, p) for p in session["split_paths"]]
            if [sha256_file(p) for p in split_files] != session.get("split_hashes"):
                raise RuntimeError("单页源文件校验失败，请重新渲染")
        else:
            split_files = split_pptx_to_single_pages(source_path, temp_dir / "split")
        if len(split_files) != int(session["slide_count"]):
            raise RuntimeError("PPT 拆分页数发生变化")
        # The commit request holds the session lease for the whole transaction,
        # so publish progress through the session snapshot instead of committing
        # the task row halfway through an otherwise atomic database operation.
        session["commit_status"] = "processing"
        session["commit_progress"] = 0
        session["commit_total"] = len(split_files)
        session["commit_message"] = f"正在准备保存，共 {len(split_files)} 个单页素材…"
        session["expires_at"] = time.time() + RESOURCE_IMPORT_TTL
        _write_resource_import_session(session)
        image_paths = [_resource_import_file(session, p) for p in session.get("image_paths", [])]
        if not image_paths:
            image_paths = [_resource_import_file(session, p) for p in session.get("preview_paths", [])]
        for index, split_ppt in enumerate(split_files, start=1):
            # split_ppt and the reviewed PNG are temporary working files. They
            # are uploaded directly; no persistent local asset directory is
            # created for a committed resource.
            v1_path = split_ppt
            # The preview was already normalized before the user confirmed it.
            # Copy that exact verified file; applying current settings again at
            # commit time could silently change the bytes the user reviewed
            # when an administrator edits image limits between the two steps.
            png_path = image_paths[index - 1] if image_paths else None
            ppt_ref = persist_asset(v1_path, "resources/ppt")
            uploaded_refs.append(ppt_ref)
            png_ref = persist_asset(png_path, "resources/png") if png_path else None
            if png_ref:
                uploaded_refs.append(png_ref)
            ts = now_iso()
            db.execute(
                """INSERT INTO resources (detail_token, name, owner_id, subject, tags, status,
                   visibility_scope, management_scope, secrecy_level, current_version,
                   updated_by, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)""",
                (new_resource_detail_token(), f"{name_prefix}_{index:02d}", user["id"], subject, tags, status,
                 visibility_scope, management_scope, secrecy_level, user["id"], ts, ts),
            )
            resource_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
            resource_ids.append(resource_id)
            _set_scope_users(db, "resource_visibility", resource_id, [int(x) for x in visible_user_ids])
            _set_scope_users(db, "resource_management", resource_id, [int(x) for x in manage_user_ids])
            _set_scope_tags(db, "resource_visibility_tags", resource_id, visible_user_tags)
            _set_scope_tags(db, "resource_management_tags", resource_id, manage_user_tags)
            version = _insert_version(
                db,
                resource_id=resource_id,
                version_no=1,
                ppt_path=v1_path,
                png_path=png_path,
                ppt_ref=ppt_ref,
                png_ref=png_ref,
                common_remark_html=sanitize_html(str(payload.get("remark_html", ""))),
                change_note="统一导入",
                created_by=int(user["id"]),
            )
            session["commit_progress"] = index
            session["commit_message"] = f"已保存第 {index}/{len(split_files)} 个单页素材…"
            _write_resource_import_session(session)
        result = {"resource_ids": resource_ids, "created": len(resource_ids)}
        db.execute(
            "INSERT INTO resource_import_commits (session_id, owner_id, result_json, created_at) VALUES (?, ?, ?, ?)",
            (session_id, int(user["id"]), json.dumps(result, ensure_ascii=False), now_iso()),
        )
        task_id = session.get("task_id")
        if isinstance(task_id, int):
            task_params_row = db.execute("SELECT params FROM tasks WHERE id = ?", (task_id,)).fetchone()
            task_params = json.loads(task_params_row["params"] or "{}") if task_params_row else {}
            task_params.update({"workflow_state": "completed", "preview_status": "ready"})
            db.execute(
                "UPDATE tasks SET status = 'completed', progress = ?, total = ?, message = '', result_data = ?, params = ?, "
                "updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime'), completed_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime') "
                "WHERE id = ? AND status <> 'cancelled'",
                (len(resource_ids), len(resource_ids), json.dumps(result, ensure_ascii=False), json.dumps(task_params, ensure_ascii=False), task_id),
            )
        db.commit()
    except Exception as exc:
        logger.exception("Resource import commit failed session_id=%s", session_id)
        db.rollback()
        _delete_resource_files(uploaded_refs, [])
        for directory in created_dirs:
            shutil.rmtree(directory, ignore_errors=True)
        _cleanup_resource_import_session(session_id, session)
        storage_message = storage_public_message(exc)
        if storage_message:
            raise HTTPException(503, storage_message) from exc
        raise HTTPException(400, "导入提交失败，临时文件已清理，请重试") from exc
    # Never turn a successful COMMIT into file rollback if cleanup fails.
    try:
        _cleanup_resource_import_session(session_id, session)
    except Exception:
        logger.exception("Committed import session awaiting expiry cleanup: %s", session_id)
    return result
