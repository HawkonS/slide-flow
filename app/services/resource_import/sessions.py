"""Services / resource import / sessions."""

from __future__ import annotations

from app.config import settings
from app.core.permissions import require_user
from app.db import get_db
from app.routers.dependencies import (
    db_read_dep,
)
from app.services.resource_import.limits import (
    RESOURCE_IMPORT_MAX_ACTIVE_SESSIONS,
    RESOURCE_IMPORT_MIN_FREE_BYTES,
    RESOURCE_IMPORT_TTL,
)
from app.services.resource_import.validation import (
    _require_resource_import_origin,
)
from contextlib import contextmanager
from fastapi import Depends
from fastapi import HTTPException
from pathlib import Path
from typing import Any
import asyncio
import fcntl
import json
import logging
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid

logger = logging.getLogger(__name__)


_resource_import_sessions: dict[str, dict[str, Any]] = {}


_resource_import_lock = threading.Lock()


async def _resource_import_cleanup_loop() -> None:
    while True:
        await asyncio.sleep(300)
        _cleanup_expired_resource_imports()


def _resource_import_root() -> Path:
    root = settings.assets_dir / ".resource_imports"
    root.mkdir(parents=True, exist_ok=True)
    return root


def reserve_resource_import_directory(*, required_bytes: int = 0) -> tuple[str, Path]:
    """Atomically admit one upload across all Gunicorn workers.

    Counting directories without a lock lets simultaneous prepare requests all
    pass the quota. The short admission lock covers the count and mkdir only;
    file uploads never hold it.
    """
    root = _resource_import_root()
    lock_path = root / ".admission.lock"
    handle = os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), "a+b")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        active = sum(1 for child in root.iterdir()
                     if child.is_dir() and not child.is_symlink() and _RESOURCE_IMPORT_SESSION_ID_RE.fullmatch(child.name))
        if active >= RESOURCE_IMPORT_MAX_ACTIVE_SESSIONS:
            raise HTTPException(429, "导入任务过多，请等待已有任务完成")
        required_free = RESOURCE_IMPORT_MIN_FREE_BYTES + max(0, int(required_bytes))
        if shutil.disk_usage(root).free < required_free:
            raise HTTPException(507, "服务器临时空间不足，请稍后重试")
        session_id = uuid.uuid4().hex
        directory = root / session_id
        directory.mkdir()
        return session_id, directory
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


_RESOURCE_IMPORT_SESSION_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def _resource_import_session_file(session_id: str) -> Path | None:
    """Return the metadata path only for a valid, contained import session id."""
    if not _RESOURCE_IMPORT_SESSION_ID_RE.fullmatch(session_id):
        return None
    root = _resource_import_root().resolve()
    directory = root / session_id
    candidate = directory / "session.json"
    if directory.is_symlink() or candidate.is_symlink() or directory.resolve() != directory:
        return None
    return candidate


def _load_resource_import_session_file(session_id: str) -> dict[str, Any] | None:
    metadata_path = _resource_import_session_file(session_id)
    if metadata_path is None or not metadata_path.is_file():
        return None
    try:
        data = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    return data if isinstance(data, dict) and data.get("session_id") == session_id else None


def _resource_import_temp_dir(session: dict[str, Any]) -> Path:
    """Return a session directory only when it is the expected contained path."""
    session_id = str(session.get("session_id", ""))
    if not _RESOURCE_IMPORT_SESSION_ID_RE.fullmatch(session_id):
        raise HTTPException(410, "导入会话已失效，请重新上传")
    root = _resource_import_root().resolve()
    expected = root / session_id
    raw = Path(str(session.get("temp_dir", "")))
    try:
        candidate = raw.resolve()
        candidate.relative_to(root)
    except (OSError, ValueError):
        raise HTTPException(410, "导入会话临时目录无效，请重新上传")
    if not raw.is_absolute() or raw.is_symlink() or candidate != expected or not candidate.is_dir():
        raise HTTPException(410, "导入会话临时目录无效，请重新上传")
    return candidate


def _resource_import_file(session: dict[str, Any], raw_path: Any, *, required: bool = True) -> Path:
    """Resolve a path from session JSON and keep it inside that session."""
    temp_dir = _resource_import_temp_dir(session)
    if not isinstance(raw_path, str) or not raw_path:
        raise HTTPException(410, "导入会话文件信息无效，请重新上传")
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        raise HTTPException(410, "导入会话文件信息无效，请重新上传")
    # Reject symlinks at every raw component, not just the resolved endpoint.
    # A symlink inside a session must not alias another input or output file.
    current = candidate
    while True:
        if current.is_symlink():
            raise HTTPException(410, "导入会话文件信息无效，请重新上传")
        if current == temp_dir or current.parent == current:
            break
        current = current.parent
    try:
        resolved = candidate.resolve(strict=required)
        resolved.relative_to(temp_dir)
    except (OSError, ValueError):
        raise HTTPException(410, "导入会话文件信息无效，请重新上传")
    if resolved == temp_dir or (required and not resolved.is_file()):
        raise HTTPException(410, "导入会话文件信息无效，请重新上传")
    return resolved


@contextmanager
def _resource_import_operation(session: dict[str, Any], *, wait: bool = False):
    """Acquire a cross-worker, per-session operation lease.

    A non-blocking flock makes a second tab fail fast instead of racing a
    font replacement/render/commit and overwriting the session snapshot. A
    stale-preview read may opt into waiting so concurrent image requests all
    observe one regenerated preview set.
    """
    temp_dir = _resource_import_temp_dir(session)
    lock_path = temp_dir / ".operation.lock"
    try:
        handle = os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), "a+b")
    except OSError as exc:
        raise HTTPException(410, "导入会话已失效，请重新上传") from exc
    try:
        try:
            flags = fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB
            fcntl.flock(handle.fileno(), flags)
        except BlockingIOError as exc:
            raise HTTPException(409, "该导入会话正在处理中，请稍后再试") from exc
        yield
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def _write_resource_import_session(session: dict[str, Any]) -> None:
    """Persist session state atomically so another Gunicorn worker can resume it."""
    session_id = str(session.get("session_id", ""))
    metadata_path = _resource_import_session_file(session_id)
    if metadata_path is None:
        raise ValueError("导入会话 ID 不正确")
    temp_dir = _resource_import_temp_dir(session)
    if temp_dir != metadata_path.parent:
        raise ValueError("导入会话临时目录不正确")
    temp_path = metadata_path.with_name(f".session-{uuid.uuid4().hex}.tmp")
    try:
        temp_path.write_text(json.dumps(session, ensure_ascii=False), encoding="utf-8")
        os.replace(temp_path, metadata_path)
    finally:
        temp_path.unlink(missing_ok=True)


def _cleanup_resource_import_session(session_id: str, session: dict[str, Any] | None = None) -> None:
    # Callers must hold the session operation lease. Never derive a deletion
    # target from metadata: only the exact validated ID is authoritative.
    if not _RESOURCE_IMPORT_SESSION_ID_RE.fullmatch(session_id):
        return
    candidate = _resource_import_root().resolve() / session_id
    if candidate.is_symlink():
        return
    # New pull-based render tasks outlive browser requests and application
    # workers. Cancel the durable queue row before deleting its session files;
    # otherwise an expired session could leave a Windows worker processing an
    # OSS task whose result can no longer be published. The import is local to
    # avoid a module cycle: render_tasks itself uses the session helpers.
    if session and session.get("render_task_id"):
        from app.services.resource_import.render_tasks import cancel_render_tasks

        with get_db() as db:
            cancel_render_tasks(db, session_id)
    with _resource_import_lock:
        _resource_import_sessions.pop(session_id, None)
    shutil.rmtree(candidate, ignore_errors=True)


def _rollback_resource_import_files(session: dict[str, Any]) -> None:
    """Reclaim only explicitly journaled import outputs after a failed job."""
    resources = settings.resources_dir.resolve()
    thumbs = settings.thumbs_dir.resolve()
    for raw in session.get("created_dirs", []):
        path = Path(raw)
        if path.parent == resources and _RESOURCE_IMPORT_SESSION_ID_RE.fullmatch(path.name) and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)
    temporary_thumb_prefixes: set[str] = set()
    for raw in session.get("created_thumbs", []):
        path = Path(raw)
        if path.parent == thumbs and path.name.startswith("preview_v") and path.suffix == ".jpg" and not path.is_symlink():
            path.unlink(missing_ok=True)
            temporary_thumb_prefixes.add(f".{path.name}.")
    # A hard worker crash skips _ensure_preview_thumb's finally block. Only
    # reclaim its exact journaled target + random 32-hex suffix, never another
    # version's temporary output, a directory, or any symbolic link.
    if temporary_thumb_prefixes:
        for candidate in thumbs.glob(".*.tmp"):
            if candidate.is_symlink() or not candidate.is_file():
                continue
            for prefix in temporary_thumb_prefixes:
                if candidate.name.startswith(prefix) and _RESOURCE_IMPORT_SESSION_ID_RE.fullmatch(candidate.name[len(prefix):-4]):
                    candidate.unlink(missing_ok=True)
                    break


def _cleanup_expired_resource_imports() -> None:
    now = time.time()
    for child in _resource_import_root().resolve().iterdir():
        if not _RESOURCE_IMPORT_SESSION_ID_RE.fullmatch(child.name) or child.is_symlink() or not child.is_dir():
            continue
        try:
            # Keep the lease until deletion is complete; checking then
            # unlocking would still race the start of a new operation.
            with _resource_import_operation({"session_id": child.name, "temp_dir": str(child)}):
                session = _load_resource_import_session_file(child.name)
                expires = float(session.get("expires_at", 0)) if session else child.stat().st_mtime + RESOURCE_IMPORT_TTL
                if expires > now:
                    continue
                if session and session.get("created_dirs"):
                    # Receipt is committed in the very same DB transaction as
                    # resources. No receipt after worker death means SQLite
                    # rolled back; reclaim the filesystem side of that job.
                    with get_db() as db:
                        receipt = _resource_import_receipt(db, child.name, int(session["owner_id"]))
                    if receipt is None:
                        _rollback_resource_import_files(session)
                _cleanup_resource_import_session(child.name, session)
        except HTTPException:
            # A held lease is normal for long rendering/splitting jobs.
            continue
        except Exception:
            logger.exception("Resource import cleanup failed session_id=%s", child.name)


def _resource_import_session(session_id: str, user: sqlite3.Row) -> dict[str, Any]:
    # Prefer the on-disk snapshot on every request. A later request may land on
    # a different Gunicorn worker, or this worker may hold an older in-memory
    # copy from before a font replacement/preview generation completed.
    session = _load_resource_import_session_file(session_id)
    if session is None or int(session.get("owner_id", -1)) != int(user["id"]):
        raise HTTPException(404, "导入会话不存在或已过期，请重新上传")
    if float(session.get("expires_at", 0)) <= time.time():
        raise HTTPException(410, "导入会话已过期，请重新上传")
    with _resource_import_lock:
        _resource_import_sessions[session_id] = session
    return session


async def _resource_import_locked_session(
    session_id: str,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
    _: None = Depends(_require_resource_import_origin),
):
    receipt = _resource_import_receipt(db, session_id, int(user["id"]))
    if receipt is not None:
        # The commit endpoint treats this as an idempotent replay. Other
        # endpoints should still be unable to operate on a consumed session.
        yield {"commit_result": receipt}
        return
    session = _resource_import_session(session_id, user)
    with _resource_import_operation(session):
        session = _resource_import_session(session_id, user)
        receipt = _resource_import_receipt(db, session_id, int(user["id"]))
        if receipt is not None:
            yield {"commit_result": receipt}
            return
        if session.get("created_dirs"):
            _rollback_resource_import_files(session)
            _cleanup_resource_import_session(session_id, session)
            raise HTTPException(410, "上次导入被中断，临时文件已清理，请重新上传")
        session["expires_at"] = time.time() + RESOURCE_IMPORT_TTL
        _write_resource_import_session(session)
        yield session


def _resource_import_receipt(db: sqlite3.Connection, session_id: str, owner_id: int) -> dict[str, Any] | None:
    row = db.execute(
        "SELECT result_json FROM resource_import_commits WHERE session_id = ? AND owner_id = ?",
        (session_id, owner_id),
    ).fetchone()
    return json.loads(row["result_json"]) if row else None
