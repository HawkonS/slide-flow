"""Resource-tag and user-tag definition management."""
from __future__ import annotations

import re
import sqlite3
import unicodedata
from collections import Counter
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from app.config import reload_settings, settings, write_properties
from app.core.permissions import is_admin, require_admin, require_user
from app.db import now_iso
from app.routers.dependencies import ApiPayload, db_dep, db_read_dep
from app.services.tagging import (
    entity_tag_names,
    refresh_entity_tag_cache,
    split_tag_name as normalized_split_tag_name,
    table_has_column,
    tag_usage_counts,
)


router = APIRouter()


class TagsCreatePayload(ApiPayload):
    tags: list[str] = Field(..., min_length=1, max_length=1000)


class TagUpdatePayload(ApiPayload):
    name: str = Field(..., min_length=1, max_length=64)


class TagBatchUpdateItem(ApiPayload):
    id: int = Field(..., ge=1)
    name: str = Field(..., min_length=1, max_length=64)


class TagsBatchUpdatePayload(ApiPayload):
    updates: list[TagBatchUpdateItem] = Field(..., min_length=1, max_length=1000)


class CategoryRenamePayload(ApiPayload):
    old_category: str = Field(..., min_length=1, max_length=64)
    new_category: str = Field(..., min_length=1, max_length=64)


class TagsConfigPayload(ApiPayload):
    resource_custom_tags: bool | None = None
    user_custom_tags: bool | None = None
    status_custom_tags: bool | None = None


class DefaultFilterPayload(ApiPayload):
    enabled: bool


def split_tag_name(name: str) -> tuple[str, str]:
    return normalized_split_tag_name(name)


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
    return _replace_csv_tags(value, {old_name: new_name})


def _replace_csv_tags(value: str, replacements: dict[str, str]) -> str:
    tags = [item.strip() for item in re.split(r"[，,\s]+", value or "") if item.strip()]
    replaced: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        current = replacements.get(tag, tag)
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
    definition_rows = db.execute(
        "SELECT t.id, t.name FROM tags t"
    ).fetchall()
    names_by_id = {int(row["id"]): str(row["name"]) for row in definition_rows}
    for tag_id, count in tag_usage_counts(db).items():
        if tag_id in names_by_id:
            counts[names_by_id[tag_id]] += count
    for table in ("resources", "shows"):
        relation_table = "resource_tags" if table == "resources" else "show_tags"
        entity_column = "resource_id" if table == "resources" else "show_id"
        relation_exists = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (relation_table,),
        ).fetchone() is not None
        for row in db.execute(
            f"SELECT id, tags FROM {table} WHERE tags <> ''"
        ).fetchall():
            has_relations = (
                db.execute(
                    f"SELECT 1 FROM {relation_table} WHERE {entity_column} = ? LIMIT 1",
                    (row["id"],),
                ).fetchone()
                if relation_exists
                else None
            )
            if has_relations is None:
                counts.update(set(_replace_csv_tag(row["tags"], "", "").split(",")) - {""})
    return counts


def _user_tag_usage_counts(db: sqlite3.Connection) -> Counter[str]:
    if table_has_column(db, "user_tags", "tag_id"):
        query = (
            "SELECT COALESCE(def.name, ut.tag_name) AS tag_name, "
            "COUNT(*) AS usage_count FROM user_tags ut "
            "LEFT JOIN user_tag_definitions def ON def.id = ut.tag_id "
            "GROUP BY COALESCE(def.name, ut.tag_name)"
        )
    else:
        query = "SELECT tag_name, COUNT(*) AS usage_count FROM user_tags GROUP BY tag_name"
    return Counter(
        {
            row["tag_name"]: int(row["usage_count"])
            for row in db.execute(
                query
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


@router.get("/status-tags")
def list_status_tags(user: sqlite3.Row = Depends(require_user), db: sqlite3.Connection = Depends(db_read_dep)) -> dict[str, Any]:
    return {
        "groups": _grouped_tags(db, "status_tag_definitions", flat_category="状态"),
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
    "status": ("status_tag_definitions", "status"),
}

_METADATA_FLAT_CATEGORIES = {
    "subject": "主体",
    "status": "状态",
}


def _metadata_user_creation_enabled(domain: str) -> bool:
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
        flat_category=_METADATA_FLAT_CATEGORIES[domain],
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
            flat_category=_METADATA_FLAT_CATEGORIES[domain],
        )
    }
    if domain == "status":
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
        flat_category=_METADATA_FLAT_CATEGORIES[domain],
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
            payload.status_custom_tags,
        )
    ):
        raise HTTPException(400, "请至少提交一个自定义标签配置")
    updates: dict[str, str] = {}
    if payload.resource_custom_tags is not None:
        updates["app.user_custom_tags"] = "true" if payload.resource_custom_tags else "false"
    if payload.user_custom_tags is not None:
        updates["app.user_custom_user_tags"] = "true" if payload.user_custom_tags else "false"
    if payload.status_custom_tags is not None:
        updates["app.user_custom_status_tags"] = "true" if payload.status_custom_tags else "false"
    write_properties(updates)
    reload_settings()
    return {
        "resource_custom_tags": settings.user_custom_tags,
        "user_custom_tags": settings.user_custom_user_tags,
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


def _batch_rename_definitions(
    db: sqlite3.Connection,
    table: str,
    updates: list[TagBatchUpdateItem],
    *,
    flat_category: str | None = None,
    metadata_column: str | None = None,
    duplicate_message: str = "标签名称已存在",
    commit: bool = True,
) -> list[dict[str, Any]]:
    """Rename several definitions and their denormalized business references atomically."""
    try:
        ids = [int(item.id) for item in updates]
        if len(set(ids)) != len(ids):
            raise HTTPException(400, "批量修改中不能重复选择同一个标签")

        placeholders = ",".join("?" for _ in ids)
        rows = db.execute(
            f"SELECT id, name, category, label, sort_order, is_default_filter, created_at "
            f"FROM {table} WHERE id IN ({placeholders})",
            ids,
        ).fetchall()
        rows_by_id = {int(row["id"]): row for row in rows}
        if len(rows_by_id) != len(ids):
            raise HTTPException(404, "标签不存在")

        normalised_updates: list[tuple[int, sqlite3.Row, str]] = []
        final_names: list[str] = []
        for item in updates:
            try:
                new_name = _validate_tag_name(item.name)
            except HTTPException as exc:
                raise HTTPException(400, f"标签「{item.name}」不合法：{exc.detail}") from None
            normalised_updates.append((int(item.id), rows_by_id[int(item.id)], new_name))
            final_names.append(new_name)

        if len(set(final_names)) != len(final_names):
            raise HTTPException(409, "批量修改后的标签名称不能重复")

        existing = db.execute(
            f"SELECT id FROM {table} WHERE name IN ({','.join('?' for _ in final_names)}) "
            f"AND id NOT IN ({','.join('?' for _ in ids)})",
            [*final_names, *ids],
        ).fetchone()
        if existing is not None:
            raise HTTPException(409, duplicate_message)

        replacements = {
            str(row["name"]): new_name
            for _, row, new_name in normalised_updates
            if str(row["name"]) != new_name
        }

        # Temporary names make swaps such as A -> B and B -> A valid under the
        # definitions table's UNIQUE constraint. Foreign-key scope tables use
        # ON UPDATE CASCADE, so they follow both phases automatically.
        changed_ids = {
            tag_id
            for tag_id, row, new_name in normalised_updates
            if str(row["name"]) != new_name
        }
        for tag_id in changed_ids:
            temporary_name = f"__tag_rename_{uuid4().hex}"
            db.execute(f"UPDATE {table} SET name = ? WHERE id = ?", (temporary_name, tag_id))

        for tag_id, _, new_name in normalised_updates:
            if flat_category is None:
                category, label = split_tag_name(new_name)
            else:
                category, label = flat_category, new_name
            db.execute(
                f"UPDATE {table} SET name = ?, category = ?, label = ? WHERE id = ?",
                (new_name, category, label, tag_id),
            )

        if replacements and table == "tags":
            tag_ids = [
                int(tag_id)
                for tag_id, row, new_name in normalised_updates
                if str(row["name"]) != new_name
            ]
            if tag_ids:
                for relation_table, entity_column, cache_table in (
                    ("resource_tags", "resource_id", "resources"),
                    ("show_tags", "show_id", "shows"),
                ):
                    relation_exists = db.execute(
                        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                        (relation_table,),
                    ).fetchone()
                    if relation_exists is None:
                        continue
                    entity_rows = db.execute(
                        f"SELECT DISTINCT {entity_column} FROM {relation_table} "
                        f"WHERE tag_id IN ({','.join('?' for _ in tag_ids)})",
                        tag_ids,
                    ).fetchall()
                    for entity_row in entity_rows:
                        refresh_entity_tag_cache(
                            db,
                            relation_table=relation_table,
                            entity_column=entity_column,
                            entity_id=int(entity_row[entity_column]),
                            cache_table=cache_table,
                        )
            for business_table in ("resources", "shows"):
                business_rows = db.execute(
                    f"SELECT id, tags FROM {business_table} WHERE tags <> ''"
                ).fetchall()
                for business_row in business_rows:
                    relation_table = "resource_tags" if business_table == "resources" else "show_tags"
                    entity_column = "resource_id" if business_table == "resources" else "show_id"
                    if db.execute(
                        f"SELECT 1 FROM {relation_table} WHERE {entity_column} = ? LIMIT 1",
                        (business_row["id"],),
                    ).fetchone() is not None:
                        continue
                    updated = _replace_csv_tags(business_row["tags"], replacements)
                    if updated != business_row["tags"]:
                        db.execute(
                            f"UPDATE {business_table} SET tags = ? WHERE id = ?",
                            (updated, business_row["id"]),
                        )
        elif replacements and table == "user_tag_definitions":
            changed_tag_rows = [
                (int(tag_id), str(row["name"]), new_name)
                for tag_id, row, new_name in normalised_updates
                if str(row["name"]) != new_name
            ]
            if table_has_column(db, "user_tags", "tag_id"):
                # user_tags has no FK on its compatibility name column.
                # Rename through temporary values so swaps remain valid under
                # the (user_id, tag_name) primary key, while retaining IDs.
                for tag_id, _, _ in changed_tag_rows:
                    temporary_name = f"__user_tag_rename_{uuid4().hex}"
                    db.execute(
                        "UPDATE user_tags SET tag_name = ? WHERE tag_id = ?",
                        (temporary_name, tag_id),
                    )
                for tag_id, _, new_name in changed_tag_rows:
                    db.execute(
                        "UPDATE user_tags SET tag_name = ? WHERE tag_id = ?",
                        (new_name, tag_id),
                    )
                # Preserve compatibility for orphaned legacy rows that have
                # no backfilled ID.
                for old_name, new_name in replacements.items():
                    db.execute(
                        "UPDATE user_tags SET tag_name = ? "
                        "WHERE tag_id IS NULL AND tag_name = ?",
                        (new_name, old_name),
                    )
            else:
                user_tag_rows = db.execute(
                    f"SELECT user_id, tag_name FROM user_tags WHERE tag_name IN "
                    f"({','.join('?' for _ in replacements)})",
                    list(replacements),
                ).fetchall()
                if user_tag_rows:
                    db.execute(
                        f"DELETE FROM user_tags WHERE tag_name IN ({','.join('?' for _ in replacements)})",
                        list(replacements),
                    )
                    for user_tag_row in user_tag_rows:
                        db.execute(
                            "INSERT OR IGNORE INTO user_tags (user_id, tag_name) VALUES (?, ?)",
                            (
                                user_tag_row["user_id"],
                                replacements.get(user_tag_row["tag_name"], user_tag_row["tag_name"]),
                            ),
                        )
            user_rows = db.execute("SELECT id, tags FROM users WHERE tags <> ''").fetchall()
            for user_row in user_rows:
                updated = _replace_csv_tags(user_row["tags"], replacements)
                if updated != user_row["tags"]:
                    db.execute("UPDATE users SET tags = ? WHERE id = ?", (updated, user_row["id"]))
        elif replacements and metadata_column is not None:
            metadata_rows = db.execute(
                f"SELECT id, {metadata_column} AS value FROM resources "
                f"WHERE TRIM(COALESCE({metadata_column}, '')) <> ''"
            ).fetchall()
            for metadata_row in metadata_rows:
                updated = replacements.get(metadata_row["value"], metadata_row["value"])
                if updated != metadata_row["value"]:
                    db.execute(
                        f"UPDATE resources SET {metadata_column} = ? WHERE id = ?",
                        (updated, metadata_row["id"]),
                    )

        if commit:
            db.commit()
        return [_serialize_tag(_load_definition(db, table, tag_id)) for tag_id in ids]
    except Exception:
        db.rollback()
        raise


def _rename_category(
    db: sqlite3.Connection, table: str, payload: CategoryRenamePayload
) -> dict[str, Any]:
    old_category = payload.old_category.strip()
    new_category = _validate_tag_name(payload.new_category)
    if not old_category or old_category == "未分类" or new_category == "未分类":
        raise HTTPException(400, "只能重命名有明确一级分类的标签")
    if "-" in new_category:
        raise HTTPException(400, "一级分类名称不能包含连字符 -")

    rows = db.execute(
        f"SELECT id, label FROM {table} WHERE category = ? ORDER BY id",
        (old_category,),
    ).fetchall()
    if not rows:
        raise HTTPException(404, "一级分类不存在")
    if old_category == new_category:
        return {"updated_count": 0, "category": new_category}
    if db.execute(
        f"SELECT 1 FROM {table} WHERE category = ? LIMIT 1", (new_category,)
    ).fetchone() is not None:
        raise HTTPException(409, "目标一级分类已存在，请使用其他名称")

    updates = []
    for row in rows:
        name = f"{new_category}-{row['label']}"
        _validate_tag_name(name)
        updates.append(TagBatchUpdateItem(id=int(row["id"]), name=name))

    # A category may have more members than the SQLite bind-variable limit.
    # Commit only after every chunk succeeds so conflicts cannot partially
    # rename a production category.
    try:
        db.execute("BEGIN IMMEDIATE")
        for start in range(0, len(updates), 400):
            _batch_rename_definitions(
                db, table, updates[start:start + 400], commit=False
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"updated_count": len(updates), "category": new_category}


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


@router.put("/admin/tags/batch")
def admin_batch_update_tags(
    payload: TagsBatchUpdatePayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    updated = _batch_rename_definitions(
        db,
        "tags",
        payload.updates,
        duplicate_message="素材标签名称已存在",
    )
    return {"updated": updated}


@router.put("/admin/tags/categories/rename")
def admin_rename_resource_category(
    payload: CategoryRenamePayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    return _rename_category(db, "tags", payload)


@router.put("/admin/user-tags/categories/rename")
def admin_rename_user_category(
    payload: CategoryRenamePayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    return _rename_category(db, "user_tag_definitions", payload)


@router.put("/admin/user-tags/batch")
def admin_batch_update_user_tags(
    payload: TagsBatchUpdatePayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    updated = _batch_rename_definitions(
        db,
        "user_tag_definitions",
        payload.updates,
        duplicate_message="用户标签名称已存在",
    )
    return {"updated": updated}


@router.put("/admin/{domain}-tags/batch")
def admin_batch_update_metadata_tags(
    domain: str,
    payload: TagsBatchUpdatePayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    config = _METADATA_DOMAINS.get(domain)
    if config is None:
        raise HTTPException(404, "标签类型不存在")
    table, column = config
    updated = _batch_rename_definitions(
        db,
        table,
        payload.updates,
        flat_category=_METADATA_FLAT_CATEGORIES[domain],
        metadata_column=column,
    )
    return {"updated": updated}


@router.put("/admin/tags/{tag_id}")
def admin_update_tag(
    tag_id: int,
    payload: TagUpdatePayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """修改标签 name，自动重新拆分 category/label（管理员）"""
    return _batch_rename_definitions(
        db,
        "tags",
        [TagBatchUpdateItem(id=tag_id, name=payload.name)],
        duplicate_message="素材标签名称已存在",
    )[0]


@router.put("/admin/user-tags/{tag_id}")
def admin_update_user_tag(
    tag_id: int,
    payload: TagUpdatePayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    return _batch_rename_definitions(
        db,
        "user_tag_definitions",
        [TagBatchUpdateItem(id=tag_id, name=payload.name)],
        duplicate_message="用户标签名称已存在",
    )[0]


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
    return _batch_rename_definitions(
        db,
        table,
        [TagBatchUpdateItem(id=tag_id, name=payload.name)],
        flat_category=_METADATA_FLAT_CATEGORIES[domain],
        metadata_column=column,
    )[0]


@router.delete("/admin/tags/{tag_id}")
def admin_delete_tag(
    tag_id: int,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """删除预设定义及其素材/放映关联。"""
    _load_definition(db, "tags", tag_id)
    relation_tables = {
        str(row["name"])
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    affected_resources = (
        db.execute(
            "SELECT resource_id FROM resource_tags WHERE tag_id = ?", (tag_id,)
        ).fetchall()
        if "resource_tags" in relation_tables
        else []
    )
    affected_shows = (
        db.execute(
            "SELECT show_id FROM show_tags WHERE tag_id = ?", (tag_id,)
        ).fetchall()
        if "show_tags" in relation_tables
        else []
    )
    db.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    for row in affected_resources:
        refresh_entity_tag_cache(
            db,
            relation_table="resource_tags",
            entity_column="resource_id",
            entity_id=int(row["resource_id"]),
            cache_table="resources",
        )
    for row in affected_shows:
        refresh_entity_tag_cache(
            db,
            relation_table="show_tags",
            entity_column="show_id",
            entity_id=int(row["show_id"]),
            cache_table="shows",
        )
    db.commit()
    return {"ok": True}


@router.delete("/admin/user-tags/{tag_id}")
def admin_delete_user_tag(
    tag_id: int,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _load_definition(db, "user_tag_definitions", tag_id)
    tag_name = str(row["name"])
    if table_has_column(db, "user_tags", "tag_id"):
        db.execute(
            "DELETE FROM user_tags WHERE tag_id = ? OR (tag_id IS NULL AND tag_name = ?)",
            (tag_id, tag_name),
        )
    else:
        db.execute("DELETE FROM user_tags WHERE tag_name = ?", (tag_name,))
    user_rows = db.execute(
        "SELECT id, tags FROM users WHERE TRIM(COALESCE(tags, '')) <> ''"
    ).fetchall()
    for user_row in user_rows:
        updated = _replace_csv_tags(user_row["tags"], {tag_name: ""})
        if updated != user_row["tags"]:
            db.execute("UPDATE users SET tags = ? WHERE id = ?", (updated, user_row["id"]))
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
    _load_definition(db, table, tag_id)
    db.execute(f"DELETE FROM {table} WHERE id = ?", (tag_id,))
    db.commit()
    return {"ok": True}
