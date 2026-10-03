"""Organization tag defaults, keyed by the UI scene that consumes them."""
from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import HTTPException

DOMAIN_TABLES = {
    "resource": "tags",
    "subject": "subject_tag_definitions",
    "status": "status_tag_definitions",
    "user": "user_tag_definitions",
}
SCENES = [
    {"id": "resource_list", "label": "单页素材 · 查询", "kind": "query"},
    {"id": "resource_create", "label": "单页素材 · 导入", "kind": "create"},
    {"id": "show_list", "label": "放映素材 · 查询", "kind": "query"},
    {"id": "show_create", "label": "放映素材 · 新建", "kind": "create"},
    {"id": "standard_show_list", "label": "标准放映 · 查询", "kind": "query"},
    {"id": "resource_picker", "label": "放映内 · 选择素材", "kind": "query"},
    {"id": "resource_manage", "label": "素材管理 · 查询", "kind": "query"},
    {"id": "user_list", "label": "用户管理 · 查询", "kind": "query"},
]


def scene_domains(scene: str) -> list[str]:
    return ["user"] if scene == "user_list" else ["subject", "status", "resource"]


def migrate_tag_defaults(db: sqlite3.Connection, schema_version: int) -> None:
    db.execute("""CREATE TABLE IF NOT EXISTS tag_default_rules (
        scene TEXT NOT NULL, domain TEXT NOT NULL, tag_id INTEGER NOT NULL,
        PRIMARY KEY (scene, domain, tag_id)
    )""")
    db.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_defaults_single
        ON tag_default_rules(scene, domain) WHERE domain IN ('subject', 'status')""")
    # The version gate is essential: clearing defaults must survive a restart.
    if schema_version < 28:
        for domain, table in DOMAIN_TABLES.items():
            scenes = ["user_list"] if domain == "user" else ["resource_list", "resource_manage"]
            rows = db.execute(
                f"SELECT id FROM {table} WHERE is_default_filter = 1 ORDER BY sort_order, id"
            ).fetchall()
            if domain in ("subject", "status"):
                rows = rows[:1]
            for scene in scenes:
                for row in rows:
                    db.execute("INSERT OR IGNORE INTO tag_default_rules VALUES (?, ?, ?)",
                               (scene, domain, row["id"]))
    sync_legacy_flags(db)


def sync_legacy_flags(db: sqlite3.Connection) -> None:
    """Legacy columns are projections, never a second source of configuration."""
    for domain, table in DOMAIN_TABLES.items():
        scene = "user_list" if domain == "user" else "resource_list"
        db.execute(f"""UPDATE {table} SET is_default_filter = CASE WHEN id IN (
            SELECT tag_id FROM tag_default_rules WHERE scene = ? AND domain = ?
        ) THEN 1 ELSE 0 END""", (scene, domain))


def admin_defaults(db: sqlite3.Connection) -> dict[str, Any]:
    defaults = {s["id"]: {domain: [] for domain in scene_domains(s["id"])} for s in SCENES}
    for domain, table in DOMAIN_TABLES.items():
        rows = db.execute(f"""SELECT r.scene, r.tag_id FROM tag_default_rules r
            JOIN {table} t ON t.id = r.tag_id WHERE r.domain = ? ORDER BY t.sort_order, t.id""",
            (domain,)).fetchall()
        for row in rows:
            if row["scene"] in defaults and domain in defaults[row["scene"]]:
                defaults[row["scene"]][domain].append(row["tag_id"])
    return {"scenes": [{**s, "domains": scene_domains(s["id"])} for s in SCENES], "defaults": defaults}


def resolved_defaults(db: sqlite3.Connection) -> dict[str, Any]:
    definitions = {
        domain: {row["id"]: row["name"] for row in db.execute(f"SELECT id, name FROM {table}")}
        for domain, table in DOMAIN_TABLES.items()
    }
    result: dict[str, Any] = {}
    for scene, slots in admin_defaults(db)["defaults"].items():
        result[scene] = {}
        for domain, ids in slots.items():
            names = [definitions[domain][tag_id] for tag_id in ids]
            key = {"resource": "resource_tags", "user": "user_tags"}.get(domain, domain)
            result[scene][key] = (names[0] if names else None) if domain in ("subject", "status") else names
    return result


def update_defaults(db: sqlite3.Connection, changes: list[dict[str, Any]]) -> dict[str, Any]:
    try:
        if not db.in_transaction:
            db.execute("BEGIN IMMEDIATE")
        allowed_scenes = {s["id"] for s in SCENES}
        seen: set[tuple[str, str]] = set()
        # Validate the entire batch before writing any part of it.
        for change in changes:
            scene, domain, ids = change["scene"], change["domain"], change["tag_ids"]
            if scene not in allowed_scenes or domain not in scene_domains(scene):
                raise HTTPException(400, "该场景不支持此标签类型")
            if (scene, domain) in seen:
                raise HTTPException(400, "同一场景的标签类型不能重复提交")
            seen.add((scene, domain))
            if len(set(ids)) != len(ids) or (domain in ("subject", "status") and len(ids) > 1):
                raise HTTPException(400, "主体和状态最多选择一个，标签不能重复")
            available = {r["id"] for r in db.execute(f"SELECT id FROM {DOMAIN_TABLES[domain]}")}
            if not set(ids).issubset(available):
                raise HTTPException(400, "默认设置包含不存在的标签，请刷新后重试")
        for change in changes:
            scene, domain = change["scene"], change["domain"]
            db.execute("DELETE FROM tag_default_rules WHERE scene = ? AND domain = ?", (scene, domain))
            db.executemany("INSERT INTO tag_default_rules VALUES (?, ?, ?)",
                           [(scene, domain, tag_id) for tag_id in change["tag_ids"]])
        sync_legacy_flags(db)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return admin_defaults(db)


def tag_scopes(db: sqlite3.Connection, table: str) -> dict[int, list[str]]:
    domain = next(key for key, value in DOMAIN_TABLES.items() if value == table)
    result: dict[int, list[str]] = {}
    for row in db.execute("SELECT tag_id, scene FROM tag_default_rules WHERE domain = ? ORDER BY scene", (domain,)):
        result.setdefault(row["tag_id"], []).append(row["scene"])
    return result


def delete_tag_defaults(db: sqlite3.Connection, table: str, tag_id: int) -> None:
    domain = next(key for key, value in DOMAIN_TABLES.items() if value == table)
    db.execute("DELETE FROM tag_default_rules WHERE domain = ? AND tag_id = ?", (domain, tag_id))
