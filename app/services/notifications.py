"""Derived per-user notification feed built from terminal task results.

Notifications deliberately keep no duplicate copy of task state.  Terminal rows
in ``tasks`` are the source of truth and ``notification_reads`` only stores the
per-user read marker.  This guarantees every terminal task is covered without
adding notification writes to the many task lifecycle paths.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from app.db import now_iso

TERMINAL_TASK_STATUSES = ("completed", "failed", "cancelled")
MAX_NOTIFICATION_LIMIT = 50
DEFAULT_NOTIFICATION_LIMIT = 20
MAX_BODY_CHARS = 140

_TASK_COLUMNS = """
    t.id, t.task_type, t.status, t.params, t.result_data, t.message,
    t.updated_at, t.completed_at, t.owner_id, r.read_at
"""
_READ_JOIN = """
    LEFT JOIN notification_reads r
      ON r.user_id = t.owner_id
     AND r.source = 'task'
     AND r.source_id = t.id
"""


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _text(value: Any, limit: int = 240) -> str:
    if value is None:
        return ""
    return str(value).strip()[:limit]


def _positive_id(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _clip(text: str) -> str:
    normalised = " ".join(str(text or "").split())
    if len(normalised) <= MAX_BODY_CHARS:
        return normalised
    return normalised[: MAX_BODY_CHARS - 1] + "…"


def parse_notification_id(value: str) -> int | None:
    """Parse the browser-facing ``task:<id>`` notification identifier."""
    if not isinstance(value, str) or not value.startswith("task:"):
        return None
    raw = value[len("task:"):]
    if not raw.isdigit():
        return None
    task_id = int(raw)
    return task_id if task_id > 0 else None


def parse_cursor(value: str | None) -> tuple[str, int] | None:
    """Parse ``<updated_at>|<task_id>`` or return ``None`` when malformed."""
    if value is None:
        return None
    at, separator, raw_id = str(value).rpartition("|")
    if not separator or not at or len(at) > 40 or not raw_id.isdigit():
        return None
    task_id = int(raw_id)
    return (at, task_id) if task_id > 0 else None


def _cursor_for(row: sqlite3.Row) -> str:
    return f"{row['updated_at']}|{int(row['id'])}"


def _terminal_where(box: str) -> list[str]:
    where = [
        "t.owner_id = ?",
        "t.status IN ('completed', 'failed', 'cancelled')",
    ]
    if box == "unread":
        where.append("r.source_id IS NULL")
    elif box == "read":
        where.append("r.source_id IS NOT NULL")
    return where


def unread_task_notification_count(db: sqlite3.Connection, user_id: int) -> int:
    row = db.execute(
        f"""
        SELECT COUNT(*) AS count
        FROM tasks t
        {_READ_JOIN}
        WHERE t.owner_id = ?
          AND t.status IN ('completed', 'failed', 'cancelled')
          AND r.source_id IS NULL
        """,
        (int(user_id),),
    ).fetchone()
    return int(row["count"] if row is not None else 0)


def _show_names(db: sqlite3.Connection, show_ids: set[int]) -> dict[int, str]:
    if not show_ids:
        return {}
    placeholders = ",".join("?" for _ in show_ids)
    rows = db.execute(
        f"SELECT id, name FROM shows WHERE id IN ({placeholders})",
        sorted(show_ids),
    ).fetchall()
    return {int(row["id"]): str(row["name"] or "") for row in rows}


def _resource_briefs(
    db: sqlite3.Connection, resource_ids: set[int]
) -> dict[int, dict[str, Any]]:
    if not resource_ids:
        return {}
    placeholders = ",".join("?" for _ in resource_ids)
    rows = db.execute(
        f"SELECT id, name, detail_token, deleted_at FROM resources "
        f"WHERE id IN ({placeholders})",
        sorted(resource_ids),
    ).fetchall()
    return {
        int(row["id"]): {
            "name": str(row["name"] or ""),
            "detail_token": str(row["detail_token"] or ""),
            "deleted": row["deleted_at"] is not None,
        }
        for row in rows
    }


def _import_count(result: dict[str, Any], params: dict[str, Any]) -> int | None:
    for key in ("created", "total"):
        value = result.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    target_key = "template_ids" if params.get("import_target") == "templates" else "resource_ids"
    values = result.get(target_key)
    if isinstance(values, list):
        return len(values)
    return None


def _titles(
    task_type: str,
    status: str,
    params: dict[str, Any],
    message: str,
) -> str:
    if status == "cancelled" and message.startswith("已忽略"):
        return "任务已忽略"
    if status == "completed":
        if task_type == "download":
            return "下载已完成"
        if task_type == "batch_split_import":
            return "模板导入完成" if params.get("import_target") == "templates" else "单页素材导入完成"
        if task_type == "ai_tagging":
            return "智能标注完成"
        if task_type == "feishu_sync":
            return "组织架构同步完成"
        return "任务已完成"
    if status == "failed":
        return {
            "download": "下载失败",
            "batch_split_import": "导入失败",
            "ai_tagging": "智能标注失败",
            "feishu_sync": "组织架构同步失败",
        }.get(task_type, "任务失败")
    return {
        "download": "下载已取消",
        "batch_split_import": "导入已取消",
        "ai_tagging": "智能标注已取消",
        "feishu_sync": "组织架构同步已取消",
    }.get(task_type, "任务已取消")


def _body(
    task_type: str,
    status: str,
    params: dict[str, Any],
    result: dict[str, Any],
    message: str,
    show_names: dict[int, str],
    resources: dict[int, dict[str, Any]],
) -> str:
    if status != "completed":
        if message:
            return _clip(message)
        return "任务处理失败，请在任务管理中查看详情" if status == "failed" else "任务已取消"

    if task_type == "download":
        show_name = show_names.get(_positive_id(params.get("show_id")) or 0, "")
        file_name = _text(result.get("file_name"))
        if show_name and file_name:
            return _clip(f"《{show_name}》 · {file_name}")
        return _clip(file_name or show_name or "文件已生成，可在任务管理中查看")

    if task_type == "batch_split_import":
        name = _text(params.get("name_prefix") or params.get("file_name")) or (
            "模板文件" if params.get("import_target") == "templates" else "PPT 文件"
        )
        count = _import_count(result, params)
        if count is None:
            return _clip(f"{name} · 导入完成")
        unit = "个模板" if params.get("import_target") == "templates" else "个素材"
        return _clip(f"{name} · 已生成 {count} {unit}")

    if task_type == "feishu_sync":
        return _clip(
            f"部门新增 {int(result.get('departments_created') or 0)}、"
            f"更新 {int(result.get('departments_updated') or 0)}、"
            f"停用 {int(result.get('departments_deactivated') or 0)}；"
            f"用户新增 {int(result.get('users_created') or 0)}、"
            f"更新 {int(result.get('users_updated') or 0)}"
        )

    # ai_tagging
    resource_id = _positive_id(params.get("target_id")) or _positive_id(result.get("target_id"))
    resource_name = resources.get(resource_id or 0, {}).get("name", "")
    suggestions = result.get("suggested_tags")
    count = len(suggestions) if isinstance(suggestions, list) else None
    name = resource_name or "素材"
    return _clip(f"{name} · 已生成 {count} 个标签建议" if count is not None else f"{name} · 标注完成")


def _link(
    task_type: str,
    params: dict[str, Any],
    result: dict[str, Any],
    resources: dict[int, dict[str, Any]],
) -> str:
    if task_type == "download":
        return "/manage/tasks"
    if task_type == "batch_split_import":
        return "/manage/tasks?tab=uploads"
    if task_type == "feishu_sync":
        return "/manage/tasks?tab=sync"
    resource_id = _positive_id(params.get("target_id")) or _positive_id(result.get("target_id"))
    resource = resources.get(resource_id or 0)
    if resource and not resource["deleted"] and resource["detail_token"]:
        return f"/resources/{resource['detail_token']}"
    return "/resources"


def _serialize_task_rows(
    db: sqlite3.Connection,
    rows: list[sqlite3.Row],
) -> list[dict[str, Any]]:
    show_ids: set[int] = set()
    resource_ids: set[int] = set()
    for row in rows:
        params = _object(row["params"])
        result = _object(row["result_data"])
        if row["task_type"] == "download":
            show_id = _positive_id(params.get("show_id"))
        else:
            show_id = None
        if show_id:
            show_ids.add(show_id)
        if row["task_type"] == "ai_tagging":
            resource_id = _positive_id(params.get("target_id")) or _positive_id(result.get("target_id"))
            if resource_id:
                resource_ids.add(resource_id)

    shows = _show_names(db, show_ids)
    resources = _resource_briefs(db, resource_ids)

    items: list[dict[str, Any]] = []
    for row in rows:
        params = _object(row["params"])
        result = _object(row["result_data"])
        message = _text(row["message"])
        task_type = str(row["task_type"])
        status = str(row["status"])
        items.append(
            {
                "id": f"task:{int(row['id'])}",
                "kind": "task",
                "task_type": task_type,
                "status": status,
                "title": _titles(task_type, status, params, message),
                "body": _body(task_type, status, params, result, message, shows, resources),
                "link": _link(task_type, params, result, resources),
                "created_at": _text(row["completed_at"] or row["updated_at"]),
                "read_at": row["read_at"],
            }
        )
    return items


def list_task_notifications(
    db: sqlite3.Connection,
    user_id: int,
    *,
    box: str = "all",
    limit: int = DEFAULT_NOTIFICATION_LIMIT,
    cursor: str | None = None,
) -> dict[str, Any]:
    safe_limit = max(1, min(int(limit), MAX_NOTIFICATION_LIMIT))
    parsed_cursor = parse_cursor(cursor)
    if cursor is not None and parsed_cursor is None:
        raise ValueError("invalid cursor")

    where = _terminal_where(box)
    params: list[Any] = [int(user_id)]
    if parsed_cursor is not None:
        where.append("(t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))")
        params.extend([parsed_cursor[0], parsed_cursor[0], parsed_cursor[1]])
    where_sql = " AND ".join(where)
    rows = db.execute(
        f"""
        SELECT {_TASK_COLUMNS}
        FROM tasks t
        {_READ_JOIN}
        WHERE {where_sql}
        ORDER BY t.updated_at DESC, t.id DESC
        LIMIT ?
        """,
        [*params, safe_limit + 1],
    ).fetchall()

    has_more = len(rows) > safe_limit
    page = rows[:safe_limit]
    return {
        "items": _serialize_task_rows(db, page),
        "unread_count": unread_task_notification_count(db, user_id),
        "has_more": has_more,
        "next_cursor": _cursor_for(page[-1]) if has_more and page else None,
    }


def mark_task_notification_read(
    db: sqlite3.Connection, user_id: int, notification_id: str
) -> dict[str, Any] | None:
    task_id = parse_notification_id(notification_id)
    if task_id is None:
        return None
    row = db.execute(
        "SELECT id, owner_id, status FROM tasks WHERE id = ?", (task_id,)
    ).fetchone()
    if row is None or int(row["owner_id"]) != int(user_id):
        return None
    if str(row["status"]) not in TERMINAL_TASK_STATUSES:
        return None
    db.execute(
        """
        INSERT OR IGNORE INTO notification_reads
            (user_id, source, source_id, read_at)
        VALUES (?, 'task', ?, ?)
        """,
        (int(user_id), task_id, now_iso()),
    )
    db.commit()
    stored = db.execute(
        "SELECT read_at FROM notification_reads "
        "WHERE user_id = ? AND source = 'task' AND source_id = ?",
        (int(user_id), task_id),
    ).fetchone()
    return {
        "id": f"task:{task_id}",
        "read_at": stored["read_at"] if stored is not None else None,
    }


def mark_task_notification_unread(
    db: sqlite3.Connection, user_id: int, notification_id: str
) -> dict[str, Any] | None:
    task_id = parse_notification_id(notification_id)
    if task_id is None:
        return None
    row = db.execute(
        "SELECT id, owner_id, status FROM tasks WHERE id = ?", (task_id,)
    ).fetchone()
    if row is None or int(row["owner_id"]) != int(user_id):
        return None
    if str(row["status"]) not in TERMINAL_TASK_STATUSES:
        return None
    db.execute(
        "DELETE FROM notification_reads "
        "WHERE user_id = ? AND source = 'task' AND source_id = ?",
        (int(user_id), task_id),
    )
    db.commit()
    return {"id": f"task:{task_id}"}


def mark_all_task_notifications_read(db: sqlite3.Connection, user_id: int) -> int:
    cursor = db.execute(
        """
        INSERT OR IGNORE INTO notification_reads
            (user_id, source, source_id, read_at)
        SELECT ?, 'task', t.id, ?
        FROM tasks t
        LEFT JOIN notification_reads r
          ON r.user_id = ? AND r.source = 'task' AND r.source_id = t.id
        WHERE t.owner_id = ?
          AND t.status IN ('completed', 'failed', 'cancelled')
          AND r.source_id IS NULL
        """,
        (int(user_id), now_iso(), int(user_id), int(user_id)),
    )
    db.commit()
    return int(cursor.rowcount or 0)
