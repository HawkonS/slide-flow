"""
系统管理路由模块
处理系统状态、重启、关闭、升级、日志等功能
"""
import heapq
import hashlib
import logging
import os
import re
import subprocess
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any

import psutil
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.config import PROPERTIES_FILE, settings
from app.core.permissions import require_system_admin
from app.core.oss import storage as oss_storage
from app.db import get_db
from app.services.system_upgrade import (
    OperationOwnershipLost,
    UpgradeAlreadyRunning,
    begin_operation,
    get_operation_state,
    get_upgrade_state,
    mark_operation_failed,
    operation_paths,
    record_operation_process,
    upgrade_paths,
)


router = APIRouter()
logger = logging.getLogger(__name__)


def _service_boot_id() -> str:
    """Return an identifier shared by all workers of one service start.

    ``run.sh`` supplies the preferred value. The parent-process fallback keeps
    the status useful for installations that start Uvicorn/Gunicorn directly,
    where the environment variable is not present.
    """
    configured = os.environ.get("SLIDEFLOW_BOOT_ID")
    if configured:
        return configured
    try:
        process = psutil.Process(os.getpid())
        owner = process.parent() or process
        return f"{owner.pid}:{owner.create_time():.6f}"
    except Exception:
        return f"pid:{os.getpid()}"


SERVICE_BOOT_ID = _service_boot_id()


def _service_start_timestamp() -> float:
    configured = os.environ.get("SLIDEFLOW_START_TIME")
    if configured:
        try:
            value = float(configured)
            if value > 0:
                return value
        except ValueError:
            pass
    try:
        process = psutil.Process(os.getpid())
        owner = process.parent() or process
        return owner.create_time()
    except Exception:
        return time.time()


SERVICE_START_TIMESTAMP = _service_start_timestamp()


def _systemd_service_state(service_name: str) -> tuple[bool, str, str]:
    """Return whether the configured unit exists plus active/enabled states."""
    try:
        result = subprocess.run(
            [
                "systemctl",
                "show",
                "--property=LoadState",
                "--property=ActiveState",
                "--property=UnitFileState",
                service_name,
            ],
            capture_output=True,
            text=True,
            timeout=2,
        )
        properties = {}
        for line in result.stdout.splitlines():
            key, separator, value = line.partition("=")
            if separator:
                properties[key] = value.strip()
        load_state = properties.get("LoadState", "")
        if result.returncode != 0 or load_state in {"", "not-found"}:
            return False, "unknown", "unknown"
        active_state = properties.get("ActiveState", "unknown") or "unknown"
        service_status = {
            "active": "running",
            "inactive": "stopped",
        }.get(active_state, active_state)
        if service_status not in {
            "running",
            "stopped",
            "activating",
            "deactivating",
            "failed",
            "reloading",
            "maintenance",
        }:
            service_status = "unknown"
        enabled_state = properties.get("UnitFileState", "unknown") or "unknown"
        if enabled_state not in {
            "enabled",
            "enabled-runtime",
            "linked",
            "linked-runtime",
            "static",
            "indirect",
            "generated",
            "transient",
            "disabled",
            "masked",
            "masked-runtime",
        }:
            enabled_state = "unknown"
        return True, service_status, enabled_state
    except (OSError, subprocess.SubprocessError):
        return False, "unknown", "unknown"


def _launch_detached_script(
    script: Path,
    *,
    log_name: str,
    env: dict[str, str] | None = None,
) -> int:
    """Start an operational script that must survive the current API worker."""
    if not script.is_file():
        raise FileNotFoundError(script)
    settings.log_dir.mkdir(parents=True, exist_ok=True)
    log_path = settings.log_dir / log_name
    with log_path.open("w", encoding="utf-8") as log_file:
        process = subprocess.Popen(
            ["bash", str(script)],
            cwd=str(settings.root_dir),
            start_new_session=True,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            close_fds=True,
            env=env,
        )
    return process.pid


def _find_vite_pid(port: int) -> int | None:
    """Return a Vite listener PID, never an unrelated process on the port."""
    try:
        connections = psutil.net_connections(kind="inet")
    except (psutil.Error, OSError):
        return None
    for connection in connections:
        if (
            connection.status != psutil.CONN_LISTEN
            or not connection.laddr
            or connection.laddr.port != port
            or connection.pid is None
        ):
            continue
        try:
            process = psutil.Process(connection.pid)
            command = " ".join(process.cmdline()).lower()
        except (psutil.Error, OSError):
            continue
        if "vite" in command:
            return connection.pid
    return None


def _operation_environment(state: dict[str, Any]) -> dict[str, str]:
    state_path, lock_path = operation_paths(settings.data_dir)
    env = os.environ.copy()
    env.update(
        SLIDEFLOW_OPERATION_JOB_ID=state["job_id"],
        SLIDEFLOW_OPERATION_TYPE=str(state.get("operation") or "upgrade"),
        SLIDEFLOW_OPERATION_STATE_FILE=str(state_path),
        SLIDEFLOW_OPERATION_LOCK_FILE=str(lock_path),
        SLIDEFLOW_OPERATION_SOURCE_BOOT_ID=SERVICE_BOOT_ID,
    )
    return env


def _start_runtime_operation(
    operation: str,
    script: Path,
    *,
    log_name: str,
    delay: int = 2,
) -> dict[str, Any]:
    if not script.is_file():
        raise HTTPException(500, f"运行脚本不存在: {script.name}")
    state_path, lock_path = operation_paths(settings.data_dir)
    get_operation_state(
        state_path,
        lock_path,
        current_boot_id=SERVICE_BOOT_ID,
    )
    try:
        state = begin_operation(
            state_path,
            lock_path,
            operation=operation,
            source_boot_id=SERVICE_BOOT_ID,
        )
    except UpgradeAlreadyRunning as exc:
        raise HTTPException(409, str(exc)) from exc

    env = _operation_environment(state)
    env["SLIDEFLOW_OPERATION_START_DELAY"] = str(delay)
    # Compatibility for an update.sh from the currently checked-out version.
    if operation == "upgrade":
        env.update(
            SLIDEFLOW_UPGRADE_JOB_ID=state["job_id"],
            SLIDEFLOW_UPGRADE_STATE_FILE=str(state_path),
            SLIDEFLOW_UPGRADE_LOCK_FILE=str(lock_path),
            SLIDEFLOW_UPGRADE_SOURCE_BOOT_ID=SERVICE_BOOT_ID,
            SLIDEFLOW_UPGRADE_START_DELAY=str(delay),
        )
    try:
        pid = _launch_detached_script(script, log_name=log_name, env=env)
    except (OSError, subprocess.SubprocessError) as exc:
        try:
            mark_operation_failed(
                state_path,
                lock_path,
                state,
                f"无法启动{operation}进程: {exc}",
            )
        except OperationOwnershipLost:
            pass
        logger.exception("系统运行操作启动失败: operation=%s", operation)
        raise HTTPException(500, "无法启动系统运行操作") from exc
    try:
        process_started_at = psutil.Process(pid).create_time()
        state = record_operation_process(
            state_path,
            lock_path,
            state,
            process_pid=pid,
            process_started_at=process_started_at,
        )
    except (psutil.Error, OSError, OperationOwnershipLost):
        # A fast-failing script may already have persisted its terminal state.
        # Status reconciliation remains authoritative in that case.
        pass
    logger.info(
        "系统运行操作已启动: operation=%s job=%s pid=%s log=%s",
        operation,
        state["job_id"],
        pid,
        settings.log_dir / log_name,
    )
    return state


LOG_TAIL_DEFAULT_LINES = 500
LOG_TAIL_MAX_LINES = 5000
LOG_TAIL_MAX_BYTES = 1024 * 1024
LOG_TAIL_READ_CHUNK = 64 * 1024
LOG_TAIL_MAX_LINE_CHARS = 16 * 1024
LOG_FILE_LIST_MAX = 1000
LOG_FILENAME_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.log(?:[._-][0-9][0-9A-Za-z_-]*)?$"
)
ANSI_ESCAPE_RE = re.compile(
    r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x1b\x07]*(?:\x07|\x1b\\)|[@-_])"
)


class LogFileInfo(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    size_bytes: int = Field(ge=0)
    modified: datetime
    version: str = Field(min_length=24, max_length=24)


class LogTailResponse(LogFileInfo):
    lines: list[str] = Field(max_length=LOG_TAIL_MAX_LINES)
    line_count: int = Field(ge=0, le=LOG_TAIL_MAX_LINES)
    requested_lines: int = Field(ge=50, le=LOG_TAIL_MAX_LINES)
    truncated: bool


def _is_log_filename(filename: str) -> bool:
    """Allow active logs and common numeric/timestamp rotation suffixes."""
    return bool(LOG_FILENAME_RE.fullmatch(filename)) and ".." not in filename


def _log_file_version(stat: os.stat_result) -> str:
    """Return an opaque version token without exposing filesystem metadata."""
    raw = f"{stat.st_dev}:{stat.st_ino}:{stat.st_mtime_ns}:{stat.st_size}".encode("ascii")
    return hashlib.blake2s(raw, digest_size=12).hexdigest()


def _sanitize_log_text(value: str) -> str:
    """Remove terminal escapes and neutralize invisible control characters."""
    value = ANSI_ESCAPE_RE.sub("", value)
    return "".join(
        char
        if char == "\t" or unicodedata.category(char) not in {"Cc", "Cf"}
        else "�"
        for char in value
    )


def _resolve_log_file(filename: str) -> Path:
    """Resolve a log filename inside the configured log directory."""
    if not _is_log_filename(filename):
        raise HTTPException(400, "非法文件名")

    log_dir = settings.log_dir.resolve()
    candidate = log_dir / filename
    # Logs are regular files. Refuse symlinks so a compromised log directory
    # cannot turn this system-admin endpoint into an arbitrary file reader.
    if candidate.is_symlink():
        raise HTTPException(400, "非法日志文件")
    file_path = candidate.resolve()
    try:
        file_path.relative_to(log_dir)
    except ValueError:
        raise HTTPException(400, "非法文件路径") from None

    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "日志文件不存在")
    return file_path


def _read_log_tail(
    file_path: Path,
    line_limit: int,
    *,
    max_bytes: int = LOG_TAIL_MAX_BYTES,
) -> tuple[list[str], bool, os.stat_result]:
    """Read the newest log lines without loading an unbounded file in memory."""
    with file_path.open("rb") as log_file:
        stat = os.fstat(log_file.fileno())
        file_size = stat.st_size
        if file_size == 0:
            return [], False, stat

        position = file_size
        chunks: list[bytes] = []
        bytes_read = 0
        newline_count = 0
        while position > 0 and bytes_read < max_bytes and newline_count <= line_limit:
            read_size = min(LOG_TAIL_READ_CHUNK, position, max_bytes - bytes_read)
            position -= read_size
            log_file.seek(position)
            chunk = log_file.read(read_size)
            chunks.append(chunk)
            bytes_read += len(chunk)
            newline_count += chunk.count(b"\n")

        data = b"".join(reversed(chunks))
        began_mid_line = False
        if position > 0:
            log_file.seek(position - 1)
            began_mid_line = log_file.read(1) not in {b"\n", b"\r"}

    text = data.decode("utf-8", errors="replace")
    lines = text.splitlines()
    # A backwards byte window normally begins in the middle of a line. Drop
    # only that partial prefix when at least one complete line follows it. If
    # the file is one very long line, keep the visible suffix for diagnostics.
    if began_mid_line and len(lines) > 1:
        lines = lines[1:]

    selected_lines = lines[-line_limit:]
    truncated_line = False
    bounded_lines: list[str] = []
    for line in selected_lines:
        if len(line) <= LOG_TAIL_MAX_LINE_CHARS:
            bounded_lines.append(_sanitize_log_text(line))
            continue
        truncated_line = True
        half = LOG_TAIL_MAX_LINE_CHARS // 2
        bounded_lines.append(
            f"{_sanitize_log_text(line[:half])} … [单行过长，已截断] … "
            f"{_sanitize_log_text(line[-half:])}"
        )

    truncated = position > 0 or len(lines) > line_limit or truncated_line
    return bounded_lines, truncated, stat


@router.get("/admin/system/status")
def api_admin_system_status(
    _: Any = Depends(require_system_admin),
) -> dict[str, Any]:
    """获取系统运行状态（仅系统管理员）。"""
    # 获取当前进程信息
    backend_pid = os.getpid()
    backend_port = settings.port
    frontend_port = settings.web_port
    
    runtime_mode = os.environ.get("SLIDEFLOW_RUNTIME_MODE", "").lower()
    frontend_pid = None if runtime_mode == "static" else _find_vite_pid(frontend_port)
    
    # 前端模式：存在前端开发进程（Vite）时为 dev；否则生产模式下前端由后端静态托管
    frontend_mode = "dev" if runtime_mode == "dev" or frontend_pid is not None else "static"
    
    # 计算运行时长
    try:
        process_start_time = SERVICE_START_TIMESTAMP
        uptime_seconds = int(time.time() - process_start_time)
        start_time = datetime.fromtimestamp(process_start_time).isoformat()
    except Exception:
        uptime_seconds = 0
        start_time = datetime.now().isoformat()
    
    # 检查 systemd 服务状态
    service_name = settings.service_name
    systemd_installed, service_status, service_enabled = _systemd_service_state(service_name)
    # Import lazily because the render-task service imports shared router
    # dependencies during application assembly.
    from app.services.resource_import.render_tasks import renderer_worker_status
    db = get_db()
    try:
        windows_renderer = renderer_worker_status(db)
    finally:
        db.close()
    
    return {
        "uptime_seconds": uptime_seconds,
        "backend_pid": backend_pid,
        "backend_port": backend_port,
        # run.sh generates one id for the whole service process group. Unlike
        # the worker PID, this remains stable across Gunicorn/Uvicorn workers
        # and changes on every actual service restart.
        "boot_id": SERVICE_BOOT_ID,
        "frontend_pid": frontend_pid,
        "frontend_port": frontend_port,
        "frontend_mode": frontend_mode,
        "start_time": start_time,
        "config_file": str(PROPERTIES_FILE),
        "log_dir": str(settings.log_dir),
        "service_name": service_name,
        "service_status": service_status,
        "service_enabled": service_enabled,
        "mode": "systemd" if systemd_installed else "direct",
        "windows_renderer": windows_renderer,
        "oss": oss_storage.health_status(),
    }


@router.post("/admin/system/shutdown")
def api_admin_system_shutdown(
    _: Any = Depends(require_system_admin),
) -> dict[str, Any]:
    """关闭系统服务（仅系统管理员）。"""
    
    state = _start_runtime_operation(
        "shutdown",
        settings.root_dir / "tools" / "shutdown.sh",
        log_name="shutdown.log",
    )
    return {"job_id": state["job_id"], "state": state["state"], "message": "关闭指令已发送"}


@router.post("/admin/system/restart")
def api_admin_system_restart(
    _: Any = Depends(require_system_admin),
) -> dict[str, Any]:
    """重启系统服务（仅系统管理员）。"""
    
    state = _start_runtime_operation(
        "restart",
        settings.root_dir / "tools" / "restart.sh",
        log_name="restart.log",
    )
    return {"job_id": state["job_id"], "state": state["state"], "message": "重启指令已发送"}


@router.post("/admin/system/upgrade")
def api_admin_system_upgrade(
    _: Any = Depends(require_system_admin),
) -> dict[str, Any]:
    """系统升级：从 Git 拉取最新代码并重启（仅系统管理员）。"""
    state = _start_runtime_operation(
        "upgrade",
        settings.root_dir / "tools" / "update.sh",
        log_name="upgrade.log",
    )
    return {
        "job_id": state["job_id"],
        "state": state["state"],
        "message": "系统升级指令已发送，请等待服务完成更新",
    }


@router.get("/admin/system/upgrade/status")
def api_admin_system_upgrade_status(
    _: Any = Depends(require_system_admin),
) -> dict[str, Any]:
    """Return the persistent state of the latest system upgrade."""
    state_path, lock_path = upgrade_paths(settings.data_dir)
    state = get_upgrade_state(
        state_path,
        lock_path,
        current_boot_id=SERVICE_BOOT_ID,
    )
    if state is None or (state.get("operation") or "upgrade") != "upgrade":
        return {"state": "idle", "message": "暂无升级任务"}
    return state


@router.get("/admin/system/operation/status")
def api_admin_system_operation_status(
    _: Any = Depends(require_system_admin),
) -> dict[str, Any]:
    """Return persistent state for the latest disruptive runtime operation."""
    state_path, lock_path = operation_paths(settings.data_dir)
    state = get_operation_state(
        state_path,
        lock_path,
        current_boot_id=SERVICE_BOOT_ID,
    )
    if state is None:
        return {"state": "idle", "message": "暂无运行操作"}
    return state


@router.get("/admin/system/logs", response_model=list[LogFileInfo])
def api_admin_system_logs(
    response: Response,
    _: Any = Depends(require_system_admin),
) -> list[LogFileInfo]:
    """获取日志文件列表（仅系统管理员）。"""
    response.headers["Cache-Control"] = "private, no-store"
    log_files: list[tuple[int, str, LogFileInfo]] = []
    log_dir = settings.log_dir

    try:
        with os.scandir(log_dir) as entries:
            for entry in entries:
                if not _is_log_filename(entry.name) or entry.is_symlink():
                    continue
                try:
                    if not entry.is_file(follow_symlinks=False):
                        continue
                    stat = entry.stat(follow_symlinks=False)
                except OSError:
                    # A rotating logger may rename/delete a file between the
                    # scan and stat. Skip that transient entry instead.
                    continue
                item = (
                    stat.st_mtime_ns,
                    entry.name,
                    LogFileInfo(
                        filename=entry.name,
                        size_bytes=stat.st_size,
                        modified=datetime.fromtimestamp(stat.st_mtime).astimezone(),
                        version=_log_file_version(stat),
                    ),
                )
                if len(log_files) < LOG_FILE_LIST_MAX:
                    heapq.heappush(log_files, item)
                elif item[:2] > log_files[0][:2]:
                    heapq.heapreplace(log_files, item)
    except FileNotFoundError:
        return []
    except OSError as exc:
        logger.warning("日志目录暂时无法读取: %s", type(exc).__name__)
        raise HTTPException(503, "日志目录暂时无法读取") from exc

    log_files.sort(key=lambda item: item[:2], reverse=True)
    return [item[2] for item in log_files]


@router.get("/admin/system/logs/{filename}/tail", response_model=LogTailResponse)
def api_admin_system_log_tail(
    filename: str,
    response: Response,
    lines: int = Query(LOG_TAIL_DEFAULT_LINES, ge=50, le=LOG_TAIL_MAX_LINES),
    _: Any = Depends(require_system_admin),
) -> LogTailResponse:
    """读取日志文件尾部的有限行数（仅系统管理员）。"""
    file_path = _resolve_log_file(filename)
    try:
        content, truncated, stat = _read_log_tail(file_path, lines)
    except FileNotFoundError:
        raise HTTPException(404, "日志文件不存在") from None
    except OSError as exc:
        logger.warning("日志文件暂时无法读取: filename=%s error=%s", filename, type(exc).__name__)
        raise HTTPException(503, "日志文件暂时无法读取") from exc
    response.headers["Cache-Control"] = "private, no-store"
    return LogTailResponse(
        filename=file_path.name,
        lines=content,
        line_count=len(content),
        requested_lines=lines,
        truncated=truncated,
        size_bytes=stat.st_size,
        modified=datetime.fromtimestamp(stat.st_mtime).astimezone(),
        version=_log_file_version(stat),
    )


@router.get("/admin/system/logs/{filename}")
def api_admin_system_logs_download(
    filename: str,
    download: bool = False,
    _: Any = Depends(require_system_admin),
) -> FileResponse:
    """下载日志文件（仅系统管理员）。"""
    file_path = _resolve_log_file(filename)
    
    if download:
        return FileResponse(
            str(file_path),
            media_type="application/octet-stream",
            filename=filename,
            headers={"Cache-Control": "private, no-store"},
        )
    else:
        return FileResponse(
            str(file_path),
            media_type="text/plain; charset=utf-8",
            headers={"Cache-Control": "private, no-store"},
        )
