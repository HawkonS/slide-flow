"""Services / resources."""

from __future__ import annotations

from app.config import settings
from app.core.fonts import missing_fonts
from app.core.permissions import can_manage_resource
from app.core.ppt import detect_ppt_fonts
from app.core.sanitize import sanitize_html
from app.db import known_font_aliases
from app.db import now_iso
from app.services.common import (
    _json_loads,
    _row_to_dict,
)
from app.services.downloads.fonts import (
    _font_alias_map,
)
from app.services.files import (
    asset_preview_url,
    _resource_file_abs,
)
from app.services.tagging import entity_tag_names, table_has_column
from fastapi import HTTPException
from pathlib import Path
from typing import Any
import json
import re
import sqlite3


RESOURCE_SCOPE_MAX_USERS = 1000
RESOURCE_SCOPE_MAX_TAGS = 100


def _normalise_scope_user_ids(db: sqlite3.Connection, user_ids: list[int]) -> list[int]:
    if not isinstance(user_ids, list) or any(type(user_id) is not int for user_id in user_ids):
        raise HTTPException(400, "用户范围必须是整数数组")
    ids = sorted({user_id for user_id in user_ids if user_id > 0})
    if len(ids) > RESOURCE_SCOPE_MAX_USERS:
        raise HTTPException(400, f"单个范围最多选择 {RESOURCE_SCOPE_MAX_USERS} 位用户")
    if ids:
        placeholders = ",".join("?" for _ in ids)
        existing = {
            int(row["id"])
            for row in db.execute(
                f"SELECT id FROM users WHERE id IN ({placeholders})", ids
            ).fetchall()
        }
        if existing != set(ids):
            raise HTTPException(400, "可见/管理范围中存在无效用户，请重新选择")
    return ids


def _set_scope_users(db: sqlite3.Connection, table: str, resource_id: int, user_ids: list[int]) -> None:
    ids = _normalise_scope_user_ids(db, user_ids)
    # Validate the complete replacement set before deleting existing rows. This
    # keeps a rejected metadata update from leaving an open partial write in a
    # pooled SQLite connection.
    db.execute(f"DELETE FROM {table} WHERE resource_id = ?", (resource_id,))
    for user_id in ids:
        db.execute(f"INSERT OR IGNORE INTO {table} (resource_id, user_id) VALUES (?, ?)", (resource_id, user_id))


def _scope_user_ids(db: sqlite3.Connection, table: str, resource_id: int) -> list[int]:
    rows = db.execute(f"SELECT user_id FROM {table} WHERE resource_id = ? ORDER BY user_id", (resource_id,)).fetchall()
    return [int(row["user_id"]) for row in rows]


def _normalise_scope_tags(db: sqlite3.Connection, tag_names: list[str]) -> list[str]:
    if not isinstance(tag_names, list) or any(not isinstance(tag, str) for tag in tag_names):
        raise HTTPException(400, "用户标签范围必须是字符串数组")
    tags = sorted({tag.strip() for tag in tag_names if tag.strip()})
    if len(tags) > RESOURCE_SCOPE_MAX_TAGS:
        raise HTTPException(400, f"单个范围最多选择 {RESOURCE_SCOPE_MAX_TAGS} 个用户标签")
    if any(len(tag) > 64 for tag in tags):
        raise HTTPException(400, "用户标签名称不能超过 64 个字符")
    if tags:
        placeholders = ",".join("?" for _ in tags)
        existing = {
            str(row["name"])
            for row in db.execute(
                f"SELECT name FROM user_tag_definitions WHERE name IN ({placeholders})",
                tags,
            ).fetchall()
        }
        if existing != set(tags):
            raise HTTPException(400, "可见/管理范围中存在无效用户标签，请重新选择")
    return tags


def _set_scope_tags(
    db: sqlite3.Connection,
    table: str,
    resource_id: int,
    tag_names: list[str],
) -> None:
    tags = _normalise_scope_tags(db, tag_names)
    db.execute(f"DELETE FROM {table} WHERE resource_id = ?", (resource_id,))
    if table_has_column(db, table, "tag_id"):
        definitions = {
            str(row["name"]): int(row["id"])
            for row in db.execute(
                f"SELECT id, name FROM user_tag_definitions "
                f"WHERE name IN ({','.join('?' for _ in tags)})",
                tags,
            ).fetchall()
        } if tags else {}
        for tag_name in tags:
            db.execute(
                f"INSERT OR IGNORE INTO {table} (resource_id, tag_name, tag_id) VALUES (?, ?, ?)",
                (resource_id, tag_name, definitions.get(tag_name)),
            )
    else:
        for tag_name in tags:
            db.execute(
                f"INSERT OR IGNORE INTO {table} (resource_id, tag_name) VALUES (?, ?)",
                (resource_id, tag_name),
            )


def _scope_tag_names(db: sqlite3.Connection, table: str, resource_id: int) -> list[str]:
    if table_has_column(db, table, "tag_id"):
        rows = db.execute(
            f"SELECT COALESCE(t.name, scope.tag_name) AS tag_name "
            f"FROM {table} scope LEFT JOIN user_tag_definitions t ON t.id = scope.tag_id "
            f"WHERE scope.resource_id = ? ORDER BY tag_name",
            (resource_id,),
        ).fetchall()
    else:
        rows = db.execute(
            f"SELECT tag_name FROM {table} WHERE resource_id = ? ORDER BY tag_name",
            (resource_id,),
        ).fetchall()
    return [str(row["tag_name"]) for row in rows]


def _resource_row(db: sqlite3.Connection, resource_id: int, *, include_deleted: bool = False) -> sqlite3.Row:
    row = db.execute("SELECT * FROM resources WHERE id = ?", (resource_id,)).fetchone()
    if row is None or (not include_deleted and "deleted_at" in row.keys() and row["deleted_at"]):
        raise HTTPException(404, "资源不存在或已删除")
    return row


def _resource_row_by_detail_token(
    db: sqlite3.Connection, detail_token: str, *, include_deleted: bool = False
) -> sqlite3.Row:
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", detail_token):
        raise HTTPException(404, "资源不存在")
    row = db.execute(
        "SELECT * FROM resources WHERE detail_token = ?",
        (detail_token,),
    ).fetchone()
    if row is None or (not include_deleted and "deleted_at" in row.keys() and row["deleted_at"]):
        raise HTTPException(404, "资源不存在或已删除")
    return row


def _version_row(db: sqlite3.Connection, resource_id: int, version_id: int | None = None, *, include_deleted: bool = False) -> sqlite3.Row:
    if version_id:
        row = db.execute(
            "SELECT * FROM resource_versions WHERE id = ? AND resource_id = ?",
            (version_id, resource_id),
        ).fetchone()
    else:
        row = db.execute(
            """
            SELECT v.* FROM resource_versions v
            JOIN resources r ON r.id = v.resource_id AND r.current_version = v.version_no
            WHERE v.resource_id = ?
            """,
            (resource_id,),
        ).fetchone()
    if row is None or (not include_deleted and "deleted_at" in row.keys() and row["deleted_at"]):
        raise HTTPException(404, "版本不存在或已删除")
    return row


def _serialize_version(resource_id: int, version: sqlite3.Row, db: sqlite3.Connection) -> dict[str, Any]:
    font_names = _json_loads(version["font_names"], [])
    return {
        "id": version["id"],
        "version_no": version["version_no"],
        "archived": bool(version["deleted_at"]) if "deleted_at" in version.keys() else False,
        "font_names": font_names,
        "font_aliases": _font_alias_map(font_names, db),
        "missing_fonts": _json_loads(version["missing_fonts"], []),
        "common_remark_html": sanitize_html(version["common_remark_html"]),
        "change_note": version["change_note"],
        "created_by": version["created_by"],
        "created_at": version["created_at"],
        "preview_url": asset_preview_url(version["png_path"], thumb=True)
        or (f"/api/resources/{resource_id}/preview-thumb?version_id={version['id']}&profile=card2" if version["png_path"] else None),
        "original_preview_url": asset_preview_url(version["png_path"])
        or (f"/api/resources/{resource_id}/preview?version_id={version['id']}" if version["png_path"] else None),
    }


_HTML_TAG_RE = re.compile(r"<[^>]*>")


def _has_personal_remark(
    db: sqlite3.Connection, resource_id: int, user_id: int
) -> bool:
    """严格判定：去掉 HTML 标签和空白后有实际文本方为真。

    富文本编辑器清空后可能留下 `<p><br></p>` 之类的空壳，
    不能用 TRIM(content_html) 简单判定。
    """
    rows = db.execute(
        "SELECT content_html FROM personal_remarks WHERE resource_id = ? AND user_id = ?",
        (resource_id, user_id),
    ).fetchall()
    for r in rows:
        html = r["content_html"] or ""
        plain = _HTML_TAG_RE.sub("", html).replace("\xa0", " ").strip()
        if plain:
            return True
    return False


def _is_resource_pinned(db: sqlite3.Connection, resource_id: int, user_id: int) -> bool:
    return db.execute(
        "SELECT 1 FROM user_pinned_resources WHERE user_id = ? AND resource_id = ?",
        (user_id, resource_id),
    ).fetchone() is not None


def _serialize_resource(db: sqlite3.Connection, row: sqlite3.Row, user: sqlite3.Row, *, include_deleted: bool = False) -> dict[str, Any]:
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    updated_by_user = None
    if row["updated_by"]:
        updated_by_user = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["updated_by"],)).fetchone()
    version_rows = db.execute(
        "SELECT * FROM resource_versions WHERE resource_id = ? ORDER BY version_no DESC, id DESC",
        (row["id"],),
    ).fetchall()
    version_rows = [v for v in version_rows if include_deleted or not ("deleted_at" in v.keys() and v["deleted_at"])]
    current_version = next((v for v in version_rows if v["version_no"] == row["current_version"]), None)
    if current_version is None and include_deleted and version_rows:
        current_version = version_rows[0]
    if current_version is None:
        raise HTTPException(404, "版本不存在或已删除")
    versions = [_serialize_version(int(row["id"]), item, db) for item in version_rows]
    current = next((item for item in versions if int(item["id"]) == int(current_version["id"])), None)
    if current is None:
        current = _serialize_version(int(row["id"]), current_version, db)
    payload = _row_to_dict(row)
    # Keep the legacy database column private. Secrecy is no longer resource
    # metadata exposed by the platform.
    payload.pop("secrecy_level", None)
    can_manage = can_manage_resource(db, row, user) and not ("deleted_at" in row.keys() and row["deleted_at"])
    payload.update(
        {
            # The normalized relation is authoritative; ``resources.tags``
            # remains only as an API/cache compatibility field.
            "tags": ",".join(
                entity_tag_names(
                    db,
                    relation_table="resource_tags",
                    entity_column="resource_id",
                    entity_id=int(row["id"]),
                    fallback=row["tags"] or "",
                )
            ),
            "owner": _row_to_dict(owner) if owner else None,
            "updated_by": _row_to_dict(updated_by_user) if updated_by_user else None,
            "can_manage": can_manage,
            # Exact member lists are management metadata. A viewer receives
            # the scope label but not the identities of everyone granted
            # access.
            "visible_user_ids": _scope_user_ids(db, "resource_visibility", int(row["id"])) if can_manage else [],
            "manage_user_ids": _scope_user_ids(db, "resource_management", int(row["id"])) if can_manage else [],
            "visible_user_tags": _scope_tag_names(db, "resource_visibility_tags", int(row["id"])) if can_manage else [],
            "manage_user_tags": _scope_tag_names(db, "resource_management_tags", int(row["id"])) if can_manage else [],
            "current": current,
            "version_count": db.execute("SELECT COUNT(*) FROM resource_versions WHERE resource_id = ? AND deleted_at IS NULL", (row["id"],)).fetchone()[0],
            "versions": versions,
            "has_personal_remark": _has_personal_remark(
                db, int(row["id"]), int(user["id"])
            ),
            "is_pinned": _is_resource_pinned(db, int(row["id"]), int(user["id"])),
        }
    )
    return payload


def _serialize_resource_lite(db: sqlite3.Connection, row: sqlite3.Row, user: sqlite3.Row) -> dict[str, Any]:
    """轻量级资源序列化：仅返回列表展示所需字段，不加载版本历史"""
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    payload = _row_to_dict(row)
    payload.pop("secrecy_level", None)
    # 获取当前版本缩略图
    ver = db.execute(
        "SELECT id, png_path FROM resource_versions WHERE resource_id = ? AND version_no = ?",
        (row["id"], row["current_version"]),
    ).fetchone()
    current = None
    if ver:
        vid = ver["id"]
        current = {
            "id": vid,
            "version_no": int(row["current_version"]),
            "preview_url": asset_preview_url(ver["png_path"], thumb=True) or (f"/api/resources/{row['id']}/preview-thumb?version_id={vid}" if ver["png_path"] else None),
            "original_preview_url": asset_preview_url(ver["png_path"]) or (f"/api/resources/{row['id']}/preview?version_id={vid}" if ver["png_path"] else None),
        }
    payload.update(
        {
            "tags": ",".join(
                entity_tag_names(
                    db,
                    relation_table="resource_tags",
                    entity_column="resource_id",
                    entity_id=int(row["id"]),
                    fallback=row["tags"] or "",
                )
            ),
            "owner": _row_to_dict(owner) if owner else None,
            "can_manage": can_manage_resource(db, row, user),
            "current": current,
            "version_count": db.execute("SELECT COUNT(*) FROM resource_versions WHERE resource_id = ? AND deleted_at IS NULL", (row["id"],)).fetchone()[0],
            "has_personal_remark": _has_personal_remark(db, int(row["id"]), int(user["id"])),
            "is_pinned": _is_resource_pinned(db, int(row["id"]), int(user["id"])),
        }
    )
    return payload


def _insert_version(
    db: sqlite3.Connection,
    *,
    resource_id: int,
    version_no: int,
    ppt_path: Path,
    png_path: Path | None,
    common_remark_html: str,
    change_note: str,
    created_by: int,
    ppt_ref: str | None = None,
    png_ref: str | None = None,
    detected_fonts: list[str] | None = None,
) -> sqlite3.Row:
    if settings.storage_backend.lower() == "oss":
        if not ppt_ref or (png_path is not None and not png_ref):
            raise RuntimeError("OSS 模式下资源版本必须先完成 PPT/PNG 上传")
    fonts = detected_fonts if detected_fonts is not None else detect_ppt_fonts(ppt_path)
    missing = missing_fonts(fonts, known_font_aliases(db))
    ts = now_iso()
    db.execute(
        """
        INSERT INTO resource_versions (
            resource_id, version_no, ppt_path, png_path, font_names, missing_fonts,
            common_remark_html, change_note, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            resource_id,
            version_no,
            ppt_ref or settings.store_path(ppt_path),
            png_ref or (settings.store_path(png_path) if png_path else None),
            json.dumps(fonts, ensure_ascii=False),
            json.dumps(missing, ensure_ascii=False),
            sanitize_html(common_remark_html),
            change_note,
            created_by,
            ts,
        ),
    )
    version_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    db.execute("UPDATE resources SET next_version_no = MAX(next_version_no, ?) WHERE id = ?", (version_no + 1, resource_id))
    return _version_row(db, resource_id, version_id)


def _allocate_version_number(db: sqlite3.Connection, resource_id: int) -> int:
    """Allocate under the writer lock; rollbacks/deletions never reuse a number."""
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    row = _resource_row(db, resource_id)
    maximum = db.execute("SELECT MAX(version_no) FROM resource_versions WHERE resource_id = ?", (resource_id,)).fetchone()[0] or 0
    pinned = db.execute("SELECT MAX(version_no) FROM show_resources WHERE resource_id = ?", (resource_id,)).fetchone()[0] or 0
    number = max(int(row["next_version_no"]), int(row["current_version"]) + 1, maximum + 1, pinned + 1)
    db.execute("UPDATE resources SET next_version_no = ? WHERE id = ?", (number + 1, resource_id))
    return number
