"""Resource-tag and user-tag definition management."""
from __future__ import annotations

import re
import sqlite3
import unicodedata
from collections import Counter
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from app.config import reload_settings, settings, write_properties
from app.core.permissions import require_admin, require_user
from app.db import now_iso
from app.routers.dependencies import ApiPayload, db_dep, db_read_dep


router = APIRouter()


class TagsCreatePayload(ApiPayload):
    tags: list[str] = Field(..., min_length=1, max_length=1000)


class TagUpdatePayload(ApiPayload):
    name: str = Field(..., min_length=1, max_length=64)


class TagsConfigPayload(ApiPayload):
    user_custom_tags: bool


def split_tag_name(name: str) -> tuple[str, str]:
    """Split the first category separator from the displayed label."""
    if "-" in name:
        category, label = name.split("-", 1)
        category, label = category.strip(), label.strip()
        if category and label:
            return category, label
    return "未分类", name.strip()


def _validate_tag_name(raw_name: str) -> str:
    name = raw_name.strip()
    if not name:
        raise HTTPException(400, "标签名称不能为空")
    if len(name) > 64:
        raise HTTPException(400, "标签名称不能超过 64 个字符")
    if any(unicodedata.category(char).startswith("C") for char in name):
        raise HTTPException(400, "标签名称不能包含控制字符")
    if re.search(r"[，,\s]", name):
        raise HTTPException(400, "标签名称不能包含逗号、空格或换行")
    return name


def _replace_csv_tag(value: str, old_name: str, new_name: str) -> str:
    tags = [item.strip() for item in re.split(r"[，,\s]+", value or "") if item.strip()]
    replaced: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        current = new_name if tag == old_name else tag
        if current and current not in seen:
            replaced.append(current)
            seen.add(current)
    return ",".join(replaced)


def _serialize_tag(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "category": row["category"],
        "label": row["label"],
        "sort_order": row["sort_order"],
        "created_at": row["created_at"],
    }


def _grouped_tags(db: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    rows = db.execute(
        f"SELECT id, name, category, label, sort_order FROM {table} ORDER BY sort_order, id"
    ).fetchall()
    groups_map: dict[str, dict[str, Any]] = {}
    for row in rows:
        category = row["category"]
        group = groups_map.setdefault(
            category,
            {"category": category, "first_sort": row["sort_order"], "tags": []},
        )
        group["tags"].append(
            {
                "id": row["id"],
                "name": row["name"],
                "label": row["label"],
                "sort_order": row["sort_order"],
            }
        )
    groups = sorted(groups_map.values(), key=lambda group: (group["first_sort"], group["category"]))
    for group in groups:
        group.pop("first_sort", None)
    return groups


def _resource_tag_usage_counts(db: sqlite3.Connection) -> Counter[str]:
    counts: Counter[str] = Counter()
    for table in ("resources", "shows"):
        for row in db.execute(f"SELECT tags FROM {table} WHERE tags <> ''").fetchall():
            counts.update(set(_replace_csv_tag(row["tags"], "", "").split(",")) - {""})
    return counts


def _user_tag_usage_counts(db: sqlite3.Connection) -> Counter[str]:
    return Counter(
        {
            row["tag_name"]: int(row["usage_count"])
            for row in db.execute(
                "SELECT tag_name, COUNT(*) AS usage_count FROM user_tags GROUP BY tag_name"
            ).fetchall()
        }
    )


def _admin_list_definitions(
    db: sqlite3.Connection,
    table: str,
    usage_counts: Counter[str],
) -> list[dict[str, Any]]:
    rows = db.execute(
        f"SELECT id, name, category, label, sort_order, created_at "
        f"FROM {table} ORDER BY sort_order, id"
    ).fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        item = _serialize_tag(row)
        item["usage_count"] = usage_counts[row["name"]]
        result.append(item)
    return result


def _create_definitions(
    db: sqlite3.Connection,
    table: str,
    payload: TagsCreatePayload,
    created_by: int,
) -> dict[str, Any]:
    created: list[dict[str, Any]] = []
    skipped: list[str] = []
    seen_in_payload: set[str] = set()
    next_sort = int(
        db.execute(f"SELECT COALESCE(MAX(sort_order), -1) + 1 FROM {table}").fetchone()[0]
    )
    created_at = now_iso()

    for raw_name in payload.tags:
        if not isinstance(raw_name, str):
            continue
        try:
            name = _validate_tag_name(raw_name)
        except HTTPException as exc:
            raise HTTPException(400, f"标签「{raw_name}」不合法：{exc.detail}") from None
        if name in seen_in_payload:
            continue
        seen_in_payload.add(name)
        if db.execute(f"SELECT id FROM {table} WHERE name = ?", (name,)).fetchone() is not None:
            skipped.append(name)
            continue
        category, label = split_tag_name(name)
        try:
            cursor = db.execute(
                f"INSERT INTO {table} "
                "(name, category, label, sort_order, created_by, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (name, category, label, next_sort, created_by, created_at),
            )
        except sqlite3.IntegrityError:
            skipped.append(name)
            continue
        created.append(
            {
                "id": cursor.lastrowid,
                "name": name,
                "category": category,
                "label": label,
                "sort_order": next_sort,
                "created_at": created_at,
            }
        )
        next_sort += 1
    db.commit()
    return {"created": created, "skipped": skipped}


@router.get("/tags")
def list_tags(
    _: Any = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """获取所有预设标签，按 category 分组（任意登录用户可调用）"""
    return {"groups": _grouped_tags(db, "tags")}


@router.get("/user-tags")
def list_user_tags(
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """Return user-tag definitions for administrative user editors."""
    return {"groups": _grouped_tags(db, "user_tag_definitions")}


@router.get("/admin/tags")
def admin_list_tags(
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """管理员视图：返回所有预设标签 + 使用次数 + 当前用户自定义标签配置"""
    return {
        "tags": _admin_list_definitions(db, "tags", _resource_tag_usage_counts(db)),
        "user_custom_tags": settings.user_custom_tags,
    }


@router.get("/admin/user-tags")
def admin_list_user_tags(
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """Return user-tag definitions and assigned-user counts."""
    return {
        "tags": _admin_list_definitions(
            db,
            "user_tag_definitions",
            _user_tag_usage_counts(db),
        )
    }


@router.post("/admin/tags")
def admin_create_tags(
    payload: TagsCreatePayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """批量创建预设标签（管理员）"""
    return _create_definitions(db, "tags", payload, int(admin["id"]))


@router.post("/admin/user-tags")
def admin_create_user_tags(
    payload: TagsCreatePayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    return _create_definitions(db, "user_tag_definitions", payload, int(admin["id"]))


@router.put("/admin/tags/config")
def admin_update_tags_config(
    payload: TagsConfigPayload,
    _: Any = Depends(require_admin),
) -> dict[str, Any]:
    """更新 user_custom_tags 配置项（管理员），写入 properties 并热加载"""
    new_value = bool(payload.user_custom_tags)
    write_properties({"app.user_custom_tags": "true" if new_value else "false"})
    reload_settings()
    return {"user_custom_tags": settings.user_custom_tags}


def _load_definition(db: sqlite3.Connection, table: str, tag_id: int) -> sqlite3.Row:
    row = db.execute(
        f"SELECT id, name, category, label, sort_order, created_at FROM {table} WHERE id = ?",
        (tag_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "标签不存在")
    return row


@router.put("/admin/tags/{tag_id}")
def admin_update_tag(
    tag_id: int,
    payload: TagUpdatePayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """修改标签 name，自动重新拆分 category/label（管理员）"""
    new_name = _validate_tag_name(payload.name)
    row = _load_definition(db, "tags", tag_id)
    if db.execute(
        "SELECT id FROM tags WHERE name = ? AND id != ?", (new_name, tag_id)
    ).fetchone() is not None:
        raise HTTPException(409, "素材标签名称已存在")
    category, label = split_tag_name(new_name)
    old_name = row["name"]
    db.execute(
        "UPDATE tags SET name = ?, category = ?, label = ? WHERE id = ?",
        (new_name, category, label, tag_id),
    )
    if old_name != new_name:
        for table in ("resources", "shows"):
            rows = db.execute(f"SELECT id, tags FROM {table} WHERE tags <> ''").fetchall()
            for item in rows:
                updated = _replace_csv_tag(item["tags"], old_name, new_name)
                if updated != item["tags"]:
                    db.execute(f"UPDATE {table} SET tags = ? WHERE id = ?", (updated, item["id"]))
    db.commit()
    return _serialize_tag(_load_definition(db, "tags", tag_id))


@router.put("/admin/user-tags/{tag_id}")
def admin_update_user_tag(
    tag_id: int,
    payload: TagUpdatePayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    new_name = _validate_tag_name(payload.name)
    row = _load_definition(db, "user_tag_definitions", tag_id)
    if db.execute(
        "SELECT id FROM user_tag_definitions WHERE name = ? AND id != ?",
        (new_name, tag_id),
    ).fetchone() is not None:
        raise HTTPException(409, "用户标签名称已存在")
    category, label = split_tag_name(new_name)
    old_name = row["name"]
    db.execute(
        "UPDATE user_tag_definitions SET name = ?, category = ?, label = ? WHERE id = ?",
        (new_name, category, label, tag_id),
    )
    if old_name != new_name:
        db.execute(
            "UPDATE OR IGNORE user_tags SET tag_name = ? WHERE tag_name = ?",
            (new_name, old_name),
        )
        db.execute("DELETE FROM user_tags WHERE tag_name = ?", (old_name,))
        rows = db.execute("SELECT id, tags FROM users WHERE tags <> ''").fetchall()
        for item in rows:
            updated = _replace_csv_tag(item["tags"], old_name, new_name)
            if updated != item["tags"]:
                db.execute("UPDATE users SET tags = ? WHERE id = ?", (updated, item["id"]))
    db.commit()
    return _serialize_tag(_load_definition(db, "user_tag_definitions", tag_id))


@router.delete("/admin/tags/{tag_id}")
def admin_delete_tag(
    tag_id: int,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """删除预设定义；历史业务数据和用户标签文本保持不变。"""
    _load_definition(db, "tags", tag_id)
    db.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    db.commit()
    return {"ok": True}


@router.delete("/admin/user-tags/{tag_id}")
def admin_delete_user_tag(
    tag_id: int,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    _load_definition(db, "user_tag_definitions", tag_id)
    db.execute("DELETE FROM user_tag_definitions WHERE id = ?", (tag_id,))
    db.commit()
    return {"ok": True}
