"""Normalized tag storage helpers.

The public API still exposes the legacy comma-separated ``tags`` field for
backward compatibility. New writes are persisted in relation tables keyed by
tag IDs and the legacy field is refreshed as a deterministic cache.
"""

from __future__ import annotations

import re
import sqlite3
import unicodedata
from collections.abc import Iterable
from typing import Any


TAG_NAME_MAX_LENGTH = 64


def table_has_column(db: sqlite3.Connection, table: str, column: str) -> bool:
    return column in {
        str(row["name"]) for row in db.execute(f"PRAGMA table_info({table})").fetchall()
    }


def tag_relation_join(
    db: sqlite3.Connection,
    relation_table: str,
    relation_alias: str,
    user_alias: str = "ut",
) -> str:
    if table_has_column(db, relation_table, "tag_id") and table_has_column(
        db, "user_tags", "tag_id"
    ):
        # IDs are authoritative for normalized rows. Keep the name branch for
        # legacy rows whose ID could not be backfilled or was written by an
        # older worker during a rolling deployment.
        return (
            f"({user_alias}.tag_id = {relation_alias}.tag_id "
            f"OR (({user_alias}.tag_id IS NULL OR {relation_alias}.tag_id IS NULL) "
            f"AND {user_alias}.tag_name = {relation_alias}.tag_name))"
        )
    return f"{user_alias}.tag_name = {relation_alias}.tag_name"


def split_tag_name(name: str) -> tuple[str, str]:
    """Return the optional first-level category and second-level label."""
    if "-" in name:
        category, label = name.split("-", 1)
        category, label = category.strip(), label.strip()
        if category and label:
            return category, label
    return "未分类", name.strip()


def parse_tag_names(value: str | Iterable[str] | None) -> list[str]:
    """Parse tag input into a stable, de-duplicated list."""
    if value is None:
        return []
    values = (
        re.split(r"[，,\s]+", value or "")
        if isinstance(value, str)
        else value
    )
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        if not isinstance(raw, str):
            continue
        name = raw.strip()
        if name and name not in seen:
            result.append(name)
            seen.add(name)
    return result


def validate_tag_names(value: str | Iterable[str] | None) -> list[str]:
    names = parse_tag_names(value)
    for name in names:
        if len(name) > TAG_NAME_MAX_LENGTH:
            raise ValueError(f"标签名称不能超过 {TAG_NAME_MAX_LENGTH} 个字符")
        if any(unicodedata.category(char).startswith("C") for char in name):
            raise ValueError("标签名称不能包含控制字符")
        if re.search(r"[，,\s]", name):
            raise ValueError("标签名称不能包含逗号、空格或换行")
    return names


def ensure_tag_definitions(
    db: sqlite3.Connection,
    names: Iterable[str],
    *,
    table: str = "tags",
    created_by: int | None = None,
    strict: bool = True,
) -> dict[str, int]:
    """Ensure definitions exist and return ``name -> id``."""
    parsed = validate_tag_names(names) if strict else parse_tag_names(names)
    if not parsed:
        return {}

    existing = {
        str(row["name"]): int(row["id"])
        for row in db.execute(
            f"SELECT id, name FROM {table} "
            f"WHERE name IN ({','.join('?' for _ in parsed)})",
            parsed,
        ).fetchall()
    }
    if created_by is None:
        owner = db.execute("SELECT id FROM users ORDER BY id LIMIT 1").fetchone()
        created_by = int(owner["id"]) if owner else None

    next_sort = int(
        db.execute(f"SELECT COALESCE(MAX(sort_order), -1) + 1 FROM {table}").fetchone()[0]
    )
    created_at = (
        __import__("datetime").datetime.utcnow().isoformat(timespec="seconds") + "Z"
    )
    for name in parsed:
        if name in existing:
            continue
        category, label = split_tag_name(name)
        if table == "tags":
            if created_by is None:
                raise ValueError("创建标签定义前必须存在用户")
            cursor = db.execute(
                "INSERT OR IGNORE INTO tags "
                "(name, category, label, sort_order, created_by, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (name, category, label, next_sort, created_by, created_at),
            )
        else:
            cursor = db.execute(
                f"INSERT OR IGNORE INTO {table} "
                "(name, category, label, sort_order, created_by, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (name, category, label, next_sort, created_by, created_at),
            )
        if cursor.rowcount:
            next_sort += 1
        row = db.execute(f"SELECT id FROM {table} WHERE name = ?", (name,)).fetchone()
        if row is not None:
            existing[name] = int(row["id"])
    return existing


def _relation_columns(db: sqlite3.Connection, table: str) -> set[str]:
    return {str(row["name"]) for row in db.execute(f"PRAGMA table_info({table})").fetchall()}


def set_entity_tags(
    db: sqlite3.Connection,
    *,
    relation_table: str,
    entity_column: str,
    entity_id: int,
    names: str | Iterable[str] | None,
    cache_table: str,
    created_by: int | None = None,
    strict: bool = True,
) -> list[str]:
    """Replace a resource/show tag set and refresh its compatibility cache."""
    parsed = validate_tag_names(names) if strict else parse_tag_names(names)
    relation_exists = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (relation_table,),
    ).fetchone() is not None
    if not relation_exists:
        db.execute(
            f"UPDATE {cache_table} SET tags = ? WHERE id = ?",
            (",".join(parsed), entity_id),
        )
        return parsed
    definitions = ensure_tag_definitions(
        db, parsed, table="tags", created_by=created_by, strict=strict
    )
    missing = [name for name in parsed if name not in definitions]
    if missing:
        raise ValueError(f"标签定义不存在：{'、'.join(missing[:5])}")

    db.execute(
        f"DELETE FROM {relation_table} WHERE {entity_column} = ?",
        (entity_id,),
    )
    for position, name in enumerate(parsed):
        db.execute(
            f"INSERT INTO {relation_table} "
            f"({entity_column}, tag_id, position) VALUES (?, ?, ?)",
            (entity_id, definitions[name], position),
        )
    cached = ",".join(parsed)
    db.execute(
        f"UPDATE {cache_table} SET tags = ? WHERE id = ?",
        (cached, entity_id),
    )
    return parsed


def entity_tag_names(
    db: sqlite3.Connection,
    *,
    relation_table: str,
    entity_column: str,
    entity_id: int,
    fallback: str = "",
) -> list[str]:
    rows = db.execute(
        f"SELECT t.name FROM {relation_table} rel "
        f"JOIN tags t ON t.id = rel.tag_id "
        f"WHERE rel.{entity_column} = ? ORDER BY rel.position, rel.tag_id",
        (entity_id,),
    ).fetchall()
    if rows:
        return [str(row["name"]) for row in rows]
    return parse_tag_names(fallback)


def refresh_entity_tag_cache(
    db: sqlite3.Connection,
    *,
    relation_table: str,
    entity_column: str,
    entity_id: int,
    cache_table: str,
) -> None:
    names = entity_tag_names(
        db,
        relation_table=relation_table,
        entity_column=entity_column,
        entity_id=entity_id,
        fallback="",
    )
    db.execute(
        f"UPDATE {cache_table} SET tags = ? WHERE id = ?",
        (",".join(names), entity_id),
    )


def migrate_entity_tags(
    db: sqlite3.Connection,
    *,
    entity_table: str,
    relation_table: str,
    entity_column: str,
) -> int:
    """Migrate a legacy CSV cache into the normalized relation table."""
    migrated = 0
    rows = db.execute(
        f"SELECT id, tags, owner_id FROM {entity_table} "
        "WHERE TRIM(COALESCE(tags, '')) <> ''"
    ).fetchall()
    for row in rows:
        names = parse_tag_names(row["tags"])
        if not names:
            continue
        definitions = ensure_tag_definitions(
            db,
            names,
            created_by=int(row["owner_id"]) if row["owner_id"] else None,
            strict=False,
        )
        db.execute(
            f"DELETE FROM {relation_table} WHERE {entity_column} = ?",
            (int(row["id"]),),
        )
        for position, name in enumerate(names):
            tag_id = definitions.get(name)
            if tag_id is None:
                continue
            db.execute(
                f"INSERT OR IGNORE INTO {relation_table} "
                f"({entity_column}, tag_id, position) VALUES (?, ?, ?)",
                (int(row["id"]), tag_id, position),
            )
        canonical = ",".join(
            name for name in names if name in definitions
        )
        if canonical != (row["tags"] or ""):
            db.execute(
                f"UPDATE {entity_table} SET tags = ? WHERE id = ?",
                (canonical, int(row["id"])),
            )
        migrated += 1
    return migrated


def tag_usage_counts(db: sqlite3.Connection) -> dict[int, int]:
    tables = {
        str(row["name"])
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    if not {"resource_tags", "show_tags"}.issubset(tables):
        return {}
    rows = db.execute(
        """
        SELECT tag_id, COUNT(*) AS usage_count
        FROM (
            SELECT tag_id FROM resource_tags
            UNION ALL
            SELECT tag_id FROM show_tags
        )
        GROUP BY tag_id
        """
    ).fetchall()
    return {int(row["tag_id"]): int(row["usage_count"]) for row in rows}
