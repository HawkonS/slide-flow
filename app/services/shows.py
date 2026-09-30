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
from app.services.resources import _normalise_scope_tags, _normalise_scope_user_ids
from app.services.tagging import entity_tag_names, tag_relation_join, table_has_column
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
    ids = _normalise_scope_user_ids(db, user_ids)
    db.execute(f"DELETE FROM {table} WHERE show_id = ?", (show_id,))
    for uid in ids:
        db.execute(f"INSERT OR IGNORE INTO {table} (show_id, user_id) VALUES (?, ?)", (show_id, uid))


def _set_show_scope_tags(
    db: sqlite3.Connection,
    show_id: int,
    tag_names: list[str],
    table: str = "show_visibility_tags",
) -> None:
    tags = _normalise_scope_tags(db, tag_names)
    db.execute(f"DELETE FROM {table} WHERE show_id = ?", (show_id,))
    definitions = {
        str(row["name"]): int(row["id"])
        for row in db.execute(
            f"SELECT id, name FROM user_tag_definitions WHERE name IN ({','.join('?' for _ in tags)})",
            tags,
        ).fetchall()
    } if tags else {}
    for tag_name in tags:
        db.execute(
            f"INSERT OR IGNORE INTO {table} (show_id, tag_name, tag_id) VALUES (?, ?, ?)",
            (show_id, tag_name, definitions.get(tag_name)),
        )


def _show_scope_tag_names(
    db: sqlite3.Connection,
    show_id: int,
    table: str = "show_visibility_tags",
) -> list[str]:
    if table_has_column(db, table, "tag_id"):
        rows = db.execute(
            f"""
            SELECT COALESCE(t.name, scope.tag_name) AS tag_name
            FROM {table} scope
            LEFT JOIN user_tag_definitions t ON t.id = scope.tag_id
            WHERE scope.show_id = ?
            ORDER BY tag_name
            """,
            (show_id,),
        ).fetchall()
    else:
        rows = db.execute(
            f"SELECT tag_name FROM {table} WHERE show_id = ? ORDER BY tag_name",
            (show_id,),
        ).fetchall()
    return [str(row["tag_name"]) for row in rows]


def _show_row(db: sqlite3.Connection, show_id: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM shows WHERE id = ?", (show_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "放映不存在")
    return row


def _serialize_show_resource(db: sqlite3.Connection, resource_id: int, version_no: int, user: sqlite3.Row, is_hidden: int = 0, *, resource: sqlite3.Row | None = None) -> dict[str, Any] | None:
    if resource is None:
        resource = db.execute(
            "SELECT r.*, v.id AS preview_version_id, v.png_path AS preview_png FROM resources r "
            "LEFT JOIN resource_versions v ON v.resource_id = r.id AND v.version_no = ? WHERE r.id = ?",
            (version_no, resource_id),
        ).fetchone()
    if resource is None:
        return None
    if can_view_resource(db, resource, user):
        latest_version_no = int(resource["current_version"])
        version_id = resource["preview_version_id"]
        png_path = resource["preview_png"]
        return {
            "id": resource_id,
            "accessible": True,
            "name": resource["name"],
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
        manage_tag_join = tag_relation_join(db, "resource_management_tags", "rmt")
        manage_rows = db.execute(
            f"""
            SELECT DISTINCT u.id, u.name, u.username
            FROM users u
            WHERE u.id IN (
                SELECT rm.user_id
                FROM resource_management rm
                WHERE rm.resource_id = ?
                UNION
                SELECT ut.user_id
                FROM resource_management_tags rmt
                JOIN user_tags ut ON {manage_tag_join}
                WHERE rmt.resource_id = ?
            )
            ORDER BY u.name COLLATE NOCASE, u.id
            """,
            (resource_id, resource_id),
        ).fetchall()
        for mrow in manage_rows:
            mid = int(mrow["id"])
            if not any(m["id"] == mid for m in managers):
                managers.append({"id": mid, "name": mrow["name"], "username": mrow["username"]})
        return {
            "id": resource_id,
            "accessible": False,
            "name": f"资源 #{resource_id}",
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
        "SELECT r.*, sr.resource_id, sr.version_no, sr.is_hidden, v.id AS preview_version_id, v.png_path AS preview_png "
        "FROM show_resources sr JOIN resources r ON r.id = sr.resource_id "
        "LEFT JOIN resource_versions v ON v.resource_id = r.id AND v.version_no = sr.version_no "
        "WHERE sr.show_id = ? ORDER BY sr.sort_order",
        (row["id"],),
    ).fetchall()
    resources = []
    for sr in sr_rows:
        sres = _serialize_show_resource(db, int(sr["resource_id"]), int(sr["version_no"]), user, int(sr["is_hidden"]), resource=sr)
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
        "tags": ",".join(
            entity_tag_names(
                db,
                relation_table="show_tags",
                entity_column="show_id",
                entity_id=int(row["id"]),
                fallback=row["tags"] or "",
            )
        ),
        "status": row["status"],
        "visibility_scope": row["visibility_scope"],
        "management_scope": row["management_scope"],
        "is_standard": bool(row["is_standard"]),
        "series_id": row["series_id"],
        "version_no": row["version_no"],
        "change_note": row["change_note"],
        "version_count": version_count,
        "latest_version_no": latest_version_no,
        "has_other_versions": version_count > 1,
        "can_manage": can_manage_show(db, row, user),
        "visible_user_ids": visible_user_ids,
        "visible_user_tags": _show_scope_tag_names(db, int(row["id"])) if can_manage_show(db, row, user) else [],
        "manage_user_ids": manage_user_ids,
        "manage_user_tags": _show_scope_tag_names(db, int(row["id"]), "show_management_tags") if can_manage_show(db, row, user) else [],
        "resources": resources,
        "is_pinned": _is_show_pinned(db, int(row["id"]), int(user["id"])),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _serialize_show_lite(db: sqlite3.Connection, row: sqlite3.Row, user: sqlite3.Row) -> dict[str, Any]:
    """轻量级放映序列化：仅返回列表展示所需字段，资源只取前2个预览；同时附带完整 resource_id 列表用于前端判断资源是否已存在"""
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    sr_rows = db.execute(
        "SELECT r.*, sr.resource_id, sr.version_no, sr.is_hidden, v.id AS preview_version_id, v.png_path AS preview_png "
        "FROM show_resources sr JOIN resources r ON r.id = sr.resource_id "
        "LEFT JOIN resource_versions v ON v.resource_id = r.id AND v.version_no = sr.version_no "
        "WHERE sr.show_id = ? ORDER BY sr.sort_order LIMIT 2",
        (row["id"],),
    ).fetchall()
    resources = []
    for sr in sr_rows:
        sres = _serialize_show_resource(db, int(sr["resource_id"]), int(sr["version_no"]), user, int(sr["is_hidden"]), resource=sr)
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
        "tags": ",".join(
            entity_tag_names(
                db,
                relation_table="show_tags",
                entity_column="show_id",
                entity_id=int(row["id"]),
                fallback=row["tags"] or "",
            )
        ),
        "status": row["status"],
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
    """按当前用户权限，返回放映下可见资源的固定版本信息（按 sort_order）。"""
    sr_rows = db.execute(
        """
        SELECT r.*, sr.resource_id, sr.version_no, sr.is_hidden, v.ppt_path, v.png_path, v.font_names, v.missing_fonts
        FROM show_resources sr
        JOIN resources r ON r.id = sr.resource_id
        JOIN resource_versions v ON v.resource_id = r.id AND v.version_no = sr.version_no
        WHERE sr.show_id = ?
        ORDER BY sr.sort_order
        """,
        (show_id,),
    ).fetchall()
    items: list[dict[str, Any]] = []
    for sr in sr_rows:
        if not can_view_resource(db, sr, user):
            continue
        items.append(
            {
                "resource_id": sr["resource_id"],
                "name": sr["name"],
                "version_no": sr["version_no"],
                "ppt_path": sr["ppt_path"],
                "png_path": sr["png_path"],
                "font_names": _json_loads(sr["font_names"], []),
                "missing_fonts": _json_loads(sr["missing_fonts"], []),
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
