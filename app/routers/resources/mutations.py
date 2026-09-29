"""Routers / resources / mutations."""

from __future__ import annotations

from app.core.fonts import missing_fonts
from app.core.permissions import can_manage_resource
from app.core.permissions import can_view_resource
from app.core.permissions import require_user
from app.core.ppt import detect_ppt_fonts
from app.core.ppt import slide_count
from app.core.sanitize import sanitize_html
from app.core.storage import save_upload
from app.core.oss import storage as oss_storage
from app.db import known_font_aliases
from app.db import new_resource_detail_token
from app.db import now_iso
from app.routers.dependencies import (
    db_dep,
    db_read_dep,
)
from app.schemas.resources import (
    MetadataPayload,
)
from app.services.common import (
    DEFAULT_RESOURCE_SUBJECT,
    _json_loads,
    _parse_id_list,
    _parse_string_list,
    _reject_removed_form_fields,
    _validate_resource_status,
    _validate_resource_subject,
    _validate_scope,
)
from app.services.files import (
    _compress_hd_image,
    _delete_resource_files,
    _validate_png_upload,
    _validate_ppt_upload,
    persist_asset,
    persist_asset_copy,
)
from app.services.resource_queries import (
    _parse_csv,
)
from app.services.resource_import.limits import (
    RESOURCE_IMPORT_MAX_IMAGE_BYTES,
    RESOURCE_IMPORT_MAX_PPT_BYTES,
)
from app.services.resource_import.validation import (
    _validate_import_image,
    _validate_import_ppt_package,
)
from app.services.resources import (
    _delete_latest_resource_version,
    _insert_version,
    _normalise_scope_tags,
    _normalise_scope_user_ids,
    _resource_row,
    _resource_row_by_detail_token,
    _scope_tag_names,
    _scope_user_ids,
    _serialize_resource,
    _set_scope_tags,
    _set_scope_users,
    _version_row,
)
from app.services.tagging import set_entity_tags
from fastapi import APIRouter
from fastapi import Body
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
import sqlite3
import tempfile

router = APIRouter()


@router.post("/api/resources")
async def create_resource(
    request: Request,
    name: str = Form(...),
    remark_html: str = Form(""),
    tags: str = Form(""),
    visibility_scope: str = Form("private"),
    visible_user_ids: str = Form(""),
    visible_user_tags: str = Form(""),
    management_scope: str = Form("private"),
    manage_user_ids: str = Form(""),
    manage_user_tags: str = Form(""),
    status: str = Form(""),
    subject: str = Form(DEFAULT_RESOURCE_SUBJECT),
    ppt_file: UploadFile = File(...),
    png_file: UploadFile | None = File(None),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    await _reject_removed_form_fields(request, "resource_type", "template_type")
    _validate_ppt_upload(ppt_file)
    visibility_scope = _validate_scope(visibility_scope)
    management_scope = _validate_scope(management_scope)
    status = _validate_resource_status(status)
    subject = _validate_resource_subject(subject)
    visible_ids = _parse_id_list(visible_user_ids)
    manage_ids = _parse_id_list(manage_user_ids)
    visible_tags = _parse_string_list(visible_user_tags, label="可见用户标签")
    manage_tags = _parse_string_list(manage_user_tags, label="管理用户标签")
    if visibility_scope == "partial" and not visible_ids and not visible_tags:
        raise HTTPException(400, "可见范围为部分时请至少选择一位用户或一个用户标签")
    if management_scope == "partial" and not manage_ids and not manage_tags:
        raise HTTPException(400, "管理范围为部分时请至少选择一位用户或一个用户标签")
    oss_storage.ensure_configured()

    uploaded_refs: list[str] = []
    try:
        with tempfile.TemporaryDirectory(prefix="slide-flow-resource-") as temp_name:
            work_dir = Path(temp_name)
            ppt_path = await save_upload(
                ppt_file, work_dir, "v1_", stage_oss=True,
                max_bytes=RESOURCE_IMPORT_MAX_PPT_BYTES,
            )
            _validate_import_ppt_package(ppt_path)
            if await asyncio.to_thread(slide_count, ppt_path) > 1:
                raise HTTPException(400, "资源导入只接收单页 PPTX，多页文件请使用「拆分导入」")
            detected_fonts = await asyncio.to_thread(detect_ppt_fonts, ppt_path)
            png_path = await save_upload(
                png_file, work_dir, "preview_", stage_oss=True,
                max_bytes=RESOURCE_IMPORT_MAX_IMAGE_BYTES,
            ) if png_file else None
            if png_path is not None:
                _validate_import_image(png_path)
                png_path = _compress_hd_image(png_path)
            ppt_ref = persist_asset(ppt_path, "resources/ppt")
            uploaded_refs.append(ppt_ref)
            png_ref = persist_asset(png_path, "resources/png") if png_path else None
            if png_ref:
                uploaded_refs.append(png_ref)
            ts = now_iso()
            db.execute(
                """
                INSERT INTO resources (
                    detail_token, name, owner_id, subject, tags, status,
                    visibility_scope, management_scope, secrecy_level,
                    current_version, updated_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 1, ?, ?, ?)
                """,
                (
                    new_resource_detail_token(), name, user["id"], subject, tags, status,
                    visibility_scope, management_scope,
                    user["id"], ts, ts,
                ),
            )
            resource_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
            set_entity_tags(
                db,
                relation_table="resource_tags",
                entity_column="resource_id",
                entity_id=resource_id,
                names=tags,
                cache_table="resources",
                created_by=int(user["id"]),
            )
            _set_scope_users(db, "resource_visibility", resource_id, visible_ids)
            _set_scope_users(db, "resource_management", resource_id, manage_ids)
            _set_scope_tags(db, "resource_visibility_tags", resource_id, visible_tags)
            _set_scope_tags(db, "resource_management_tags", resource_id, manage_tags)
            _insert_version(
                db,
                resource_id=resource_id,
                version_no=1,
                ppt_path=ppt_path,
                png_path=png_path,
                ppt_ref=ppt_ref,
                png_ref=png_ref,
                detected_fonts=detected_fonts,
                common_remark_html=sanitize_html(remark_html),
                change_note="创建资源",
                created_by=int(user["id"]),
            )
            db.commit()
    except Exception:
        db.rollback()
        _delete_resource_files(uploaded_refs, [])
        raise
    row = _resource_row(db, resource_id)
    return {"resource": _serialize_resource(db, row, user)}


@router.get("/api/resources/{resource_id}")
def get_resource(
    resource_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    row = _resource_row(db, resource_id)
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无可见权限")
    return {"resource": _serialize_resource(db, row, user)}


@router.get("/api/resources/by-key/{detail_token}")
def get_resource_by_detail_token(
    detail_token: str,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    row = _resource_row_by_detail_token(db, detail_token)
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无可见权限")
    return {"resource": _serialize_resource(db, row, user)}


@router.put("/api/resources/{resource_id}/metadata")
def update_resource_metadata(
    resource_id: int,
    payload: MetadataPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _resource_row(db, resource_id)
    if not can_manage_resource(db, row, user):
        raise HTTPException(403, "无管理权限")
    subject = _validate_resource_subject(payload.subject)
    status = _validate_resource_status(payload.status)
    visibility_scope = _validate_scope(payload.visibility_scope)
    management_scope = _validate_scope(payload.management_scope)
    if visibility_scope == "partial" and not payload.visible_user_ids and not payload.visible_user_tags:
        raise HTTPException(400, "可见范围为部分时请至少选择一位用户或一个用户标签")
    if management_scope == "partial" and not payload.manage_user_ids and not payload.manage_user_tags:
        raise HTTPException(400, "管理范围为部分时请至少选择一位用户或一个用户标签")
    db.execute(
        """
        UPDATE resources
        SET name = ?, subject = ?, tags = ?, status = ?, visibility_scope = ?, management_scope = ?, updated_by = ?, updated_at = ?
        WHERE id = ?
        """,
        (
            payload.name,
            subject,
            payload.tags,
            status,
            visibility_scope,
            management_scope,
            user["id"],
            now_iso(),
            resource_id,
        ),
    )
    set_entity_tags(
        db,
        relation_table="resource_tags",
        entity_column="resource_id",
        entity_id=resource_id,
        names=payload.tags,
        cache_table="resources",
        created_by=int(user["id"]),
    )
    _set_scope_users(db, "resource_visibility", resource_id, payload.visible_user_ids)
    _set_scope_users(db, "resource_management", resource_id, payload.manage_user_ids)
    _set_scope_tags(db, "resource_visibility_tags", resource_id, payload.visible_user_tags)
    _set_scope_tags(db, "resource_management_tags", resource_id, payload.manage_user_tags)
    db.commit()
    return {"resource": _serialize_resource(db, _resource_row(db, resource_id), user)}


@router.post("/api/resources/{resource_id}/versions")
async def create_resource_version(
    resource_id: int,
    mode: str = Form("iterate"),
    change_note: str = Form(""),
    common_remark_html: str = Form(""),
    inherit_personal_remarks: bool = Form(True),
    ppt_file: UploadFile | None = File(None),
    png_file: UploadFile | None = File(None),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _resource_row(db, resource_id)
    if not can_manage_resource(db, row, user):
        raise HTTPException(403, "无管理权限")
    mode_aliases = {"edit": "iterate", "reupload": "iterate", "image": "replace"}
    mode = mode_aliases.get(mode, mode)
    if mode not in {"iterate", "replace"}:
        raise HTTPException(400, "版本模式不正确")
    if mode == "iterate":
        raise HTTPException(400, "请通过版本迭代流程上传单页 PPT，并确认平台生成的预览图")
    latest = _version_row(db, resource_id)
    oss_storage.ensure_configured()
    has_ppt = bool(ppt_file is not None and ppt_file.filename)
    has_png = bool(png_file is not None and png_file.filename)

    if mode == "replace":
        if not has_ppt and not has_png:
            raise HTTPException(400, "重传请至少上传 PPTX 或 PNG")
        ppt_path = None
        png_path = None
        ppt_ref = latest["ppt_path"]
        png_ref = latest["png_path"]
        font_names = _json_loads(latest["font_names"], [])
        missing = _json_loads(latest["missing_fonts"], [])
        old_paths: list[Path | str | None] = []
        uploaded_refs: list[str] = []
        try:
            with tempfile.TemporaryDirectory(prefix=f"slide-flow-resource-{resource_id}-") as temp_name:
                work_dir = Path(temp_name)
                if has_ppt:
                    assert ppt_file is not None
                    _validate_ppt_upload(ppt_file)
                    new_ppt = await save_upload(
                        ppt_file, work_dir, f"v{latest['version_no']}_replace_",
                        stage_oss=True, max_bytes=RESOURCE_IMPORT_MAX_PPT_BYTES,
                    )
                    _validate_import_ppt_package(new_ppt)
                    if slide_count(new_ppt) > 1:
                        raise HTTPException(400, "重传只接收单页 PPTX")
                    old_paths.append(latest["ppt_path"])
                    ppt_path = new_ppt
                    ppt_ref = persist_asset(new_ppt, "resources/ppt")
                    uploaded_refs.append(ppt_ref)
                    font_names = detect_ppt_fonts(ppt_path)
                    missing = missing_fonts(font_names, known_font_aliases(db))
                if has_png:
                    assert png_file is not None
                    _validate_png_upload(png_file)
                    old_paths.append(latest["png_path"])
                    png_path = await save_upload(
                        png_file, work_dir, "preview_replace_", stage_oss=True,
                        max_bytes=RESOURCE_IMPORT_MAX_IMAGE_BYTES,
                    )
                    _validate_import_image(png_path)
                    png_path = _compress_hd_image(png_path)
                    png_ref = persist_asset(png_path, "resources/png")
                    uploaded_refs.append(png_ref)
                db.execute(
                    """
                    UPDATE resource_versions
                    SET ppt_path = ?, png_path = ?, font_names = ?, missing_fonts = ?, change_note = ?
                    WHERE id = ?
                    """,
                    (
                        ppt_ref, png_ref,
                        json.dumps(font_names, ensure_ascii=False),
                        json.dumps(missing, ensure_ascii=False),
                        change_note or "重传文件", latest["id"],
                    ),
                )
                db.execute("UPDATE resources SET updated_by = ?, updated_at = ? WHERE id = ?", (user["id"], now_iso(), resource_id))
                db.commit()
        except Exception:
            db.rollback()
            _delete_resource_files(uploaded_refs, [])
            raise
        _delete_resource_files(old_paths, [int(latest["id"])] if has_png else [])
        return {"resource": _serialize_resource(db, _resource_row(db, resource_id), user)}

    version_no = int(row["current_version"]) + 1
    if not has_ppt:
        raise HTTPException(400, "迭代模式请上传新版 PPTX")
    assert ppt_file is not None
    _validate_ppt_upload(ppt_file)
    uploaded_refs: list[str] = []
    try:
        with tempfile.TemporaryDirectory(prefix=f"slide-flow-resource-{resource_id}-") as temp_name:
            work_dir = Path(temp_name)
            ppt_path = await save_upload(ppt_file, work_dir, f"v{version_no}_", stage_oss=True)
            if slide_count(ppt_path) > 1:
                raise HTTPException(400, "版本迭代只接收单页 PPTX")
            detected_fonts = detect_ppt_fonts(ppt_path)
            ppt_ref = persist_asset(ppt_path, "resources/ppt")
            uploaded_refs.append(ppt_ref)
            if has_png:
                assert png_file is not None
                _validate_png_upload(png_file)
                png_path = await save_upload(png_file, work_dir, "preview_", stage_oss=True)
                png_path = _compress_hd_image(png_path)
                png_ref = persist_asset(png_path, "resources/png")
            elif latest["png_path"]:
                png_path = None
                png_ref = persist_asset_copy(latest["png_path"], "resources/png")
            else:
                png_path = None
                png_ref = None
            if png_ref:
                uploaded_refs.append(png_ref)

            new_ver = _insert_version(
                db,
                resource_id=resource_id,
                version_no=version_no,
                ppt_path=ppt_path,
                png_path=png_path,
                ppt_ref=ppt_ref,
                png_ref=png_ref,
                detected_fonts=detected_fonts,
                common_remark_html=sanitize_html(common_remark_html or ""),
                change_note=change_note or "迭代",
                created_by=int(user["id"]),
            )
            # 按选项继承上一版本的个人备注
            if inherit_personal_remarks:
                old_version_id = latest["id"]
                new_version_id = new_ver["id"]
                old_remarks = db.execute(
                    "SELECT user_id, content_html FROM personal_remarks WHERE resource_id = ? AND version_id = ?",
                    (resource_id, old_version_id),
                ).fetchall()
                for old_remark in old_remarks:
                    db.execute(
                        """
                        INSERT INTO personal_remarks (resource_id, version_id, user_id, content_html, updated_at)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (resource_id, new_version_id, old_remark["user_id"], sanitize_html(old_remark["content_html"]), now_iso()),
                    )
            db.execute("UPDATE resources SET current_version = ?, updated_by = ?, updated_at = ? WHERE id = ?", (version_no, user["id"], now_iso(), resource_id))
            db.commit()
    except Exception:
        db.rollback()
        _delete_resource_files(uploaded_refs, [])
        raise
    return {"resource": _serialize_resource(db, _resource_row(db, resource_id), user)}


@router.post("/api/resources/{resource_id}/versions/rollback")
def rollback_resource_version(
    resource_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """删除当前最新版本，回退到上一版本；仅剩 1 个版本时拒绝。"""
    row = _resource_row(db, resource_id)
    if not can_manage_resource(db, row, user):
        raise HTTPException(403, "无管理权限")
    paths, version_ids = _delete_latest_resource_version(db, resource_id)
    _delete_resource_files(paths, version_ids)
    return {"resource": _serialize_resource(db, _resource_row(db, resource_id), user)}


@router.put("/api/resources/batch")
def batch_update_resources(
    body: dict = Body(...),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict:
    """批量编辑资源元数据。"""
    resource_ids_raw = body.get("resource_ids", [])
    fields_raw = body.get("fields", {})
    if not isinstance(resource_ids_raw, list) or any(type(value) is not int for value in resource_ids_raw):
        raise HTTPException(400, "resource_ids 必须是整数数组")
    resource_ids = list(dict.fromkeys(value for value in resource_ids_raw if value > 0))
    if not resource_ids:
        raise HTTPException(400, "resource_ids 不能为空")
    if len(resource_ids) > 1000:
        raise HTTPException(400, "一次最多批量编辑 1000 个资源")
    if not isinstance(fields_raw, dict):
        raise HTTPException(400, "fields 必须是对象")
    if not fields_raw:
        raise HTTPException(400, "fields 不能为空")
    fields = dict(fields_raw)

    # 允许更新的字段白名单。
    allowed_scalar = {
        "status": _validate_resource_status,
        "visibility_scope": _validate_scope,
        "management_scope": _validate_scope,
    }
    allowed_relational = {
        "visible_user_ids", "manage_user_ids", "visible_user_tags", "manage_user_tags"
    }

    invalid = set(fields.keys()) - set(allowed_scalar.keys()) - allowed_relational - {"name", "tags"}
    if invalid:
        raise HTTPException(400, f"不支持的字段: {', '.join(sorted(invalid))}")

    # Validate the complete request before mutating any row. This keeps batch
    # updates atomic and prevents creating a `partial` scope with no grants.
    for key, validator in allowed_scalar.items():
        if key not in fields:
            continue
        fields[key] = validator(fields[key])
    for key in ("visible_user_ids", "manage_user_ids"):
        if key in fields:
            fields[key] = _normalise_scope_user_ids(db, fields[key])
    for key in ("visible_user_tags", "manage_user_tags"):
        if key in fields:
            fields[key] = _normalise_scope_tags(db, fields[key])
    if fields.get("visibility_scope") in {"public", "private"}:
        fields["visible_user_ids"] = []
        fields["visible_user_tags"] = []
    if fields.get("management_scope") in {"public", "private"}:
        fields["manage_user_ids"] = []
        fields["manage_user_tags"] = []
    if "name" in fields:
        name_field = fields["name"]
        if not isinstance(name_field, dict):
            raise HTTPException(400, "name 必须是包含 mode 的对象")
        mode = name_field.get("mode")
        value = name_field.get("value", "")
        search = name_field.get("search", "")
        if mode not in {"prefix", "suffix", "replace"}:
            raise HTTPException(400, f"不支持的 name mode: {mode}")
        if not isinstance(value, str) or not isinstance(search, str):
            raise HTTPException(400, "name.value 和 name.search 必须是字符串")
        if mode in {"prefix", "suffix"} and not value.strip():
            raise HTTPException(400, "名称前缀或后缀不能为空")
        if mode == "replace" and not search.strip():
            raise HTTPException(400, "名称查找内容不能为空")
        fields["name"] = {"mode": mode, "value": value, "search": search}
    if "tags" in fields:
        tags_field = fields["tags"]
        if not isinstance(tags_field, dict):
            raise HTTPException(400, "tags 必须是包含 mode 和 values 的对象")
        mode = tags_field.get("mode")
        values = tags_field.get("values")
        if mode not in {"replace", "append", "remove"}:
            raise HTTPException(400, f"不支持的 tags mode: {mode}")
        if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
            raise HTTPException(400, "tags.values 必须是字符串数组")
        normalised_values = list(dict.fromkeys(value.strip() for value in values if value.strip()))
        if mode in {"append", "remove"} and not normalised_values:
            raise HTTPException(400, "追加或移除标签时必须至少选择一个标签")
        fields["tags"] = {
            "mode": mode,
            "values": normalised_values,
        }

    # 预先检查权限并收集资源行
    rows: dict[int, sqlite3.Row] = {}
    planned_names: dict[int, str] = {}
    for rid in resource_ids:
        row = _resource_row(db, rid)
        if not can_manage_resource(db, row, user):
            raise HTTPException(403, f"资源 {rid} 无管理权限")
        if "name" in fields:
            name_field = fields["name"]
            current_name = str(row["name"] or "")
            if name_field["mode"] == "prefix":
                next_name = f"{name_field['value']}{current_name}"
            elif name_field["mode"] == "suffix":
                next_name = f"{current_name}{name_field['value']}"
            else:
                next_name = current_name.replace(name_field["search"], name_field["value"])
            if not next_name.strip():
                raise HTTPException(400, f"资源 {rid} 修改后的名称不能为空")
            if len(next_name) > 200:
                raise HTTPException(400, f"资源 {rid} 修改后的名称不能超过 200 个字符")
            planned_names[rid] = next_name
        visibility_scope = fields.get("visibility_scope", row["visibility_scope"])
        visible_ids = fields.get(
            "visible_user_ids", _scope_user_ids(db, "resource_visibility", rid)
        )
        visible_tags = fields.get(
            "visible_user_tags", _scope_tag_names(db, "resource_visibility_tags", rid)
        )
        management_scope = fields.get("management_scope", row["management_scope"])
        manage_ids = fields.get(
            "manage_user_ids", _scope_user_ids(db, "resource_management", rid)
        )
        manage_tags = fields.get(
            "manage_user_tags", _scope_tag_names(db, "resource_management_tags", rid)
        )
        if visibility_scope == "partial" and not visible_ids and not visible_tags:
            raise HTTPException(400, f"资源 {rid} 的可见范围为部分时请至少选择一位用户或一个用户标签")
        if management_scope == "partial" and not manage_ids and not manage_tags:
            raise HTTPException(400, f"资源 {rid} 的管理范围为部分时请至少选择一位用户或一个用户标签")
        rows[rid] = row

    updated = 0
    timestamp = now_iso()
    try:
        for rid, row in rows.items():
            set_clauses: list[str] = []
            set_values: list[Any] = []
            for key in allowed_scalar:
                if key in fields:
                    set_clauses.append(f"{key} = ?")
                    set_values.append(fields[key])

            if rid in planned_names:
                set_clauses.append("name = ?")
                set_values.append(planned_names[rid])

            # 处理 tags 字段：支持 replace/append/remove 三种模式
            if "tags" in fields:
                tags_field = fields["tags"]
                mode = tags_field.get("mode")
                values = tags_field.get("values")
                if mode == "replace":
                    tag_value = ",".join(values)
                elif mode == "append":
                    existing = _parse_csv(row["tags"] or "")
                    tag_value = ",".join(dict.fromkeys([*existing, *values]))
                else:
                    remove_set = set(values)
                    tag_value = ",".join(
                        tag for tag in _parse_csv(row["tags"] or "") if tag not in remove_set
                    )
                set_clauses.append("tags = ?")
                set_values.append(tag_value)

            set_clauses.extend(["updated_by = ?", "updated_at = ?"])
            set_values.extend([user["id"], timestamp, rid])
            db.execute(
                f"UPDATE resources SET {', '.join(set_clauses)} WHERE id = ?",
                tuple(set_values),
            )
            if "tags" in fields:
                set_entity_tags(
                    db,
                    relation_table="resource_tags",
                    entity_column="resource_id",
                    entity_id=rid,
                    names=tag_value,
                    cache_table="resources",
                    created_by=int(user["id"]),
                )

            # 处理关联表字段
            if "visible_user_ids" in fields:
                _set_scope_users(db, "resource_visibility", rid, fields["visible_user_ids"])
            if "manage_user_ids" in fields:
                _set_scope_users(db, "resource_management", rid, fields["manage_user_ids"])
            if "visible_user_tags" in fields:
                _set_scope_tags(db, "resource_visibility_tags", rid, fields["visible_user_tags"])
            if "manage_user_tags" in fields:
                _set_scope_tags(db, "resource_management_tags", rid, fields["manage_user_tags"])

            updated += 1

        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"updated": updated}


@router.delete("/api/resources/batch")
def batch_delete_resources(
    body: dict = Body(...),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict:
    """批量删除资源及其全部版本（含物理文件与缩略图）。"""
    resource_ids = body.get("resource_ids", [])
    if not resource_ids:
        raise HTTPException(400, "resource_ids 不能为空")

    deleted = 0
    all_paths: list[Path | str | None] = []
    all_version_ids: list[int] = []

    for rid in resource_ids:
        row = _resource_row(db, rid)
        if not can_manage_resource(db, row, user):
            raise HTTPException(403, f"资源 {rid} 无管理权限")

        versions = db.execute(
            "SELECT id, ppt_path, png_path FROM resource_versions WHERE resource_id = ?",
            (rid,),
        ).fetchall()
        for v in versions:
            all_paths.append(v["ppt_path"])
            all_paths.append(v["png_path"])
            all_version_ids.append(int(v["id"]))

        # ON DELETE CASCADE 会自动清理 resource_versions / resource_visibility /
        # resource_management / personal_remarks 四张关联表
        db.execute("DELETE FROM resources WHERE id = ?", (rid,))
        deleted += 1

    db.commit()
    _delete_resource_files(all_paths, all_version_ids)
    return {"deleted": deleted}


@router.delete("/api/resources/{resource_id}")
def delete_resource(
    resource_id: int,
    scope: str = Query("all"),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """删除资源。

    scope=all：删除资源及其全部版本（默认，原有行为）；
    scope=latest：仅删除最新版本并回退到上一版本（仅剩 1 个版本时等同于全部删除）。
    """
    row = _resource_row(db, resource_id)
    if not can_manage_resource(db, row, user):
        raise HTTPException(403, "无管理权限")
    if scope not in {"all", "latest"}:
        raise HTTPException(400, "删除范围不正确")
    if scope == "latest":
        version_count = db.execute(
            "SELECT COUNT(*) FROM resource_versions WHERE resource_id = ?",
            (resource_id,),
        ).fetchone()[0]
        if version_count > 1:
            paths, version_ids = _delete_latest_resource_version(db, resource_id)
            _delete_resource_files(paths, version_ids)
            return {"ok": True, "scope": "latest", "deleted_versions": 1}
        # 仅剩 1 个版本：删除最新版本即删除整个资源，落入全量删除
    versions = db.execute(
        "SELECT id, ppt_path, png_path FROM resource_versions WHERE resource_id = ?",
        (resource_id,),
    ).fetchall()
    paths: list[Path | str | None] = []
    version_ids: list[int] = []
    for v in versions:
        paths.append(v["ppt_path"])
        paths.append(v["png_path"])
        version_ids.append(int(v["id"]))
    # ON DELETE CASCADE 会自动清理 resource_versions / resource_visibility /
    # resource_management / personal_remarks 四张关联表
    db.execute("DELETE FROM resources WHERE id = ?", (resource_id,))
    db.commit()
    _delete_resource_files(paths, version_ids)
    return {"ok": True, "scope": "all", "deleted": 1, "deleted_versions": len(version_ids)}
