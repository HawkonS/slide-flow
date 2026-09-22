"""Services / templates."""

from __future__ import annotations

from app.core.permissions import is_admin
from app.core.permissions import is_system_admin
from app.core.storage import safe_filename
from app.services.common import (
    _json_loads,
    _row_to_dict,
)
from app.services.downloads.fonts import (
    _font_alias_map,
)
from app.services.files import asset_preview_url
from fastapi import HTTPException
from pathlib import Path
from typing import Any
import sqlite3


def _validate_template_platform(platform: str) -> str:
    if platform not in {"wps", "microsoft"}:
        raise HTTPException(400, "模板平台不正确")
    return platform


def _validate_template_ratio(ratio: str) -> str:
    if ratio not in {"16:9", "4:3"}:
        raise HTTPException(400, "模板比例不正确")
    return ratio


def _validate_standalone_template_type(template_type: str) -> str:
    if template_type not in {"cover", "catalog", "content", "other"}:
        raise HTTPException(400, "模板类型不正确")
    return template_type


def _validate_standalone_template_subject(subject: str | None) -> str:
    value = (subject or "").strip()
    if not value:
        raise HTTPException(400, "请填写模板主体")
    if any(separator in value for separator in [",", "，", ";", "；", "\n", "\r"]):
        raise HTTPException(400, "主体只能填写一个")
    if len(value) > 80:
        raise HTTPException(400, "主体不能超过 80 个字符")
    return value


def _validate_template_series(series: str | None) -> str:
    value = (series or "").strip()
    if not value:
        raise HTTPException(400, "请填写模板系列")
    if any(separator in value for separator in [",", "，", ";", "；", "\n", "\r"]):
        raise HTTPException(400, "系列只能填写一个")
    if len(value) > 80:
        raise HTTPException(400, "系列不能超过 80 个字符")
    return value


def _template_name(series: str, subject: str, platform: str, ratio: str, template_type: str) -> str:
    type_labels = {"cover": "封面", "catalog": "目录", "content": "正文", "other": "其他"}
    platform_labels = {"wps": "WPS", "microsoft": "Microsoft"}
    return f"{subject}-{series}-{type_labels.get(template_type, template_type)}-{platform_labels.get(platform, platform)}-{ratio}"


def _template_office_file_name(series: str, subject: str, platform: str, ratio: str, template_type: str, suffix: str) -> str:
    return safe_filename(f"{_template_name(series, subject, platform, ratio, template_type)}{suffix.lower() or '.pptx'}")


def _template_preview_file_name(series: str, subject: str, platform: str, ratio: str, template_type: str) -> str:
    return safe_filename(f"{_template_name(series, subject, platform, ratio, template_type)}_预览.png")


def _rename_template_file(path: Path, file_name: str) -> Path:
    target = path.with_name(file_name)
    if path.resolve() == target.resolve():
        return path
    if target.exists():
        target = path.with_name(f"{target.stem}_{path.stem[-6:]}{target.suffix}")
    path.rename(target)
    return target


def _template_group_order_values(db: sqlite3.Connection, subject: str, series: str) -> tuple[int, int, int]:
    subject_row = db.execute(
        "SELECT MIN(subject_order) AS value FROM templates WHERE subject = ?",
        (subject,),
    ).fetchone()
    subject_order = int(subject_row["value"]) if subject_row and subject_row["value"] is not None else 0
    if not subject_order:
        subject_order = int(db.execute("SELECT COALESCE(MAX(subject_order), 0) + 10 AS value FROM templates").fetchone()["value"])

    series_row = db.execute(
        "SELECT MIN(series_order) AS value FROM templates WHERE subject = ? AND series = ?",
        (subject, series),
    ).fetchone()
    series_order = int(series_row["value"]) if series_row and series_row["value"] is not None else 0
    if not series_order:
        series_order = int(
            db.execute(
                "SELECT COALESCE(MAX(series_order), 0) + 10 AS value FROM templates WHERE subject = ?",
                (subject,),
            ).fetchone()["value"]
        )

    sort_order = int(
        db.execute(
            "SELECT COALESCE(MAX(sort_order), 0) + 10 AS value FROM templates WHERE subject = ? AND series = ?",
            (subject, series),
        ).fetchone()["value"]
    )
    return subject_order, series_order, sort_order


def _set_template_scope_users(db: sqlite3.Connection, table: str, template_id: int, user_ids: list[int]) -> None:
    db.execute(f"DELETE FROM {table} WHERE template_id = ?", (template_id,))
    for user_id in sorted(set(user_ids)):
        db.execute(f"INSERT OR IGNORE INTO {table} (template_id, user_id) VALUES (?, ?)", (template_id, user_id))


def _template_scope_user_ids(db: sqlite3.Connection, table: str, template_id: int) -> list[int]:
    rows = db.execute(f"SELECT user_id FROM {table} WHERE template_id = ? ORDER BY user_id", (template_id,)).fetchall()
    return [int(row["user_id"]) for row in rows]


def _template_row(db: sqlite3.Connection, template_id: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM templates WHERE id = ?", (template_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "模板不存在")
    return row


def _linked_template_user_ids(db: sqlite3.Connection, table: str, template_id: int) -> set[int]:
    rows = db.execute(f"SELECT user_id FROM {table} WHERE template_id = ?", (template_id,)).fetchall()
    return {int(row["user_id"]) for row in rows}


def can_view_template(db: sqlite3.Connection, template: sqlite3.Row, user: sqlite3.Row) -> bool:
    if is_system_admin(user):
        return True
    if int(template["owner_id"]) == int(user["id"]):
        return True
    scope = template["visibility_scope"]
    if scope == "public":
        return True
    if scope == "private":
        return False
    if scope == "partial":
        return int(user["id"]) in _linked_template_user_ids(db, "template_visibility", int(template["id"]))
    return False


def can_manage_template(db: sqlite3.Connection, template: sqlite3.Row, user: sqlite3.Row) -> bool:
    if is_system_admin(user):
        return True
    # 模板仅允许管理员级别（运营管理员 / 系统管理员）维护
    if not is_admin(user):
        return False
    if int(template["owner_id"]) == int(user["id"]):
        return True
    scope = template["management_scope"]
    if scope == "public":
        return True
    if scope == "private":
        return False
    if scope == "partial":
        return int(user["id"]) in _linked_template_user_ids(db, "template_management", int(template["id"]))
    return False


def _serialize_template(db: sqlite3.Connection, row: sqlite3.Row, user: sqlite3.Row) -> dict[str, Any]:
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    font_names = _json_loads(row["font_names"], [])
    payload = _row_to_dict(row)
    payload.pop("office_path", None)
    payload.pop("png_path", None)
    payload.update(
        {
            "owner": _row_to_dict(owner) if owner else None,
            "can_manage": can_manage_template(db, row, user),
            "visible_user_ids": _template_scope_user_ids(db, "template_visibility", int(row["id"])),
            "manage_user_ids": _template_scope_user_ids(db, "template_management", int(row["id"])),
            "preview_url": asset_preview_url(row["png_path"], thumb=True) or (f"/api/templates/{row['id']}/preview-thumb" if row["png_path"] else None),
            "original_preview_url": asset_preview_url(row["png_path"]) or (f"/api/templates/{row['id']}/preview" if row["png_path"] else None),
            "download_url": f"/api/templates/{row['id']}/download",
            "font_names": font_names,
            "font_aliases": _font_alias_map(font_names, db),
            "missing_fonts": _json_loads(row["missing_fonts"], []),
        }
    )
    return payload
