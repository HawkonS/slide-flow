"""Durable PPT-to-PNG tasks pulled by Windows render workers."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import secrets
import shutil
import sqlite3
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from app.config import settings
from app.core.errors import render_public_message
from app.core.fonts import normalize_font_name
from app.core.oss import oss_ref, storage as oss_storage
from app.core.ppt import split_pptx_to_single_pages
from app.db import get_db, now_iso
from app.services.files import _compress_hd_image
from app.services.resource_import.remote_fonts import sha256_file
from app.services.resource_import.rendering import RESOURCE_IMPORT_RENDERER_VERSION
from app.services.resource_import.sessions import (
    _load_resource_import_session_file,
    _resource_import_file,
    _resource_import_operation,
    _resource_import_temp_dir,
    _write_resource_import_session,
)
from app.services.resource_import.validation import _validate_import_image

logger = logging.getLogger(__name__)

LEASE_SECONDS = 600
MAX_ATTEMPTS = 5
MAX_OUTPUT_IMAGE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_OUTPUT_BYTES = 512 * 1024 * 1024
RESULT_URL_SECONDS = 900
RENDER_SESSION_TTL = 7 * 24 * 3600
TERMINAL_OBJECT_CLEANUP_GRACE_SECONDS = RESULT_URL_SECONDS + 300
RENDERER_WORKER_HEARTBEAT_PREFIX = "renderer_worker:"
RENDERER_WORKER_HEARTBEAT_TTL_SECONDS = 90
RETRYABLE_ERROR_CODES = {
    "network_error", "render_timeout", "renderer_unavailable", "worker_restarted",
    "disk_pressure", "temporary_oss_error", "internal_error", "queue_full",
    "renderer_draining", "worker_unavailable",
}


def touch_renderer_worker(
    db: sqlite3.Connection,
    worker_id: str,
    *,
    state: str,
    task_id: str | None = None,
) -> None:
    """Persist the latest pull-worker contact for the admin runtime view.

    The pull protocol already gives us a bounded heartbeat: an idle worker
    opens a long-poll claim request at least every 25 seconds, while a busy
    worker renews its task lease every 30 seconds. Keeping the heartbeat in
    ``runtime_state`` avoids another table migration and lets all API workers
    observe the same Windows worker state.
    """
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", worker_id):
        return
    payload = {
        "worker_id": worker_id,
        "state": state if state in {"polling", "idle", "running"} else "polling",
        "task_id": task_id,
        "last_seen": time.time(),
        "last_seen_at": now_iso(),
    }
    db.execute(
        "INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        (
            RENDERER_WORKER_HEARTBEAT_PREFIX + worker_id,
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            payload["last_seen_at"],
        ),
    )


def renderer_worker_status(db: sqlite3.Connection) -> dict[str, Any]:
    """Return a compact, bounded snapshot for the admin runtime page."""
    now = time.time()
    workers: list[dict[str, Any]] = []
    for row in db.execute(
        "SELECT value FROM runtime_state WHERE key LIKE ? ORDER BY updated_at DESC",
        (RENDERER_WORKER_HEARTBEAT_PREFIX + "%",),
    ).fetchall():
        try:
            item = json.loads(row["value"] or "{}")
        except (TypeError, ValueError):
            continue
        if not isinstance(item, dict) or not isinstance(item.get("worker_id"), str):
            continue
        try:
            last_seen = float(item.get("last_seen"))
        except (TypeError, ValueError):
            continue
        age = max(0, int(now - last_seen))
        workers.append({
            "worker_id": item["worker_id"],
            "state": item.get("state") if item.get("state") in {"polling", "idle", "running"} else "polling",
            "task_id": item.get("task_id") if isinstance(item.get("task_id"), str) else None,
            "last_seen_at": item.get("last_seen_at"),
            "age_seconds": age,
            "connected": age <= RENDERER_WORKER_HEARTBEAT_TTL_SECONDS,
        })

    live_workers = [item for item in workers if item["connected"]]
    active_workers = [item for item in live_workers if item["state"] == "running"]
    active_tasks = int(db.execute(
        "SELECT COUNT(*) FROM renderer_ppt_tasks WHERE status='running' AND lease_until>?",
        (now,),
    ).fetchone()[0])

    if active_workers:
        process_status = "running"
    elif live_workers:
        process_status = "idle"
    elif active_tasks:
        process_status = "disconnected"
    else:
        process_status = "stopped"

    connection_status = "connected" if live_workers else "disconnected"
    latest = live_workers[0] if live_workers else (workers[0] if workers else None)
    return {
        "process": {
            "status": process_status,
            "worker_count": len(live_workers),
            "active_task_count": active_tasks,
            "worker_id": active_workers[0]["worker_id"] if active_workers else (latest or {}).get("worker_id"),
            "task_id": active_workers[0].get("task_id") if active_workers else None,
        },
        "connection": {
            "status": connection_status,
            "worker_count": len(live_workers),
            "worker_id": (latest or {}).get("worker_id"),
            "last_seen_at": (latest or {}).get("last_seen_at"),
            "age_seconds": (latest or {}).get("age_seconds"),
        },
    }


def _token_hash(token: str) -> str:
    return hmac.new(settings.secret_key.encode("utf-8"), token.encode("ascii"), hashlib.sha256).hexdigest()


def _manifest(row: sqlite3.Row, column: str) -> dict[str, Any]:
    try:
        value = json.loads(row[column] or "{}")
    except (TypeError, ValueError):
        value = {}
    if not isinstance(value, dict):
        raise RuntimeError("PPT 渲染任务清单损坏")
    return value


def _safe_error_code(value: str | None) -> str:
    if not value:
        return "render_failed"
    clean = "".join(char for char in str(value)[:80] if char.isalnum() or char in "_-.")
    return clean or "render_failed"


def _task_key(task_id: str, kind: str, index: int, suffix: str) -> str:
    return oss_storage.key(f"_render_tasks/{task_id}/{kind}/{index:04d}", suffix)


def _render_font_inventory(db: sqlite3.Connection, names: list[str]) -> tuple[list[str], list[str]]:
    required = list(dict.fromkeys(
        name.strip() for name in names
        if isinstance(name, str) and name.strip() and not name.strip().startswith("+")
    ))
    if len(required) > 128 or any(len(name) > 256 for name in required):
        raise RuntimeError("PPT 所需字体清单无效")
    if not required:
        return [], []
    wanted = {normalize_font_name(name): name for name in required}
    found: set[str] = set()
    hashes: list[str] = []
    rows = db.execute(
        "SELECT f.aliases, t.sha256 FROM fonts f JOIN renderer_font_tasks t ON t.font_id=f.id "
        "ORDER BY f.id"
    ).fetchall()
    for row in rows:
        try:
            aliases = json.loads(row["aliases"] or "[]")
        except (TypeError, ValueError):
            continue
        normalized = {
            normalize_font_name(alias)
            for alias in aliases
            if isinstance(alias, str) and alias.strip()
        }
        matches = wanted.keys() & normalized
        if not matches:
            continue
        found.update(matches)
        digest = str(row["sha256"] or "")
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise RuntimeError("标准字体同步记录损坏，请管理员重新上传字体")
        if digest not in hashes:
            hashes.append(digest)
    missing = wanted.keys() - found
    if missing:
        raise RuntimeError("标准字体清单与 PPT 不匹配：" + "、".join(wanted[key] for key in sorted(missing)))
    if len(hashes) > 64:
        raise RuntimeError("本次渲染所需标准字体文件过多")
    return required, hashes


def _cleanup_manifest_objects(manifest: dict[str, Any]) -> bool:
    cleaned = True
    for collection in (
        manifest.get("pages", []), manifest.get("outputs", []), manifest.get("stale_outputs", []),
    ):
        if not isinstance(collection, list):
            continue
        for item in collection:
            ref = (item.get("source_ref") or item.get("output_ref")) if isinstance(item, dict) else None
            if isinstance(ref, str):
                try:
                    oss_storage.delete(ref)
                except Exception:
                    cleaned = False
                    logger.warning("Deferred OSS render-task cleanup", exc_info=True)
    return cleaned


def cleanup_terminal_render_task_objects() -> int:
    """Retry deleting terminal task objects after signed URLs expire."""
    cutoff = (
        datetime.utcnow() - timedelta(seconds=TERMINAL_OBJECT_CLEANUP_GRACE_SECONDS)
    ).isoformat(timespec="seconds") + "Z"
    db = get_db()
    cleaned = 0
    try:
        rows = db.execute(
            "SELECT * FROM renderer_ppt_tasks WHERE status IN ('completed','failed','cancelled') "
            "AND objects_cleaned_at IS NULL AND updated_at<? ORDER BY updated_at LIMIT 100",
            (cutoff,),
        ).fetchall()
        for row in rows:
            if _cleanup_manifest_objects(_manifest(row, "source_manifest")):
                changed = db.execute(
                    "UPDATE renderer_ppt_tasks SET objects_cleaned_at=? "
                    "WHERE task_id=? AND objects_cleaned_at IS NULL",
                    (now_iso(), row["task_id"]),
                )
                cleaned += max(0, changed.rowcount)
        db.commit()
        return cleaned
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


async def render_task_cleanup_loop() -> None:
    while True:
        await asyncio.sleep(300)
        try:
            await asyncio.to_thread(cleanup_terminal_render_task_objects)
        except Exception:
            logger.exception("Terminal Windows render-task OSS cleanup failed")


def cancel_render_tasks(
    db: sqlite3.Connection, session_id: str, *, except_attempt: str | None = None,
    commit: bool = True,
) -> None:
    params: list[Any] = [session_id]
    where = "session_id=? AND status NOT IN ('completed','failed','cancelled')"
    if except_attempt:
        where += " AND render_attempt<>?"
        params.append(except_attempt)
    rows = db.execute(f"SELECT * FROM renderer_ppt_tasks WHERE {where}", params).fetchall()
    if not rows:
        return
    db.execute(
        f"UPDATE renderer_ppt_tasks SET status='cancelled', lease_token_hash=NULL, lease_until=NULL,"
        f" updated_at=? WHERE {where}",
        [now_iso(), *params],
    )
    if commit:
        db.commit()
    for row in rows:
        _cleanup_manifest_objects(_manifest(row, "source_manifest"))


def cancel_render_tasks_for_parent(db: sqlite3.Connection, parent_task_id: int) -> None:
    rows = db.execute(
        "SELECT * FROM renderer_ppt_tasks WHERE parent_task_id=? "
        "AND status NOT IN ('completed','failed','cancelled')",
        (parent_task_id,),
    ).fetchall()
    if not rows:
        return
    db.execute(
        "UPDATE renderer_ppt_tasks SET status='cancelled', lease_token_hash=NULL, lease_until=NULL,"
        " updated_at=? WHERE parent_task_id=? AND status NOT IN ('completed','failed','cancelled')",
        (now_iso(), parent_task_id),
    )
    db.commit()
    for row in rows:
        _cleanup_manifest_objects(_manifest(row, "source_manifest"))


def create_render_task(session: dict[str, Any]) -> sqlite3.Row:
    """Split, stage in OSS and enqueue one immutable render generation."""
    if session.get("missing_fonts"):
        raise RuntimeError("请先处理不在标准字体库中的字体")
    if settings.storage_backend.strip().lower() != "oss":
        raise RuntimeError("Windows 主动领取转图任务要求启用 OSS 存储")
    oss_storage.ensure_configured()
    root = _resource_import_temp_dir(session)
    source = _resource_import_file(session, session.get("source_path"))
    expected = int(session["slide_count"])
    attempt = uuid.uuid4().hex
    task_id = uuid.uuid4().hex
    directory = root / f"previews_{attempt}"
    source_dir = directory / "sources"
    directory.mkdir()
    refs: list[str] = []
    original_session = dict(session)
    task_committed = False
    try:
        if shutil.disk_usage(root).free < 1024 * 1024 * 1024:
            raise RuntimeError("主服务器临时空间不足，请稍后重试")
        singles = split_pptx_to_single_pages(source, source_dir, max_total_bytes=512 * 1024 * 1024)
        if len(singles) != expected:
            raise RuntimeError("PPT 拆分页数不一致，未提交渲染")
        pages: list[dict[str, Any]] = []
        for index, single in enumerate(singles):
            size = single.stat().st_size
            if not 0 < size <= 120 * 1024 * 1024:
                raise RuntimeError(f"第 {index + 1} 页 PPTX 为空或超过 120 MiB")
            source_ref = oss_storage.upload_file(
                single, _task_key(task_id, "input", index, ".pptx"),
                content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            )
            refs.append(source_ref)
            pages.append({
                "index": index,
                "source_ref": source_ref,
                "sha256": sha256_file(single),
                "size": size,
            })
        manifest = {
            "version": 1,
            "session_id": session["session_id"],
            "render_attempt": attempt,
            "dpi": int(settings.render_dpi),
            "pages": pages,
            "outputs": [],
            "stale_outputs": [],
        }
        db = get_db()
        cancelled_manifests: list[dict[str, Any]] = []
        try:
            # Backfill synchronization receipts before freezing the font
            # inventory into this immutable render attempt.
            from app.services.resource_import.font_tasks import ensure_all_font_tasks
            ensure_all_font_tasks(db)
            db.commit()
            db.execute("BEGIN IMMEDIATE")
            required_fonts, font_hashes = _render_font_inventory(db, session.get("fonts", []))
            manifest["required_fonts"] = required_fonts
            manifest["font_hashes"] = font_hashes
            cancelled = db.execute(
                "SELECT * FROM renderer_ppt_tasks WHERE session_id=? "
                "AND status NOT IN ('completed','failed','cancelled')",
                (str(session["session_id"]),),
            ).fetchall()
            cancelled_manifests = [_manifest(item, "source_manifest") for item in cancelled]
            if cancelled:
                db.execute(
                    "UPDATE renderer_ppt_tasks SET status='cancelled', lease_token_hash=NULL, lease_until=NULL,"
                    " updated_at=? WHERE session_id=? AND status NOT IN ('completed','failed','cancelled')",
                    (now_iso(), str(session["session_id"])),
                )
            db.execute(
                "INSERT INTO renderer_ppt_tasks "
                "(task_id,session_id,render_attempt,parent_task_id,status,source_manifest,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (task_id, session["session_id"], attempt, session.get("task_id"), "queued",
                 json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), now_iso(), now_iso()),
            )
            row = db.execute("SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (task_id,)).fetchone()
            # Publish the session pointer before committing the queue row while
            # BEGIN IMMEDIATE still prevents a worker from seeing the task.
            # This closes the race where an extremely fast worker could finish
            # before the session knew which immutable render attempt it owned.
            session.update(
                preview_status="rendering", preview_error=None, preview_paths=[], partial_preview_paths={},
                render_attempt=attempt, render_task_id=task_id, renderer_version=RESOURCE_IMPORT_RENDERER_VERSION,
                split_paths=[str(path) for path in singles], split_hashes=[item["sha256"] for item in pages],
                rendered_source_sha256=sha256_file(source), expires_at=time.time() + RENDER_SESSION_TTL,
            )
            _write_resource_import_session(session)
            try:
                db.commit()
            except Exception:
                db.rollback()
                session.clear()
                session.update(original_session)
                try:
                    _write_resource_import_session(session)
                except Exception:
                    logger.exception("Failed to restore session after render-task commit failure")
                raise
            task_committed = True
        finally:
            db.close()
        for cancelled_manifest in cancelled_manifests:
            _cleanup_manifest_objects(cancelled_manifest)
        return row
    except Exception:
        if not task_committed:
            session.clear()
            session.update(original_session)
            for ref in refs:
                try:
                    oss_storage.delete(ref)
                except Exception:
                    pass
            shutil.rmtree(directory, ignore_errors=True)
        raise


def ensure_render_task(session: dict[str, Any]) -> sqlite3.Row:
    task_id = session.get("render_task_id")
    attempt = session.get("render_attempt")
    if isinstance(task_id, str) and isinstance(attempt, str):
        db = get_db()
        try:
            row = db.execute(
                "SELECT * FROM renderer_ppt_tasks WHERE task_id=? AND session_id=? AND render_attempt=?",
                (task_id, session["session_id"], attempt),
            ).fetchone()
            if row and row["status"] not in {"failed", "cancelled"}:
                return row
        finally:
            db.close()
    return create_render_task(session)


def render_task_state(session: dict[str, Any]) -> dict[str, Any]:
    if session.get("preview_status") == "ready":
        return {"status": "completed", "preview_count": len(session.get("preview_paths", []))}
    task_id = session.get("render_task_id")
    if not isinstance(task_id, str):
        return {"status": "pending", "preview_count": 0}
    db = get_db()
    try:
        row = db.execute("SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (task_id,)).fetchone()
    finally:
        db.close()
    if row is None:
        return {"status": "error", "message": "渲染任务不存在，请重新生成图片"}
    if row["status"] == "cancelled":
        return {"status": "error", "message": "该图片渲染任务已取消，请重新生成"}
    if row["status"] == "failed":
        return {"status": "error", "message": render_public_message(row["error_code"])}
    if row["status"] == "completed" and session.get("preview_status") != "ready":
        if _recover_completed_session(row, session):
            return {"status": "completed", "preview_count": len(session.get("preview_paths", []))}
        return {"status": "publishing", "preview_count": 0, "attempts": int(row["attempts"])}
    return {"status": str(row["status"]), "preview_count": 0, "attempts": int(row["attempts"])}


def _recover_completed_session(row: sqlite3.Row, session: dict[str, Any]) -> bool:
    """Repair the session snapshot after a crash between DB commit and JSON publication."""
    if session.get("render_attempt") != row["render_attempt"] or session.get("render_task_id") != row["task_id"]:
        return False
    result = _manifest(row, "result_manifest")
    raw_paths = result.get("preview_paths")
    hashes = result.get("preview_hashes")
    if not isinstance(raw_paths, list) or not isinstance(hashes, list) or len(raw_paths) != len(hashes):
        return False
    try:
        paths = [_resource_import_file(session, path) for path in raw_paths]
    except Exception:
        return False
    if any(sha256_file(path) != digest for path, digest in zip(paths, hashes)):
        return False
    try:
        with _resource_import_operation(session):
            current = _load_resource_import_session_file(str(row["session_id"]))
            if not current or current.get("render_attempt") != row["render_attempt"] or current.get("render_task_id") != row["task_id"]:
                return False
            current.update(
                preview_paths=[str(path) for path in paths], partial_preview_paths={},
                preview_hashes=hashes, preview_status="ready", preview_error=None,
                renderer_version=RESOURCE_IMPORT_RENDERER_VERSION,
                expires_at=time.time() + RENDER_SESSION_TTL,
            )
            _write_resource_import_session(current)
            session.clear()
            session.update(current)
            _cleanup_manifest_objects(_manifest(row, "source_manifest"))
            return True
    except Exception:
        # The completing request may still hold the session lock, or the disk
        # may be temporarily unavailable. A later status poll retries safely.
        return False


def claim_render_task(db: sqlite3.Connection, worker_id: str) -> tuple[sqlite3.Row, str] | None:
    """Atomically reclaim an expired lease or claim one queued task."""
    now = time.time()
    db.execute("BEGIN IMMEDIATE")
    try:
        font_counts = {
            str(item["status"]): int(item["count"])
            for item in db.execute(
                "SELECT t.status, COUNT(*) AS count FROM renderer_font_tasks t "
                "JOIN fonts f ON f.id=t.font_id GROUP BY t.status"
            ).fetchall()
        }
        font_total = int(db.execute("SELECT COUNT(*) FROM fonts").fetchone()[0])
        task_total = sum(font_counts.values())
        deletion_counts = {
            str(item["status"]): int(item["count"])
            for item in db.execute(
                "SELECT status, COUNT(*) AS count FROM renderer_font_delete_tasks GROUP BY status"
            ).fetchall()
        }
        if (font_counts.get("failed", 0) or task_total != font_total
                or font_total != font_counts.get("completed", 0)
                or deletion_counts.get("queued", 0) or deletion_counts.get("running", 0)
                or deletion_counts.get("failed", 0)):
            db.commit()
            return None
        expired = db.execute(
            "SELECT * FROM renderer_ppt_tasks WHERE status='running' AND lease_until<? AND attempts>=?",
            (now, MAX_ATTEMPTS),
        ).fetchall()
        for item in expired:
            db.execute(
                "UPDATE renderer_ppt_tasks SET status='failed', lease_token_hash=NULL, lease_until=NULL,"
                " error_code='lease_exhausted', updated_at=? WHERE task_id=?",
                (now_iso(), item["task_id"]),
            )
            failed = db.execute(
                "SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (item["task_id"],)
            ).fetchone()
            _update_parent_task(
                db, failed, success=False,
                error_message=render_public_message("lease_exhausted"),
            )
        row = db.execute(
            "SELECT * FROM renderer_ppt_tasks WHERE "
            "status='queued' OR (status='running' AND lease_until<? AND attempts<?) "
            "ORDER BY created_at, task_id LIMIT 1",
            (now, MAX_ATTEMPTS),
        ).fetchone()
        token = None
        if row is not None:
            token = secrets.token_urlsafe(32)
            manifest = _manifest(row, "source_manifest")
            next_attempt = int(row["attempts"]) + 1
            stale_outputs = [*manifest.get("stale_outputs", []), *manifest.get("outputs", [])]
            manifest["stale_outputs"] = stale_outputs
            manifest["outputs"] = [
                {
                    "index": int(page["index"]),
                    "output_ref": oss_ref(_task_key(row["task_id"], f"output-{next_attempt}", int(page["index"]), ".png")),
                }
                for page in manifest.get("pages", [])
            ]
            changed = db.execute(
                "UPDATE renderer_ppt_tasks SET status='running', lease_token_hash=?, lease_until=?, worker_id=?,"
                " attempts=attempts+1, source_manifest=?, error_code=NULL, updated_at=? WHERE task_id=? AND "
                "(status='queued' OR (status='running' AND lease_until<? AND attempts<?))",
                (_token_hash(token), now + LEASE_SECONDS, worker_id,
                 json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
                 now_iso(), row["task_id"], now, MAX_ATTEMPTS),
            )
            if changed.rowcount != 1:
                db.rollback()
                return None
        db.commit()
        for item in expired:
            session = _load_resource_import_session_file(str(item["session_id"]))
            if session and session.get("render_attempt") == item["render_attempt"]:
                session.update(
                    preview_status="error",
                    preview_error=render_public_message("lease_exhausted"),
                )
                _write_resource_import_session(session)
            _cleanup_manifest_objects(_manifest(item, "source_manifest"))
        if row is None or token is None:
            return None
        return db.execute("SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (row["task_id"],)).fetchone(), token
    except Exception:
        db.rollback()
        raise


def render_queue_status(db: sqlite3.Connection) -> dict[str, int | bool]:
    rows = db.execute(
        "SELECT status, COUNT(*) AS count FROM renderer_ppt_tasks GROUP BY status"
    ).fetchall()
    counts = {str(row["status"]): int(row["count"]) for row in rows}
    font_total = int(db.execute("SELECT COUNT(*) FROM fonts").fetchone()[0])
    completed_fonts = int(db.execute(
        "SELECT COUNT(*) FROM renderer_font_tasks t JOIN fonts f ON f.id=t.font_id "
        "WHERE t.status='completed'"
    ).fetchone()[0])
    failed_fonts = int(db.execute(
        "SELECT COUNT(*) FROM renderer_font_tasks t JOIN fonts f ON f.id=t.font_id "
        "WHERE t.status='failed'"
    ).fetchone()[0])
    pending_deletions = int(db.execute(
        "SELECT COUNT(*) FROM renderer_font_delete_tasks WHERE status IN ('queued','running','failed')"
    ).fetchone()[0])
    return {
        "queued": counts.get("queued", 0),
        "running": counts.get("running", 0),
        "completed": counts.get("completed", 0),
        "failed": counts.get("failed", 0),
        "cancelled": counts.get("cancelled", 0),
        "fonts_ready": failed_fonts == 0 and completed_fonts == font_total and pending_deletions == 0,
    }


def claim_payload(row: sqlite3.Row, lease_token: str) -> dict[str, Any]:
    manifest = _manifest(row, "source_manifest")
    pages = [
        {"index": int(page["index"]), "sha256": page["sha256"], "size": int(page["size"])}
        for page in manifest.get("pages", [])
    ]
    return {
        "task_id": row["task_id"], "lease_token": lease_token, "lease_seconds": LEASE_SECONDS,
        "attempts": int(row["attempts"]), "dpi": int(manifest["dpi"]), "pages": pages,
        "required_fonts": manifest.get("required_fonts", []),
        "font_hashes": manifest.get("font_hashes", []),
    }


def refresh_render_task_urls(
    db: sqlite3.Connection, task_id: str, lease_token: str, page_index: int,
) -> dict[str, Any]:
    """Issue fresh signed URLs for one page without changing its task lease."""
    row = _leased_row(db, task_id, lease_token)
    manifest = _manifest(row, "source_manifest")
    sources = {int(item["index"]): item for item in manifest.get("pages", [])}
    outputs = {int(item["index"]): item for item in manifest.get("outputs", [])}
    if page_index not in sources or page_index not in outputs:
        raise ValueError("invalid_page_index")
    return {
        "index": page_index,
        "download_url": oss_storage.signed_url(sources[page_index]["source_ref"]),
        "upload_url": oss_storage.signed_put_url(
            outputs[page_index]["output_ref"], expires_seconds=RESULT_URL_SECONDS,
            content_type="image/png",
        ),
    }


def _leased_row(db: sqlite3.Connection, task_id: str, lease_token: str) -> sqlite3.Row:
    row = db.execute("SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (task_id,)).fetchone()
    if row is None:
        raise KeyError(task_id)
    if row["status"] != "running" or not row["lease_token_hash"] or not hmac.compare_digest(
        str(row["lease_token_hash"]), _token_hash(lease_token)
    ):
        raise PermissionError("lease_lost")
    if float(row["lease_until"] or 0) <= time.time():
        raise PermissionError("lease_expired")
    return row


def renew_render_task(db: sqlite3.Connection, task_id: str, lease_token: str) -> float:
    db.execute("BEGIN IMMEDIATE")
    try:
        _leased_row(db, task_id, lease_token)
        lease_until = time.time() + LEASE_SECONDS
        db.execute("UPDATE renderer_ppt_tasks SET lease_until=?, updated_at=? WHERE task_id=?",
                   (lease_until, now_iso(), task_id))
        db.commit()
        return lease_until
    except Exception:
        db.rollback()
        raise


def _update_parent_task(
    db: sqlite3.Connection,
    row: sqlite3.Row,
    *,
    success: bool,
    error_message: str | None = None,
) -> None:
    parent = row["parent_task_id"]
    if parent is None:
        return
    task = db.execute("SELECT params FROM tasks WHERE id=?", (parent,)).fetchone()
    params = json.loads(task["params"] or "{}") if task else {}
    if success:
        params.update({"workflow_state": "awaiting_confirmation", "preview_status": "ready", "preview_error": None})
        message, progress = "图片已渲染，等待确认导入", len(_manifest(row, "source_manifest").get("pages", []))
        db.execute(
            "UPDATE tasks SET status='pending', progress=?, total=?, message=?, error_message=NULL, params=?,"
            " updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id=? AND status<>'cancelled'",
            (progress, progress, message, json.dumps(params, ensure_ascii=False), parent),
        )
    else:
        message = error_message or render_public_message("render_failed")
        params.update({"workflow_state": "awaiting_render", "preview_status": "error", "preview_error": message})
        db.execute(
            "UPDATE tasks SET status='pending', message=?, error_message=?, params=?,"
            " updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id=? AND status<>'cancelled'",
            (message, message, json.dumps(params, ensure_ascii=False), parent),
        )


def complete_render_task(db: sqlite3.Connection, task_id: str, lease_token: str, pages: list[dict[str, Any]]) -> None:
    row = _leased_row(db, task_id, lease_token)
    manifest = _manifest(row, "source_manifest")
    expected = {int(item["index"]): item for item in manifest.get("outputs", [])}
    received: dict[int, dict[str, Any]] = {}
    for item in pages:
        index = item.get("index")
        if type(index) is not int or index not in expected or index in received:
            raise ValueError("invalid_page_index")
        size, digest = item.get("size"), item.get("sha256")
        if type(size) is not int or not 0 < size <= MAX_OUTPUT_IMAGE_BYTES:
            raise ValueError("invalid_page_size")
        if not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ValueError("invalid_page_sha256")
        received[index] = {"index": index, "size": size, "sha256": digest}
    if set(received) != set(expected) or sum(item["size"] for item in received.values()) > MAX_TOTAL_OUTPUT_BYTES:
        raise ValueError("incomplete_results")

    session = _load_resource_import_session_file(str(row["session_id"]))
    if not session or session.get("render_attempt") != row["render_attempt"] or session.get("render_task_id") != task_id:
        raise PermissionError("stale_render_attempt")
    root = _resource_import_temp_dir(session)
    directory = root / f"previews_{row['render_attempt']}"
    staging = directory / f".complete-{uuid.uuid4().hex}"
    staging.mkdir()
    paths: list[Path] = []
    published: list[Path] = []
    database_committed = False
    completed_successfully = False
    try:
        for index in sorted(expected):
            ref = expected[index]["output_ref"]
            target = staging / f"page_{index:04d}.png"
            oss_storage.download_file(ref, target)
            paths.append(target)
            if target.stat().st_size != received[index]["size"] or sha256_file(target) != received[index]["sha256"]:
                raise ValueError("result_checksum_mismatch")
            _validate_import_image(target)
            normalized = _compress_hd_image(target)
            paths[-1] = normalized
        with _resource_import_operation(session, wait=True):
            session = _load_resource_import_session_file(str(row["session_id"]))
            if not session or session.get("render_attempt") != row["render_attempt"] or session.get("render_task_id") != task_id:
                raise PermissionError("stale_render_attempt")
            db.execute("BEGIN IMMEDIATE")
            try:
                _leased_row(db, task_id, lease_token)
                for index, path in zip(sorted(expected), paths):
                    target = directory / f"page_{index:04d}.png"
                    path.replace(target)
                    published.append(target)
                preview_hashes = [sha256_file(path) for path in published]
                db.execute(
                    "UPDATE renderer_ppt_tasks SET status='completed', lease_token_hash=NULL, lease_until=NULL,"
                    " result_manifest=?, updated_at=? WHERE task_id=?",
                    (json.dumps({
                        "pages": [received[i] for i in sorted(received)],
                        "preview_paths": [str(path) for path in published],
                        "preview_hashes": preview_hashes,
                    }, separators=(",", ":")), now_iso(), task_id),
                )
                completed = db.execute("SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (task_id,)).fetchone()
                _update_parent_task(db, completed, success=True)
                db.commit()
                database_committed = True
            except Exception:
                db.rollback()
                # Filesystem publication and SQLite cannot share one native
                # transaction. Remove only files published by this request
                # before restoring the previous session snapshot. A stale
                # worker cannot enter this section because the lease is
                # rechecked while BEGIN IMMEDIATE holds the writer lock.
                for path in published:
                    path.unlink(missing_ok=True)
                published.clear()
                raise
            session.update(
                preview_paths=[str(path) for path in published], partial_preview_paths={},
                preview_hashes=preview_hashes, preview_status="ready", preview_error=None,
                renderer_version=RESOURCE_IMPORT_RENDERER_VERSION,
                expires_at=time.time() + RENDER_SESSION_TTL,
            )
            try:
                _write_resource_import_session(session)
            except Exception:
                # SQLite is the durable completion receipt. Status polling
                # reconstructs this session snapshot from result_manifest.
                logger.exception("Completed render session publication deferred to recovery")
        completed_successfully = True
    except Exception:
        if not database_committed:
            for path in paths:
                path.unlink(missing_ok=True)
            for path in published:
                path.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    if completed_successfully:
        _cleanup_manifest_objects(manifest)


def fail_render_task(db: sqlite3.Connection, task_id: str, lease_token: str, error_code: str | None) -> str:
    db.execute("BEGIN IMMEDIATE")
    try:
        # Validate and mutate under the same SQLite writer lock. Otherwise an
        # old worker could pass the lease check immediately before expiry,
        # then clear a newer worker's lease after the task is reclaimed.
        row = _leased_row(db, task_id, lease_token)
        code = _safe_error_code(error_code)
        retry = code in RETRYABLE_ERROR_CODES and int(row["attempts"]) < MAX_ATTEMPTS
        status = "queued" if retry else "failed"
        db.execute(
            "UPDATE renderer_ppt_tasks SET status=?, lease_token_hash=NULL, lease_until=NULL, error_code=?, updated_at=?"
            " WHERE task_id=?",
            (status, code, now_iso(), task_id),
        )
        current = db.execute("SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (task_id,)).fetchone()
        if status == "failed":
            _update_parent_task(
                db, current, success=False,
                error_message=render_public_message(code),
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    if status == "failed":
        session = _load_resource_import_session_file(str(row["session_id"]))
        if session and session.get("render_attempt") == row["render_attempt"]:
            session.update(preview_status="error", preview_error=render_public_message(code))
            try:
                _write_resource_import_session(session)
            except Exception:
                logger.exception("Failed to persist terminal Windows render error in import session")
    if status == "failed":
        _cleanup_manifest_objects(_manifest(row, "source_manifest"))
    return status
