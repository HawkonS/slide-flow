"""Services / shows."""

from __future__ import annotations

from app.core.permissions import can_manage_show
from app.core.permissions import can_view_resource
from app.services.common import (
    _json_loads,
    _row_to_dict,
)
from app.services.downloads.fonts import (
    _font_alias_map,
)
from app.services.files import asset_preview_url
from fastapi import HTTPException
from typing import Any
import sqlite3


def _is_show_pinned(db: sqlite3.Connection, show_id: int, user_id: int) -> bool:
    return db.execute(
        "SELECT 1 FROM user_pinned_shows WHERE user_id = ? AND show_id = ?",
        (user_id, show_id),
    ).fetchone() is not None


def _show_scope_user_ids(db: sqlite3.Connection, table: str, show_id: int) -> list[int]:
    rows = db.execute(f"SELECT user_id FROM {table} WHERE show_id = ? ORDER BY user_id", (show_id,)).fetchall()
    return [int(row["user_id"]) for row in rows]


def _set_show_scope_users(db: sqlite3.Connection, table: str, show_id: int, user_ids: list[int]) -> None:
    db.execute(f"DELETE FROM {table} WHERE show_id = ?", (show_id,))
    for uid in sorted(set(user_ids)):
        db.execute(f"INSERT OR IGNORE INTO {table} (show_id, user_id) VALUES (?, ?)", (show_id, uid))


def _show_row(db: sqlite3.Connection, show_id: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM shows WHERE id = ?", (show_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "放映不存在")
    return row


def _serialize_show_resource(db: sqlite3.Connection, resource_id: int, version_no: int, user: sqlite3.Row, is_hidden: int = 0) -> dict[str, Any] | None:
    resource = db.execute("SELECT * FROM resources WHERE id = ?", (resource_id,)).fetchone()
    if resource is None:
        return None
    if can_view_resource(db, resource, user):
        latest_version_no = int(resource["current_version"])
        version_row = db.execute(
            "SELECT id, png_path FROM resource_versions WHERE resource_id = ? AND version_no = ?",
            (resource_id, version_no),
        ).fetchone()
        version_id = version_row["id"] if version_row else None
        png_path = version_row["png_path"] if version_row else None
        return {
            "id": resource_id,
            "accessible": True,
            "name": resource["name"],
            "secrecy_level": resource["secrecy_level"],
            "version_no": version_no,
            "latest_version_no": latest_version_no,
            "preview_url": asset_preview_url(png_path, thumb=True) or (f"/api/resources/{resource_id}/preview-thumb?version_id={version_id}" if png_path else None),
            "original_preview_url": asset_preview_url(png_path) or (f"/api/resources/{resource_id}/preview?version_id={version_id}" if png_path else None),
            "hidden": bool(is_hidden),
        }
    else:
        owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (resource["owner_id"],)).fetchone()
        managers: list[dict[str, Any]] = []
        if owner:
            managers.append({"id": owner["id"], "name": owner["name"], "username": owner["username"]})
        manage_rows = db.execute(
            "SELECT u.id, u.name, u.username FROM resource_management rm JOIN users u ON u.id = rm.user_id WHERE rm.resource_id = ?",
            (resource_id,),
        ).fetchall()
        for mrow in manage_rows:
            mid = int(mrow["id"])
            if not any(m["id"] == mid for m in managers):
                managers.append({"id": mid, "name": mrow["name"], "username": mrow["username"]})
        return {
            "id": resource_id,
            "accessible": False,
            "name": f"资源 #{resource_id}",
            "secrecy_level": resource["secrecy_level"],
            "managers": managers,
            "hidden": bool(is_hidden),
        }


def _show_series_stats(db: sqlite3.Connection, series_id: str) -> tuple[int, int]:
    """返回放映系列的 (版本总数, 最新版本号)。"""
    stats = db.execute(
        "SELECT COUNT(*) AS cnt, MAX(COALESCE(version_no, 0)) AS max_ver"
        " FROM shows WHERE series_id = ?",
        (series_id,),
    ).fetchone()
    return int(stats[0]), int(stats[1] or 0)


def _serialize_show(db: sqlite3.Connection, row: sqlite3.Row, user: sqlite3.Row) -> dict[str, Any]:
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    visible_user_ids = _show_scope_user_ids(db, "show_visibility", int(row["id"]))
    manage_user_ids = _show_scope_user_ids(db, "show_management", int(row["id"]))
    sr_rows = db.execute(
        "SELECT resource_id, version_no, is_hidden FROM show_resources WHERE show_id = ? ORDER BY sort_order",
        (row["id"],),
    ).fetchall()
    resources = []
    for sr in sr_rows:
        sres = _serialize_show_resource(db, int(sr["resource_id"]), int(sr["version_no"]), user, int(sr["is_hidden"]))
        if sres is not None:
            resources.append(sres)
    updated_by_user = None
    if row["updated_by"]:
        updated_by_user = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["updated_by"],)).fetchone()
    version_count, latest_version_no = _show_series_stats(db, row["series_id"])
    return {
        "id": row["id"],
        "name": row["name"],
        "owner_id": row["owner_id"],
        "owner": _row_to_dict(owner) if owner else None,
        "updated_by": _row_to_dict(updated_by_user) if updated_by_user else None,
        "subject": row["subject"],
        "tags": row["tags"],
        "status": row["status"],
        "visibility_scope": row["visibility_scope"],
        "management_scope": row["management_scope"],
        "secrecy_level": row["secrecy_level"],
        "is_standard": bool(row["is_standard"]),
        "series_id": row["series_id"],
        "version_no": row["version_no"],
        "change_note": row["change_note"],
        "version_count": version_count,
        "latest_version_no": latest_version_no,
        "has_other_versions": version_count > 1,
        "can_manage": can_manage_show(db, row, user),
        "visible_user_ids": visible_user_ids,
        "manage_user_ids": manage_user_ids,
        "resources": resources,
        "is_pinned": _is_show_pinned(db, int(row["id"]), int(user["id"])),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _serialize_show_lite(db: sqlite3.Connection, row: sqlite3.Row, user: sqlite3.Row) -> dict[str, Any]:
    """轻量级放映序列化：仅返回列表展示所需字段，资源只取前2个预览；同时附带完整 resource_id 列表用于前端判断资源是否已存在"""
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    sr_rows = db.execute(
        "SELECT resource_id, version_no FROM show_resources WHERE show_id = ? ORDER BY sort_order LIMIT 2",
        (row["id"],),
    ).fetchall()
    resources = []
    for sr in sr_rows:
        sres = _serialize_show_resource(db, int(sr["resource_id"]), int(sr["version_no"]), user)
        if sres is not None:
            resources.append(sres)
    all_ids_rows = db.execute(
        "SELECT resource_id FROM show_resources WHERE show_id = ? ORDER BY sort_order",
        (row["id"],),
    ).fetchall()
    all_resource_ids = [int(r["resource_id"]) for r in all_ids_rows]
    version_count, latest_version_no = _show_series_stats(db, row["series_id"])
    return {
        "id": row["id"],
        "name": row["name"],
        "owner_id": row["owner_id"],
        "owner": _row_to_dict(owner) if owner else None,
        "subject": row["subject"],
        "tags": row["tags"],
        "status": row["status"],
        "secrecy_level": row["secrecy_level"],
        "is_standard": bool(row["is_standard"]),
        "series_id": row["series_id"],
        "version_no": row["version_no"],
        "version_count": version_count,
        "latest_version_no": latest_version_no,
        "has_other_versions": version_count > 1,
        "can_manage": can_manage_show(db, row, user),
        "resources": resources,
        "all_resource_ids": all_resource_ids,
        "is_pinned": _is_show_pinned(db, int(row["id"]), int(user["id"])),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _collect_show_accessible_resources(
    db: sqlite3.Connection, show_id: int, user: sqlite3.Row
) -> list[dict[str, Any]]:
    """按当前用户权限，返回放映下可见资源的当前版本信息（按 sort_order）。"""
    sr_rows = db.execute(
        """
        SELECT sr.resource_id, sr.version_no, sr.is_hidden, r.name
        FROM show_resources sr
        JOIN resources r ON r.id = sr.resource_id
        WHERE sr.show_id = ?
        ORDER BY sr.sort_order
        """,
        (show_id,),
    ).fetchall()
    items: list[dict[str, Any]] = []
    for sr in sr_rows:
        resource = db.execute(
            "SELECT * FROM resources WHERE id = ?", (sr["resource_id"],)
        ).fetchone()
        if resource is None or not can_view_resource(db, resource, user):
            continue
        version_row = db.execute(
            "SELECT ppt_path, font_names, missing_fonts FROM resource_versions"
            " WHERE resource_id = ? AND version_no = ?",
            (sr["resource_id"], sr["version_no"]),
        ).fetchone()
        if not version_row:
            continue
        items.append(
            {
                "resource_id": sr["resource_id"],
                "name": sr["name"],
                "version_no": sr["version_no"],
                "ppt_path": version_row["ppt_path"],
                "font_names": _json_loads(version_row["font_names"], []),
                "missing_fonts": _json_loads(version_row["missing_fonts"], []),
                "is_hidden": bool(sr["is_hidden"]),
            }
        )
    return items


def _aggregate_show_fonts(
    db: sqlite3.Connection, items: list[dict[str, Any]]
) -> dict[str, Any]:
    """聚合多个资源版本的字体名/别名/缺失清单。"""
    names: list[str] = []
    seen_names: set[str] = set()
    missing: list[str] = []
    seen_missing: set[str] = set()
    for item in items:
        for name in item["font_names"]:
            cleaned = (name or "").strip()
            if not cleaned:
                continue
            key = cleaned.lower()
            if key not in seen_names:
                names.append(cleaned)
                seen_names.add(key)
        for name in item["missing_fonts"]:
            cleaned = (name or "").strip()
            if not cleaned:
                continue
            key = cleaned.lower()
            if key not in seen_missing:
                missing.append(cleaned)
                seen_missing.add(key)
    return {
        "font_names": names,
        "font_aliases": _font_alias_map(names, db),
        "missing_fonts": missing,
    }
