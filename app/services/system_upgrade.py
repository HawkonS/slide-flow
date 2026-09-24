"""Persistent coordination for disruptive system runtime operations.

Restart, shutdown, and upgrade scripts deliberately outlive the API worker
that starts them. A small state file and an exclusive lock let every Gunicorn
worker (and the fresh process after a restart) observe the same result without
relying on process-local threads.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import fcntl
import psutil


ACTIVE_UPGRADE_STATES = frozenset({"queued", "running", "restarting"})
ACTIVE_OPERATION_STATES = frozenset({"queued", "running", "restarting", "stopping"})
TERMINAL_UPGRADE_STATES = frozenset({"succeeded", "failed"})
VALID_UPGRADE_STATES = ACTIVE_OPERATION_STATES | TERMINAL_UPGRADE_STATES
VALID_OPERATION_TYPES = frozenset({"upgrade", "restart", "shutdown"})
UPGRADE_STALE_SECONDS = 15 * 60
MAX_STATE_FILE_BYTES = 64 * 1024


class UpgradeAlreadyRunning(RuntimeError):
    """Raised when another worker already owns the upgrade lock."""


class OperationOwnershipLost(RuntimeError):
    """Raised when a superseded operation attempts to overwrite newer state."""


def upgrade_paths(data_dir: Path) -> tuple[Path, Path]:
    # Keep the established filenames for compatibility with an upgrade that
    # was launched by the previous application version. The files now
    # coordinate every disruptive runtime operation, not upgrades alone.
    return data_dir / ".system_upgrade_state.json", data_dir / ".system_upgrade.lock"


operation_paths = upgrade_paths


@contextmanager
def _coordination_guard(lock_path: Path):
    """Serialize state/owner checks so compare-and-write is truly atomic."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    guard_path = lock_path.with_name(f"{lock_path.name}.guard")
    with guard_path.open("a+b") as guard:
        os.chmod(guard_path, 0o600)
        fcntl.flock(guard.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(guard.fileno(), fcntl.LOCK_UN)


def _timestamp(now: float | None = None) -> str:
    timestamp = time.time() if now is None else now
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def _parse_timestamp(value: object) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def _lock_owner(lock_path: Path) -> str | None:
    try:
        owner = lock_path.read_text(encoding="ascii").strip()
    except (FileNotFoundError, OSError, UnicodeError):
        return None
    return owner or None


def _release_lock(lock_path: Path, job_id: str) -> None:
    """Release only the lock owned by this job."""
    if _lock_owner(lock_path) == job_id:
        _safe_unlink(lock_path)


def _read_state_file(path: Path) -> dict[str, Any] | None:
    try:
        if path.stat().st_size > MAX_STATE_FILE_BYTES:
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    state = payload.get("state")
    job_id = payload.get("job_id")
    if state not in VALID_UPGRADE_STATES or not isinstance(job_id, str) or not job_id:
        return None
    return payload


def write_upgrade_state(path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    """Atomically persist a bounded, browser-safe upgrade state."""
    state = payload.get("state")
    if state not in VALID_UPGRADE_STATES:
        raise ValueError(f"Unsupported upgrade state: {state!r}")
    job_id = payload.get("job_id")
    if not isinstance(job_id, str) or not job_id:
        raise ValueError("Upgrade state requires a job_id")

    normalized = dict(payload)
    normalized["message"] = str(normalized.get("message") or "")[:2000]
    normalized["updated_at"] = str(normalized.get("updated_at") or _timestamp())
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(normalized, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        _safe_unlink(temporary)
    return normalized


def _lock_is_stale(lock_path: Path, *, now: float) -> bool:
    try:
        return now - lock_path.stat().st_mtime > UPGRADE_STALE_SECONDS
    except FileNotFoundError:
        return False


def begin_upgrade(
    state_path: Path,
    lock_path: Path,
    *,
    source_boot_id: str,
    now: float | None = None,
) -> dict[str, Any]:
    return begin_operation(
        state_path,
        lock_path,
        operation="upgrade",
        source_boot_id=source_boot_id,
        now=now,
    )


def begin_operation(
    state_path: Path,
    lock_path: Path,
    *,
    operation: str,
    source_boot_id: str,
    now: float | None = None,
) -> dict[str, Any]:
    """Acquire the cross-worker operation lock and create initial state."""
    if operation not in VALID_OPERATION_TYPES:
        raise ValueError(f"Unsupported system operation: {operation!r}")
    current_time = time.time() if now is None else now
    state_path.parent.mkdir(parents=True, exist_ok=True)
    job_id = uuid.uuid4().hex
    started_at = _timestamp(current_time)
    payload = {
        "job_id": job_id,
        "operation": operation,
        "state": "queued",
        "message": {
            "upgrade": "升级任务已创建",
            "restart": "重启任务已创建",
            "shutdown": "关闭任务已创建",
        }[operation],
        "source_boot_id": source_boot_id,
        "started_at": started_at,
        "updated_at": started_at,
    }

    with _coordination_guard(lock_path):
        for attempt in range(2):
            try:
                fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                try:
                    os.write(fd, job_id.encode("ascii"))
                    os.fsync(fd)
                finally:
                    os.close(fd)
                break
            except FileExistsError:
                current = _read_state_file(state_path)
                owner = _lock_owner(lock_path)
                owner_matches_state = bool(
                    current and owner and owner == current.get("job_id")
                )
                updated = _parse_timestamp(current.get("updated_at")) if current else None
                state_is_stale = bool(
                    owner_matches_state
                    and current.get("state") in ACTIVE_OPERATION_STATES
                    and updated is not None
                    and current_time - updated > UPGRADE_STALE_SECONDS
                    and not _operation_process_is_alive(current)
                )
                terminal_owner = bool(
                    owner_matches_state
                    and current.get("state") in TERMINAL_UPGRADE_STATES
                )
                # A valid state belonging to a different owner is never enough
                # reason to remove that owner's lock, even when its mtime is
                # old. Only reclaim an mtime-stale orphan when there is no
                # valid state at all.
                orphan_is_stale = current is None and _lock_is_stale(
                    lock_path, now=current_time
                )
                if attempt == 0 and (terminal_owner or state_is_stale or orphan_is_stale):
                    _safe_unlink(lock_path)
                    continue
                raise UpgradeAlreadyRunning("系统运行操作正在执行，请勿重复提交") from None
        else:  # pragma: no cover - loop either breaks or raises
            raise UpgradeAlreadyRunning("系统运行操作正在执行，请勿重复提交")

        try:
            return write_upgrade_state(state_path, payload)
        except Exception:
            _release_lock(lock_path, job_id)
            raise


def finish_upgrade(
    state_path: Path,
    lock_path: Path,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return finish_operation(state_path, lock_path, payload)


def finish_operation(
    state_path: Path,
    lock_path: Path,
    payload: dict[str, Any],
) -> dict[str, Any]:
    job_id = str(payload.get("job_id") or "")
    with _coordination_guard(lock_path):
        if not job_id or _lock_owner(lock_path) != job_id:
            raise OperationOwnershipLost("系统运行操作已被新的任务取代")
        current = _read_state_file(state_path)
        if current is not None and current.get("job_id") != job_id:
            raise OperationOwnershipLost("系统运行操作状态已被新的任务取代")
        persisted = write_upgrade_state(state_path, payload)
        if persisted["state"] in TERMINAL_UPGRADE_STATES:
            _release_lock(lock_path, job_id)
        return persisted


def record_operation_process(
    state_path: Path,
    lock_path: Path,
    payload: dict[str, Any],
    *,
    process_pid: int,
    process_started_at: float,
) -> dict[str, Any]:
    """Attach the detached script identity without overwriting newer state."""
    job_id = str(payload.get("job_id") or "")
    with _coordination_guard(lock_path):
        if not job_id or _lock_owner(lock_path) != job_id:
            raise OperationOwnershipLost("系统运行操作已被新的任务取代")
        current = _read_state_file(state_path)
        if current is None or current.get("job_id") != job_id:
            raise OperationOwnershipLost("系统运行操作状态已被新的任务取代")
        current.update(
            process_pid=process_pid,
            process_started_at=process_started_at,
        )
        return write_upgrade_state(state_path, current)


def _operation_process_is_alive(payload: dict[str, Any]) -> bool:
    pid = payload.get("process_pid")
    started_at = payload.get("process_started_at")
    if not isinstance(pid, int) or pid <= 0 or not isinstance(started_at, (int, float)):
        return False
    try:
        process = psutil.Process(pid)
        return (
            process.is_running()
            and process.status() != psutil.STATUS_ZOMBIE
            and abs(process.create_time() - float(started_at)) < 0.01
        )
    except (psutil.Error, OSError):
        return False


def get_upgrade_state(
    state_path: Path,
    lock_path: Path,
    *,
    current_boot_id: str,
    now: float | None = None,
) -> dict[str, Any] | None:
    return get_operation_state(
        state_path,
        lock_path,
        current_boot_id=current_boot_id,
        now=now,
    )


def get_operation_state(
    state_path: Path,
    lock_path: Path,
    *,
    current_boot_id: str,
    now: float | None = None,
) -> dict[str, Any] | None:
    """Read state and reconcile a restart that killed the old script.

    systemd stops every process in the service cgroup during a restart, which
    can terminate the detached upgrade shell after it has handed control to
    systemd.  The first healthy worker of the new boot is authoritative proof
    that the handoff succeeded.
    """
    with _coordination_guard(lock_path):
        payload = _read_state_file(state_path)
        if payload is None:
            return None

        owner = _lock_owner(lock_path)
        if owner and owner != payload["job_id"]:
            # A new owner may have created its lock immediately before writing
            # its state. Never mutate or release either side of this mismatch.
            return None
        if owner is None and payload["state"] in ACTIVE_OPERATION_STATES:
            # Active state without an owner cannot represent a live task. Do
            # not report it as running or mutate it; the next operation may
            # safely acquire the absent lock and replace the orphaned state.
            return None

        operation = payload.get("operation") or "upgrade"
        payload.setdefault("operation", operation)
        current_time = time.time() if now is None else now
        if (
            payload["state"] in {"restarting", "stopping"}
            and payload.get("source_boot_id")
            and payload.get("source_boot_id") != current_boot_id
            and owner == payload["job_id"]
        ):
            payload.update(
                state="succeeded",
                message={
                    "upgrade": "升级完成，服务已恢复",
                    "restart": "服务已成功重启",
                    "shutdown": "上次关闭操作已完成",
                }.get(str(operation), "系统运行操作已完成"),
                completed_at=_timestamp(current_time),
                updated_at=_timestamp(current_time),
            )
            persisted = write_upgrade_state(state_path, payload)
            _release_lock(lock_path, payload["job_id"])
            return persisted

        updated = _parse_timestamp(payload.get("updated_at"))
        if (
            payload["state"] in ACTIVE_OPERATION_STATES
            and updated is not None
            and current_time - updated > UPGRADE_STALE_SECONDS
            and owner == payload["job_id"]
            and not _operation_process_is_alive(payload)
        ):
            log_name = {
                "upgrade": "upgrade.log",
                "restart": "restart.log",
                "shutdown": "shutdown.log",
            }.get(str(operation), "运行日志")
            payload.update(
                state="failed",
                message=f"运行操作长时间无响应，请检查 {log_name}",
                completed_at=_timestamp(current_time),
                updated_at=_timestamp(current_time),
            )
            persisted = write_upgrade_state(state_path, payload)
            _release_lock(lock_path, payload["job_id"])
            return persisted

        if payload["state"] in TERMINAL_UPGRADE_STATES and owner == payload["job_id"]:
            _release_lock(lock_path, payload["job_id"])
        return payload


def mark_upgrade_failed(
    state_path: Path,
    lock_path: Path,
    payload: dict[str, Any],
    message: str,
) -> dict[str, Any]:
    return mark_operation_failed(state_path, lock_path, payload, message)


def mark_operation_failed(
    state_path: Path,
    lock_path: Path,
    payload: dict[str, Any],
    message: str,
) -> dict[str, Any]:
    failed = dict(payload)
    failed.update(
        state="failed",
        message=message,
        completed_at=_timestamp(),
        updated_at=_timestamp(),
    )
    return finish_operation(state_path, lock_path, failed)
