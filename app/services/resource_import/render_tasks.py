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
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from app.config import settings
from app.core.errors import render_public_message
from app.core.fonts import normalize_font_name
from app.core.oss import oss_key, oss_ref, storage as oss_storage
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
from app.services.resource_import.validation import _split_import_pages

logger = logging.getLogger(__name__)

LEASE_SECONDS = 600
MAX_ATTEMPTS = 5
MAX_OUTPUT_IMAGE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_OUTPUT_BYTES = 512 * 1024 * 1024
RENDER_RESULT_IO_CONCURRENCY = 4
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


def _render_font_inventory(
    db: sqlite3.Connection,
    names: list[str],
) -> tuple[list[str], list[str], list[dict[str, str]]]:
    wanted: dict[str, str] = {}
    for raw_name in names:
        if not isinstance(raw_name, str):
            continue
        name = raw_name.strip()
        if not name or name.startswith("+"):
            continue
        wanted.setdefault(normalize_font_name(name), name)
    required = list(wanted.values())
    if len(required) > 128 or any(len(name) > 256 for name in required):
        raise RuntimeError("PPT 所需字体清单无效")
    if not required:
        return [], [], []
    found: set[str] = set()
    hashes: list[str] = []
    bindings: list[dict[str, str]] = []
    binding_keys: set[tuple[str, str]] = set()
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
        for key in wanted:
            if key not in matches or (key, digest) in binding_keys:
                continue
            binding_keys.add((key, digest))
            bindings.append({"name": wanted[key], "sha256": digest})
    missing = wanted.keys() - found
    if missing:
        raise RuntimeError("标准字体清单与 PPT 不匹配：" + "、".join(wanted[key] for key in sorted(missing)))
    if len(hashes) > 64:
        raise RuntimeError("本次渲染所需标准字体文件过多")
    if len(bindings) > 512:
        raise RuntimeError("本次渲染所需字体别名绑定过多")
    return required, hashes, bindings


def _cleanup_manifest_objects(manifest: dict[str, Any]) -> bool:
    cleaned = True
    source = manifest.get("source")
    if isinstance(source, dict) and isinstance(source.get("source_ref"), str):
        try:
            oss_storage.delete(source["source_ref"])
        except Exception:
            cleaned = False
            logger.warning("Deferred OSS render-source cleanup", exc_info=True)
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


def _mark_parent_rendering(
    db: sqlite3.Connection,
    parent_task_id: int | None,
    *,
    task_id: str,
    render_attempt: str,
    total: int,
) -> None:
    """Publish a child render generation to its durable parent transactionally."""
    if parent_task_id is None:
        return
    parent = db.execute(
        "SELECT status, params FROM tasks WHERE id=?",
        (parent_task_id,),
    ).fetchone()
    if parent is None or parent["status"] not in {"uploading", "pending", "processing"}:
        raise RuntimeError("导入任务已结束，不能创建图片渲染任务")
    try:
        params = json.loads(parent["params"] or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        params = {}
    params.update({
        "workflow_state": "rendering",
        "preview_status": "rendering",
        "preview_error": None,
        "render_stage": "queued",
        "render_completed": 0,
        "render_total": total,
        "render_task_id": task_id,
        "render_attempt": render_attempt,
    })
    changed = db.execute(
        "UPDATE tasks SET status='pending', progress=0, total=?,"
        " message='等待 Windows 转换节点领取任务…', error_message=NULL, params=?,"
        " updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
        " WHERE id=? AND status IN ('uploading','pending','processing')",
        (total, json.dumps(params, ensure_ascii=False), parent_task_id),
    )
    if changed.rowcount != 1:
        raise RuntimeError("导入任务状态已变化，未创建图片渲染任务")


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
        # The durable import worker may already have removed pages that contain
        # external media. Reuse that immutable filtered split; re-splitting the
        # original source would put the rejected pages back into rendering.
        existing_splits = [
            _resource_import_file(session, path)
            for path in session.get("split_paths", [])
            if isinstance(path, str)
        ]
        if existing_splits:
            singles = existing_splits
        elif session.get("skipped_pages"):
            singles, source_indexes, skipped, _ = _split_import_pages(
                source, source_dir, max_total_bytes=512 * 1024 * 1024,
            )
            session["valid_source_page_indexes"] = source_indexes
            session["skipped_pages"] = skipped
            session["split_paths"] = [str(path) for path in singles]
            session["split_hashes"] = [sha256_file(path) for path in singles]
            _write_resource_import_session(session)
        else:
            singles = split_pptx_to_single_pages(
                source, source_dir, max_total_bytes=512 * 1024 * 1024
            )
        if len(singles) != expected:
            raise RuntimeError("PPT 拆分页数不一致，未提交渲染")
        batch_size = max(1, min(50, int(getattr(settings, "render_wps_batch_size", 20))))
        if session.get("skipped_pages"):
            # v2 renders the original multi-page source and therefore cannot
            # omit a rejected page. Use the validated single-page inputs.
            batch_size = 1
        source_sha256 = sha256_file(source)
        render_source: dict[str, Any] | None = None
        if batch_size > 1:
            source_size = source.stat().st_size
            if source_size <= 0:
                raise RuntimeError("待渲染 PPTX 为空")
            source_ref = oss_storage.upload_file(
                source, _task_key(task_id, "source", 0, ".pptx"),
                content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            )
            refs.append(source_ref)
            render_source = {
                "source_ref": source_ref,
                "sha256": source_sha256,
                "size": source_size,
                "slide_count": expected,
            }
        original_indexes = list(session.get("valid_source_page_indexes") or range(len(singles)))
        if len(original_indexes) != len(singles):
            raise RuntimeError("PPT 有效页码清单不一致，未提交渲染")
        pages: list[dict[str, Any]] = []
        for index, single in enumerate(singles):
            size = single.stat().st_size
            if not 0 < size <= 120 * 1024 * 1024:
                raise RuntimeError(f"第 {index + 1} 页 PPTX 为空或超过 120 MiB")
            # Keep the immutable local split for import and v1 fallback. A v2
            # worker only needs the full source, so upload singles on demand.
            source_ref = oss_ref(_task_key(task_id, "input", index, ".pptx"))
            pages.append({
                "index": index,
                "source_page": int(original_indexes[index]),
                "source_ref": source_ref,
                "source_uploaded": False,
                "sha256": sha256_file(single),
                "size": size,
            })
        manifest = {
            "version": 1,
            "session_id": session["session_id"],
            "render_attempt": attempt,
            "dpi": int(settings.render_dpi),
            "batch_size": batch_size,
            "pages": pages,
            "outputs": [],
            "stale_outputs": [],
        }
        if render_source is not None:
            manifest["source"] = render_source
        db = get_db()
        cancelled_manifests: list[dict[str, Any]] = []
        try:
            # Backfill synchronization receipts before freezing the font
            # inventory into this immutable render attempt.
            from app.services.resource_import.font_tasks import ensure_all_font_tasks
            ensure_all_font_tasks(db)
            db.commit()
            db.execute("BEGIN IMMEDIATE")
            required_fonts, font_hashes, font_bindings = _render_font_inventory(
                db, session.get("fonts", []),
            )
            manifest["required_fonts"] = required_fonts
            manifest["font_hashes"] = font_hashes
            manifest["font_bindings"] = font_bindings
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
            _mark_parent_rendering(
                db,
                session.get("task_id") if isinstance(session.get("task_id"), int) else None,
                task_id=task_id,
                render_attempt=attempt,
                total=expected,
            )
            row = db.execute("SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (task_id,)).fetchone()
            # Publish the session pointer before committing the queue row while
            # BEGIN IMMEDIATE still prevents a worker from seeing the task.
            # This closes the race where an extremely fast worker could finish
            # before the session knew which immutable render attempt it owned.
            session.update(
                preview_status="rendering", preview_error=None, preview_paths=[], preview_hashes=[],
                partial_preview_paths={}, partial_preview_hashes={},
                render_attempt=attempt, render_task_id=task_id, render_worker_attempt=0,
                renderer_version=RESOURCE_IMPORT_RENDERER_VERSION,
                split_paths=[str(path) for path in singles], split_hashes=[item["sha256"] for item in pages],
                rendered_source_sha256=source_sha256, expires_at=time.time() + RENDER_SESSION_TTL,
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


def _render_result_manifest(row: sqlite3.Row) -> dict:
    try:
        return _manifest(row, "result_manifest")
    except RuntimeError as exc:
        raise ValueError("invalid_result_receipt") from exc


def _render_receipt_files(row: sqlite3.Row) -> tuple[dict, dict]:
    result = _render_result_manifest(row)
    if "worker_attempt" in result:
        _, paths, hashes = _accepted_render_results(row)
        return paths, hashes
    if row["status"] != "completed":
        return {}, {}
    # Completed receipts written before incremental publication remain valid.
    paths, hashes = result.get("preview_paths"), result.get("preview_hashes")
    indexes = sorted(int(item["index"]) for item in _manifest(row, "source_manifest").get("pages", []))
    if (not isinstance(paths, list) or not isinstance(hashes, list)
            or len(paths) != len(indexes) or len(hashes) != len(indexes)
            or any(not isinstance(value, str) or not value for value in paths)
            or any(not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None for value in hashes)):
        raise ValueError("invalid_result_receipt")
    return dict(zip(map(str, indexes), paths)), dict(zip(map(str, indexes), hashes))


def _recover_render_snapshot(db: sqlite3.Connection, row: sqlite3.Row, session: dict) -> bool:
    """Repair JSON publication without reviving a reclaimed or cancelled claim."""
    try:
        with _resource_import_operation(session):
            current = _current_render_session(row)
            latest = db.execute("SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (row["task_id"],)).fetchone()
            if (latest is None or latest["status"] not in {"queued", "running", "completed"}
                    or latest["attempts"] != row["attempts"]):
                return False
            _assert_render_owner(db, latest, current)
            paths, hashes = _render_receipt_files(latest)
            _verify_render_receipt_files(current, paths, hashes)
            final = latest["status"] == "completed"
            expected = {str(item["index"]) for item in _manifest(latest, "source_manifest").get("pages", [])}
            if final and set(paths) != expected:
                return False
            indexes = sorted(paths, key=int)
            receipt = {
                "partial_preview_paths": paths, "partial_preview_hashes": hashes,
                "preview_paths": [paths[index] for index in indexes],
                "preview_hashes": [hashes[index] for index in indexes],
            }
            db.execute("BEGIN IMMEDIATE")
            try:
                checked = db.execute("SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (row["task_id"],)).fetchone()
                if (checked is None or checked["status"] != latest["status"]
                        or checked["attempts"] != latest["attempts"]
                        or checked["result_manifest"] != latest["result_manifest"]):
                    db.rollback()
                    return False
                _assert_render_owner(db, checked, _current_render_session(checked))
                _apply_render_snapshot(current, checked, receipt, final=final)
                _write_resource_import_session(current)
                db.commit()
            except Exception:
                db.rollback()
                raise
            session.clear()
            session.update(current)
            return True
    except Exception:
        # A writer may still own the operation lock or disk may be unavailable.
        # The durable receipt remains intact for a later status poll.
        return False


def render_task_state(session: dict[str, Any]) -> dict[str, Any]:
    task_id = session.get("render_task_id")
    if not isinstance(task_id, str):
        ready = session.get("preview_status") == "ready"
        count = len(session.get("preview_paths", [])) if ready else 0
        return {"status": "completed" if ready else "pending", "preview_count": count,
                "ready_indexes": list(range(count))}
    db = get_db()
    try:
        row = db.execute("SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (task_id,)).fetchone()
        if row is None:
            return {"status": "error", "message": "渲染任务不存在，请重新生成图片", "preview_count": 0}
        try:
            _assert_render_owner(db, row, session)
        except PermissionError:
            return {"status": "error", "message": "该图片渲染任务已失效，请刷新预览", "preview_count": 0}
        if row["status"] in {"cancelled", "failed"}:
            message = "该图片渲染任务已取消，请重新生成" if row["status"] == "cancelled" else render_public_message(row["error_code"])
            return {"status": "error", "message": message, "preview_count": 0}
        generation = int(row["attempts"])
        try:
            paths, hashes = _render_receipt_files(row)
        except (TypeError, ValueError, KeyError):
            return {"status": "publishing", "preview_count": 0, "ready_indexes": [], "attempts": generation}
        final = row["status"] == "completed"
        indexes = sorted(paths, key=int)
        expected_count = len(_manifest(row, "source_manifest").get("pages", []))
        if final and len(paths) != expected_count:
            return {"status": "publishing", "preview_count": 0, "ready_indexes": [], "attempts": generation}
        matching = (
            session.get("render_worker_attempt") == generation
            and session.get("renderer_version") == RESOURCE_IMPORT_RENDERER_VERSION
            and session.get("preview_status") == ("ready" if final else "rendering")
            and (session.get("preview_paths") == [paths[index] for index in indexes]
                 and session.get("preview_hashes") == [hashes[index] for index in indexes]
                 if final else session.get("partial_preview_paths", {}) == paths
                 and session.get("partial_preview_hashes", {}) == hashes
                 and not session.get("preview_paths"))
        )
        if not matching and not _recover_render_snapshot(db, row, session):
            return {"status": "publishing", "preview_count": 0, "ready_indexes": [], "attempts": generation}
        # Recovery cannot return an old receipt after another worker reclaimed it.
        latest = db.execute("SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (task_id,)).fetchone()
        if (latest is None or latest["attempts"] != row["attempts"]
                or latest["status"] != row["status"] or latest["result_manifest"] != row["result_manifest"]):
            return {"status": "publishing", "preview_count": 0, "ready_indexes": [],
                    "attempts": int(latest["attempts"]) if latest else generation}
        try:
            _assert_render_owner(db, latest, session)
        except PermissionError:
            return {"status": "error", "message": "该图片渲染任务已失效，请刷新预览", "preview_count": 0}
        return {"status": str(row["status"]), "preview_count": len(paths),
                "ready_indexes": [int(index) for index in indexes], "attempts": generation,
                "render_attempt": str(row["render_attempt"])}
    finally:
        db.close()


def render_task_preview_file(session: dict, index: int, worker_attempt: int | None = None) -> Path:
    """Resolve a verified current receipt, never a stale JSON partial path."""
    db = get_db()
    try:
        with _resource_import_operation(session, wait=True):
            row = db.execute("SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (session.get("render_task_id"),)).fetchone()
            if row is None or row["status"] not in {"queued", "running", "completed"}:
                raise PermissionError("stale_render_attempt")
            current = _current_render_session(row)
            _assert_render_owner(db, row, current)
            if (session.get("render_attempt") != row["render_attempt"]
                    or worker_attempt is not None and worker_attempt != int(row["attempts"])):
                raise PermissionError("stale_worker_attempt")
            paths, hashes = _render_receipt_files(row)
            if str(index) not in paths:
                raise KeyError(index)
            path = _resource_import_file(current, paths[str(index)])
            if sha256_file(path) != hashes[str(index)]:
                raise ValueError("preview_checksum_mismatch")
            latest = db.execute("SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (row["task_id"],)).fetchone()
            if (latest is None or latest["attempts"] != row["attempts"]
                    or latest["status"] not in {"queued", "running", "completed"}):
                raise PermissionError("stale_worker_attempt")
            _assert_render_owner(db, latest, _current_render_session(latest))
            return path
    finally:
        db.close()


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
                " attempts=attempts+1, source_manifest=?, result_manifest=NULL, error_code=NULL, updated_at=? WHERE task_id=? AND "
                "(status='queued' OR (status='running' AND lease_until<? AND attempts<?))",
                (_token_hash(token), now + LEASE_SECONDS, worker_id,
                 json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
                 now_iso(), row["task_id"], now, MAX_ATTEMPTS),
            )
            if changed.rowcount != 1:
                db.rollback()
                return None
            claimed = db.execute(
                "SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (row["task_id"],)
            ).fetchone()
            _update_parent_render_progress(db, claimed, 0)
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
    payload = {
        "task_id": row["task_id"], "lease_token": lease_token, "lease_seconds": LEASE_SECONDS,
        "attempts": int(row["attempts"]), "dpi": int(manifest["dpi"]), "pages": pages,
        "batch_size": max(1, min(50, int(manifest.get("batch_size", 1)))),
        "incremental_results": True, "first_batch_size": 4,
        "required_fonts": manifest.get("required_fonts", []),
        "font_hashes": manifest.get("font_hashes", []),
        "font_bindings": manifest.get("font_bindings", []),
    }
    source = manifest.get("source")
    if isinstance(source, dict):
        payload["source"] = {
            "sha256": source.get("sha256"),
            "size": int(source.get("size", 0)),
            "slide_count": int(source.get("slide_count", 0)),
        }
    return payload


def refresh_render_task_source_url(
    db: sqlite3.Connection, task_id: str, lease_token: str,
) -> dict[str, Any]:
    """Issue a fresh signed URL for the immutable multi-page render source."""
    row = _leased_row(db, task_id, lease_token)
    source = _manifest(row, "source_manifest").get("source")
    if not isinstance(source, dict) or not source.get("source_ref"):
        raise ValueError("render_source_unavailable")
    return {
        "download_url": oss_storage.signed_url(source["source_ref"]),
        "sha256": source.get("sha256"),
        "size": int(source.get("size", 0)),
        "slide_count": int(source.get("slide_count", 0)),
    }


def refresh_render_task_urls(
    db: sqlite3.Connection, task_id: str, lease_token: str, page_index: int,
    include_source: bool = True,
) -> dict[str, Any]:
    """Issue fresh signed URLs for one page without changing its task lease."""
    row = _leased_row(db, task_id, lease_token)
    manifest = _manifest(row, "source_manifest")
    sources = {int(item["index"]): item for item in manifest.get("pages", [])}
    outputs = {int(item["index"]): item for item in manifest.get("outputs", [])}
    if page_index not in sources or page_index not in outputs:
        raise ValueError("invalid_page_index")
    if include_source and sources[page_index].get("source_uploaded") is False:
        session = _current_render_session(row)
        with _resource_import_operation(session, wait=True):
            row = _leased_row(db, task_id, lease_token)
            session = _current_render_session(row)
            _assert_render_owner(db, row, session)
            manifest = _manifest(row, "source_manifest")
            source = next(item for item in manifest["pages"] if item["index"] == page_index)
            if source.get("source_uploaded") is False:
                split_paths, split_hashes = session.get("split_paths"), session.get("split_hashes")
                if (not isinstance(split_paths, list) or not isinstance(split_hashes, list)
                        or page_index >= len(split_paths) or page_index >= len(split_hashes)
                        or split_hashes[page_index] != source["sha256"]):
                    raise ValueError("invalid_split_source")
                path = _resource_import_file(session, split_paths[page_index])
                if path.stat().st_size != source["size"] or sha256_file(path) != source["sha256"]:
                    raise ValueError("split_source_checksum_mismatch")
                # The session operation lock prevents replacement of the local
                # source. No SQLite writer lock is held during OSS transfer.
                oss_storage.upload_file(
                    path, oss_key(source["source_ref"]),
                    content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                )
                db.execute("BEGIN IMMEDIATE")
                try:
                    row = _leased_row(db, task_id, lease_token)
                    _assert_render_owner(db, row, _current_render_session(row))
                    manifest = _manifest(row, "source_manifest")
                    current_source = next(item for item in manifest["pages"] if item["index"] == page_index)
                    if current_source["source_ref"] != source["source_ref"] or current_source["sha256"] != source["sha256"]:
                        raise PermissionError("stale_render_source")
                    current_source["source_uploaded"] = True
                    db.execute(
                        "UPDATE renderer_ppt_tasks SET source_manifest=?, updated_at=? WHERE task_id=?",
                        (json.dumps(manifest, separators=(",", ":")), now_iso(), task_id),
                    )
                    db.commit()
                except Exception:
                    db.rollback()
                    raise
        # A cancelled or reclaimed task must not receive a fresh signed URL.
        row = _leased_row(db, task_id, lease_token)
        manifest = _manifest(row, "source_manifest")
        sources = {int(item["index"]): item for item in manifest["pages"]}
        outputs = {int(item["index"]): item for item in manifest["outputs"]}
    result = {
        "index": page_index,
        "upload_url": oss_storage.signed_put_url(
            outputs[page_index]["output_ref"], expires_seconds=RESULT_URL_SECONDS,
            content_type="image/png",
        ),
    }
    if include_source:
        result["download_url"] = oss_storage.signed_url(sources[page_index]["source_ref"])
    return result


def _current_render_session(row: sqlite3.Row) -> dict[str, Any]:
    session = _load_resource_import_session_file(str(row["session_id"]))
    if (not session or session.get("render_attempt") != row["render_attempt"]
            or session.get("render_task_id") != row["task_id"]):
        raise PermissionError("stale_render_attempt")
    return session


def _render_parent_params(db: sqlite3.Connection, row: sqlite3.Row) -> dict | None:
    parent_id = row["parent_task_id"]
    if parent_id is None:
        return None
    parent = db.execute("SELECT status, params FROM tasks WHERE id=?", (parent_id,)).fetchone()
    if parent is None or parent["status"] not in {"uploading", "pending", "processing"}:
        raise PermissionError("stale_render_parent")
    try:
        params = json.loads(parent["params"] or "{}")
    except (TypeError, ValueError):
        raise PermissionError("stale_render_parent") from None
    if (not isinstance(params, dict)
            or params.get("render_task_id") not in (None, row["task_id"])
            or params.get("render_attempt") not in (None, row["render_attempt"])
            or params.get("session_id") not in (None, row["session_id"])):
        raise PermissionError("stale_render_parent")
    return params


def _assert_render_owner(db: sqlite3.Connection, row: sqlite3.Row, session: dict[str, Any]) -> None:
    if (session.get("render_attempt") != row["render_attempt"]
            or session.get("render_task_id") != row["task_id"]
            or "commit_result" in session):
        raise PermissionError("stale_render_attempt")
    if row["parent_task_id"] is not None and session.get("task_id") not in (None, row["parent_task_id"]):
        raise PermissionError("stale_render_parent")
    _render_parent_params(db, row)


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
    try:
        params = _render_parent_params(db, row)
    except PermissionError:
        return
    if success:
        total = len(_manifest(row, "source_manifest").get("pages", []))
        params.update({
            "workflow_state": "awaiting_confirmation", "preview_status": "ready", "preview_error": None,
            "render_stage": "completed", "render_completed": total, "render_total": total,
            "render_worker_attempt": int(row["attempts"]),
            "skipped_pages": params.get("skipped_pages", []),
        })
        message, progress = "图片已渲染，等待确认导入", len(_manifest(row, "source_manifest").get("pages", []))
        db.execute(
            "UPDATE tasks SET status='pending', progress=?, total=?, message=?, error_message=NULL, params=?,"
            " updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
            " WHERE id=? AND status IN ('uploading','pending','processing')",
            (progress, progress, message, json.dumps(params, ensure_ascii=False), parent),
        )
    else:
        message = error_message or render_public_message("render_failed")
        params.update({
            "workflow_state": "awaiting_render", "preview_status": "error", "preview_error": message,
            "render_stage": "failed", "render_completed": 0,
        })
        db.execute(
            "UPDATE tasks SET status='pending', message=?, error_message=?, params=?,"
            " updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
            " WHERE id=? AND status IN ('uploading','pending','processing')",
            (message, message, json.dumps(params, ensure_ascii=False), parent),
        )


def _validated_render_pages(pages: list[dict[str, Any]], expected: set[int]) -> dict[int, dict[str, Any]]:
    if not isinstance(pages, list) or not 1 <= len(pages) <= 500:
        raise ValueError("invalid_results")
    received: dict[int, dict[str, Any]] = {}
    for item in pages:
        if not isinstance(item, dict):
            raise ValueError("invalid_page_result")
        index = item.get("index")
        if type(index) is not int or index not in expected or index in received:
            raise ValueError("invalid_page_index")
        size, digest = item.get("size"), item.get("sha256")
        if type(size) is not int or not 0 < size <= MAX_OUTPUT_IMAGE_BYTES:
            raise ValueError("invalid_page_size")
        if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            raise ValueError("invalid_page_sha256")
        received[index] = {"index": index, "size": size, "sha256": digest}
    return received


def _accepted_render_results(row: sqlite3.Row) -> tuple[dict, dict, dict]:
    """Only receipts accepted during this claim can participate in publication."""
    result = _render_result_manifest(row)
    if type(result.get("worker_attempt")) is not int or result["worker_attempt"] != int(row["attempts"]):
        return {}, {}, {}
    expected = {int(item["index"]) for item in _manifest(row, "source_manifest").get("pages", [])}
    received = _validated_render_pages(result.get("pages"), expected)
    paths = result.get("partial_preview_paths")
    hashes = result.get("partial_preview_hashes")
    keys = {str(index) for index in received}
    if (not isinstance(paths, dict) or not isinstance(hashes, dict)
            or set(paths) != keys or set(hashes) != keys
            or any(not isinstance(value, str) or not value for value in paths.values())
            or any(not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None
                   for value in hashes.values())
            or sum(item["size"] for item in received.values()) > MAX_TOTAL_OUTPUT_BYTES):
        raise ValueError("invalid_result_receipt")
    return received, dict(paths), dict(hashes)


def _merge_render_results(previous: dict, received: dict) -> dict:
    for index, item in received.items():
        if index in previous and previous[index] != item:
            raise ValueError("conflicting_page_result")
    merged = {**previous, **received}
    if sum(item["size"] for item in merged.values()) > MAX_TOTAL_OUTPUT_BYTES:
        raise ValueError("results_too_large")
    return merged


def _verify_render_receipt_files(session: dict, paths: dict, hashes: dict) -> None:
    for index, raw_path in paths.items():
        path = _resource_import_file(session, raw_path)
        if sha256_file(path) != hashes[index]:
            raise ValueError("preview_checksum_mismatch")


def _apply_render_snapshot(session: dict, row: sqlite3.Row, receipt: dict, *, final: bool) -> None:
    session.update(
        preview_paths=receipt.get("preview_paths", []) if final else [],
        preview_hashes=receipt.get("preview_hashes", []) if final else [],
        partial_preview_paths={} if final else receipt["partial_preview_paths"],
        partial_preview_hashes={} if final else receipt["partial_preview_hashes"],
        render_worker_attempt=int(row["attempts"]),
        preview_status="ready" if final else "rendering", preview_error=None,
        renderer_version=RESOURCE_IMPORT_RENDERER_VERSION,
        expires_at=time.time() + RENDER_SESSION_TTL,
    )


def _update_parent_render_progress(db: sqlite3.Connection, row: sqlite3.Row, count: int) -> None:
    parent_id = row["parent_task_id"]
    if parent_id is None:
        return
    try:
        params = _render_parent_params(db, row)
    except PermissionError:
        return
    total = len(_manifest(row, "source_manifest").get("pages", []))
    params.update({
        "workflow_state": "rendering", "preview_status": "rendering", "preview_error": None,
        "render_stage": "rendering", "render_completed": count, "render_total": total,
        "render_task_id": row["task_id"], "render_attempt": row["render_attempt"],
        "render_worker_attempt": int(row["attempts"]),
    })
    db.execute(
        "UPDATE tasks SET progress=?, total=?, message=?, error_message=NULL, params=?,"
        " updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
        " WHERE id=? AND status IN ('uploading','pending','processing')",
        (count, total, f"已完成 {count} / {total} 页图片渲染", json.dumps(params, ensure_ascii=False), parent_id),
    )


def _publish_render_task_results(
    db: sqlite3.Connection, task_id: str, lease_token: str, pages: list[dict[str, Any]], *, final: bool,
) -> dict[str, Any]:
    row = _leased_row(db, task_id, lease_token)
    manifest = _manifest(row, "source_manifest")
    expected = {int(item["index"]): item for item in manifest.get("outputs", [])}
    received = _validated_render_pages(pages, set(expected))
    if final and set(received) != set(expected):
        raise ValueError("incomplete_results")
    session = _current_render_session(row)
    _assert_render_owner(db, row, session)
    previous, _, _ = _accepted_render_results(row)
    _merge_render_results(previous, received)
    generation = int(row["attempts"])
    root = _resource_import_temp_dir(session)
    directory = root / f"previews_{row['render_attempt']}"
    # Reclaimed leases never overwrite files a previous lease published.
    # Preserve first-claim paths for compatibility with existing receipts.
    destination = directory if generation == 1 else directory / f"worker_{generation}"
    destination.mkdir(parents=True, exist_ok=True)
    staging = directory / f".complete-{uuid.uuid4().hex}"
    staging.mkdir()
    staged: dict[int, Path] = {}
    staged_hashes: dict[int, str] = {}
    published: list[Path] = []
    database_committed = False
    try:
        new_indexes = sorted(set(received) - set(previous))

        def stage_one(index: int) -> tuple[int, Path, str]:
            target = staging / f"page_{index:04d}.png"
            oss_storage.download_file(expected[index]["output_ref"], target)
            if target.stat().st_size != received[index]["size"] or sha256_file(target) != received[index]["sha256"]:
                raise ValueError("result_checksum_mismatch")
            try:
                _validate_import_image(target)
            except Exception as exc:
                raise ValueError("invalid_rendered_image") from exc
            normalized = _compress_hd_image(target)
            return index, normalized, sha256_file(normalized)

        # Each output is immutable and independently checksummed. Parallelize
        # the OSS download and image normalization before taking the SQLite
        # writer lock, so one slow page does not delay publication of the rest
        # of the incremental batch.
        if new_indexes:
            workers = min(RENDER_RESULT_IO_CONCURRENCY, len(new_indexes))
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="render-result") as pool:
                for index, normalized, digest in pool.map(stage_one, new_indexes):
                    staged[index] = normalized
                    staged_hashes[index] = digest
        with _resource_import_operation(session, wait=True):
            session = _current_render_session(row)
            current = _leased_row(db, task_id, lease_token)
            _assert_render_owner(db, current, session)
            previous, preview_paths, preview_hashes = _accepted_render_results(current)
            _merge_render_results(previous, received)
            # Filesystem checks occur outside the SQLite writer transaction.
            if final or not staged:
                _verify_render_receipt_files(session, preview_paths, preview_hashes)
            db.execute("BEGIN IMMEDIATE")
            try:
                current = _leased_row(db, task_id, lease_token)
                _assert_render_owner(db, current, _current_render_session(current))
                if int(current["attempts"]) != generation:
                    raise PermissionError("stale_worker_attempt")
                previous, preview_paths, preview_hashes = _accepted_render_results(current)
                merged = _merge_render_results(previous, received)
                for index in sorted(set(received) - set(previous)):
                    path = staged[index]
                    target = destination / f"page_{index:04d}.png"
                    path.replace(target)
                    published.append(target)
                    preview_paths[str(index)] = str(target)
                    preview_hashes[str(index)] = staged_hashes[index]
                receipt = {
                    "worker_attempt": generation,
                    "pages": [merged[index] for index in sorted(merged)],
                    "partial_preview_paths": preview_paths,
                    "partial_preview_hashes": preview_hashes,
                }
                if final:
                    if set(merged) != set(expected):
                        raise ValueError("incomplete_results")
                    receipt["preview_paths"] = [preview_paths[str(index)] for index in sorted(expected)]
                    receipt["preview_hashes"] = [preview_hashes[str(index)] for index in sorted(expected)]
                    db.execute(
                        "UPDATE renderer_ppt_tasks SET status='completed', lease_token_hash=NULL, lease_until=NULL,"
                        " result_manifest=?, updated_at=? WHERE task_id=?",
                        (json.dumps(receipt, separators=(",", ":")), now_iso(), task_id),
                    )
                    _update_parent_task(db, current, success=True)
                else:
                    db.execute(
                        "UPDATE renderer_ppt_tasks SET result_manifest=?, updated_at=? WHERE task_id=?",
                        (json.dumps(receipt, separators=(",", ":")), now_iso(), task_id),
                    )
                    _update_parent_render_progress(db, current, len(merged))
                db.commit()
                database_committed = True
            except Exception:
                db.rollback()
                # Never delete another batch's durable, accepted page.
                for path in published:
                    path.unlink(missing_ok=True)
                published.clear()
                raise
            _apply_render_snapshot(session, current, receipt, final=final)
            try:
                _write_resource_import_session(session)
            except Exception:
                logger.exception("Render session publication deferred to receipt recovery")
        if final:
            _cleanup_manifest_objects(manifest)
        return {"ok": True, "preview_count": len(merged), "total": len(expected)}
    except Exception:
        if not database_committed:
            for path in published:
                path.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def publish_render_task_progress(
    db: sqlite3.Connection, task_id: str, lease_token: str, pages: list[dict[str, Any]],
) -> dict[str, Any]:
    return _publish_render_task_results(db, task_id, lease_token, pages, final=False)


def complete_render_task(db: sqlite3.Connection, task_id: str, lease_token: str, pages: list[dict[str, Any]]) -> None:
    _publish_render_task_results(db, task_id, lease_token, pages, final=True)


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
