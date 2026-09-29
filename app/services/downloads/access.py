"""Live authorization for queued and completed download tasks."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from fastapi import HTTPException

from app.core.permissions import can_view_resource, can_view_show
from app.services.shows import _show_row


def _download_task_params(task: sqlite3.Row) -> dict[str, Any]:
    try:
        params = json.loads(task["params"] or "{}")
        if not isinstance(params, dict):
            raise ValueError("invalid task parameters")
        int(params["show_id"])
        int(params["session_version"])
    except (KeyError, ValueError, TypeError):
        raise HTTPException(410, "下载任务授权信息已失效，请重新发起下载") from None
    return params


def _download_task_owner(db: sqlite3.Connection, task: sqlite3.Row) -> sqlite3.Row:
    """A queued export is bound to its creator's live account and session."""
    params = _download_task_params(task)
    owner = db.execute("SELECT * FROM users WHERE id = ?", (task["owner_id"],)).fetchone()
    if owner is None or int(owner["session_version"]) != int(params["session_version"]):
        raise HTTPException(401, "下载任务的登录会话已失效，请重新发起下载")
    if owner["must_change_pwd"]:
        raise HTTPException(403, "请先修改临时密码后再继续使用")
    return owner


def _validate_download_result_access(
    db: sqlite3.Connection, task: sqlite3.Row, user: sqlite3.Row, result: dict[str, Any],
) -> None:
    """Recheck every resource actually included, even if later removed from the show."""
    refs = result.get("resource_refs")
    if not isinstance(refs, list) or not refs or any(
        not isinstance(ref, list) or len(ref) != 2
        or any(type(value) is not int or value <= 0 for value in ref)
        for ref in refs
    ):
        # Old exports did not record their contents and cannot be safely
        # reconstructed after show edits or cross-user legacy cache reuse.
        raise HTTPException(410, "下载文件授权信息已失效，请重新发起下载")
    _download_task_owner(db, task)
    show_id = int(_download_task_params(task)["show_id"])
    show = _show_row(db, show_id)
    if not can_view_show(db, show, user):
        raise HTTPException(403, "无可见权限")
    for resource_id, version_no in refs:
        resource = db.execute("SELECT * FROM resources WHERE id = ?", (resource_id,)).fetchone()
        if resource is None or not can_view_resource(db, resource, user):
            raise HTTPException(403, "无素材可见权限")
        version = db.execute(
            "SELECT 1 FROM resource_versions WHERE resource_id = ? AND version_no = ?",
            (resource_id, version_no),
        ).fetchone()
        if version is None:
            raise HTTPException(410, "下载文件引用的素材版本已失效，请重新发起下载")
