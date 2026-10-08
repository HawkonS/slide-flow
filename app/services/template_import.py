"""Commit a reviewed resource-import session as a standard-template series."""

from __future__ import annotations

from app.core.errors import storage_public_message
from app.core.fonts import missing_fonts
from app.core.ppt import detect_ppt_fonts
from app.db import known_font_aliases, now_iso
from app.services.common import _validate_scope
from app.services.files import _delete_template_files, persist_asset
from app.services.resource_import.limits import RESOURCE_IMPORT_TTL
from app.services.resource_import.remote_fonts import sha256_file
from app.services.resource_import.rendering import RESOURCE_IMPORT_RENDERER_VERSION
from app.services.resource_import.sessions import (
    _cleanup_resource_import_session,
    _resource_import_file,
    _write_resource_import_session,
)
from app.services.templates import (
    _set_template_scope_tags,
    _set_template_scope_users,
    _template_group_order_values,
    _template_page_name,
    _template_page_office_file_name,
    _validate_template_subject,
    _validate_standalone_template_type,
    _validate_template_platform,
    _validate_template_ratio,
    _validate_template_series,
)
from app.services.resources import _normalise_scope_tags, _normalise_scope_user_ids
from fastapi import HTTPException
from typing import Any
import json
import logging
import sqlite3
import time

logger = logging.getLogger(__name__)

def _commit_template_import_sync(
    session_id: str,
    payload: dict[str, Any],
    user: sqlite3.Row,
    db: sqlite3.Connection,
    session: dict[str, Any],
) -> dict[str, Any]:
    if session.get("import_target") != "templates":
        raise HTTPException(400, "该导入任务不是标准模板导入")
    if session.get("missing_fonts"):
        raise HTTPException(400, "请先替换所有不在标准字体库中的字体")
    slide_count = int(session.get("slide_count") or 0)
    if session.get("preview_status") != "ready" or len(session.get("preview_paths", [])) != slide_count:
        raise HTTPException(400, "请先生成并确认 PPT 预览图")
    if session.get("renderer_version") != RESOURCE_IMPORT_RENDERER_VERSION or not session.get("split_paths"):
        raise HTTPException(400, "预览版本已过期，请重新渲染")

    series = _validate_template_series(payload.get("series"))
    subject = _validate_template_subject(db, payload.get("subject"))
    platform = _validate_template_platform(str(payload.get("platform") or ""))
    ratio = _validate_template_ratio(str(payload.get("ratio") or ""))
    template_type = _validate_standalone_template_type(str(payload.get("template_type") or ""))
    visibility_scope = _validate_scope(str(payload.get("visibility_scope") or ""))
    management_scope = _validate_scope(str(payload.get("management_scope") or ""))
    visible_user_ids = _normalise_scope_user_ids(db, payload.get("visible_user_ids", []))
    manage_user_ids = _normalise_scope_user_ids(db, payload.get("manage_user_ids", []))
    visible_user_tags = _normalise_scope_tags(db, payload.get("visible_user_tags", []))
    manage_user_tags = _normalise_scope_tags(db, payload.get("manage_user_tags", []))
    if visibility_scope == "partial" and not visible_user_ids and not visible_user_tags:
        raise HTTPException(400, "可见范围为部分时请至少选择一位用户或一个用户标签")
    if management_scope == "partial" and not manage_user_ids and not manage_user_tags:
        raise HTTPException(400, "管理范围为部分时请至少选择一位用户或一个用户标签")

    source_path = _resource_import_file(session, session.get("source_path"))
    if sha256_file(source_path) != session.get("rendered_source_sha256"):
        raise HTTPException(409, "PPT 源文件与确认预览不一致，请重新渲染")
    preview_paths = [_resource_import_file(session, path) for path in session.get("preview_paths", [])]
    if [sha256_file(path) for path in preview_paths] != session.get("preview_hashes"):
        raise HTTPException(409, "高清图片完整性校验失败，请重新渲染")
    split_files = [_resource_import_file(session, path) for path in session.get("split_paths", [])]
    if len(split_files) != slide_count or [sha256_file(path) for path in split_files] != session.get("split_hashes"):
        raise HTTPException(409, "单页源文件完整性校验失败，请重新渲染")

    uploaded_refs: list[str] = []
    template_ids: list[int] = []
    try:
        session.update(
            commit_status="processing",
            commit_progress=0,
            commit_total=slide_count,
            commit_message=f"正在准备保存，共 {slide_count} 个标准模板…",
            expires_at=time.time() + RESOURCE_IMPORT_TTL,
        )
        _write_resource_import_session(session)
        aliases = known_font_aliases(db)
        for index, (split_ppt, preview_path) in enumerate(zip(split_files, preview_paths), start=1):
            font_names = detect_ppt_fonts(split_ppt)
            missing = missing_fonts(font_names, aliases)
            office_ref = persist_asset(split_ppt, "templates/ppt")
            uploaded_refs.append(office_ref)
            preview_ref = persist_asset(preview_path, "templates/png")
            uploaded_refs.append(preview_ref)
            subject_order, series_order, sort_order = _template_group_order_values(db, subject, series)
            timestamp = now_iso()
            template_name = _template_page_name(series, subject, platform, ratio, template_type, index)
            office_name = _template_page_office_file_name(series, subject, platform, ratio, template_type, index)
            cursor = db.execute(
                """
                INSERT INTO templates (
                    name, series, subject, platform, ratio, template_type,
                    office_file_name, office_path, png_path, font_names, missing_fonts,
                    subject_order, series_order, sort_order,
                    visibility_scope, management_scope, owner_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    template_name, series, subject, platform, ratio, template_type,
                    office_name, office_ref, preview_ref,
                    json.dumps(font_names, ensure_ascii=False), json.dumps(missing, ensure_ascii=False),
                    subject_order, series_order, sort_order,
                    visibility_scope, management_scope, int(user["id"]), timestamp, timestamp,
                ),
            )
            template_id = int(cursor.lastrowid)
            template_ids.append(template_id)
            _set_template_scope_users(db, "template_visibility", template_id, visible_user_ids)
            _set_template_scope_users(db, "template_management", template_id, manage_user_ids)
            _set_template_scope_tags(db, "template_visibility_tags", template_id, visible_user_tags)
            _set_template_scope_tags(db, "template_management_tags", template_id, manage_user_tags)
            session["commit_progress"] = index
            session["commit_message"] = f"已保存第 {index}/{slide_count} 个标准模板…"
            _write_resource_import_session(session)

        result = {
            "template_ids": template_ids,
            "created": len(template_ids),
            "total": int(session.get("source_slide_count") or slide_count),
            "skipped_pages": list(session.get("skipped_pages") or []),
        }
        db.execute(
            "INSERT INTO resource_import_commits (session_id, owner_id, result_json, created_at) VALUES (?, ?, ?, ?)",
            (session_id, int(user["id"]), json.dumps(result, ensure_ascii=False), now_iso()),
        )
        task_id = session.get("task_id")
        if isinstance(task_id, int):
            row = db.execute("SELECT params FROM tasks WHERE id = ?", (task_id,)).fetchone()
            params = json.loads(row["params"] or "{}") if row else {}
            params.update({"workflow_state": "completed", "preview_status": "ready"})
            db.execute(
                "UPDATE tasks SET status = 'completed', progress = ?, total = ?, message = '', result_data = ?, params = ?, "
                "updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime'), completed_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime') "
                "WHERE id = ? AND status <> 'cancelled'",
                (len(template_ids), len(template_ids), json.dumps(result, ensure_ascii=False), json.dumps(params, ensure_ascii=False), task_id),
            )
        db.commit()
    except Exception as exc:
        logger.exception("Template import commit failed session_id=%s", session_id)
        db.rollback()
        _delete_template_files(uploaded_refs)
        _cleanup_resource_import_session(session_id, session)
        message = storage_public_message(exc)
        if message:
            raise HTTPException(503, message) from exc
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(400, "标准模板导入失败，临时文件已清理，请重试") from exc

    try:
        _cleanup_resource_import_session(session_id, session)
    except Exception:
        logger.exception("Committed template import session awaiting expiry cleanup: %s", session_id)
    return result
