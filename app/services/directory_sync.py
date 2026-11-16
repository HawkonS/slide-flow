"""Synchronize the Feishu directory into live departments and users."""
from __future__ import annotations

import json
import re
import secrets
import sqlite3
import unicodedata
from datetime import datetime, timedelta
from typing import Any

from fastapi import HTTPException

from app.config import settings
from app.core.feishu import (
    FeishuAPIError,
    FeishuDepartmentInfo,
    FeishuUserInfo,
    get_directory_tree,
    get_tenant_access_token,
)
from app.core.security import hash_password
from app.core.user_profiles import (
    is_managed_avatar_ref,
    normalise_display_name,
    normalise_username,
    username_lookup_key,
    validate_avatar_url,
)
from app.db import now_iso
from app.services import departments as department_service

USERNAME_MAX_LENGTH = 50
DEPARTMENT_NAME_MAX_LENGTH = 64


def _clean_department_name(value: str, fallback: str) -> str:
    name = unicodedata.normalize("NFKC", str(value or "")).strip()
    name = "".join(char for char in name if not unicodedata.category(char).startswith("C"))
    if not name:
        name = fallback
    return name[:DEPARTMENT_NAME_MAX_LENGTH]


def _unique_sibling_name(
    db: sqlite3.Connection,
    parent_id: int,
    desired: str,
    *,
    exclude_id: int | None = None,
) -> str:
    base = _clean_department_name(desired, "未命名部门")
    candidate = base
    suffix = 2
    while True:
        row = db.execute(
            "SELECT id FROM departments WHERE parent_id = ? AND name = ? LIMIT 1",
            (int(parent_id), candidate),
        ).fetchone()
        if row is None or (exclude_id is not None and int(row["id"]) == int(exclude_id)):
            return candidate
        tail = f" ({suffix})"
        candidate = f"{base[:max(1, DEPARTMENT_NAME_MAX_LENGTH - len(tail))]}{tail}"
        suffix += 1
        if suffix > 9999:
            return f"{base[:50]} {secrets.token_hex(3)}"


def _display_name(value: str, open_id: str) -> str:
    try:
        return normalise_display_name(value)
    except ValueError:
        fallback = f"飞书用户 {open_id[-6:]}" if open_id else "飞书用户"
        return fallback[:100]


def _safe_avatar(value: str) -> str:
    try:
        return validate_avatar_url(value)
    except ValueError:
        return ""


def _username_seed(user: FeishuUserInfo) -> str:
    raw = ""
    if user.email:
        raw = user.email.split("@", 1)[0]
    if not raw:
        raw = user.name or user.open_id
    safe = re.sub(r"[^\w\u4e00-\u9fff]", "", unicodedata.normalize("NFKC", raw))
    safe = safe[:USERNAME_MAX_LENGTH]
    if len(safe) < 2:
        safe = f"feishu_{safe}" if safe else "feishu_user"
    return safe


def _unique_username(db: sqlite3.Connection, user: FeishuUserInfo) -> str:
    base = _username_seed(user)
    candidate = base
    index = 2
    while True:
        try:
            normalised = normalise_username(candidate)
        except ValueError:
            normalised = f"feishu_user_{index}"
        key = username_lookup_key(normalised)
        row = db.execute(
            "SELECT 1 FROM users WHERE username = ? OR username_key = ? LIMIT 1",
            (normalised, key),
        ).fetchone()
        if row is None:
            return normalised
        suffix = f"_{index}"
        candidate = f"{base[:max(2, USERNAME_MAX_LENGTH - len(suffix))]}{suffix}"
        index += 1
        if index > 9999:
            candidate = f"feishu_{secrets.token_hex(6)}"


def _ensure_local_user(
    db: sqlite3.Connection,
    user: FeishuUserInfo,
) -> tuple[int, bool, bool]:
    """Return ``(user_id, created, changed)`` for one Feishu user."""
    existing = db.execute(
        "SELECT * FROM users WHERE feishu_id = ? LIMIT 1",
        (user.open_id,),
    ).fetchone()
    display_name = _display_name(user.name, user.open_id)
    email = (user.email or user.enterprise_email or "").strip()[:254]
    avatar_url = _safe_avatar(user.avatar_url)
    employment_status = user.employment_status if user.employment_status in {
        "active",
        "resigned",
        "frozen",
        "unknown",
    } else "active"
    if existing is None:
        username = _unique_username(db, user)
        ts = now_iso()
        cursor = db.execute(
            "INSERT INTO users "
            "(name, username, username_key, password_hash, feishu_id, avatar_url, tags, "
            " email, job_title, employee_no, employment_status, role, must_change_pwd, "
            " created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, 'user', 0, ?, ?)",
            (
                display_name,
                username,
                username_lookup_key(username),
                hash_password(secrets.token_urlsafe(16)),
                user.open_id,
                avatar_url,
                email,
                (user.job_title or "").strip()[:100],
                (user.employee_no or "").strip()[:64],
                employment_status,
                ts,
                ts,
            ),
        )
        return int(cursor.lastrowid), True, True

    changes: list[str] = []
    values: list[str] = []
    if display_name and display_name != (existing["name"] or ""):
        changes.append("name = ?")
        values.append(display_name)
    if (
        avatar_url
        and avatar_url != (existing["avatar_url"] or "")
        and not is_managed_avatar_ref(existing["avatar_url"] or "", user_id=int(existing["id"]))
    ):
        changes.append("avatar_url = ?")
        values.append(avatar_url)
    if email and email != (existing["email"] or ""):
        changes.append("email = ?")
        values.append(email)
    job_title = (user.job_title or "").strip()[:100]
    if job_title and job_title != (existing["job_title"] or ""):
        changes.append("job_title = ?")
        values.append(job_title)
    employee_no = (user.employee_no or "").strip()[:64]
    if employee_no and employee_no != (existing["employee_no"] or ""):
        changes.append("employee_no = ?")
        values.append(employee_no)
    if employment_status != (existing["employment_status"] or "active"):
        changes.append("employment_status = ?")
        values.append(employment_status)
    if not changes:
        return int(existing["id"]), False, False
    changes.append("updated_at = ?")
    values.append(now_iso())
    values.append(str(existing["id"]))
    db.execute(f"UPDATE users SET {', '.join(changes)} WHERE id = ?", values)
    return int(existing["id"]), False, True


def _existing_external_departments(db: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    rows = db.execute(
        "SELECT * FROM departments WHERE external_source = 'feishu' AND external_id <> ''"
    ).fetchall()
    return {str(row["external_id"]): row for row in rows}


def _existing_feishu_users(db: sqlite3.Connection, open_ids: list[str]) -> dict[str, sqlite3.Row]:
    result: dict[str, sqlite3.Row] = {}
    chunk = 500
    for start in range(0, len(open_ids), chunk):
        part = open_ids[start:start + chunk]
        if not part:
            continue
        placeholders = ",".join("?" for _ in part)
        rows = db.execute(
            f"SELECT * FROM users WHERE feishu_id IN ({placeholders})",
            part,
        ).fetchall()
        for row in rows:
            result[str(row["feishu_id"])] = row
    return result


def _current_feishu_memberships(db: sqlite3.Connection, user_id: int) -> set[int]:
    rows = db.execute(
        "SELECT department_id FROM department_members "
        "WHERE user_id = ? AND source = 'feishu'",
        (int(user_id),),
    ).fetchall()
    return {int(row["department_id"]) for row in rows}


def _build_sync_result(
    *,
    dry_run: bool,
    departments_created: int = 0,
    departments_updated: int = 0,
    departments_deactivated: int = 0,
    users_created: int = 0,
    users_updated: int = 0,
    memberships_added: int = 0,
    memberships_removed: int = 0,
    leaders_set: int = 0,
    skipped_users: int = 0,
    warnings: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "dry_run": bool(dry_run),
        "departments_created": departments_created,
        "departments_updated": departments_updated,
        "departments_deactivated": departments_deactivated,
        "users_created": users_created,
        "users_updated": users_updated,
        "memberships_added": memberships_added,
        "memberships_removed": memberships_removed,
        "leaders_set": leaders_set,
        "skipped_users": skipped_users,
        "warnings": warnings or [],
    }


def _fetch_directory() -> tuple[list[FeishuDepartmentInfo], list[FeishuUserInfo]]:
    if not settings.feishu_sso_enabled:
        raise HTTPException(400, "请先启用飞书 SSO")
    app_id = settings.feishu_app_id.strip()
    app_secret = settings.feishu_app_secret.strip()
    if not app_id or not app_secret:
        raise HTTPException(400, "请先配置飞书 App ID 和 App Secret")
    try:
        token = get_tenant_access_token(app_id, app_secret)
        return get_directory_tree(token)
    except FeishuAPIError as exc:
        raise HTTPException(502, f"拉取飞书通讯录失败：{exc.msg}") from None


def _dry_run(
    db: sqlite3.Connection,
    feishu_departments: list[FeishuDepartmentInfo],
    feishu_users: list[FeishuUserInfo],
) -> dict[str, Any]:
    existing_departments = _existing_external_departments(db)
    fetched_ids = {item.open_department_id for item in feishu_departments}
    departments_created = sum(
        1 for item in feishu_departments if item.open_department_id not in existing_departments
    )
    departments_updated = 0
    for item in feishu_departments:
        row = existing_departments.get(item.open_department_id)
        if row is None:
            continue
        if (
            str(row["name"]) != item.name
            or bool(row["is_active"]) != bool(item.is_active)
        ):
            departments_updated += 1
    departments_deactivated = sum(
        1
        for external_id, row in existing_departments.items()
        if external_id not in fetched_ids and bool(row["is_active"])
    )
    existing_users = _existing_feishu_users(db, [item.open_id for item in feishu_users])
    users_created = sum(1 for item in feishu_users if item.open_id not in existing_users)
    users_updated = sum(
        1
        for item in feishu_users
        if item.open_id in existing_users
        and (
            str(existing_users[item.open_id]["name"] or "") != item.name
            or str(existing_users[item.open_id]["employment_status"] or "active") != item.employment_status
            or (
                (item.email or item.enterprise_email)
                and str(existing_users[item.open_id]["email"] or "")
                != (item.email or item.enterprise_email)
            )
        )
    )
    memberships_added = 0
    memberships_removed = 0
    for item in feishu_users:
        row = existing_users.get(item.open_id)
        if row is None:
            continue
        current = _current_feishu_memberships(db, int(row["id"]))
        desired = {external_id for external_id in item.department_ids if external_id in fetched_ids}
        memberships_added += len(desired - current)
        memberships_removed += len(current - desired)
    leaders_set = sum(len(item.leader_open_ids) for item in feishu_departments)
    return _build_sync_result(
        dry_run=True,
        departments_created=departments_created,
        departments_updated=departments_updated,
        departments_deactivated=departments_deactivated,
        users_created=users_created,
        users_updated=users_updated,
        memberships_added=memberships_added,
        memberships_removed=memberships_removed,
        leaders_set=leaders_set,
    )


def _ordered_departments(
    feishu_departments: list[FeishuDepartmentInfo],
) -> list[FeishuDepartmentInfo]:
    by_id = {item.open_department_id: item for item in feishu_departments}
    result: list[FeishuDepartmentInfo] = []
    seen: set[str] = set()

    def visit(item: FeishuDepartmentInfo, stack: set[str]) -> None:
        if item.open_department_id in seen:
            return
        parent = by_id.get(item.parent_department_id)
        if parent is not None and parent.open_department_id not in seen:
            if parent.open_department_id in stack:
                return
            visit(parent, {*stack, item.open_department_id})
        if item.open_department_id not in seen:
            seen.add(item.open_department_id)
            result.append(item)

    for item in feishu_departments:
        visit(item, set())
    return result


def sync_feishu_directory(
    db: sqlite3.Connection,
    *,
    actor_id: int,
    dry_run: bool = False,
) -> dict[str, Any]:
    feishu_departments, feishu_users = _fetch_directory()
    if dry_run:
        return _dry_run(db, feishu_departments, feishu_users)

    started_at = now_iso()
    run_id: int | None = None
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    try:
        cursor = db.execute(
            "INSERT INTO directory_sync_runs (actor_user_id, started_at, status) "
            "VALUES (?, ?, 'running')",
            (int(actor_id), started_at),
        )
        run_id = int(cursor.lastrowid)
        root = department_service.get_root_department(db)
        existing_departments = _existing_external_departments(db)
        fetched_ids = {item.open_department_id for item in feishu_departments}
        external_to_local: dict[str, int] = {
            external_id: int(row["id"]) for external_id, row in existing_departments.items()
        }
        warnings: list[str] = []
        departments_created = 0
        departments_updated = 0
        departments_deactivated = 0
        for item in _ordered_departments(feishu_departments):
            parent_external = item.parent_department_id
            if parent_external in external_to_local:
                parent_local = external_to_local[parent_external]
            else:
                parent_local = int(root["id"])
                if parent_external not in {"", "0"} and parent_external not in fetched_ids:
                    warnings.append(
                        f"部门「{item.name}」的上级不在同步范围内，已挂到根部门"
                    )
            name = _unique_sibling_name(
                db,
                parent_local,
                item.name,
                exclude_id=external_to_local.get(item.open_department_id),
            )
            local_row = existing_departments.get(item.open_department_id)
            if local_row is None:
                created = department_service.create_department(
                    db,
                    name=name,
                    parent_id=parent_local,
                    created_by=int(actor_id),
                    sort_order=int(item.order) if item.order else None,
                )
                department_id = int(created["id"])
                db.execute(
                    "UPDATE departments SET external_source = 'feishu', external_id = ?, "
                    "is_active = ?, updated_at = ? WHERE id = ?",
                    (
                        item.open_department_id,
                        1 if item.is_active else 0,
                        now_iso(),
                        department_id,
                    ),
                )
                external_to_local[item.open_department_id] = department_id
                departments_created += 1
            else:
                department_id = int(local_row["id"])
                external_to_local[item.open_department_id] = department_id
                changed = False
                if int(local_row["parent_id"] or 0) != parent_local:
                    department_service.update_department(db, department_id, parent_id=parent_local)
                    changed = True
                if str(local_row["name"]) != name:
                    department_service.update_department(db, department_id, name=name)
                    changed = True
                if int(local_row["sort_order"]) != int(item.order or 0):
                    department_service.update_department(
                        db, department_id, sort_order=int(item.order or 0)
                    )
                    changed = True
                if bool(local_row["is_active"]) != bool(item.is_active):
                    department_service.update_department(
                        db, department_id, is_active=bool(item.is_active)
                    )
                    changed = True
                if str(local_row["external_source"]) != "feishu" or str(
                    local_row["external_id"]
                ) != item.open_department_id:
                    db.execute(
                        "UPDATE departments SET external_source = 'feishu', external_id = ?, "
                        "updated_at = ? WHERE id = ?",
                        (item.open_department_id, now_iso(), department_id),
                    )
                    changed = True
                departments_updated += 1 if changed else 0
            department_service.ensure_department_tag(
                db, department_service.get_department(db, department_id)
            )

        for external_id, row in existing_departments.items():
            if external_id in fetched_ids or not bool(row["is_active"]):
                continue
            db.execute(
                "UPDATE departments SET is_active = 0, updated_at = ? WHERE id = ?",
                (now_iso(), int(row["id"])),
            )
            departments_deactivated += 1

        users_created = 0
        users_updated = 0
        skipped_users = 0
        affected_user_ids: set[int] = set()
        user_ids_by_open_id: dict[str, int] = {}
        for item in feishu_users:
            try:
                user_id, created, changed = _ensure_local_user(db, item)
            except sqlite3.IntegrityError:
                skipped_users += 1
                warnings.append(f"用户「{item.name}」写入冲突，已跳过")
                continue
            user_ids_by_open_id[item.open_id] = user_id
            users_created += 1 if created else 0
            users_updated += 1 if changed and not created else 0
            affected_user_ids.add(user_id)

        memberships_added = 0
        memberships_removed = 0
        for item in feishu_users:
            user_id = user_ids_by_open_id.get(item.open_id)
            if user_id is None:
                continue
            desired = {
                external_to_local[external_id]
                for external_id in item.department_ids
                if external_id in external_to_local
            }
            current = _current_feishu_memberships(db, user_id)
            to_remove = current - desired
            to_add = desired - current
            if to_remove:
                placeholders = ",".join("?" for _ in to_remove)
                db.execute(
                    "DELETE FROM department_members WHERE user_id = ? AND source = 'feishu' "
                    f"AND department_id IN ({placeholders})",
                    [user_id, *sorted(to_remove)],
                )
                memberships_removed += len(to_remove)
            ts = now_iso()
            for department_id in sorted(to_add):
                db.execute(
                    "INSERT OR IGNORE INTO department_members "
                    "(user_id, department_id, source, created_at) VALUES (?, ?, 'feishu', ?)",
                    (user_id, department_id, ts),
                )
                memberships_added += 1

        leaders_set = 0
        leader_local: dict[str, int] = {}
        leader_open_ids = sorted(
            {open_id for item in feishu_departments for open_id in item.leader_open_ids}
        )
        if leader_open_ids:
            chunk = 500
            for start in range(0, len(leader_open_ids), chunk):
                part = leader_open_ids[start:start + chunk]
                placeholders = ",".join("?" for _ in part)
                rows = db.execute(
                    f"SELECT id, feishu_id FROM users WHERE feishu_id IN ({placeholders})",
                    part,
                ).fetchall()
                for row in rows:
                    leader_local[str(row["feishu_id"])] = int(row["id"])
        for item in feishu_departments:
            department_id = external_to_local.get(item.open_department_id)
            if department_id is None:
                continue
            db.execute(
                "DELETE FROM department_leaders WHERE department_id = ? AND source = 'feishu'",
                (department_id,),
            )
            manual_primary = db.execute(
                "SELECT 1 FROM department_leaders "
                "WHERE department_id = ? AND is_primary = 1 AND source = 'manual' LIMIT 1",
                (department_id,),
            ).fetchone() is not None
            ts = now_iso()
            for index, open_id in enumerate(item.leader_open_ids):
                user_id = leader_local.get(open_id)
                if user_id is None:
                    continue
                is_primary = 0 if manual_primary else (1 if index == 0 else 0)
                db.execute(
                    "INSERT OR IGNORE INTO department_leaders "
                    "(department_id, user_id, is_primary, source, sort_order, created_at) "
                    "VALUES (?, ?, ?, 'feishu', ?, ?)",
                    (department_id, user_id, is_primary, index, ts),
                )
                leaders_set += 1

        department_service.recompute_department_tags(db, sorted(affected_user_ids))
        result = _build_sync_result(
            dry_run=False,
            departments_created=departments_created,
            departments_updated=departments_updated,
            departments_deactivated=departments_deactivated,
            users_created=users_created,
            users_updated=users_updated,
            memberships_added=memberships_added,
            memberships_removed=memberships_removed,
            leaders_set=leaders_set,
            skipped_users=skipped_users,
            warnings=warnings,
        )
        db.execute(
            "UPDATE directory_sync_runs SET finished_at = ?, status = 'success', summary_json = ? "
            "WHERE id = ?",
            (
                now_iso(),
                json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                run_id,
            ),
        )
        return result
    except Exception as exc:
        if db.in_transaction:
            db.rollback()
        # The running row was rolled back with the failed transaction; record a
        # separate failed run so administrators can see why synchronization
        # stopped without committing partial organization data.
        try:
            db.execute(
                "INSERT INTO directory_sync_runs "
                "(actor_user_id, started_at, finished_at, status, summary_json, error_message) "
                "VALUES (?, ?, ?, 'failed', '{}', ?)",
                (int(actor_id), started_at, now_iso(), str(exc)[:500]),
            )
            db.commit()
        except sqlite3.Error:
            db.rollback()
        raise


DIRECTORY_SYNC_INTERVAL_OPTIONS = (1, 6, 12, 24, 72, 168)


def _schedule_defaults() -> dict[str, Any]:
    return {
        "enabled": False,
        "interval_hours": 24,
        "owner_id": None,
        "next_due_at": None,
        "last_started_at": None,
        "last_completed_at": None,
        "last_status": "",
        "last_message": "",
        "updated_at": None,
    }


def get_directory_sync_schedule(db: sqlite3.Connection) -> dict[str, Any]:
    row = db.execute("SELECT * FROM directory_sync_schedule WHERE id = 1").fetchone()
    if row is None:
        return _schedule_defaults()
    return {
        "enabled": bool(row["enabled"]),
        "interval_hours": int(row["interval_hours"]),
        "owner_id": int(row["owner_id"]) if row["owner_id"] is not None else None,
        "next_due_at": row["next_due_at"],
        "last_started_at": row["last_started_at"],
        "last_completed_at": row["last_completed_at"],
        "last_status": row["last_status"] or "",
        "last_message": row["last_message"] or "",
        "updated_at": row["updated_at"],
    }


def update_directory_sync_schedule(
    db: sqlite3.Connection,
    *,
    enabled: bool,
    interval_hours: int,
    owner_id: int,
) -> dict[str, Any]:
    hours = int(interval_hours)
    if hours not in DIRECTORY_SYNC_INTERVAL_OPTIONS:
        raise HTTPException(400, "定时同步间隔不正确")
    now = datetime.utcnow()
    next_due = (
        (now + timedelta(hours=hours)).isoformat(timespec="seconds") + "Z"
        if enabled
        else None
    )
    ts = now.isoformat(timespec="seconds") + "Z"
    db.execute(
        """INSERT INTO directory_sync_schedule
           (id, enabled, interval_hours, owner_id, next_due_at, updated_at)
           VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
               enabled = excluded.enabled,
               interval_hours = excluded.interval_hours,
               owner_id = excluded.owner_id,
               next_due_at = excluded.next_due_at,
               updated_at = excluded.updated_at""",
        (1 if enabled else 0, hours, int(owner_id), next_due, ts),
    )
    return get_directory_sync_schedule(db)


def mark_directory_sync_schedule(
    db: sqlite3.Connection,
    *,
    status: str,
    message: str = "",
    started_at: str | None = None,
) -> None:
    row = db.execute("SELECT 1 FROM directory_sync_schedule WHERE id = 1").fetchone()
    if row is None:
        return
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    if started_at:
        db.execute(
            "UPDATE directory_sync_schedule SET last_started_at = ?, updated_at = ? WHERE id = 1",
            (started_at, now),
        )
    if status in {"completed", "failed", "cancelled"}:
        db.execute(
            "UPDATE directory_sync_schedule SET last_completed_at = ?, last_status = ?, "
            "last_message = ?, updated_at = ? WHERE id = 1",
            (now, status, str(message or "")[:1000], now),
        )


__all__ = [
    "sync_feishu_directory",
    "get_directory_sync_schedule",
    "update_directory_sync_schedule",
    "mark_directory_sync_schedule",
    "DIRECTORY_SYNC_INTERVAL_OPTIONS",
]
