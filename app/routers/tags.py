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
from app.core.permissions import is_admin, require_admin, require_user
from app.db import now_iso
from app.routers.dependencies import ApiPayload, db_dep, db_read_dep


router = APIRouter()


class TagsCreatePayload(ApiPayload):
    tags: list[str] = Field(..., min_length=1, max_length=1000)


class TagUpdatePayload(ApiPayload):
    name: str = Field(..., min_length=1, max_length=64)


class TagsConfigPayload(ApiPayload):
    resource_custom_tags: bool | None = None
    user_custom_tags: bool | None = None
    secrecy_custom_tags: bool | None = None
    status_custom_tags: bool | None = None


class DefaultFilterPayload(ApiPayload):
    enabled: bool


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
        "default_filter": bool(row["is_default_filter"]),
        "created_at": row["created_at"],
    }


def _grouped_tags(
    db: sqlite3.Connection,
    table: str,
    *,
    flat_category: str | None = None,
) -> list[dict[str, Any]]:
    rows = db.execute(
        f"SELECT id, name, category, label, sort_order, is_default_filter "
        f"FROM {table} ORDER BY sort_order, id"
    ).fetchall()
    if flat_category is not None:
        return [{
            "category": flat_category,
            "tags": [
                {
                    "id": row["id"],
                    "name": row["name"],
                    "label": row["name"],
                    "sort_order": row["sort_order"],
                    "default_filter": bool(row["is_default_filter"]),
                }
                for row in rows
            ],
        }] if rows else []
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
                "default_filter": bool(row["is_default_filter"]),
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


def _metadata_usage_counts(db: sqlite3.Connection, column: str) -> Counter[str]:
    return Counter(
        {
            str(row["value"]): int(row["usage_count"])
            for row in db.execute(
                f"SELECT {column} AS value, COUNT(*) AS usage_count "
                f"FROM resources WHERE TRIM(COALESCE({column}, '')) <> '' GROUP BY {column}"
            ).fetchall()
        }
    )


def _admin_list_definitions(
    db: sqlite3.Connection,
    table: str,
    usage_counts: Counter[str],
    *,
    flat_category: str | None = None,
) -> list[dict[str, Any]]:
    rows = db.execute(
        f"SELECT id, name, category, label, sort_order, is_default_filter, created_at "
        f"FROM {table} ORDER BY sort_order, id"
    ).fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        item = _serialize_tag(row)
        if flat_category is not None:
            item["category"] = flat_category
            item["label"] = item["name"]
        item["usage_count"] = usage_counts[row["name"]]
        result.append(item)
    return result


def _create_definitions(
    db: sqlite3.Connection,
    table: str,
    payload: TagsCreatePayload,
    created_by: int,
    *,
    flat_category: str | None = None,
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
        if flat_category is None:
            category, label = split_tag_name(name)
        else:
            category, label = flat_category, name
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
                "default_filter": False,
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
    _: Any = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """Return user-tag definitions for user editors and permission pickers."""
    return {"groups": _grouped_tags(db, "user_tag_definitions")}


@router.get("/subject-tags")
def list_subject_tags(user: sqlite3.Row = Depends(require_user), db: sqlite3.Connection = Depends(db_read_dep)) -> dict[str, Any]:
    return {
        "groups": _grouped_tags(db, "subject_tag_definitions", flat_category="主体"),
        "can_create": is_admin(user),
    }


@router.get("/secrecy-tags")
def list_secrecy_tags(user: sqlite3.Row = Depends(require_user), db: sqlite3.Connection = Depends(db_read_dep)) -> dict[str, Any]:
    return {
        "groups": _grouped_tags(db, "secrecy_tag_definitions"),
        "can_create": is_admin(user) or settings.user_custom_secrecy_tags,
    }


@router.get("/status-tags")
def list_status_tags(user: sqlite3.Row = Depends(require_user), db: sqlite3.Connection = Depends(db_read_dep)) -> dict[str, Any]:
    return {
        "groups": _grouped_tags(db, "status_tag_definitions"),
        "can_create": is_admin(user) or settings.user_custom_status_tags,
    }


@router.get("/admin/tags")
def admin_list_tags(
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """管理员视图：返回所有预设标签 + 使用次数 + 当前用户自定义标签配置"""
    return {
        "tags": _admin_list_definitions(db, "tags", _resource_tag_usage_counts(db)),
        "resource_custom_tags": settings.user_custom_tags,
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
        ),
        "user_custom_tags": settings.user_custom_user_tags,
    }


_METADATA_DOMAINS = {
    "subject": ("subject_tag_definitions", "subject"),
    "secrecy": ("secrecy_tag_definitions", "secrecy_level"),
    "status": ("status_tag_definitions", "status"),
}


def _metadata_user_creation_enabled(domain: str) -> bool:
    if domain == "secrecy":
        return settings.user_custom_secrecy_tags
    if domain == "status":
        return settings.user_custom_status_tags
    return False


@router.post("/{domain}-tags")
def create_metadata_tags(
    domain: str,
    payload: TagsCreatePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    config = _METADATA_DOMAINS.get(domain)
    if config is None:
        raise HTTPException(404, "标签类型不存在")
    if not is_admin(user) and not _metadata_user_creation_enabled(domain):
        raise HTTPException(403, "当前仅管理员可添加该类标签")
    return _create_definitions(
        db,
        config[0],
        payload,
        int(user["id"]),
        flat_category="主体" if domain == "subject" else None,
    )


@router.get("/admin/{domain}-tags")
def admin_list_metadata_tags(
    domain: str,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    config = _METADATA_DOMAINS.get(domain)
    if config is None:
        raise HTTPException(404, "标签类型不存在")
    table, column = config
    result = {
        "tags": _admin_list_definitions(
            db,
            table,
            _metadata_usage_counts(db, column),
            flat_category="主体" if domain == "subject" else None,
        )
    }
    if domain == "secrecy":
        result["secrecy_custom_tags"] = settings.user_custom_secrecy_tags
    elif domain == "status":
        result["status_custom_tags"] = settings.user_custom_status_tags
    return result


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


@router.post("/admin/{domain}-tags")
def admin_create_metadata_tags(
    domain: str,
    payload: TagsCreatePayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    config = _METADATA_DOMAINS.get(domain)
    if config is None:
        raise HTTPException(404, "标签类型不存在")
    return _create_definitions(
        db,
        config[0],
        payload,
        int(admin["id"]),
        flat_category="主体" if domain == "subject" else None,
    )


@router.put("/admin/tags/config")
def admin_update_tags_config(
    payload: TagsConfigPayload,
    _: Any = Depends(require_admin),
) -> dict[str, Any]:
    """更新 user_custom_tags 配置项（管理员），写入 properties 并热加载"""
    if all(
        value is None
        for value in (
            payload.resource_custom_tags,
            payload.user_custom_tags,
            payload.secrecy_custom_tags,
            payload.status_custom_tags,
        )
    ):
        raise HTTPException(400, "请至少提交一个自定义标签配置")
    updates: dict[str, str] = {}
    if payload.resource_custom_tags is not None:
        updates["app.user_custom_tags"] = "true" if payload.resource_custom_tags else "false"
    if payload.user_custom_tags is not None:
        updates["app.user_custom_user_tags"] = "true" if payload.user_custom_tags else "false"
    if payload.secrecy_custom_tags is not None:
        updates["app.user_custom_secrecy_tags"] = "true" if payload.secrecy_custom_tags else "false"
    if payload.status_custom_tags is not None:
        updates["app.user_custom_status_tags"] = "true" if payload.status_custom_tags else "false"
    write_properties(updates)
    reload_settings()
    return {
        "resource_custom_tags": settings.user_custom_tags,
        "user_custom_tags": settings.user_custom_user_tags,
        "secrecy_custom_tags": settings.user_custom_secrecy_tags,
        "status_custom_tags": settings.user_custom_status_tags,
    }


def _load_definition(db: sqlite3.Connection, table: str, tag_id: int) -> sqlite3.Row:
    row = db.execute(
        f"SELECT id, name, category, label, sort_order, is_default_filter, created_at "
        f"FROM {table} WHERE id = ?",
        (tag_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "标签不存在")
    return row


def _update_default_filter(
    db: sqlite3.Connection,
    table: str,
    tag_id: int,
    enabled: bool,
    *,
    exclusive: bool,
) -> dict[str, Any]:
    row = _load_definition(db, table, tag_id)
    if enabled and exclusive:
        db.execute(f"UPDATE {table} SET is_default_filter = 0")
    db.execute(
        f"UPDATE {table} SET is_default_filter = ? WHERE id = ?",
        (1 if enabled else 0, tag_id),
    )
    db.commit()
    return _serialize_tag(_load_definition(db, table, tag_id))


@router.put("/admin/tags/{tag_id}/default-filter")
def admin_update_resource_default_filter(
    tag_id: int,
    payload: DefaultFilterPayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """Toggle a resource tag's default filter state."""
    return _update_default_filter(db, "tags", tag_id, payload.enabled, exclusive=False)


@router.put("/admin/user-tags/{tag_id}/default-filter")
def admin_update_user_default_filter(
    tag_id: int,
    payload: DefaultFilterPayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    return _update_default_filter(db, "user_tag_definitions", tag_id, payload.enabled, exclusive=False)


@router.put("/admin/{domain}-tags/{tag_id}/default-filter")
def admin_update_metadata_default_filter(
    domain: str,
    tag_id: int,
    payload: DefaultFilterPayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    config = _METADATA_DOMAINS.get(domain)
    if config is None:
        raise HTTPException(404, "标签类型不存在")
    return _update_default_filter(db, config[0], tag_id, payload.enabled, exclusive=True)


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


@router.put("/admin/{domain}-tags/{tag_id}")
def admin_update_metadata_tag(
    domain: str,
    tag_id: int,
    payload: TagUpdatePayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    config = _METADATA_DOMAINS.get(domain)
    if config is None:
        raise HTTPException(404, "标签类型不存在")
    table, column = config
    new_name = _validate_tag_name(payload.name)
    row = _load_definition(db, table, tag_id)
    if db.execute(f"SELECT id FROM {table} WHERE name = ? AND id != ?", (new_name, tag_id)).fetchone():
        raise HTTPException(409, "标签名称已存在")
    if domain == "status" and row["name"] in {"active", "disabled"} and new_name != row["name"]:
        raise HTTPException(400, "系统状态标签的内部值不能重命名")
    category, label = ("主体", new_name) if domain == "subject" else split_tag_name(new_name)
    old_name = str(row["name"])
    db.execute(
        f"UPDATE {table} SET name = ?, category = ?, label = ? WHERE id = ?",
        (new_name, category, label, tag_id),
    )
    if old_name != new_name:
        db.execute(f"UPDATE resources SET {column} = ? WHERE {column} = ?", (new_name, old_name))
    db.commit()
    return _serialize_tag(_load_definition(db, table, tag_id))


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


@router.delete("/admin/{domain}-tags/{tag_id}")
def admin_delete_metadata_tag(
    domain: str,
    tag_id: int,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    config = _METADATA_DOMAINS.get(domain)
    if config is None:
        raise HTTPException(404, "标签类型不存在")
    table, _ = config
    row = _load_definition(db, table, tag_id)
    if domain == "status" and row["name"] in {"active", "disabled"}:
        raise HTTPException(400, "系统状态标签不能删除")
    db.execute(f"DELETE FROM {table} WHERE id = ?", (tag_id,))
    db.commit()
    return {"ok": True}
