"""Automatic SQLite database backups.

The backup worker is intentionally small: SQLite's online backup API produces a
consistent snapshot, the file is written atomically, and retention is applied
afterwards.  Backups are always kept locally as a fallback; when configured for
OSS they are also uploaded to a private object prefix.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from app.config import ROOT_DIR, read_config_view, settings
from app.core.oss import oss_ref, storage as oss_storage
from app.db import get_db, now_iso

logger = logging.getLogger(__name__)

BACKUP_STATE_ID = 1
BACKUP_PREFIX = "slide-flow-backup-"
BACKUP_SUFFIX = ".db"
DEFAULT_LOCAL_DIR = "data/backups/auto"
DEFAULT_OSS_PREFIX = "backups/db"


def _parse_bool(value: str | None, default: bool = True) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _parse_int(value: str | None, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def backup_options() -> dict[str, Any]:
    """Read backup settings from the live properties file on every check."""
    values = read_config_view()
    storage = (values.get("backup.storage") or "oss").strip().lower()
    if storage not in {"oss", "local"}:
        logger.warning("未知的备份存储位置 %r，已回退到本地", storage)
        storage = "local"
    local_dir_raw = (values.get("backup.local_dir") or DEFAULT_LOCAL_DIR).strip()
    local_dir = Path(local_dir_raw)
    if not local_dir.is_absolute():
        local_dir = ROOT_DIR / local_dir
    return {
        "enabled": _parse_bool(values.get("backup.enabled"), True),
        "storage": storage,
        "interval_hours": _parse_int(values.get("backup.interval_hours"), 24, 1, 720),
        "retention": _parse_int(values.get("backup.retention"), 7, 1, 100),
        "local_dir": local_dir,
        "oss_prefix": (values.get("backup.oss_prefix") or DEFAULT_OSS_PREFIX).strip().strip("/"),
    }


def _backup_stamp(now: datetime | None = None) -> str:
    current = now or datetime.utcnow()
    return current.strftime("%Y%m%dT%H%M%SZ")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    temp = path.with_name(f".{path.name}.tmp")
    try:
        temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def _prune_local(local_dir: Path, retention: int) -> list[str]:
    backups = sorted(local_dir.glob(f"{BACKUP_PREFIX}*{BACKUP_SUFFIX}"))
    removed: list[str] = []
    for old in backups[:-max(1, retention)]:
        old.unlink(missing_ok=True)
        old.with_name(f"{old.name}.json").unlink(missing_ok=True)
        removed.append(old.name)
    return removed


def _oss_base(prefix: str) -> str:
    parts = [part.strip("/") for part in (settings.oss_prefix, prefix) if part and part.strip("/")]
    return "/".join(parts)


def _prune_oss(base: str, retention: int) -> list[str]:
    if not base:
        return []
    try:
        objects = oss_storage.list_objects(base + "/")
    except Exception:
        logger.warning("读取 OSS 备份列表失败，跳过远端保留清理", exc_info=True)
        return []
    keys = sorted(
        str(item["key"]) for item in objects
        if str(item.get("key", "")).endswith(BACKUP_SUFFIX)
    )
    removed: list[str] = []
    for key in keys[:-max(1, retention)]:
        try:
            oss_storage.delete(oss_ref(key))
            oss_storage.delete(oss_ref(key + ".json"))
            removed.append(key)
        except Exception:
            logger.warning("删除过期 OSS 备份失败: %s", key, exc_info=True)
    return removed


def create_database_backup(
    *,
    db_path: Path | None = None,
    local_dir: Path | None = None,
    retention: int = 7,
    storage: str = "local",
    oss_prefix: str = DEFAULT_OSS_PREFIX,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Create one consistent SQLite snapshot, optionally upload it to OSS."""
    source_path = Path(db_path or settings.db_path)
    destination_dir = Path(local_dir or (ROOT_DIR / DEFAULT_LOCAL_DIR))
    destination_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(destination_dir, 0o700)
    except OSError:
        pass
    if not source_path.exists():
        raise FileNotFoundError(f"数据库不存在: {source_path}")

    stamp = _backup_stamp(now)
    filename = f"{BACKUP_PREFIX}{stamp}{BACKUP_SUFFIX}"
    final_path = destination_dir / filename
    temp_path = destination_dir / f".{filename}.tmp"
    metadata_name = f"{filename}.json"

    try:
        source = sqlite3.connect(str(source_path), timeout=30)
        try:
            source.execute("PRAGMA busy_timeout = 10000")
            schema_version = int(source.execute("PRAGMA user_version").fetchone()[0])
            target = sqlite3.connect(str(temp_path))
            try:
                source.backup(target)
                check = target.execute("PRAGMA quick_check").fetchone()
                if not check or str(check[0]).lower() != "ok":
                    raise RuntimeError("备份数据库完整性检查失败")
            finally:
                target.close()
        finally:
            source.close()
    
        os.replace(temp_path, final_path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    try:
        os.chmod(final_path, 0o600)
    except OSError:
        pass
    size = final_path.stat().st_size
    digest = _sha256(final_path)
    metadata = {
        "filename": filename,
        "created_at": now_iso(),
        "size": size,
        "sha256": digest,
        "schema_version": schema_version,
        "source": str(source_path),
    }
    metadata_path = destination_dir / metadata_name
    _write_json_atomic(metadata_path, metadata)
    try:
        os.chmod(metadata_path, 0o600)
    except OSError:
        pass

    result: dict[str, Any] = {
        "filename": filename,
        "path": str(final_path),
        "size": size,
        "sha256": digest,
        "storage": "local",
        "oss_keys": [],
        "oss_error": "",
        "removed_local": _prune_local(destination_dir, retention),
    }
    if storage != "oss":
        return result

    base = _oss_base(oss_prefix)
    db_key = f"{base}/{filename}" if base else filename
    meta_key = f"{base}/{metadata_name}" if base else metadata_name
    try:
        oss_storage.upload_file(final_path, db_key, content_type="application/x-sqlite3")
        oss_storage.upload_file(metadata_path, meta_key, content_type="application/json")
        result["storage"] = "oss"
        result["oss_keys"] = [db_key, meta_key]
        result["removed_oss"] = _prune_oss(base, retention)
    except Exception as exc:
        # Never lose the local snapshot because the remote copy failed.
        logger.exception("备份上传 OSS 失败，本地副本保留: %s", final_path)
        result["oss_error"] = str(exc)
    return result


def _claim_backup(db: sqlite3.Connection, interval_hours: int) -> bool:
    now = datetime.utcnow()
    due = now.isoformat(timespec="seconds") + "Z"
    next_due = (now + timedelta(hours=max(1, interval_hours))).isoformat(timespec="seconds") + "Z"
    db.execute(
        """INSERT OR IGNORE INTO backup_state
           (id, last_started_at, last_completed_at, next_due_at, status, message)
           VALUES (1, NULL, NULL, NULL, 'idle', '')"""
    )
    cursor = db.execute(
        """UPDATE backup_state
           SET last_started_at = ?, next_due_at = ?, status = 'running', message = ''
           WHERE id = 1 AND (next_due_at IS NULL OR next_due_at <= ?)""",
        (due, next_due, due),
    )
    db.commit()
    return cursor.rowcount == 1


def _finish_backup(
    db: sqlite3.Connection,
    *,
    status: str,
    message: str,
    interval_hours: int,
) -> None:
    now = datetime.utcnow()
    next_due = (now + timedelta(hours=max(1, interval_hours))).isoformat(timespec="seconds") + "Z"
    db.execute(
        """UPDATE backup_state
           SET last_completed_at = ?, next_due_at = ?, status = ?, message = ?
           WHERE id = 1""",
        (now_iso(), next_due, status, message[:1000]),
    )
    db.commit()


def run_scheduled_backup() -> dict[str, Any]:
    """Run one due backup; safe to call from every Gunicorn worker."""
    options = backup_options()
    if not options["enabled"]:
        return {"status": "disabled"}
    db = get_db()
    try:
        # A shortened interval must take effect now, not after the old due time.
        now = datetime.utcnow()
        threshold = (now + timedelta(hours=int(options["interval_hours"]))).isoformat(timespec="seconds") + "Z"
        db.execute(
            "UPDATE backup_state SET next_due_at = ? WHERE id = 1 AND next_due_at IS NOT NULL AND next_due_at > ?",
            (now.isoformat(timespec="seconds") + "Z", threshold),
        )
        db.commit()
        if not _claim_backup(db, int(options["interval_hours"])):
            return {"status": "not_due"}
        try:
            result = create_database_backup(
                db_path=settings.db_path,
                local_dir=options["local_dir"],
                retention=int(options["retention"]),
                storage=str(options["storage"]),
                oss_prefix=str(options["oss_prefix"]),
            )
            if result.get("oss_error"):
                message = f"本地备份完成；OSS 上传失败：{result['oss_error']}"
                status = "warning"
            else:
                message = f"备份完成：{result['filename']}（{result['storage']}）"
                status = "ok"
            _finish_backup(db, status=status, message=message, interval_hours=int(options["interval_hours"]))
            logger.info("数据库备份完成: %s", result["filename"])
            return {"status": status, **result}
        except Exception as exc:
            logger.exception("数据库备份失败")
            _finish_backup(
                db,
                status="error",
                message=f"备份失败：{exc}",
                interval_hours=min(1, int(options["interval_hours"])),
            )
            return {"status": "error", "error": str(exc)}
    finally:
        db.close()


async def backup_loop() -> None:
    """Check once a minute; the DB state row makes the backup cross-worker safe."""
    await asyncio.sleep(120)
    while True:
        try:
            await asyncio.to_thread(run_scheduled_backup)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("数据库备份循环异常")
        await asyncio.sleep(60)
