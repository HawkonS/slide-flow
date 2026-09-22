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
from fastapi import HTTPException
from pathlib import Path
from typing import Any
import json
import re
import sqlite3


def _set_scope_users(db: sqlite3.Connection, table: str, resource_id: int, user_ids: list[int]) -> None:
    db.execute(f"DELETE FROM {table} WHERE resource_id = ?", (resource_id,))
    for user_id in sorted(set(user_ids)):
        db.execute(f"INSERT OR IGNORE INTO {table} (resource_id, user_id) VALUES (?, ?)", (resource_id, user_id))


def _scope_user_ids(db: sqlite3.Connection, table: str, resource_id: int) -> list[int]:
    rows = db.execute(f"SELECT user_id FROM {table} WHERE resource_id = ? ORDER BY user_id", (resource_id,)).fetchall()
    return [int(row["user_id"]) for row in rows]


def _resource_row(db: sqlite3.Connection, resource_id: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM resources WHERE id = ?", (resource_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "资源不存在")
    return row


def _version_row(db: sqlite3.Connection, resource_id: int, version_id: int | None = None) -> sqlite3.Row:
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
    if row is None:
        raise HTTPException(404, "版本不存在")
    return row


def _serialize_version(resource_id: int, version: sqlite3.Row, db: sqlite3.Connection) -> dict[str, Any]:
    font_names = _json_loads(version["font_names"], [])
    return {
        "id": version["id"],
        "version_no": version["version_no"],
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


def _serialize_resource(db: sqlite3.Connection, row: sqlite3.Row, user: sqlite3.Row) -> dict[str, Any]:
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    updated_by_user = None
    if row["updated_by"]:
        updated_by_user = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["updated_by"],)).fetchone()
    current_version = _version_row(db, int(row["id"]))
    version_rows = db.execute(
        "SELECT * FROM resource_versions WHERE resource_id = ? ORDER BY version_no DESC, id DESC",
        (row["id"],),
    ).fetchall()
    versions = [_serialize_version(int(row["id"]), item, db) for item in version_rows]
    current = next((item for item in versions if int(item["id"]) == int(current_version["id"])), None)
    if current is None:
        current = _serialize_version(int(row["id"]), current_version, db)
    payload = _row_to_dict(row)
    payload.update(
        {
            "owner": _row_to_dict(owner) if owner else None,
            "updated_by": _row_to_dict(updated_by_user) if updated_by_user else None,
            "can_manage": can_manage_resource(db, row, user),
            "visible_user_ids": _scope_user_ids(db, "resource_visibility", int(row["id"])),
            "manage_user_ids": _scope_user_ids(db, "resource_management", int(row["id"])),
            "current": current,
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
            "owner": _row_to_dict(owner) if owner else None,
            "can_manage": can_manage_resource(db, row, user),
            "current": current,
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
    return _version_row(db, resource_id)


def _delete_latest_resource_version(
    db: sqlite3.Connection, resource_id: int
) -> tuple[list[Path | None], list[int]]:
    """删除资源最新版本并回退 current_version，返回待清理的 (物理文件路径, 版本ID)。

    供“回退上一版”与“仅删除最新版本”共用；仅剩 1 个版本时拒绝。
    """
    versions = db.execute(
        "SELECT id, version_no, ppt_path, png_path FROM resource_versions "
        "WHERE resource_id = ? ORDER BY version_no DESC",
        (resource_id,),
    ).fetchall()
    if len(versions) <= 1:
        raise HTTPException(400, "仅剩 1 个版本，无法继续回退；如需清空请使用删除资源")
    latest = versions[0]
    prev_version_no = int(versions[1]["version_no"])
    latest_version_id = int(latest["id"])
    db.execute("DELETE FROM resource_versions WHERE id = ?", (latest_version_id,))
    db.execute(
        "UPDATE resources SET current_version = ?, updated_at = ? WHERE id = ?",
        (prev_version_no, now_iso(), resource_id),
    )
    db.commit()
    return (
        [latest["ppt_path"], latest["png_path"]],
        [latest_version_id],
    )
