"""Department tree, membership and directory administration."""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import Field

from app.core.permissions import require_admin, require_user
from app.db import now_iso
from app.routers.dependencies import ApiPayload, db_dep, db_read_dep
from app.services import departments as service

router = APIRouter()


class DepartmentCreatePayload(ApiPayload):
    parent_id: int = Field(..., ge=1)
    name: str = Field(..., min_length=1, max_length=64)
    sort_order: int | None = Field(default=None, ge=0, le=1_000_000)


class DepartmentUpdatePayload(ApiPayload):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    parent_id: int | None = Field(default=None, ge=1)
    sort_order: int | None = Field(default=None, ge=0, le=1_000_000)
    is_active: bool | None = None


class DepartmentMembersPayload(ApiPayload):
    user_ids: list[int] = Field(..., max_length=service.MAX_MEMBERS_PER_REQUEST)


class DepartmentLeadersPayload(ApiPayload):
    user_ids: list[int] = Field(default_factory=list, max_length=service.MAX_MEMBERS_PER_REQUEST)
    primary_user_id: int | None = Field(default=None, ge=1)


class DirectorySyncPayload(ApiPayload):
    dry_run: bool = False


class DirectorySyncSchedulePayload(ApiPayload):
    enabled: bool
    interval_hours: int = Field(..., ge=1, le=168)


def _audit(
    db: sqlite3.Connection,
    actor: sqlite3.Row | dict[str, Any],
    action: str,
    *,
    department_id: int | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    payload: dict[str, Any] = dict(details or {})
    if department_id is not None:
        payload["department_id"] = int(department_id)
    db.execute(
        "INSERT INTO admin_audit_events "
        "(actor_user_id, subject_user_id, action, details, created_at) "
        "VALUES (?, NULL, ?, ?, ?)",
        (
            int(actor["id"]),
            action,
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            now_iso(),
        ),
    )


@router.get("/departments")
def list_departments(
    _: Any = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """Basic active tree for scope pickers; no member profiles or leaders."""
    rows = service.list_departments_with_counts(db, include_inactive=False)
    root = service.get_root_department(db)
    return {
        "root_id": int(root["id"]),
        "departments": [
            {
                "id": item["id"],
                "parent_id": item["parent_id"],
                "name": item["name"],
                "path": item["path"],
                "path_names": item["path_names"],
                "depth": item["depth"],
                "is_active": item["is_active"],
                "member_count": item["member_count"],
                "direct_member_count": item["direct_member_count"],
            }
            for item in rows
        ],
    }


@router.get("/admin/directory")
def admin_directory(
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    rows = service.list_departments_with_counts(db, include_inactive=True)
    return {"stats": service.department_stats(db), "departments": rows}


@router.post("/departments")
def create_department(
    payload: DepartmentCreatePayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    department = service.create_department(
        db,
        name=payload.name,
        parent_id=int(payload.parent_id),
        created_by=int(admin["id"]),
        sort_order=payload.sort_order,
    )
    _audit(db, admin, "department.create", department_id=int(department["id"]), details={"name": department["name"]})
    db.commit()
    return {"department": _serialize_department(db, department)}


def _serialize_department(db: sqlite3.Connection, department: sqlite3.Row) -> dict[str, Any]:
    rows = service.list_departments_with_counts(db, include_inactive=True)
    for row in rows:
        if int(row["id"]) == int(department["id"]):
            return row
    return {
        "id": int(department["id"]),
        "parent_id": int(department["parent_id"]) if department["parent_id"] is not None else None,
        "name": department["name"],
        "path": department["path"],
        "depth": int(department["depth"]),
        "sort_order": int(department["sort_order"]),
        "is_active": bool(department["is_active"]),
        "external_source": department["external_source"],
        "direct_member_count": 0,
        "member_count": 0,
        "leaders": [],
    }


@router.patch("/departments/{department_id}")
def update_department(
    department_id: int,
    payload: DepartmentUpdatePayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    if all(
        value is None
        for value in (payload.name, payload.parent_id, payload.sort_order, payload.is_active)
    ):
        from fastapi import HTTPException
        raise HTTPException(400, "请至少提交一个部门修改项")
    department = service.update_department(
        db,
        department_id,
        name=payload.name,
        parent_id=payload.parent_id,
        sort_order=payload.sort_order,
        is_active=payload.is_active,
    )
    _audit(
        db,
        admin,
        "department.update",
        department_id=department_id,
        details={
            key: value
            for key, value in payload.model_dump().items()
            if value is not None
        },
    )
    db.commit()
    return {"department": _serialize_department(db, department)}


@router.delete("/departments/{department_id}")
def delete_department(
    department_id: int,
    force: bool = Query(False),
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    usage = service.delete_department(db, department_id, force=force)
    _audit(
        db,
        admin,
        "department.delete",
        department_id=department_id,
        details={"force": bool(force), "usage": usage},
    )
    db.commit()
    return {"ok": True, "usage": service.serialize_usage(usage)}


@router.get("/departments/{department_id}/usage")
def department_usage(
    department_id: int,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    service.get_department(db, department_id)
    return service.serialize_usage(service.department_usage_counts(db, department_id))


@router.put("/departments/{department_id}/members")
def replace_department_members(
    department_id: int,
    payload: DepartmentMembersPayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    service.replace_manual_members(db, department_id, payload.user_ids)
    _audit(
        db,
        admin,
        "department.members.replace",
        department_id=department_id,
        details={"user_count": len(set(payload.user_ids))},
    )
    db.commit()
    return {"ok": True}


@router.post("/departments/{department_id}/members")
def add_department_members(
    department_id: int,
    payload: DepartmentMembersPayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    service.add_department_members(db, department_id, payload.user_ids)
    _audit(
        db,
        admin,
        "department.members.add",
        department_id=department_id,
        details={"user_count": len(set(payload.user_ids))},
    )
    db.commit()
    return {"ok": True}


@router.delete("/departments/{department_id}/members/{user_id}")
def remove_department_member(
    department_id: int,
    user_id: int,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    service.remove_department_member(db, department_id, user_id)
    _audit(
        db,
        admin,
        "department.members.remove",
        department_id=department_id,
        details={"user_id": int(user_id)},
    )
    db.commit()
    return {"ok": True}


@router.put("/departments/{department_id}/leaders")
def set_department_leaders(
    department_id: int,
    payload: DepartmentLeadersPayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    service.set_department_leaders(
        db,
        department_id,
        payload.user_ids,
        payload.primary_user_id,
    )
    _audit(
        db,
        admin,
        "department.leaders.set",
        department_id=department_id,
        details={
            "user_ids": sorted(set(payload.user_ids)),
            "primary_user_id": payload.primary_user_id,
        },
    )
    db.commit()
    return {"ok": True}


@router.post("/departments/rebuild-tags")
def rebuild_department_tags(
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    count = service.rebuild_department_tags(db)
    _audit(db, admin, "department.tags.rebuild", details={"users": count})
    db.commit()
    return {"ok": True, "users": count}


@router.get("/departments/sync-schedule")
def get_sync_schedule(
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    from app.services.directory_sync import get_directory_sync_schedule

    schedule = get_directory_sync_schedule(db)
    active = db.execute(
        "SELECT id, status FROM tasks WHERE task_type = 'feishu_sync' "
        "AND status IN ('pending','processing') ORDER BY id DESC LIMIT 1"
    ).fetchone()
    schedule["active_task_id"] = int(active["id"]) if active is not None else None
    schedule["active_task_status"] = active["status"] if active is not None else None
    return schedule


@router.put("/departments/sync-schedule")
def update_sync_schedule(
    payload: DirectorySyncSchedulePayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    from app.services.directory_sync import update_directory_sync_schedule

    schedule = update_directory_sync_schedule(
        db,
        enabled=payload.enabled,
        interval_hours=int(payload.interval_hours),
        owner_id=int(admin["id"]),
    )
    _audit(
        db,
        admin,
        "department.sync_schedule",
        details={
            "enabled": payload.enabled,
            "interval_hours": int(payload.interval_hours),
        },
    )
    db.commit()
    return schedule


@router.post("/departments/sync-feishu")
def sync_feishu_departments(
    payload: DirectorySyncPayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    from app.services.directory_sync import sync_feishu_directory

    result = sync_feishu_directory(db, actor_id=int(admin["id"]), dry_run=payload.dry_run)
    if not payload.dry_run:
        _audit(db, admin, "department.sync_feishu", details=result)
        db.commit()
    return result
