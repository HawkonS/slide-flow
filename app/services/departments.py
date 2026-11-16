"""Department tree, membership and department-tag projection.

Departments are the authoritative organizational hierarchy.  Every non-root
department is projected into ``user_tag_definitions`` as a system-managed tag
(``dept:<id>``) so the existing tag based permission engine can grant access to
a department and all of its descendants without changing any ACL query.
"""
from __future__ import annotations

import sqlite3
import unicodedata
from collections import defaultdict
from typing import Any, Iterable

from fastapi import HTTPException

from app.db import now_iso
from app.services.tag_defaults import delete_tag_defaults

DEPARTMENT_TAG_PREFIX = "dept:"
ROOT_DEPARTMENT_NAME = "全部"
MAX_DEPARTMENT_DEPTH = 20
MAX_DEPARTMENTS = 5000
MAX_MEMBERS_PER_REQUEST = 1000
MAX_DEPARTMENTS_PER_USER = 50
EMPLOYMENT_STATUSES = {"active", "resigned", "frozen", "unknown"}

SCOPE_RELATION_TABLES = (
    "resource_visibility_tags",
    "resource_management_tags",
    "show_visibility_tags",
    "show_management_tags",
    "template_visibility_tags",
    "template_management_tags",
)
def department_tag_name(department_id: int) -> str:
    return f"{DEPARTMENT_TAG_PREFIX}{int(department_id)}"


def validate_department_name(value: str | None) -> str:
    name = (value or "").strip()
    if not name:
        raise HTTPException(400, "部门名称不能为空")
    if len(name) > 64:
        raise HTTPException(400, "部门名称不能超过 64 个字符")
    if any(unicodedata.category(char).startswith("C") for char in name):
        raise HTTPException(400, "部门名称不能包含控制字符")
    return name


def get_root_department(db: sqlite3.Connection) -> sqlite3.Row:
    row = db.execute(
        "SELECT * FROM departments WHERE parent_id IS NULL ORDER BY id LIMIT 1"
    ).fetchone()
    if row is None:
        raise RuntimeError("部门根节点不存在，请检查数据库迁移")
    return row


def get_department(db: sqlite3.Connection, department_id: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM departments WHERE id = ?", (int(department_id),)).fetchone()
    if row is None:
        raise HTTPException(404, "部门不存在")
    return row


def display_path(path: str, names: dict[int, str], root_id: int | None = None) -> str:
    """Turn the internal ``/1/4/9/`` path into a human-readable name path."""
    parts: list[str] = []
    for raw in str(path or "").split("/"):
        raw = raw.strip()
        if not raw:
            continue
        try:
            department_id = int(raw)
        except ValueError:
            continue
        if root_id is not None and department_id == int(root_id):
            continue
        parts.append(names.get(department_id, raw))
    return " / ".join(parts)


def _next_sort_order(db: sqlite3.Connection, parent_id: int) -> int:
    row = db.execute(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM departments WHERE parent_id = ?",
        (int(parent_id),),
    ).fetchone()
    return int(row[0]) if row else 1


def _get_department_tag(db: sqlite3.Connection, department_id: int) -> sqlite3.Row | None:
    return db.execute(
        "SELECT * FROM user_tag_definitions WHERE department_id = ? LIMIT 1",
        (int(department_id),),
    ).fetchone()


def ensure_department_tag(db: sqlite3.Connection, department: sqlite3.Row) -> sqlite3.Row:
    """Create or refresh the system tag that represents a department."""
    department_id = int(department["id"])
    tag_name = department_tag_name(department_id)
    existing = _get_department_tag(db, department_id)
    if existing is not None:
        if str(existing["label"]) != str(department["name"]):
            db.execute(
                "UPDATE user_tag_definitions SET label = ? WHERE id = ?",
                (str(department["name"]), int(existing["id"])),
            )
            existing = _get_department_tag(db, department_id)
        return existing
    collision = db.execute(
        "SELECT id, department_id FROM user_tag_definitions WHERE name = ? LIMIT 1",
        (tag_name,),
    ).fetchone()
    if collision is not None:
        raise HTTPException(
            409,
            "部门标签名称已被手工标签占用，请先重命名该手工标签",
        )
    ts = now_iso()
    cursor = db.execute(
        "INSERT INTO user_tag_definitions "
        "(name, category, label, sort_order, is_default_filter, department_id, created_by, created_at) "
        "VALUES (?, '组织架构', ?, ?, 0, ?, NULL, ?)",
        (
            tag_name,
            str(department["name"]),
            int(department["sort_order"]),
            department_id,
            ts,
        ),
    )
    row = db.execute(
        "SELECT * FROM user_tag_definitions WHERE id = ?",
        (int(cursor.lastrowid),),
    ).fetchone()
    assert row is not None
    return row


def _department_tag(db: sqlite3.Connection, department_id: int) -> sqlite3.Row | None:
    return _get_department_tag(db, department_id)


def create_department(
    db: sqlite3.Connection,
    *,
    name: str,
    parent_id: int,
    created_by: int | None = None,
    sort_order: int | None = None,
) -> sqlite3.Row:
    parent = get_department(db, parent_id)
    if not bool(parent["is_active"]):
        raise HTTPException(400, "上级部门已停用，不能在其下创建部门")
    clean_name = validate_department_name(name)
    depth = int(parent["depth"]) + 1
    if depth > MAX_DEPARTMENT_DEPTH:
        raise HTTPException(400, f"部门层级不能超过 {MAX_DEPARTMENT_DEPTH} 层")
    total = int(db.execute("SELECT COUNT(*) FROM departments").fetchone()[0])
    if total >= MAX_DEPARTMENTS:
        raise HTTPException(400, f"部门数量不能超过 {MAX_DEPARTMENTS} 个")
    ts = now_iso()
    order = _next_sort_order(db, int(parent_id)) if sort_order is None else int(sort_order)
    try:
        cursor = db.execute(
            "INSERT INTO departments "
            "(parent_id, name, path, depth, sort_order, is_active, "
            " external_source, external_id, created_by, created_at, updated_at) "
            "VALUES (?, ?, '', ?, ?, 1, '', '', ?, ?, ?)",
            (int(parent_id), clean_name, depth, order, created_by, ts, ts),
        )
    except sqlite3.IntegrityError:
        raise HTTPException(409, "同级部门名称已存在") from None
    department_id = int(cursor.lastrowid)
    db.execute(
        "UPDATE departments SET path = ? WHERE id = ?",
        (f"{parent['path']}{department_id}/", department_id),
    )
    department = get_department(db, department_id)
    ensure_department_tag(db, department)
    return department


def _subtree_rows(db: sqlite3.Connection, department: sqlite3.Row) -> list[sqlite3.Row]:
    return db.execute(
        "SELECT id, path, depth FROM departments WHERE path LIKE ? ORDER BY depth, id",
        (f"{department['path']}%",),
    ).fetchall()


def _users_in_subtree(db: sqlite3.Connection, path_prefix: str) -> list[int]:
    rows = db.execute(
        "SELECT DISTINCT m.user_id FROM department_members m "
        "JOIN departments d ON d.id = m.department_id "
        "WHERE d.path LIKE ?",
        (f"{path_prefix}%",),
    ).fetchall()
    return [int(row["user_id"]) for row in rows]


def update_department(
    db: sqlite3.Connection,
    department_id: int,
    *,
    name: str | None = None,
    parent_id: int | None = None,
    sort_order: int | None = None,
    is_active: bool | None = None,
) -> sqlite3.Row:
    department = get_department(db, department_id)
    if department["parent_id"] is None:
        raise HTTPException(400, "根部门不能修改")
    changed = False
    moved = False
    new_path: str | None = None
    if name is not None:
        clean_name = validate_department_name(name)
        if clean_name != str(department["name"]):
            try:
                db.execute(
                    "UPDATE departments SET name = ?, updated_at = ? WHERE id = ?",
                    (clean_name, now_iso(), department_id),
                )
            except sqlite3.IntegrityError:
                raise HTTPException(409, "同级部门名称已存在") from None
            changed = True
    if parent_id is not None and int(parent_id) != int(department["parent_id"]):
        new_parent = get_department(db, parent_id)
        if int(new_parent["id"]) == int(department["id"]):
            raise HTTPException(400, "不能把部门移动到自身")
        if str(new_parent["path"]).startswith(str(department["path"])):
            raise HTTPException(400, "不能把部门移动到自己的下级")
        old_path = str(department["path"])
        new_path = f"{new_parent['path']}{department['id']}/"
        deepest = db.execute(
            "SELECT MAX(depth) FROM departments WHERE path LIKE ?",
            (f"{old_path}%",),
        ).fetchone()[0]
        relative_depth = int(deepest or department["depth"]) - int(department["depth"])
        if int(new_parent["depth"]) + 1 + relative_depth > MAX_DEPARTMENT_DEPTH:
            raise HTTPException(400, f"移动后部门层级不能超过 {MAX_DEPARTMENT_DEPTH} 层")
        depth_delta = int(new_parent["depth"]) + 1 - int(department["depth"])
        try:
            db.execute(
                "UPDATE departments SET parent_id = ?, updated_at = ? WHERE id = ?",
                (int(parent_id), now_iso(), department_id),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "同级部门名称已存在") from None
        for row in _subtree_rows(db, department):
            old_subtree_path = str(row["path"])
            suffix = old_subtree_path[len(old_path):]
            db.execute(
                "UPDATE departments SET path = ?, depth = ? WHERE id = ?",
                (f"{new_path}{suffix}", int(row["depth"]) + depth_delta, int(row["id"])),
            )
        moved = True
        changed = True
    if sort_order is not None:
        db.execute(
            "UPDATE departments SET sort_order = ?, updated_at = ? WHERE id = ?",
            (int(sort_order), now_iso(), department_id),
        )
        changed = True
    if is_active is not None:
        db.execute(
            "UPDATE departments SET is_active = ?, updated_at = ? WHERE id = ?",
            (1 if is_active else 0, now_iso(), department_id),
        )
        changed = True
    if not changed:
        return department
    updated = get_department(db, department_id)
    ensure_department_tag(db, updated)
    if moved:
        recompute_department_tags(db, _users_in_subtree(db, str(updated["path"])))
    return updated


def department_usage_counts(db: sqlite3.Connection, department_id: int) -> dict[str, Any]:
    tag = _department_tag(db, department_id)
    usage: dict[str, int] = {}
    if tag is not None:
        tag_id = int(tag["id"])
        tag_name = str(tag["name"])
        for table in SCOPE_RELATION_TABLES:
            row = db.execute(
                f"SELECT COUNT(*) FROM {table} "
                "WHERE tag_id = ? OR (tag_id IS NULL AND tag_name = ?)",
                (tag_id, tag_name),
            ).fetchone()
            usage[table] = int(row[0]) if row else 0
    else:
        for table in SCOPE_RELATION_TABLES:
            usage[table] = 0
    member_count = int(
        db.execute(
            "SELECT COUNT(*) FROM department_members WHERE department_id = ?",
            (int(department_id),),
        ).fetchone()[0]
    )
    child_count = int(
        db.execute(
            "SELECT COUNT(*) FROM departments WHERE parent_id = ?",
            (int(department_id),),
        ).fetchone()[0]
    )
    return {
        "departments": usage,
        "grants": sum(usage.values()),
        "members": member_count,
        "children": child_count,
        "tag_id": int(tag["id"]) if tag is not None else None,
    }


def delete_department(
    db: sqlite3.Connection,
    department_id: int,
    *,
    force: bool = False,
) -> dict[str, Any]:
    department = get_department(db, department_id)
    if department["parent_id"] is None:
        raise HTTPException(400, "根部门不能删除")
    usage = department_usage_counts(db, department_id)
    if usage["children"]:
        raise HTTPException(409, "请先移动或删除下级部门")
    if not force and (usage["members"] or usage["grants"]):
        raise HTTPException(
            409,
            "该部门仍有成员或可见/管理授权，确认影响后使用强制删除",
        )
    tag = _department_tag(db, department_id)
    if tag is not None:
        delete_tag_defaults(db, "user_tag_definitions", int(tag["id"]))
        db.execute(
            "DELETE FROM user_tags WHERE tag_id = ? OR (tag_id IS NULL AND tag_name = ?)",
            (int(tag["id"]), str(tag["name"])),
        )
        db.execute("DELETE FROM user_tag_definitions WHERE id = ?", (int(tag["id"]),))
    db.execute("DELETE FROM departments WHERE id = ?", (int(department_id),))
    return usage


def _validate_user_ids(db: sqlite3.Connection, user_ids: Iterable[int]) -> list[int]:
    ids: list[int] = []
    for raw in user_ids:
        value = int(raw)
        if value > 0 and value not in ids:
            ids.append(value)
    if len(ids) > MAX_MEMBERS_PER_REQUEST:
        raise HTTPException(400, f"单次最多操作 {MAX_MEMBERS_PER_REQUEST} 位成员")
    if ids:
        placeholders = ",".join("?" for _ in ids)
        existing = {
            int(row["id"])
            for row in db.execute(
                f"SELECT id FROM users WHERE id IN ({placeholders})", ids
            ).fetchall()
        }
        missing = [value for value in ids if value not in existing]
        if missing:
            raise HTTPException(400, "存在已删除的用户，请重新选择")
    return ids


def _current_manual_members(db: sqlite3.Connection, department_id: int) -> list[int]:
    rows = db.execute(
        "SELECT user_id FROM department_members "
        "WHERE department_id = ? AND source = 'manual'",
        (int(department_id),),
    ).fetchall()
    return [int(row["user_id"]) for row in rows]


def add_department_members(
    db: sqlite3.Connection,
    department_id: int,
    user_ids: Iterable[int],
) -> None:
    department = get_department(db, department_id)
    if not bool(department["is_active"]):
        raise HTTPException(400, "部门已停用，不能添加成员")
    ids = _validate_user_ids(db, user_ids)
    ts = now_iso()
    try:
        db.executemany(
            "INSERT OR IGNORE INTO department_members "
            "(user_id, department_id, source, created_at) VALUES (?, ?, 'manual', ?)",
            [(user_id, int(department_id), ts) for user_id in ids],
        )
    except sqlite3.IntegrityError:
        raise HTTPException(409, "成员关系写入冲突，请刷新后重试") from None
    recompute_department_tags(db, ids)


def replace_manual_members(
    db: sqlite3.Connection,
    department_id: int,
    user_ids: Iterable[int],
) -> None:
    department = get_department(db, department_id)
    if not bool(department["is_active"]):
        raise HTTPException(400, "部门已停用，不能修改成员")
    ids = _validate_user_ids(db, user_ids)
    old_ids = _current_manual_members(db, department_id)
    db.execute(
        "DELETE FROM department_members WHERE department_id = ? AND source = 'manual'",
        (int(department_id),),
    )
    ts = now_iso()
    db.executemany(
        "INSERT OR IGNORE INTO department_members "
        "(user_id, department_id, source, created_at) VALUES (?, ?, 'manual', ?)",
        [(user_id, int(department_id), ts) for user_id in ids],
    )
    recompute_department_tags(db, sorted(set(old_ids) | set(ids)))


def remove_department_member(
    db: sqlite3.Connection,
    department_id: int,
    user_id: int,
) -> None:
    get_department(db, department_id)
    db.execute(
        "DELETE FROM department_members WHERE department_id = ? AND user_id = ?",
        (int(department_id), int(user_id)),
    )
    recompute_department_tags(db, [int(user_id)])


def set_department_leaders(
    db: sqlite3.Connection,
    department_id: int,
    user_ids: Iterable[int],
    primary_user_id: int | None = None,
) -> None:
    department = get_department(db, department_id)
    if department["parent_id"] is None:
        raise HTTPException(400, "根部门不能设置负责人")
    ids = _validate_user_ids(db, user_ids)
    primary = int(primary_user_id) if primary_user_id is not None else None
    if primary is not None and primary not in ids:
        raise HTTPException(400, "主负责人必须在负责人列表中")
    ts = now_iso()
    # Manual leader editing is authoritative for this department; Feishu sync
    # will re-populate its own leaders on the next run.
    db.execute("DELETE FROM department_leaders WHERE department_id = ?", (int(department_id),))
    db.executemany(
        "INSERT INTO department_leaders "
        "(department_id, user_id, is_primary, source, sort_order, created_at) "
        "VALUES (?, ?, ?, 'manual', ?, ?)",
        [
            (
                int(department_id),
                user_id,
                1 if primary is not None and user_id == primary else 0,
                index,
                ts,
            )
            for index, user_id in enumerate(ids)
        ],
    )


def list_department_leaders(
    db: sqlite3.Connection,
    department_ids: Iterable[int],
) -> dict[int, list[dict[str, Any]]]:
    ids = [int(value) for value in department_ids]
    if not ids:
        return {}
    placeholders = ",".join("?" for _ in ids)
    rows = db.execute(
        "SELECT l.department_id, l.user_id, l.is_primary, l.source, "
        "u.name, u.username, u.avatar_url "
        "FROM department_leaders l JOIN users u ON u.id = l.user_id "
        f"WHERE l.department_id IN ({placeholders}) "
        "ORDER BY l.is_primary DESC, l.sort_order, u.name COLLATE NOCASE, u.id",
        ids,
    ).fetchall()
    result: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        result[int(row["department_id"])].append(
            {
                "user_id": int(row["user_id"]),
                "name": row["name"],
                "username": row["username"],
                "avatar_url": row["avatar_url"] or "",
                "is_primary": bool(row["is_primary"]),
                "source": row["source"],
            }
        )
    return dict(result)


def list_user_departments(
    db: sqlite3.Connection,
    user_ids: Iterable[int],
) -> dict[int, list[dict[str, Any]]]:
    ids = [int(value) for value in user_ids]
    if not ids:
        return {}
    result: dict[int, list[dict[str, Any]]] = defaultdict(list)
    try:
        department_rows = db.execute("SELECT id, name, path FROM departments").fetchall()
        root = get_root_department(db)
    except sqlite3.OperationalError:
        return {}
    names = {int(row["id"]): str(row["name"]) for row in department_rows}
    chunk_size = 500
    for start in range(0, len(ids), chunk_size):
        chunk = ids[start:start + chunk_size]
        placeholders = ",".join("?" for _ in chunk)
        try:
            rows = db.execute(
                "SELECT m.user_id, m.source, d.id, d.name, d.path "
                "FROM department_members m JOIN departments d ON d.id = m.department_id "
                f"WHERE m.user_id IN ({placeholders}) "
                "ORDER BY d.path COLLATE NOCASE, d.id",
                chunk,
            ).fetchall()
        except sqlite3.OperationalError:
            # Older or intentionally minimal databases may not have the
            # directory tables yet; user identity must still be readable.
            return {}
        for row in rows:
            result[int(row["user_id"])].append(
                {
                    "id": int(row["id"]),
                    "name": row["name"],
                    "path": row["path"],
                    "path_names": display_path(str(row["path"]), names, int(root["id"])),
                    "source": row["source"],
                }
            )
    return dict(result)


def department_member_counts(db: sqlite3.Connection) -> tuple[dict[int, int], dict[int, int]]:
    """Return ``(direct_counts, subtree_counts)`` keyed by department id."""
    direct = {
        int(row["department_id"]): int(row["count"])
        for row in db.execute(
            "SELECT department_id, COUNT(*) AS count FROM department_members GROUP BY department_id"
        ).fetchall()
    }
    subtree_rows = db.execute(
        "SELECT d.id AS department_id, COUNT(DISTINCT m.user_id) AS count "
        "FROM departments d "
        "JOIN departments child ON child.path LIKE d.path || '%' "
        "JOIN department_members m ON m.department_id = child.id "
        "GROUP BY d.id"
    ).fetchall()
    subtree = {int(row["department_id"]): int(row["count"]) for row in subtree_rows}
    return direct, subtree


def department_stats(db: sqlite3.Connection) -> dict[str, Any]:
    root = get_root_department(db)
    people_count = int(db.execute("SELECT COUNT(*) FROM users").fetchone()[0])
    department_count = int(
        db.execute("SELECT COUNT(*) FROM departments WHERE parent_id IS NOT NULL").fetchone()[0]
    )
    unassigned_count = int(
        db.execute(
            "SELECT COUNT(*) FROM users u WHERE NOT EXISTS "
            "(SELECT 1 FROM department_members m WHERE m.user_id = u.id)"
        ).fetchone()[0]
    )
    sync_row = db.execute(
        "SELECT finished_at, started_at, status, summary_json "
        "FROM directory_sync_runs ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return {
        "root_id": int(root["id"]),
        "people_count": people_count,
        "department_count": department_count,
        "unassigned_count": unassigned_count,
        "last_synced_at": (
            (sync_row["finished_at"] or sync_row["started_at"])
            if sync_row is not None
            else None
        ),
        "last_sync_status": sync_row["status"] if sync_row is not None else None,
    }


def list_departments(db: sqlite3.Connection, *, include_inactive: bool = False) -> list[sqlite3.Row]:
    where = "" if include_inactive else "WHERE is_active = 1 OR parent_id IS NULL"
    return db.execute(
        f"SELECT * FROM departments {where} ORDER BY path COLLATE NOCASE, sort_order, id"
    ).fetchall()


def list_departments_with_counts(
    db: sqlite3.Connection,
    *,
    include_inactive: bool = False,
) -> list[dict[str, Any]]:
    rows = list_departments(db, include_inactive=include_inactive)
    direct, subtree = department_member_counts(db)
    leaders = list_department_leaders(db, [int(row["id"]) for row in rows])
    root = get_root_department(db)
    names = {int(row["id"]): str(row["name"]) for row in db.execute("SELECT id, name FROM departments").fetchall()}
    result: list[dict[str, Any]] = []
    for row in rows:
        department_id = int(row["id"])
        result.append(
            {
                "id": department_id,
                "parent_id": int(row["parent_id"]) if row["parent_id"] is not None else None,
                "name": row["name"],
                "path": row["path"],
                "path_names": display_path(str(row["path"]), names, int(root["id"])),
                "depth": int(row["depth"]),
                "sort_order": int(row["sort_order"]),
                "is_active": bool(row["is_active"]),
                "external_source": row["external_source"],
                "direct_member_count": direct.get(department_id, 0),
                "member_count": subtree.get(department_id, 0),
                "leaders": leaders.get(department_id, []),
            }
        )
    return result


def validate_department_ids(
    db: sqlite3.Connection,
    values: Iterable[int],
    *,
    allow_inactive: bool = False,
) -> list[int]:
    ids: list[int] = []
    for raw in values:
        value = int(raw)
        if value <= 0:
            continue
        if value not in ids:
            ids.append(value)
    if len(ids) > MAX_DEPARTMENTS_PER_USER:
        raise HTTPException(400, f"单个用户最多属于 {MAX_DEPARTMENTS_PER_USER} 个部门")
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    rows = db.execute(
        f"SELECT id, is_active FROM departments WHERE id IN ({placeholders})",
        ids,
    ).fetchall()
    existing = {int(row["id"]): bool(row["is_active"]) for row in rows}
    if len(existing) != len(ids):
        raise HTTPException(400, "部门不存在或已被删除，请重新选择")
    inactive = [value for value, active in existing.items() if not active]
    if inactive and not allow_inactive:
        raise HTTPException(400, "不能把用户分配到已停用的部门")
    return ids


def set_user_departments(
    db: sqlite3.Connection,
    user_id: int,
    department_ids: Iterable[int],
    *,
    allow_inactive: bool = False,
) -> None:
    ids = validate_department_ids(db, department_ids, allow_inactive=allow_inactive)
    old_feishu_ids = {
        int(row["department_id"])
        for row in db.execute(
            "SELECT department_id FROM department_members "
            "WHERE user_id = ? AND source = 'feishu'",
            (int(user_id),),
        ).fetchall()
    }
    # Manual edits replace the user's manual memberships while keeping rows
    # written by Feishu synchronization intact.
    db.execute(
        "DELETE FROM department_members WHERE user_id = ? AND source = 'manual'",
        (int(user_id),),
    )
    ts = now_iso()
    for department_id in ids:
        if department_id in old_feishu_ids:
            continue
        db.execute(
            "INSERT OR IGNORE INTO department_members "
            "(user_id, department_id, source, created_at) VALUES (?, ?, 'manual', ?)",
            (int(user_id), int(department_id), ts),
        )
    recompute_department_tags(db, [int(user_id)])


def recompute_department_tags(
    db: sqlite3.Connection,
    user_ids: Iterable[int] | None = None,
) -> None:
    """Refresh the projected ``dept:<id>`` tag rows for affected users."""
    if user_ids is None:
        rows = db.execute(
            "SELECT DISTINCT user_id FROM department_members "
            "UNION SELECT DISTINCT ut.user_id FROM user_tags ut "
            "JOIN user_tag_definitions def ON def.id = ut.tag_id "
            "WHERE def.department_id IS NOT NULL"
        ).fetchall()
        targets = [int(row["user_id"]) for row in rows]
    else:
        targets = sorted({int(value) for value in user_ids if int(value) > 0})
    if not targets:
        return
    chunk_size = 400
    for start in range(0, len(targets), chunk_size):
        chunk = targets[start:start + chunk_size]
        placeholders = ",".join("?" for _ in chunk)
        db.execute(
            f"DELETE FROM user_tags WHERE user_id IN ({placeholders}) AND ("
            "tag_id IN (SELECT id FROM user_tag_definitions WHERE department_id IS NOT NULL) "
            "OR (tag_id IS NULL AND tag_name LIKE 'dept:%'))",
            chunk,
        )
        rows = db.execute(
            "SELECT DISTINCT m.user_id, def.id AS tag_id, def.name AS tag_name "
            "FROM department_members m "
            "JOIN departments unit ON unit.id = m.department_id "
            "JOIN departments anc ON unit.path LIKE anc.path || '%' "
            "JOIN user_tag_definitions def ON def.department_id = anc.id "
            f"WHERE m.user_id IN ({placeholders})",
            chunk,
        ).fetchall()
        if rows:
            db.executemany(
                "INSERT OR IGNORE INTO user_tags (user_id, tag_name, tag_id) VALUES (?, ?, ?)",
                [
                    (int(row["user_id"]), str(row["tag_name"]), int(row["tag_id"]))
                    for row in rows
                ],
            )


def rebuild_department_tags(db: sqlite3.Connection) -> int:
    for department in db.execute(
        "SELECT * FROM departments WHERE parent_id IS NOT NULL"
    ).fetchall():
        ensure_department_tag(db, department)
    rows = db.execute("SELECT id FROM users").fetchall()
    recompute_department_tags(db, [int(row["id"]) for row in rows])
    return len(rows)


def serialize_usage(usage: dict[str, Any]) -> dict[str, Any]:
    labels = {
        "resource_visibility_tags": "资源可见",
        "resource_management_tags": "资源管理",
        "show_visibility_tags": "放映可见",
        "show_management_tags": "放映管理",
        "template_visibility_tags": "模板可见",
        "template_management_tags": "模板管理",
    }
    items = [
        {"key": key, "label": labels.get(key, key), "count": count}
        for key, count in (usage.get("departments") or {}).items()
        if count
    ]
    return {
        "items": items,
        "grants": int(usage.get("grants") or 0),
        "members": int(usage.get("members") or 0),
        "children": int(usage.get("children") or 0),
        "tag_id": usage.get("tag_id"),
    }
