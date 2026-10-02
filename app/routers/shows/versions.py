"""Routers / shows / versions."""

from __future__ import annotations

from app.core.permissions import can_manage_show
from app.core.permissions import can_view_show
from app.core.permissions import can_view_resource
from app.core.permissions import require_user
from app.core.sanitize import sanitize_html
from app.db import now_iso
from app.routers.dependencies import (
    db_dep,
    db_read_dep,
)
from app.services.files import asset_preview_url
from app.schemas.shows import (
    ShowIteratePayload,
    ShowIterateUpgradePayload,
    ShowUpgradePayload,
)
from app.services.shows import (
    _serialize_show,
    _set_show_scope_tags,
    _set_show_scope_users,
    _show_scope_tag_names,
    _show_row,
    _show_scope_user_ids,
)
from app.services.tagging import entity_tag_names, set_entity_tags
from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from typing import Any
import sqlite3

router = APIRouter()


@router.post("/api/shows/{show_id}/iterate")
def iterate_show(
    show_id: int,
    payload: ShowIteratePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    # Serialize version allocation across workers before reading MAX(version_no).
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    row = _show_row(db, show_id)
    if not can_manage_show(db, row, user):
        raise HTTPException(403, "无管理权限")
    existing_ids = {int(item[0]) for item in db.execute(
        "SELECT resource_id FROM show_resources WHERE show_id = ?", (show_id,),
    )}
    if payload.resource_ids is None or set(payload.resource_ids) == existing_ids:
        raise HTTPException(400, "页面内容未变化；调整顺序请使用保存播放顺序")
    for resource_id in set(payload.resource_ids) - existing_ids:
        resource = db.execute("SELECT * FROM resources WHERE id = ? AND deleted_at IS NULL", (resource_id,)).fetchone()
        if resource is None or not can_view_resource(db, resource, user):
            raise HTTPException(403, "部分新增素材不可访问，请重新选择")
    series_id = row["series_id"]
    max_ver_row = db.execute("SELECT MAX(version_no) FROM shows WHERE series_id = ?", (series_id,)).fetchone()
    max_version = int(max_ver_row[0]) if max_ver_row[0] is not None else 0
    new_version_no = max_version + 1
    new_name = payload.name if payload.name is not None else row["name"]
    ts = now_iso()
    db.execute(
        """
        INSERT INTO shows (name, owner_id, subject, tags, status, visibility_scope, management_scope, is_standard, series_id, version_no, change_note, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (new_name, user["id"], row["subject"], row["tags"], row["status"], row["visibility_scope"], row["management_scope"], row["is_standard"], series_id, new_version_no, payload.change_note, user["id"], ts, ts),
    )
    new_show_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    set_entity_tags(
        db,
        relation_table="show_tags",
        entity_column="show_id",
        entity_id=new_show_id,
        names=entity_tag_names(
            db,
            relation_table="show_tags",
            entity_column="show_id",
            entity_id=int(show_id),
            fallback=row["tags"] or "",
        ),
        cache_table="shows",
        created_by=int(user["id"]),
    )
    # 复制权限记录
    visible_ids = _show_scope_user_ids(db, "show_visibility", show_id)
    manage_ids = _show_scope_user_ids(db, "show_management", show_id)
    manage_tags = _show_scope_tag_names(db, show_id, "show_management_tags")
    _set_show_scope_users(db, "show_visibility", new_show_id, visible_ids)
    _set_show_scope_tags(db, new_show_id, _show_scope_tag_names(db, show_id))
    _set_show_scope_users(db, "show_management", new_show_id, manage_ids)
    _set_show_scope_tags(db, new_show_id, manage_tags, "show_management_tags")
    # 保留已有页面的版本、隐藏状态与讲演备注；新增页面使用当前版本。
    existing_rows = db.execute(
        "SELECT resource_id, version_no, is_hidden FROM show_resources WHERE show_id = ?",
        (show_id,),
    ).fetchall()
    existing = {int(sr["resource_id"]): sr for sr in existing_rows}
    for index, rid in enumerate(payload.resource_ids):
        previous = existing.get(rid)
        version_no = int(previous["version_no"]) if previous else int(db.execute(
            "SELECT current_version FROM resources WHERE id = ?", (rid,),
        ).fetchone()[0])
        db.execute(
            "INSERT INTO show_resources (show_id, resource_id, version_no, sort_order, is_hidden) VALUES (?, ?, ?, ?, ?)",
            (new_show_id, rid, version_no, index, int(previous["is_hidden"]) if previous else 0),
        )
    db.execute(
        """INSERT INTO show_remarks (show_id, resource_id, user_id, content_html, updated_at)
        SELECT ?, rm.resource_id, rm.user_id, rm.content_html, rm.updated_at
        FROM show_remarks rm JOIN show_resources sr ON sr.show_id = ? AND sr.resource_id = rm.resource_id
        WHERE rm.show_id = ?""",
        (new_show_id, new_show_id, show_id),
    )
    db.commit()
    return {"show": _serialize_show(db, _show_row(db, new_show_id), user)}


@router.get("/api/shows/{show_id}/versions")
def show_versions(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    series_id = row["series_id"]
    version_rows = db.execute(
        "SELECT * FROM shows WHERE series_id = ? ORDER BY version_no DESC",
        (series_id,),
    ).fetchall()
    versions = []
    for vrow in version_rows:
        if not can_view_show(db, vrow, user):
            continue
        owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (vrow["owner_id"],)).fetchone()
        resource_count = db.execute(
            "SELECT COUNT(*) FROM show_resources WHERE show_id = ?", (vrow["id"],)
        ).fetchone()[0]
        versions.append({
            "id": vrow["id"],
            "version_no": vrow["version_no"],
            "name": vrow["name"],
            "change_note": vrow["change_note"],
            "resource_count": resource_count,
            "created_at": vrow["created_at"],
            "owner": {"id": owner["id"], "username": owner["username"], "name": owner["name"]} if owner else None,
        })
    return {"versions": versions, "current_version_no": row["version_no"]}


@router.get("/api/shows/{show_id}/check-updates")
def check_show_updates(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    updates = []
    sr_rows = db.execute(
        """
        SELECT r.*, sr.resource_id, sr.version_no,
               latest.id AS latest_id, latest.png_path AS latest_png,
               latest.common_remark_html AS latest_remark,
               current.id AS current_id, current.png_path AS current_png,
               current.common_remark_html AS current_remark
        FROM show_resources sr
        JOIN resources r ON r.id = sr.resource_id
        LEFT JOIN resource_versions latest ON latest.resource_id = r.id AND latest.version_no = r.current_version
        LEFT JOIN resource_versions current ON current.resource_id = r.id AND current.version_no = sr.version_no
        WHERE sr.show_id = ? AND r.deleted_at IS NULL AND latest.deleted_at IS NULL AND r.current_version > sr.version_no
        ORDER BY sr.sort_order
        """,
        (show_id,),
    ).fetchall()
    for sr in sr_rows:
        if not can_view_resource(db, sr, user):
            continue
        current = int(sr["version_no"])
        latest = int(sr["current_version"])
        if latest > current:
            preview_url = None
            if sr["latest_png"]:
                preview_url = asset_preview_url(sr["latest_png"], thumb=True) or f"/api/resources/{sr['resource_id']}/preview-thumb?version_id={sr['latest_id']}"
            current_preview_url = None
            if sr["current_png"]:
                current_preview_url = asset_preview_url(sr["current_png"], thumb=True) or f"/api/resources/{sr['resource_id']}/preview-thumb?version_id={sr['current_id']}"
            latest_remark = sr["latest_remark"]
            current_remark = sr["current_remark"]
            has_remark_change = (latest_remark or None) != (current_remark or None)
            updates.append({
                "resource_id": sr["resource_id"],
                "current_version_no": current,
                "latest_version_no": latest,
                "name": sr["name"],
                "preview_url": preview_url,
                "has_remark_change": has_remark_change,
                "version_gap": latest - current,
                "current_preview_url": current_preview_url,
            })
    return {"updates": updates}


@router.post("/api/shows/{show_id}/upgrade")
def upgrade_show_resources(
    show_id: int,
    payload: ShowUpgradePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    row = _show_row(db, show_id)
    if not can_manage_show(db, row, user):
        raise HTTPException(403, "无管理权限")
    target_ids = set(payload.resource_ids)
    sr_rows = db.execute(
        "SELECT r.*, sr.resource_id, sr.version_no FROM show_resources sr "
        "JOIN resources r ON r.id = sr.resource_id WHERE sr.show_id = ?",
        (show_id,),
    ).fetchall()
    if target_ids - {int(sr["resource_id"]) for sr in sr_rows}:
        raise HTTPException(400, "升级列表包含不属于当前放映的资源，请刷新后重试")
    selected = [sr for sr in sr_rows if not target_ids or int(sr["resource_id"]) in target_ids]
    if target_ids and any(not can_view_resource(db, sr, user) for sr in selected):
        raise HTTPException(403, "部分升级素材不可访问，请重新选择")
    if target_ids and any(sr["deleted_at"] for sr in selected):
        raise HTTPException(400, "素材已从库中移除，只能保留原页面")
    upgraded = []
    for sr in selected:
        if sr["deleted_at"]:
            continue
        if not can_view_resource(db, sr, user):
            continue
        rid = int(sr["resource_id"])
        latest = int(sr["current_version"])
        current = int(sr["version_no"])
        if latest > current:
            db.execute(
                "UPDATE show_resources SET version_no = ? WHERE show_id = ? AND resource_id = ?",
                (latest, show_id, rid),
            )
            upgraded.append({
                "resource_id": rid,
                "name": sr["name"],
                "old_version_no": current,
                "new_version_no": latest,
            })
    if upgraded:
        db.execute("UPDATE shows SET updated_by = ?, updated_at = ? WHERE id = ?", (user["id"], now_iso(), show_id))
    db.commit()
    return {"upgraded": upgraded}


@router.post("/api/shows/{show_id}/iterate-upgrade")
def iterate_upgrade_show(
    show_id: int,
    payload: ShowIterateUpgradePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """迭代式升级：创建新版本 + 升级选中资源 + 迁移备注"""
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    row = _show_row(db, show_id)
    if not can_manage_show(db, row, user):
        raise HTTPException(403, "无管理权限")
    resource_rows = db.execute(
        "SELECT r.*, sr.resource_id, sr.version_no, sr.sort_order, sr.is_hidden FROM show_resources sr "
        "JOIN resources r ON r.id = sr.resource_id WHERE sr.show_id = ? ORDER BY sr.sort_order",
        (show_id,),
    ).fetchall()
    existing_resource_ids = {int(sr["resource_id"]) for sr in resource_rows}
    requested_resource_ids = set(payload.resource_ids)
    if requested_resource_ids - existing_resource_ids:
        raise HTTPException(400, "升级列表包含不属于当前放映的资源，请刷新后重试")
    try:
        remark_resource_ids = {int(resource_id) for resource_id in payload.remarks}
    except (TypeError, ValueError):
        raise HTTPException(400, "放映备注对应的资源无效") from None
    if not remark_resource_ids.issubset(requested_resource_ids):
        raise HTTPException(400, "请仅修改本次升级素材的放映备注")
    if any(r["deleted_at"] for r in resource_rows if int(r["resource_id"]) in requested_resource_ids):
        raise HTTPException(400, "素材已从库中移除，只能保留原页面")
    for resource in resource_rows:
        if int(resource["resource_id"]) in requested_resource_ids and not can_view_resource(db, resource, user):
            raise HTTPException(403, "部分升级素材不可访问，请重新选择")
    if not any(int(sr["current_version"]) > int(sr["version_no"]) for sr in resource_rows if int(sr["resource_id"]) in requested_resource_ids):
        raise HTTPException(400, "所选素材已是最新版本，无需创建新版本")
    # 1. 创建新 show 版本
    series_id = row["series_id"]
    max_ver_row = db.execute("SELECT MAX(version_no) FROM shows WHERE series_id = ?", (series_id,)).fetchone()
    max_version = int(max_ver_row[0]) if max_ver_row[0] is not None else 0
    new_version_no = max_version + 1
    ts = now_iso()
    db.execute(
        """
        INSERT INTO shows (name, owner_id, subject, tags, status, visibility_scope, management_scope, is_standard, series_id, version_no, change_note, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (payload.name if payload.name is not None else row["name"], user["id"], row["subject"], row["tags"], row["status"], row["visibility_scope"], row["management_scope"], row["is_standard"], series_id, new_version_no, payload.change_note, user["id"], ts, ts),
    )
    new_show_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    set_entity_tags(
        db,
        relation_table="show_tags",
        entity_column="show_id",
        entity_id=new_show_id,
        names=entity_tag_names(
            db,
            relation_table="show_tags",
            entity_column="show_id",
            entity_id=int(show_id),
            fallback=row["tags"] or "",
        ),
        cache_table="shows",
        created_by=int(user["id"]),
    )
    # 2. 复制权限记录
    visible_ids = _show_scope_user_ids(db, "show_visibility", show_id)
    manage_ids = _show_scope_user_ids(db, "show_management", show_id)
    manage_tags = _show_scope_tag_names(db, show_id, "show_management_tags")
    _set_show_scope_users(db, "show_visibility", new_show_id, visible_ids)
    _set_show_scope_tags(db, new_show_id, _show_scope_tag_names(db, show_id))
    _set_show_scope_users(db, "show_management", new_show_id, manage_ids)
    _set_show_scope_tags(db, new_show_id, manage_tags, "show_management_tags")
    # 3. 复制 show_resources 并升级选中资源
    upgrade_target_ids = set(payload.resource_ids)
    upgraded = []
    for sr in resource_rows:
        rid = int(sr["resource_id"])
        old_vno = int(sr["version_no"])
        new_vno = old_vno
        if rid in upgrade_target_ids and int(sr["current_version"]) > old_vno:
            new_vno = int(sr["current_version"])
            upgraded.append({
                "resource_id": rid,
                "name": sr["name"],
                "old_version_no": old_vno,
                "new_version_no": new_vno,
            })
        db.execute(
            "INSERT OR IGNORE INTO show_resources (show_id, resource_id, version_no, sort_order, is_hidden) VALUES (?, ?, ?, ?, ?)",
            (new_show_id, rid, new_vno, sr["sort_order"], sr["is_hidden"]),
        )
    # 4. 迁移 show_remarks
    old_remarks = db.execute(
        "SELECT resource_id, user_id, content_html, updated_at FROM show_remarks WHERE show_id = ?",
        (show_id,),
    ).fetchall()
    for rm in old_remarks:
        db.execute(
            """INSERT INTO show_remarks (show_id, resource_id, user_id, content_html, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(show_id, resource_id, user_id) DO UPDATE SET content_html = excluded.content_html, updated_at = excluded.updated_at""",
            (new_show_id, rm["resource_id"], rm["user_id"], sanitize_html(rm["content_html"]), rm["updated_at"]),
        )
    # 覆盖当前用户指定资源的备注
    for res_id_str, remark_html in payload.remarks.items():
        res_id = int(res_id_str)
        db.execute(
            """INSERT INTO show_remarks (show_id, resource_id, user_id, content_html, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(show_id, resource_id, user_id) DO UPDATE SET content_html = excluded.content_html, updated_at = excluded.updated_at""",
            (new_show_id, res_id, user["id"], sanitize_html(remark_html), ts),
        )
    # 5. 提交并返回
    db.commit()
    new_row = _show_row(db, new_show_id)
    return {"show": _serialize_show(db, new_row, user), "upgraded": upgraded}


@router.get("/api/shows/{show_id}/resource-diff/{resource_id}")
def get_resource_diff(
    show_id: int,
    resource_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    # 获取 show_resources 中当前版本
    sr = db.execute(
        "SELECT version_no FROM show_resources WHERE show_id = ? AND resource_id = ?",
        (show_id, resource_id),
    ).fetchone()
    if sr is None:
        raise HTTPException(404, "放映中不存在该资源")
    current_version_no = int(sr["version_no"])
    # 获取资源信息
    resource = db.execute(
        "SELECT * FROM resources WHERE id = ?",
        (resource_id,),
    ).fetchone()
    if resource is None or not can_view_resource(db, resource, user):
        raise HTTPException(404, "资源不存在或无权查看")
    latest_version_no = int(resource["current_version"])
    # 获取当前版本和最新版本的 version id
    current_ver = db.execute(
        "SELECT id, png_path, common_remark_html FROM resource_versions WHERE resource_id = ? AND version_no = ?",
        (resource_id, current_version_no),
    ).fetchone()
    latest_ver = db.execute(
        "SELECT id, png_path, common_remark_html FROM resource_versions WHERE resource_id = ? AND version_no = ?",
        (resource_id, latest_version_no),
    ).fetchone()
    current_version_id = current_ver["id"] if current_ver else None
    latest_version_id = latest_ver["id"] if latest_ver else None
    # 构造预览 URL
    current_preview_url = asset_preview_url(current_ver["png_path"], thumb=True) if current_ver and current_ver["png_path"] else (f"/api/resources/{resource_id}/preview-thumb?version_id={current_version_id}" if current_version_id else None)
    latest_preview_url = asset_preview_url(latest_ver["png_path"], thumb=True) if latest_ver and latest_ver["png_path"] else (f"/api/resources/{resource_id}/preview-thumb?version_id={latest_version_id}" if latest_version_id else None)
    current_original_preview_url = asset_preview_url(current_ver["png_path"]) if current_ver and current_ver["png_path"] else (f"/api/resources/{resource_id}/preview?version_id={current_version_id}" if current_version_id else None)
    latest_original_preview_url = asset_preview_url(latest_ver["png_path"]) if latest_ver and latest_ver["png_path"] else (f"/api/resources/{resource_id}/preview?version_id={latest_version_id}" if latest_version_id else None)
    # 查询当前版本和最新版本之间的所有版本记录（不含当前版本，含最新版本）
    versions_between_rows = db.execute(
        "SELECT version_no, change_note, created_at FROM resource_versions WHERE resource_id = ? AND version_no > ? AND version_no <= ? ORDER BY version_no ASC",
        (resource_id, current_version_no, latest_version_no),
    ).fetchall()
    versions_between = [
        {
            "version_no": int(v["version_no"]),
            "change_note": v["change_note"],
            "created_at": v["created_at"],
        }
        for v in versions_between_rows
    ]
    # common_remark 对比
    common_remark_diff = {
        "current_html": sanitize_html(current_ver["common_remark_html"]) if current_ver else "",
        "latest_html": sanitize_html(latest_ver["common_remark_html"]) if latest_ver else "",
    }
    # 获取当前用户的放映备注
    remark_row = db.execute(
        "SELECT content_html FROM show_remarks WHERE show_id = ? AND resource_id = ? AND user_id = ?",
        (show_id, resource_id, user["id"]),
    ).fetchone()
    show_remark_html = sanitize_html(remark_row["content_html"]) if remark_row else ""
    return {
        "resource_id": resource_id,
        "resource_name": resource["name"],
        "current_version_no": current_version_no,
        "latest_version_no": latest_version_no,
        "current_preview_url": current_preview_url,
        "latest_preview_url": latest_preview_url,
        "current_original_preview_url": current_original_preview_url,
        "latest_original_preview_url": latest_original_preview_url,
        "versions_between": versions_between,
        "common_remark_diff": common_remark_diff,
        "show_remark_html": show_remark_html,
    }
