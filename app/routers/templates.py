"""Routers / templates."""

from __future__ import annotations

from app.core.fonts import missing_fonts
from app.core.permissions import is_system_admin
from app.core.permissions import require_admin
from app.core.permissions import require_user
from app.core.ppt import detect_ppt_fonts, merge_pptx_files
from app.core.storage import save_upload
from app.db import known_font_aliases
from app.db import now_iso
from app.routers.dependencies import (
    db_dep,
    db_read_dep,
)
from app.schemas.templates import (
    TemplateComposePayload,
    TemplateDeletePayload,
    TemplateOrderPayload,
)
from app.services.common import (
    _json_loads,
    _parse_id_list,
    _validate_scope,
)
from app.services.downloads.fonts import (
    _build_fonts_bundle,
    _write_fonts_into_zip,
)
from app.services.files import (
    asset_preview_url,
    _compress_hd_image,
    _content_disposition,
    _delete_template_files,
    _ensure_preview_thumb,
    _resource_file_abs,
    _validate_office_upload,
    _validate_png_upload,
    materialization_scope,
    persist_asset,
)
from app.core.oss import is_oss_ref
from app.core.oss import storage as oss_storage
from app.services.templates import (
    _rename_template_file,
    _serialize_template,
    _set_template_scope_users,
    _template_group_order_values,
    _template_name,
    _template_office_file_name,
    _template_preview_file_name,
    _template_row,
    _validate_standalone_template_subject,
    _validate_standalone_template_type,
    _validate_template_platform,
    _validate_template_ratio,
    _validate_template_series,
    can_view_template,
)
from fastapi import APIRouter
from fastapi import Depends
from fastapi import File
from fastapi import Form
from fastapi import HTTPException
from fastapi import Query
from fastapi import Response
from fastapi import UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from functools import wraps
from pathlib import Path
from typing import Any, Callable, TypeVar
import asyncio
import io
import json
import sqlite3
import tempfile
import zipfile

router = APIRouter()

_T = TypeVar("_T")


def _cleanup_oss_materialized(endpoint: Callable[..., _T]) -> Callable[..., _T]:
    @wraps(endpoint)
    def wrapped(*args: Any, **kwargs: Any) -> _T:
        with materialization_scope():
            return endpoint(*args, **kwargs)
    return wrapped


@router.delete("/api/admin/templates/{template_id}")
def delete_template(
    template_id: int,
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _template_row(db, template_id)
    paths = [row["office_path"], row["png_path"]]
    db.execute("DELETE FROM templates WHERE id = ?", (template_id,))
    db.commit()
    _delete_template_files(paths)
    return {"ok": True, "deleted": 1}


@router.post("/api/admin/templates/bulk-delete")
def bulk_delete_templates(
    payload: TemplateDeletePayload,
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    template_ids = sorted({int(tid) for tid in payload.template_ids if int(tid) > 0})
    if not template_ids:
        raise HTTPException(400, "请选择要删除的模板")
    placeholders = ",".join("?" for _ in template_ids)
    rows = db.execute(f"SELECT * FROM templates WHERE id IN ({placeholders})", template_ids).fetchall()
    if not rows:
        raise HTTPException(404, "未找到可删除的模板")
    paths: list[Path | str | None] = []
    for row in rows:
        paths.append(row["office_path"])
        paths.append(row["png_path"])
    db.execute(f"DELETE FROM templates WHERE id IN ({placeholders})", template_ids)
    db.commit()
    _delete_template_files(paths)
    return {"ok": True, "deleted": len(rows)}


@router.put("/api/admin/templates/order")
def reorder_templates(
    payload: TemplateOrderPayload,
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    if payload.subjects:
        template_ids: list[int] = []
        for subject in payload.subjects:
            for series in subject.series:
                template_ids.extend(int(template_id) for template_id in series.template_ids)
    else:
        template_ids = [int(template_id) for template_id in payload.template_ids]
    if not template_ids:
        raise HTTPException(400, "请选择需要排序的模板")
    if len(template_ids) != len(set(template_ids)):
        raise HTTPException(400, "排序列表存在重复模板")
    placeholders = ",".join("?" for _ in template_ids)
    rows = db.execute(f"SELECT id, subject, series FROM templates WHERE id IN ({placeholders})", template_ids).fetchall()
    existing = {int(row["id"]) for row in rows}
    missing = [template_id for template_id in template_ids if template_id not in existing]
    if missing:
        raise HTTPException(404, "部分模板不存在")
    now = now_iso()
    if payload.subjects:
        rows_by_id = {int(row["id"]): row for row in rows}
        for subject_index, subject in enumerate(payload.subjects, start=1):
            for series_index, series in enumerate(subject.series, start=1):
                for template_index, template_id in enumerate(series.template_ids, start=1):
                    row = rows_by_id[int(template_id)]
                    if row["subject"] != subject.subject or row["series"] != series.series:
                        raise HTTPException(400, "排序数据与当前模板分组不一致，请刷新后重试")
                    db.execute(
                        """
                        UPDATE templates
                        SET subject_order = ?, series_order = ?, sort_order = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (subject_index * 10, series_index * 10, template_index * 10, now, int(template_id)),
                    )
    else:
        for index, template_id in enumerate(template_ids, start=1):
            db.execute(
                "UPDATE templates SET sort_order = ?, updated_at = ? WHERE id = ?",
                (index * 10, now, template_id),
            )
    db.commit()
    return {"ok": True, "ordered": len(template_ids)}


@router.get("/api/templates")
def list_templates(
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=500),
    search: str = Query(""),
    subject: str = Query(""),
    series: str = Query(""),
    template_type: str = Query(""),
    platform: str = Query(""),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    uid = int(user["id"])
    # ── 可见性 SQL 条件 ──
    params: dict[str, Any] = {"vis_uid": uid}
    if is_system_admin(user):
        vis_cond = "1=1"
    else:
        vis_cond = (
            "(t.owner_id = :vis_uid"
            " OR t.visibility_scope = 'public'"
            " OR (t.visibility_scope = 'partial' AND t.id IN"
            " (SELECT template_id FROM template_visibility WHERE user_id = :vis_uid)))"
        )

    where_parts = [vis_cond]

    # 筛选
    q = search.strip()
    if q:
        where_parts.append(
            "(LOWER(COALESCE(t.name, '')) LIKE :fl_q"
            " OR LOWER(COALESCE(t.subject, '')) LIKE :fl_q"
            " OR LOWER(COALESCE(t.series, '')) LIKE :fl_q)"
        )
        params["fl_q"] = f"%{q.lower()}%"
    if subject and subject != "all":
        where_parts.append("COALESCE(t.subject, '') = :fl_subject")
        params["fl_subject"] = subject
    if series and series != "all":
        where_parts.append("COALESCE(t.series, '') = :fl_series")
        params["fl_series"] = series
    if template_type and template_type != "all":
        where_parts.append("COALESCE(t.template_type, '') = :fl_type")
        params["fl_type"] = template_type
    if platform and platform != "all":
        where_parts.append("COALESCE(t.platform, '') = :fl_platform")
        params["fl_platform"] = platform

    where_clause = " AND ".join(where_parts)
    base_sql = f"SELECT t.* FROM templates t WHERE {where_clause}"

    order_sql = """t.subject_order ASC,
            t.subject COLLATE NOCASE,
            t.series_order ASC,
            t.series COLLATE NOCASE,
            t.sort_order ASC,
            t.platform COLLATE NOCASE,
            CASE t.template_type
                WHEN 'cover' THEN 1
                WHEN 'catalog' THEN 2
                WHEN 'content' THEN 3
                ELSE 4
            END,
            t.ratio DESC,
            t.updated_at DESC,
            t.id DESC"""

    # 收集筛选项
    facet_rows = db.execute(
        f"SELECT t.subject, t.series FROM templates t WHERE {where_clause}",
        params,
    ).fetchall()
    all_subjects = sorted({fr["subject"] for fr in facet_rows if fr["subject"]})
    all_series = sorted({fr["series"] for fr in facet_rows if fr["series"]})

    # 总数
    total: int = db.execute(
        f"SELECT COUNT(*) FROM templates t WHERE {where_clause}", params,
    ).fetchone()[0]

    # 分页
    offset = (page - 1) * page_size
    page_rows = db.execute(
        f"{base_sql} ORDER BY {order_sql} LIMIT :lim OFFSET :off",
        {**params, "lim": page_size, "off": offset},
    ).fetchall()
    templates = [_serialize_template(db, row, user) for row in page_rows]
    return {
        "items": templates,
        "total": total,
        "page": page,
        "page_size": page_size,
        "all_subjects": all_subjects,
        "all_series": all_series,
    }


@router.post(
    "/api/templates/compose-download",
    response_class=Response,
    responses={
        200: {
            "content": {
                "application/vnd.openxmlformats-officedocument.presentationml.presentation": {}
            }
        }
    },
)
@_cleanup_oss_materialized
def compose_template_download(
    payload: TemplateComposePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> Response:
    template_ids = [int(template_id) for template_id in payload.template_ids]
    if len(template_ids) < 2:
        raise HTTPException(400, "组合下载至少选择 2 个模板")
    if len(template_ids) > 100:
        raise HTTPException(400, "单次最多组合 100 个模板")
    if any(template_id <= 0 for template_id in template_ids):
        raise HTTPException(400, "模板编号不正确")
    if len(template_ids) != len(set(template_ids)):
        raise HTTPException(400, "组合下载不能包含重复模板")

    placeholders = ",".join("?" for _ in template_ids)
    rows = db.execute(
        f"SELECT * FROM templates WHERE id IN ({placeholders})",
        template_ids,
    ).fetchall()
    rows_by_id = {int(row["id"]): row for row in rows}
    if len(rows_by_id) != len(template_ids):
        raise HTTPException(404, "部分模板不存在")
    ordered_rows = [rows_by_id[template_id] for template_id in template_ids]
    if any(not can_view_template(db, row, user) for row in ordered_rows):
        raise HTTPException(403, "部分模板无可见权限")

    ratios = {str(row["ratio"] or "") for row in ordered_rows}
    if len(ratios) != 1:
        raise HTTPException(400, "组合下载需选择相同比例的模板")

    input_paths: list[Path] = []
    for row in ordered_rows:
        filename = str(row["office_file_name"] or row["office_path"] or "")
        if Path(filename).suffix.lower() != ".pptx":
            raise HTTPException(400, "组合下载目前仅支持 PPTX 模板")
        path = _resource_file_abs(row["office_path"])
        if path is None or not path.exists():
            raise HTTPException(404, f"模板文件不存在：{row['name']}")
        input_paths.append(path)

    with tempfile.TemporaryDirectory(prefix="slide-flow-template-compose-") as temp_name:
        output_path = Path(temp_name) / "combined_templates.pptx"
        try:
            merge_pptx_files(input_paths, output_path)
        except (ValueError, zipfile.BadZipFile) as exc:
            raise HTTPException(400, f"模板组合失败：{exc}") from exc
        content = output_path.read_bytes()

    filename = f"标准模板组合_{len(template_ids)}页.pptx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": _content_disposition(filename)},
    )


@router.post("/api/templates")
async def create_template(
    name: str = Form(""),
    series: str = Form(...),
    subject: str = Form(...),
    platform: str = Form("wps"),
    ratio: str = Form(...),
    template_type: str = Form(...),
    visibility_scope: str = Form("public"),
    visible_user_ids: str = Form(""),
    management_scope: str = Form("private"),
    manage_user_ids: str = Form(""),
    office_file: UploadFile = File(...),
    png_file: UploadFile | None = File(None),
    user: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    series = _validate_template_series(series)
    subject = _validate_standalone_template_subject(subject)
    platform = _validate_template_platform(platform)
    ratio = _validate_template_ratio(ratio)
    template_type = _validate_standalone_template_type(template_type)
    visibility_scope = _validate_scope(visibility_scope)
    management_scope = _validate_scope(management_scope)
    _validate_office_upload(office_file)
    oss_storage.ensure_configured()
    uploaded_refs: list[str] = []
    try:
        with tempfile.TemporaryDirectory(prefix="slide-flow-template-") as temp_name:
            template_dir = Path(temp_name)
            office_path = await save_upload(office_file, template_dir, "office_", stage_oss=True)
            font_names = await asyncio.to_thread(detect_ppt_fonts, office_path)
            missing = missing_fonts(font_names, known_font_aliases(db))
            office_file_name = _template_office_file_name(series, subject, platform, ratio, template_type, Path(office_file.filename or "").suffix)
            office_path = _rename_template_file(office_path, office_file_name)
            office_ref = persist_asset(office_path, "templates/ppt")
            uploaded_refs.append(office_ref)
            png_ref = None
            if png_file is not None and png_file.filename:
                _validate_png_upload(png_file)
                png_path = _rename_template_file(
                    await save_upload(png_file, template_dir, "preview_", stage_oss=True),
                    _template_preview_file_name(series, subject, platform, ratio, template_type),
                )
                png_path = _compress_hd_image(png_path)
                png_ref = persist_asset(png_path, "templates/png")
                uploaded_refs.append(png_ref)
            template_name = _template_name(series, subject, platform, ratio, template_type)
            subject_order, series_order, sort_order = _template_group_order_values(db, subject, series)
            ts = now_iso()
            db.execute(
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
                    office_file_name, office_ref, png_ref,
                    json.dumps(font_names, ensure_ascii=False),
                    json.dumps(missing, ensure_ascii=False),
                    subject_order, series_order, sort_order,
                    visibility_scope, management_scope, user["id"], ts, ts,
                ),
            )
            template_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
            _set_template_scope_users(db, "template_visibility", template_id, _parse_id_list(visible_user_ids))
            _set_template_scope_users(db, "template_management", template_id, _parse_id_list(manage_user_ids))
            db.commit()
    except Exception:
        db.rollback()
        _delete_template_files(uploaded_refs)
        raise
    return {"template": _serialize_template(db, _template_row(db, template_id), user)}


@router.put("/api/templates/{template_id}")
async def update_template(
    template_id: int,
    name: str = Form(""),
    series: str = Form(...),
    subject: str = Form(...),
    platform: str = Form("wps"),
    ratio: str = Form(...),
    template_type: str = Form(...),
    visibility_scope: str = Form("public"),
    visible_user_ids: str = Form(""),
    management_scope: str = Form("private"),
    manage_user_ids: str = Form(""),
    office_file: UploadFile | None = File(None),
    png_file: UploadFile | None = File(None),
    user: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _template_row(db, template_id)
    series = _validate_template_series(series)
    subject = _validate_standalone_template_subject(subject)
    platform = _validate_template_platform(platform)
    ratio = _validate_template_ratio(ratio)
    template_type = _validate_standalone_template_type(template_type)
    visibility_scope = _validate_scope(visibility_scope)
    management_scope = _validate_scope(management_scope)
    oss_storage.ensure_configured()
    old_paths: list[Path | str | None] = []
    uploaded_refs: list[str] = []
    try:
        with tempfile.TemporaryDirectory(prefix=f"slide-flow-template-{template_id}-") as temp_name:
            template_dir = Path(temp_name)
            office_path = row["office_path"]
            current_suffix = Path(row["office_file_name"] or row["office_path"]).suffix
            office_name = _template_office_file_name(series, subject, platform, ratio, template_type, current_suffix)
            font_names = _json_loads(row["font_names"], [])
            missing = _json_loads(row["missing_fonts"], [])
            if office_file is not None and office_file.filename:
                _validate_office_upload(office_file)
                new_office = await save_upload(office_file, template_dir, "office_", stage_oss=True)
                font_names = detect_ppt_fonts(new_office)
                missing = missing_fonts(font_names, known_font_aliases(db))
                old_paths.append(row["office_path"])
                office_name = _template_office_file_name(series, subject, platform, ratio, template_type, Path(office_file.filename or "").suffix)
                office_path = persist_asset(_rename_template_file(new_office, office_name), "templates/ppt")
                uploaded_refs.append(office_path)
            png_path = row["png_path"]
            if png_file is not None and png_file.filename:
                _validate_png_upload(png_file)
                new_png = await save_upload(png_file, template_dir, "preview_", stage_oss=True)
                old_paths.append(row["png_path"])
                renamed_png = _rename_template_file(new_png, _template_preview_file_name(series, subject, platform, ratio, template_type))
                renamed_png = _compress_hd_image(renamed_png)
                png_path = persist_asset(renamed_png, "templates/png")
                uploaded_refs.append(png_path)
            template_name = _template_name(series, subject, platform, ratio, template_type)
            if row["subject"] != subject or row["series"] != series:
                subject_order, series_order, sort_order = _template_group_order_values(db, subject, series)
            else:
                subject_order = int(row["subject_order"])
                series_order = int(row["series_order"])
                sort_order = int(row["sort_order"])
            db.execute(
                """
                UPDATE templates
                SET name = ?, series = ?, subject = ?, platform = ?, ratio = ?, template_type = ?,
                    office_file_name = ?, office_path = ?, png_path = ?, font_names = ?, missing_fonts = ?,
                    subject_order = ?, series_order = ?, sort_order = ?,
                    visibility_scope = ?, management_scope = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    template_name, series, subject, platform, ratio, template_type,
                    office_name, office_path, png_path,
                    json.dumps(font_names, ensure_ascii=False),
                    json.dumps(missing, ensure_ascii=False),
                    subject_order, series_order, sort_order,
                    visibility_scope, management_scope, now_iso(), template_id,
                ),
            )
            _set_template_scope_users(db, "template_visibility", template_id, _parse_id_list(visible_user_ids))
            _set_template_scope_users(db, "template_management", template_id, _parse_id_list(manage_user_ids))
            db.commit()
    except Exception:
        db.rollback()
        _delete_template_files(uploaded_refs)
        raise
    _delete_template_files(old_paths)
    return {"template": _serialize_template(db, _template_row(db, template_id), user)}


@router.get("/api/templates/{template_id}/preview")
def template_preview(
    template_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> FileResponse:
    row = _template_row(db, template_id)
    if not can_view_template(db, row, user):
        raise HTTPException(403, "无可见权限")
    if is_oss_ref(row["png_path"]):
        url = asset_preview_url(row["png_path"])
        if not url:
            raise HTTPException(503, "OSS 预览地址生成失败")
        return RedirectResponse(url, status_code=307)  # type: ignore[return-value]
    path = _resource_file_abs(row["png_path"])
    if path is None or not path.exists():
        raise HTTPException(404, "预览图不存在")
    return FileResponse(path)


@router.get("/api/templates/{template_id}/preview-thumb")
def template_preview_thumb(
    template_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> FileResponse:
    row = _template_row(db, template_id)
    if not can_view_template(db, row, user):
        raise HTTPException(403, "无可见权限")
    if is_oss_ref(row["png_path"]):
        url = asset_preview_url(row["png_path"], thumb=True)
        if not url:
            raise HTTPException(503, "OSS 小图地址生成失败")
        return RedirectResponse(url, status_code=307)  # type: ignore[return-value]
    path = _resource_file_abs(row["png_path"])
    if path is None or not path.exists():
        raise HTTPException(404, "预览图不存在")
    try:
        thumb = _ensure_preview_thumb(path, 900000000 + int(template_id))
    except Exception:
        return FileResponse(path, headers={"Cache-Control": "private, max-age=3600"})
    return FileResponse(thumb, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@router.get("/api/templates/{template_id}/download")
@_cleanup_oss_materialized
def download_template(
    template_id: int,
    with_fonts: bool = Query(False),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
):
    row = _template_row(db, template_id)
    if not can_view_template(db, row, user):
        raise HTTPException(403, "无可见权限")
    if is_oss_ref(row["office_path"]) and not with_fonts:
        return RedirectResponse(
            oss_storage.signed_url(row["office_path"], filename=row["office_file_name"], download=True),
            status_code=307,
        )
    path = _resource_file_abs(row["office_path"])
    if path is None or not path.exists():
        raise HTTPException(404, "模板文件不存在")
    filename = row["office_file_name"] or path.name
    if not with_fonts:
        return FileResponse(path, headers={"Content-Disposition": _content_disposition(filename)})

    font_names = _json_loads(row["font_names"], [])
    fonts, _ = _build_fonts_bundle(db, font_names)
    missing = _json_loads(row["missing_fonts"], [])
    filename_base = Path(filename).stem
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as package:
        package.write(path, arcname=filename)
        _write_fonts_into_zip(package, fonts, missing)
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(f"{filename_base}_with_fonts.zip")},
    )
