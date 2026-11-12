"""Services / resource import / commit."""

from __future__ import annotations

from app.config import settings
from app.core.errors import storage_public_message
from app.core.permissions import can_manage_resource, can_view_resource
from app.core.fonts import missing_fonts
from app.core.ppt import detect_ppt_fonts, split_pptx_to_single_pages
from app.core.sanitize import sanitize_html
from app.core.storage import copy_into
from app.db import known_font_aliases, new_resource_detail_token, now_iso
from app.services.common import (
    DEFAULT_RESOURCE_SUBJECT,
    _validate_resource_status,
    _validate_resource_subject,
    _validate_required_scope,
)
from app.services.fingerprints import compute_dhash_path, dhash_hex, store_fingerprint
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
    _allocate_version_number,
    _resource_row,
    _set_scope_tags,
    _set_scope_users,
    _version_row,
)
from app.services.tagging import set_entity_tags
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


def _commit_resource_iteration_sync(
    session_id: str,
    resource_id: int,
    payload: dict[str, Any],
    user: sqlite3.Row,
    db: sqlite3.Connection,
    session: dict[str, Any],
) -> dict[str, Any]:
    """Commit one reviewed import page as the next version of a resource."""
    if session.get("import_target") == "templates":
        raise HTTPException(400, "模板导入任务不能用于素材迭代")
    resource = _resource_row(db, resource_id)
    if not can_manage_resource(db, resource, user):
        raise HTTPException(403, "无管理权限")
    if int(session.get("slide_count") or 0) != 1:
        raise HTTPException(400, "版本迭代只接收单页 PPTX")
    if session.get("mode") != "ppt":
        raise HTTPException(400, "版本迭代的预览图必须由平台生成")
    if session.get("missing_fonts"):
        raise HTTPException(400, "请先替换所有不在标准字体库中的字体")
    preview_paths = list(session.get("preview_paths") or [])
    split_paths = list(session.get("split_paths") or [])
    if session.get("preview_status") != "ready" or len(preview_paths) != 1:
        raise HTTPException(400, "请先生成并确认预览图")
    if session.get("renderer_version") != RESOURCE_IMPORT_RENDERER_VERSION or len(split_paths) != 1:
        raise HTTPException(400, "预览版本已过期，请重新渲染")

    source_path = _resource_import_file(session, session.get("source_path"))
    ppt_path = _resource_import_file(session, split_paths[0])
    png_path = _resource_import_file(session, preview_paths[0])
    if sha256_file(source_path) != session.get("rendered_source_sha256"):
        raise HTTPException(409, "PPT 源文件与确认预览不一致，请重新渲染")
    split_hashes = list(session.get("split_hashes") or [])
    preview_hashes = list(session.get("preview_hashes") or [])
    if len(split_hashes) != 1 or sha256_file(ppt_path) != split_hashes[0]:
        raise HTTPException(409, "单页 PPT 完整性校验失败，请重新渲染")
    if len(preview_hashes) != 1 or sha256_file(png_path) != preview_hashes[0]:
        raise HTTPException(409, "高清图片完整性校验失败，请重新渲染")

    change_note = str(payload.get("change_note") or "").strip()
    if not change_note:
        raise HTTPException(400, "请填写版本说明")
    if len(change_note) > 500:
        raise HTTPException(400, "版本说明不能超过 500 个字符")
    inherit_personal = payload.get("inherit_personal_remarks", True)
    if not isinstance(inherit_personal, bool):
        raise HTTPException(400, "个人备注继承选项不正确")

    uploaded_refs: list[str] = []
    try:
        version_no = _allocate_version_number(db, resource_id)
        if not can_manage_resource(db, _resource_row(db, resource_id), user):
            raise HTTPException(403, "无管理权限")
        latest = _version_row(db, resource_id)
        ppt_ref = persist_asset(ppt_path, "resources/ppt")
        uploaded_refs.append(ppt_ref)
        png_ref = persist_asset(png_path, "resources/png")
        uploaded_refs.append(png_ref)
        version = _insert_version(
            db,
            resource_id=resource_id,
            version_no=version_no,
            ppt_path=ppt_path,
            png_path=png_path,
            ppt_ref=ppt_ref,
            png_ref=png_ref,
            detected_fonts=[str(value) for value in session.get("fonts", []) if str(value).strip()],
            common_remark_html=str(payload.get("common_remark_html") or ""),
            change_note=change_note,
            created_by=int(user["id"]),
        )
        if inherit_personal:
            old_remarks = db.execute(
                "SELECT user_id, content_html FROM personal_remarks WHERE resource_id = ? AND version_id = ?",
                (resource_id, int(latest["id"])),
            ).fetchall()
            for remark in old_remarks:
                db.execute(
                    """
                    INSERT INTO personal_remarks (resource_id, version_id, user_id, content_html, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        resource_id,
                        int(version["id"]),
                        int(remark["user_id"]),
                        sanitize_html(remark["content_html"] or ""),
                        now_iso(),
                    ),
                )
        db.execute(
            "UPDATE resources SET current_version = ?, updated_by = ?, updated_at = ? WHERE id = ?",
            (version_no, int(user["id"]), now_iso(), resource_id),
        )
        result = {"resource_id": resource_id, "version_no": version_no, "created": 1}
        db.execute(
            "INSERT INTO resource_import_commits (session_id, owner_id, result_json, created_at) VALUES (?, ?, ?, ?)",
            (session_id, int(user["id"]), json.dumps(result, ensure_ascii=False), now_iso()),
        )
        db.commit()
    except HTTPException:
        db.rollback()
        _delete_resource_files(uploaded_refs, [])
        raise
    except Exception as exc:
        logger.exception("Resource iteration commit failed session_id=%s resource_id=%s", session_id, resource_id)
        db.rollback()
        _delete_resource_files(uploaded_refs, [])
        storage_message = storage_public_message(exc)
        if storage_message:
            raise HTTPException(503, storage_message) from exc
        raise HTTPException(400, "版本保存失败，预览仍保留，可稍后重试") from exc

    try:
        _cleanup_resource_import_session(session_id, session)
    except Exception:
        logger.exception("Committed iteration session awaiting expiry cleanup: %s", session_id)
    return result


def _commit_resource_import_sync(
    session_id: str, payload: dict[str, Any], user: sqlite3.Row, db: sqlite3.Connection, session: dict[str, Any],
) -> dict[str, Any]:
    if session.get("import_target") == "templates":
        raise HTTPException(400, "该导入任务应保存为标准模板")
    payload = _validate_resource_import_payload(payload, db)
    if session.get("missing_fonts"):
        raise HTTPException(400, "请先替换所有不在标准字体库中的字体")
    if session.get("preview_status") != "ready" or len(session.get("preview_paths", [])) != int(session["slide_count"]):
        raise HTTPException(400, "请先生成 PPT 预览图")
    name_prefix = str(payload.get("name_prefix", "")).strip()
    if not name_prefix:
        raise HTTPException(400, "请填写素材名称")
    if len(name_prefix) > RESOURCE_IMPORT_MAX_NAME_LENGTH or any(ord(char) < 32 for char in name_prefix):
        raise HTTPException(400, f"素材名称不能超过 {RESOURCE_IMPORT_MAX_NAME_LENGTH} 个字符且不能包含控制字符")
    subject = _validate_resource_subject(str(payload.get("subject", DEFAULT_RESOURCE_SUBJECT)), allow_empty=True)
    tags = str(payload.get("tags", ""))
    status = _validate_resource_status(str(payload.get("status", "")))
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
    replaced_files: list[str] = []
    replaced_version_ids: list[int] = []
    try:
        if session.get("mode") == "ppt":
            split_files = [_resource_import_file(session, p) for p in session["split_paths"]]
            if [sha256_file(p) for p in split_files] != session.get("split_hashes"):
                raise RuntimeError("单页源文件校验失败，请重新渲染")
        else:
            split_files = split_pptx_to_single_pages(source_path, temp_dir / "split")
        if len(split_files) != int(session["slide_count"]):
            raise RuntimeError("PPT 拆分页数发生变化")
        actions: dict[int, dict[str, Any]] = {}
        raw_actions = payload.get("actions")
        if raw_actions not in (None, {}):
            if not isinstance(raw_actions, dict):
                raise HTTPException(400, "页面处理方式参数格式不正确")
            for raw_index, raw_action in raw_actions.items():
                if isinstance(raw_index, bool) or not isinstance(raw_action, dict):
                    raise HTTPException(400, "页面处理方式参数格式不正确")
                try:
                    page_index = int(raw_index)
                except (TypeError, ValueError):
                    raise HTTPException(400, "页面处理方式参数格式不正确")
                action = str(raw_action.get("action") or "")
                if action not in {"reuse", "iterate", "overwrite", "new"}:
                    raise HTTPException(400, "页面处理方式不正确")
                resource_id = raw_action.get("resource_id")
                if action != "new" and (type(resource_id) is not int or resource_id <= 0):
                    raise HTTPException(400, "页面处理方式缺少要处理的素材")
                actions[page_index] = {"action": action, "resource_id": resource_id}
        raw_reuse = payload.get("reuse")
        if raw_reuse not in (None, {}):
            if not isinstance(raw_reuse, dict):
                raise HTTPException(400, "复用素材参数格式不正确")
            for raw_index, raw_resource in raw_reuse.items():
                if isinstance(raw_index, bool) or isinstance(raw_resource, bool):
                    raise HTTPException(400, "复用素材参数格式不正确")
                try:
                    page_index = int(raw_index)
                    reuse_resource_id = int(raw_resource)
                except (TypeError, ValueError):
                    raise HTTPException(400, "复用素材参数格式不正确")
                actions[page_index] = {"action": "reuse", "resource_id": reuse_resource_id}

        if any(page_index < 0 or page_index >= len(split_files) for page_index in actions):
            raise HTTPException(400, "页面处理方式超出当前导入范围")
        target_ids = [int(entry["resource_id"]) for entry in actions.values() if entry["action"] != "new"]
        if len(target_ids) != len(set(target_ids)):
            raise HTTPException(400, "同一已有素材不能在一份导入里被多个页面处理")
        existing_rows: dict[int, sqlite3.Row] = {}
        if target_ids:
            placeholders = ",".join("?" for _ in target_ids)
            existing_rows = {
                int(row["id"]): row
                for row in db.execute(
                    f"SELECT * FROM resources WHERE id IN ({placeholders}) AND deleted_at IS NULL",
                    target_ids,
                )
            }
            if len(existing_rows) != len(set(target_ids)):
                raise HTTPException(400, "要处理的素材不存在或已从库中移除")
            for entry in actions.values():
                action = entry["action"]
                if action == "new":
                    continue
                row = existing_rows[int(entry["resource_id"])]
                if action == "reuse":
                    if not can_view_resource(db, row, user):
                        raise HTTPException(403, "部分要复用的素材已无可见权限，请重新选择")
                elif not can_manage_resource(db, row, user):
                    raise HTTPException(403, "迭代或覆盖已有素材需要管理权限")
        overwrite_ids = [int(entry["resource_id"]) for entry in actions.values() if entry["action"] == "overwrite"]
        if overwrite_ids:
            placeholders = ",".join("?" for _ in overwrite_ids)
            active_shares = db.execute(
                f"""SELECT COUNT(*) FROM show_share_pages p
                    JOIN resource_versions v ON v.id = p.version_id
                    JOIN show_share_tokens st ON st.id = p.share_id
                    WHERE v.resource_id IN ({placeholders}) AND st.revoked_at IS NULL AND st.expires_at > ?""",
                [*overwrite_ids, now_iso()],
            ).fetchone()[0]
            if active_shares:
                raise HTTPException(409, "部分素材当前版本仍被生效中的分享链接引用，请先撤销分享")

        # The commit request holds the session lease for the whole transaction,
        # so publish progress through the session snapshot instead of committing
        # the task row halfway through an otherwise atomic database operation.
        session["commit_status"] = "processing"
        session["commit_progress"] = 0
        session["commit_total"] = len(split_files)
        session["commit_message"] = f"正在准备保存，共 {len(split_files)} 个单页素材…"
        session["expires_at"] = time.time() + RESOURCE_IMPORT_TTL
        _write_resource_import_session(session)
        reused_count = 0
        iterated_count = 0
        overwritten_count = 0
        image_paths = [_resource_import_file(session, p) for p in session.get("image_paths", [])]
        if not image_paths:
            image_paths = [_resource_import_file(session, p) for p in session.get("preview_paths", [])]
        # Keep enough precision to distinguish two batches committed in the
        # same second while retaining one shared timestamp per batch.
        batch_ts = now_iso(timespec="milliseconds")
        skipped_pages = list(session.get("skipped_pages") or [])
        source_indexes = list(session.get("valid_source_page_indexes") or range(len(split_files)))
        if len(source_indexes) != len(split_files):
            raise RuntimeError("PPT 有效页码清单不一致")
        name_width = max(2, len(str(max(source_indexes, default=0) + 1)))

        # Stage all OSS writes before opening the SQLite write transaction.
        # Uploading a large deck used to keep the single writer lock for the
        # whole batch, blocking every other request behind busy_timeout.
        prepared: list[dict[str, Any]] = []
        for index, split_ppt in enumerate(split_files, start=1):
            source_page = int(source_indexes[index - 1]) + 1
            png_path = image_paths[index - 1] if image_paths else None
            entry = actions.get(index - 1)
            action = entry["action"] if entry else "new"
            item: dict[str, Any] = {
                "index": index,
                "source_page": source_page,
                "split_ppt": split_ppt,
                "png_path": png_path,
                "action": action,
                "target_id": int(entry["resource_id"]) if action != "new" else None,
                "ppt_ref": None,
                "png_ref": None,
                "dhash": None,
                "fonts": [],
                "missing": [],
                "current_id": None,
                "current_version_no": None,
            }
            if action != "reuse":
                ppt_ref = persist_asset(split_ppt, "resources/ppt")
                uploaded_refs.append(ppt_ref)
                png_ref = persist_asset(png_path, "resources/png") if png_path else None
                if png_ref:
                    uploaded_refs.append(png_ref)
                item["ppt_ref"] = ppt_ref
                item["png_ref"] = png_ref
                if png_path:
                    try:
                        item["dhash"] = dhash_hex(compute_dhash_path(png_path))
                    except Exception:
                        logger.warning("导入页面指纹计算失败，提交后由查重扫描补齐", exc_info=True)
                if action == "overwrite":
                    current = _version_row(db, int(item["target_id"]))
                    item["current_id"] = int(current["id"])
                    item["current_version_no"] = int(current["version_no"])
                    try:
                        fonts = detect_ppt_fonts(split_ppt)
                        item["fonts"] = fonts
                        item["missing"] = missing_fonts(fonts, known_font_aliases(db))
                    except Exception:
                        logger.warning("覆盖版本字体检测失败，保留原字体信息", exc_info=True)
                        item["fonts"] = json.loads(current["font_names"] or "[]")
                        item["missing"] = json.loads(current["missing_fonts"] or "[]")
                else:
                    try:
                        item["fonts"] = detect_ppt_fonts(split_ppt)
                    except Exception:
                        # Invalid/fake single-page files are re-checked by
                        # _insert_version; do not fail before the DB phase.
                        logger.warning("导入页面字体预检测失败", exc_info=True)
                        item["fonts"] = None
            prepared.append(item)
            session["commit_progress"] = index
            session["commit_message"] = (
                f"第 {index}/{len(split_files)} 页复用已有素材…"
                if action == "reuse"
                else f"正在上传第 {index}/{len(split_files)} 页{'迭代' if action == 'iterate' else '覆盖' if action == 'overwrite' else ''}素材…"
            )
            _write_resource_import_session(session)

        # From here on only fast SQLite work happens. Keep it in one short
        # IMMEDIATE transaction so validation and writes stay atomic.
        if not db.in_transaction:
            db.execute("BEGIN IMMEDIATE")
        overwrite_ids = [int(item["target_id"]) for item in prepared if item["action"] == "overwrite"]
        if overwrite_ids:
            placeholders = ",".join("?" for _ in overwrite_ids)
            active_shares = db.execute(
                f"""SELECT COUNT(*) FROM show_share_pages p
                    JOIN resource_versions v ON v.id = p.version_id
                    JOIN show_share_tokens st ON st.id = p.share_id
                    WHERE v.resource_id IN ({placeholders}) AND st.revoked_at IS NULL AND st.expires_at > ?""",
                [*overwrite_ids, now_iso()],
            ).fetchone()[0]
            if active_shares:
                raise HTTPException(409, "部分素材当前版本仍被生效中的分享链接引用，请先撤销分享")

        session["commit_message"] = "正在写入素材库…"
        for item in prepared:
            index = int(item["index"])
            action = item["action"]
            target_id = item["target_id"]
            split_ppt = item["split_ppt"]
            png_path = item["png_path"]
            ppt_ref = item["ppt_ref"]
            png_ref = item["png_ref"]
            if action != "new":
                target = db.execute("SELECT * FROM resources WHERE id = ? AND deleted_at IS NULL", (target_id,)).fetchone()
                if target is None:
                    raise RuntimeError("要处理的素材已从库中移除，请重新选择")
                if action == "reuse":
                    if not can_view_resource(db, target, user):
                        raise HTTPException(403, "部分要复用的素材已无可见权限，请重新选择")
                elif not can_manage_resource(db, target, user):
                    raise HTTPException(403, "迭代或覆盖已有素材需要管理权限")
            if action == "reuse":
                resource_ids.append(int(target_id))
                db.execute(
                    "INSERT INTO resource_dedup_events (actor_id, action, resource_id, related_resource_id, details, created_at) VALUES (?, 'import_reuse', ?, NULL, ?, ?)",
                    (int(user["id"]), int(target_id), json.dumps({"session_id": session_id, "page": index}, ensure_ascii=False), now_iso()),
                )
                reused_count += 1
                continue
            if action == "iterate":
                version_no = _allocate_version_number(db, int(target_id))
                _insert_version(
                    db,
                    resource_id=int(target_id),
                    version_no=version_no,
                    ppt_path=split_ppt,
                    png_path=png_path,
                    ppt_ref=ppt_ref,
                    png_ref=png_ref,
                    common_remark_html="",
                    change_note="导入迭代",
                    created_by=int(user["id"]),
                    detected_fonts=item["fonts"],
                )
                db.execute(
                    "UPDATE resources SET current_version = ?, updated_at = ?, updated_by = ? WHERE id = ?",
                    (version_no, batch_ts, int(user["id"]), int(target_id)),
                )
                db.execute(
                    "INSERT INTO resource_dedup_events (actor_id, action, resource_id, related_resource_id, details, created_at) VALUES (?, 'import_iterate', ?, NULL, ?, ?)",
                    (int(user["id"]), int(target_id), json.dumps({"session_id": session_id, "page": index, "version_no": version_no}, ensure_ascii=False), now_iso()),
                )
                if item["dhash"]:
                    store_fingerprint(db, int(target_id), version_no, item["dhash"])
                db.execute("DELETE FROM resource_text_fingerprints WHERE resource_id = ?", (int(target_id),))
                resource_ids.append(int(target_id))
                iterated_count += 1
                continue
            if action == "overwrite":
                current = _version_row(db, int(target_id))
                if int(current["id"]) != int(item["current_id"]) or int(current["version_no"]) != int(item["current_version_no"]):
                    raise HTTPException(409, "素材版本已变化，请重新选择后再提交")
                replaced_files.extend([current["ppt_path"], current["png_path"]] if current["png_path"] else [current["ppt_path"]])
                replaced_version_ids.append(int(current["id"]))
                db.execute(
                    "UPDATE resource_versions SET ppt_path = ?, png_path = ?, font_names = ?, missing_fonts = ? WHERE id = ?",
                    (ppt_ref, png_ref, json.dumps(item["fonts"], ensure_ascii=False), json.dumps(item["missing"], ensure_ascii=False), current["id"]),
                )
                db.execute(
                    "UPDATE resources SET updated_at = ?, updated_by = ? WHERE id = ?",
                    (batch_ts, int(user["id"]), int(target_id)),
                )
                db.execute(
                    "INSERT INTO resource_dedup_events (actor_id, action, resource_id, related_resource_id, details, created_at) VALUES (?, 'import_overwrite', ?, NULL, ?, ?)",
                    (int(user["id"]), int(target_id), json.dumps({"session_id": session_id, "page": index, "version_no": int(current["version_no"])}, ensure_ascii=False), now_iso()),
                )
                if item["dhash"]:
                    store_fingerprint(db, int(target_id), int(current["version_no"]), item["dhash"])
                db.execute("DELETE FROM resource_text_fingerprints WHERE resource_id = ?", (int(target_id),))
                resource_ids.append(int(target_id))
                overwritten_count += 1
                continue

            name = name_prefix if len(split_files) == 1 else f"{name_prefix}_{item['source_page']:0{name_width}d}"
            db.execute(
                """INSERT INTO resources (detail_token, name, owner_id, subject, tags, status,
                   visibility_scope, management_scope, secrecy_level, current_version,
                   updated_by, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 1, ?, ?, ?)""",
                (new_resource_detail_token(), name, user["id"], subject, tags, status,
                 visibility_scope, management_scope, user["id"], batch_ts, batch_ts),
            )
            resource_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
            resource_ids.append(resource_id)
            set_entity_tags(
                db,
                relation_table="resource_tags",
                entity_column="resource_id",
                entity_id=resource_id,
                names=tags,
                cache_table="resources",
                created_by=int(user["id"]),
            )
            _set_scope_users(db, "resource_visibility", resource_id, [int(x) for x in visible_user_ids])
            _set_scope_users(db, "resource_management", resource_id, [int(x) for x in manage_user_ids])
            _set_scope_tags(db, "resource_visibility_tags", resource_id, visible_user_tags)
            _set_scope_tags(db, "resource_management_tags", resource_id, manage_user_tags)
            _insert_version(
                db,
                resource_id=resource_id,
                version_no=1,
                ppt_path=split_ppt,
                png_path=png_path,
                ppt_ref=ppt_ref,
                png_ref=png_ref,
                common_remark_html=sanitize_html(str(payload.get("remark_html", ""))),
                change_note="统一导入",
                created_by=int(user["id"]),
                detected_fonts=item["fonts"],
            )
            if item["dhash"]:
                store_fingerprint(db, resource_id, 1, item["dhash"])

        result = {
            "resource_ids": resource_ids,
            "created": len(resource_ids),
            "reused": reused_count,
            "iterated": iterated_count,
            "overwritten": overwritten_count,
            "total": int(session.get("source_slide_count") or session["slide_count"]),
            "skipped_pages": skipped_pages,
        }
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
    if replaced_files:
        try:
            _delete_resource_files(replaced_files, replaced_version_ids)
        except Exception:
            logger.warning("删除被覆盖版本的旧文件失败", exc_info=True)
    # Never turn a successful COMMIT into file rollback if cleanup fails.
    try:
        _cleanup_resource_import_session(session_id, session)
    except Exception:
        logger.exception("Committed import session awaiting expiry cleanup: %s", session_id)
    return result
