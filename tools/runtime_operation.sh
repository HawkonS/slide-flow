#!/usr/bin/env bash
# Shared persistent state helpers for restart, shutdown, and upgrade scripts.
# This file is sourced by the operation scripts; it is not an entry point.

OPERATION_JOB_ID="${SLIDEFLOW_OPERATION_JOB_ID:-${SLIDEFLOW_UPGRADE_JOB_ID:-}}"
OPERATION_TYPE="${SLIDEFLOW_OPERATION_TYPE:-upgrade}"
OPERATION_STATE_FILE="${SLIDEFLOW_OPERATION_STATE_FILE:-${SLIDEFLOW_UPGRADE_STATE_FILE:-}}"
OPERATION_LOCK_FILE="${SLIDEFLOW_OPERATION_LOCK_FILE:-${SLIDEFLOW_UPGRADE_LOCK_FILE:-}}"
OPERATION_SOURCE_BOOT_ID="${SLIDEFLOW_OPERATION_SOURCE_BOOT_ID:-${SLIDEFLOW_UPGRADE_SOURCE_BOOT_ID:-}}"

operation_python() {
  if [ -x "$PROJECT_ROOT/.venv/bin/python" ]; then
    printf '%s\n' "$PROJECT_ROOT/.venv/bin/python"
  elif command -v python3 >/dev/null 2>&1; then
    command -v python3
  else
    return 1
  fi
}

write_operation_state() {
  local state="$1"
  local message="$2"
  local timestamp python_cmd
  [ -n "$OPERATION_JOB_ID" ] && [ -n "$OPERATION_STATE_FILE" ] && [ -n "$OPERATION_LOCK_FILE" ] || return 0
  timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  python_cmd="$(operation_python)" || {
    printf '[SlideFlow] 无法写入运行操作状态：未找到 Python\n' >&2
    return 1
  }
  "$python_cmd" - \
    "$OPERATION_STATE_FILE" \
    "$OPERATION_LOCK_FILE" \
    "$OPERATION_JOB_ID" \
    "$OPERATION_TYPE" \
    "$state" \
    "$message" \
    "$OPERATION_SOURCE_BOOT_ID" \
    "$timestamp" <<'PY'
import json
import os
import sys
import tempfile
import fcntl

(
    path,
    lock_path,
    job_id,
    operation,
    state,
    message,
    source_boot_id,
    timestamp,
) = sys.argv[1:]

directory = os.path.dirname(path) or "."
os.makedirs(directory, exist_ok=True)
guard_path = f"{lock_path}.guard"
with open(guard_path, "a+b") as guard:
    os.chmod(guard_path, 0o600)
    fcntl.flock(guard.fileno(), fcntl.LOCK_EX)
    try:
        with open(lock_path, encoding="ascii") as handle:
            if handle.read().strip() != job_id:
                raise SystemExit(75)
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
        if not isinstance(payload, dict) or payload.get("job_id") != job_id:
            raise SystemExit(75)

        payload.update({
            "job_id": job_id,
            "operation": operation,
            "state": state,
            "message": message[:2000],
            "source_boot_id": source_boot_id,
            "updated_at": timestamp,
        })
        if state in {"succeeded", "failed"}:
            payload["completed_at"] = timestamp

        fd, temporary = tempfile.mkstemp(prefix=".system-operation-", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
    except (FileNotFoundError, OSError, ValueError):
        raise SystemExit(75)
PY
}

release_operation_lock() {
  [ -n "$OPERATION_LOCK_FILE" ] && [ -n "$OPERATION_JOB_ID" ] || return 0
  local python_cmd
  python_cmd="$(operation_python)" || return 1
  "$python_cmd" - "$OPERATION_LOCK_FILE" "$OPERATION_JOB_ID" <<'PY'
import fcntl
import os
import sys

lock_path, job_id = sys.argv[1:]
guard_path = f"{lock_path}.guard"
with open(guard_path, "a+b") as guard:
    os.chmod(guard_path, 0o600)
    fcntl.flock(guard.fileno(), fcntl.LOCK_EX)
    try:
        with open(lock_path, encoding="ascii") as handle:
            owner = handle.read().strip()
    except (FileNotFoundError, OSError):
        owner = None
    if owner == job_id:
        try:
            os.unlink(lock_path)
        except FileNotFoundError:
            pass
PY
}

fail_operation() {
  local exit_code="${1:-1}"
  local line_no="${2:-unknown}"
  local label="${3:-运行操作}"
  set +e
  write_operation_state "failed" "${label}失败（步骤行 ${line_no}，退出码 ${exit_code}），请检查对应日志"
  release_operation_lock
  return "$exit_code"
}
