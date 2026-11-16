"""Background organization-directory synchronization tasks."""
from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import threading
from datetime import datetime, timedelta
from typing import Any

from fastapi import HTTPException

from app.config import settings
from app.db import get_db, now_iso
from app.services.directory_sync import (
    get_directory_sync_schedule,
    mark_directory_sync_schedule,
    sync_feishu_directory,
)
from app.services.tasks.runtime import (
    _heavy_executor,
    _pending_task_futures,
    _task_cancel_flags,
)

logger = logging.getLogger(__name__)

TASK_TYPE = "feishu_sync"
_ACTIVE_STATUSES = {"pending", "processing"}


def _feishu_configured() -> bool:
    return bool(
        settings.feishu_sso_enabled
        and settings.feishu_app_id.strip()
        and settings.feishu_app_secret.strip()
    )


def _schedule_summary(result: dict[str, Any]) -> str:
    return (
        f"部门新增 {int(result.get('departments_created') or 0)}、"
        f"更新 {int(result.get('departments_updated') or 0)}、"
        f"停用 {int(result.get('departments_deactivated') or 0)}；"
        f"用户新增 {int(result.get('users_created') or 0)}、"
        f"更新 {int(result.get('users_updated') or 0)}"
    )


def _insert_sync_task(
    db: sqlite3.Connection,
    *,
    owner_id: int,
    trigger: str,
) -> int:
    params = {"trigger": trigger, "owner_id": int(owner_id)}
    db.execute(
        "INSERT INTO tasks "
        "(task_type, status, owner_id, params, progress, total, message) "
        "VALUES (?, 'pending', ?, ?, 0, 1, '等待同步飞书组织架构…')",
        (TASK_TYPE, int(owner_id), json.dumps(params, ensure_ascii=False, separators=(",", ":"))),
    )
    task_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    _task_cancel_flags[task_id] = threading.Event()
    return task_id


def create_feishu_sync_task(
    db: sqlite3.Connection,
    *,
    owner_id: int,
    trigger: str = "manual",
) -> int:
    if not _feishu_configured():
        raise HTTPException(400, "请先启用并配置飞书 SSO")
    active = db.execute(
        "SELECT id FROM tasks WHERE task_type = ? AND status IN ('pending','processing') "
        "ORDER BY id DESC LIMIT 1",
        (TASK_TYPE,),
    ).fetchone()
    if active is not None:
        raise HTTPException(409, f"已有组织架构同步任务在运行（#{int(active['id'])}）")
    return _insert_sync_task(db, owner_id=int(owner_id), trigger=trigger)


async def schedule_feishu_sync_task(task_id: int) -> None:
    async def run() -> None:
        await asyncio.get_running_loop().run_in_executor(
            _heavy_executor, _execute_feishu_sync_task, task_id
        )

    future = asyncio.ensure_future(run())
    future.add_done_callback(lambda completed: completed.exception() if not completed.cancelled() else None)
    _pending_task_futures[task_id] = future


def _fallback_owner(db: sqlite3.Connection, preferred: Any) -> int | None:
    try:
        value = int(preferred)
    except (TypeError, ValueError):
        value = 0
    if value > 0:
        row = db.execute("SELECT id FROM users WHERE id = ?", (value,)).fetchone()
        if row is not None:
            return value
    row = db.execute(
        "SELECT id FROM users WHERE role = 'system_admin' ORDER BY id LIMIT 1"
    ).fetchone()
    return int(row["id"]) if row is not None else None


def _execute_feishu_sync_task(task_id: int) -> None:
    db = get_db()
    try:
        row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None or row["task_type"] != TASK_TYPE:
            return
        cancel_event = _task_cancel_flags.get(task_id)
        if cancel_event is not None and cancel_event.is_set():
            return
        claimed = db.execute(
            "UPDATE tasks SET status = 'processing', message = '正在同步飞书组织架构…', "
            "progress = 0, total = 1, updated_at = ? "
            "WHERE id = ? AND status = 'pending'",
            (now_iso(), task_id),
        )
        db.commit()
        if claimed.rowcount != 1:
            return
        try:
            params = json.loads(row["params"] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            params = {}
        owner_id = _fallback_owner(db, params.get("owner_id") or row["owner_id"])
        if owner_id is None:
            raise HTTPException(400, "没有可用于执行同步的管理员账号")
        started_at = now_iso()
        mark_directory_sync_schedule(db, status="running", started_at=started_at)
        db.commit()
        try:
            result = sync_feishu_directory(db, actor_id=owner_id)
            db.commit()
            summary = _schedule_summary(result)
            current = db.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()
            cancelled = (
                (cancel_event is not None and cancel_event.is_set())
                or (current is not None and current["status"] == "cancelled")
            )
            result_json = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
            if cancelled:
                db.execute(
                    "UPDATE tasks SET status = 'cancelled', progress = 1, total = 1, "
                    "message = ?, result_data = ?, completed_at = ?, updated_at = ? WHERE id = ?",
                    (f"同步已完成，但任务被取消：{summary}", result_json, now_iso(), now_iso(), task_id),
                )
                mark_directory_sync_schedule(db, status="cancelled", message=summary)
            else:
                db.execute(
                    "UPDATE tasks SET status = 'completed', progress = 1, total = 1, "
                    "message = ?, result_data = ?, completed_at = ?, updated_at = ? WHERE id = ?",
                    (summary, result_json, now_iso(), now_iso(), task_id),
                )
                mark_directory_sync_schedule(db, status="completed", message=summary)
            db.commit()
        except HTTPException as exc:
            db.rollback()
            message = str(exc.detail or "组织架构同步失败")
            db.execute(
                "UPDATE tasks SET status = 'failed', error_message = ?, message = ?, "
                "completed_at = ?, updated_at = ? WHERE id = ?",
                (message, message, now_iso(), now_iso(), task_id),
            )
            mark_directory_sync_schedule(db, status="failed", message=message)
            db.commit()
        except Exception:
            db.rollback()
            logger.exception("Directory synchronization task failed: %s", task_id)
            message = "组织架构同步失败，请稍后重试"
            db.execute(
                "UPDATE tasks SET status = 'failed', error_message = ?, message = ?, "
                "completed_at = ?, updated_at = ? WHERE id = ?",
                (message, message, now_iso(), now_iso(), task_id),
            )
            mark_directory_sync_schedule(db, status="failed", message=message)
            db.commit()
    finally:
        _task_cancel_flags.pop(task_id, None)
        _pending_task_futures.pop(task_id, None)
        db.close()


def prepare_due_directory_sync_task() -> int | None:
    """Claim one due scheduled sync and insert its task, or return None."""
    db = get_db()
    try:
        if not db.in_transaction:
            db.execute("BEGIN IMMEDIATE")
        schedule = get_directory_sync_schedule(db)
        if not schedule["enabled"]:
            db.commit()
            return None
        due = schedule["next_due_at"]
        now_dt = datetime.utcnow()
        if due and str(due) > now_dt.isoformat(timespec="seconds") + "Z":
            db.commit()
            return None
        hours = int(schedule["interval_hours"])
        next_due = (now_dt + timedelta(hours=hours)).isoformat(timespec="seconds") + "Z"
        owner_id = _fallback_owner(db, schedule.get("owner_id"))
        if owner_id is None:
            db.execute(
                "UPDATE directory_sync_schedule SET next_due_at = ?, last_status = 'failed', "
                "last_message = '没有可用于执行同步的管理员账号', updated_at = ? WHERE id = 1",
                (next_due, now_iso()),
            )
            db.commit()
            return None
        active = db.execute(
            "SELECT id FROM tasks WHERE task_type = ? AND status IN ('pending','processing') "
            "ORDER BY id DESC LIMIT 1",
            (TASK_TYPE,),
        ).fetchone()
        if active is not None:
            db.execute(
                "UPDATE directory_sync_schedule SET next_due_at = ?, updated_at = ? WHERE id = 1",
                (next_due, now_iso()),
            )
            db.commit()
            return None
        if not _feishu_configured():
            db.execute(
                "UPDATE directory_sync_schedule SET next_due_at = ?, last_status = 'failed', "
                "last_message = '飞书 SSO 未启用或未配置', updated_at = ? WHERE id = 1",
                (next_due, now_iso()),
            )
            db.commit()
            return None
        claimed = db.execute(
            "UPDATE directory_sync_schedule SET next_due_at = ?, last_started_at = ?, "
            "updated_at = ? WHERE id = 1 AND enabled = 1 "
            "AND (next_due_at IS NULL OR next_due_at <= ?)",
            (next_due, now_iso(), now_iso(), now_iso()),
        )
        if claimed.rowcount != 1:
            db.commit()
            return None
        task_id = _insert_sync_task(db, owner_id=owner_id, trigger="scheduled")
        db.commit()
        return task_id
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


async def directory_sync_schedule_loop() -> None:
    await asyncio.sleep(60)
    while True:
        try:
            task_id = await asyncio.to_thread(prepare_due_directory_sync_task)
            if task_id is not None:
                await schedule_feishu_sync_task(task_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Directory sync schedule loop failed")
        await asyncio.sleep(60)


__all__ = [
    "TASK_TYPE",
    "create_feishu_sync_task",
    "schedule_feishu_sync_task",
    "prepare_due_directory_sync_task",
    "directory_sync_schedule_loop",
]
