"""
系统管理路由模块
处理系统状态、重启、关闭、升级、日志等功能
"""
import logging
import os
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import psutil
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from app.config import PROPERTIES_FILE, settings
from app.core.permissions import require_super_admin


router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/admin/system/status")
def api_admin_system_status(
    _: Any = Depends(require_super_admin),
) -> dict[str, Any]:
    """获取系统运行状态（仅超级管理员）。"""
    # 获取当前进程信息
    backend_pid = os.getpid()
    backend_port = settings.port
    frontend_port = settings.web_port
    
    # 尝试获取前端进程（通过端口查找）
    frontend_pid = None
    try:
        result = subprocess.run(
            ["lsof", "-ti", f"tcp:{frontend_port}"],
            capture_output=True,
            text=True,
            timeout=2
        )
        if result.returncode == 0 and result.stdout.strip():
            frontend_pid = int(result.stdout.strip().split('\n')[0])
    except Exception:
        pass
    
    # 计算运行时长
    try:
        process_start_time = psutil.Process(backend_pid).create_time()
        uptime_seconds = int(time.time() - process_start_time)
        start_time = datetime.fromtimestamp(process_start_time).isoformat()
    except Exception:
        uptime_seconds = 0
        start_time = datetime.now().isoformat()
    
    # 检查 systemd 服务状态
    service_name = "slide-flow"
    service_status = "unknown"
    service_enabled = "unknown"
    
    try:
        # 检查服务是否运行
        result = subprocess.run(
            ["systemctl", "is-active", "--quiet", service_name],
            capture_output=True,
            timeout=2
        )
        service_status = "running" if result.returncode == 0 else "stopped"
        
        # 检查是否开机自启
        result = subprocess.run(
            ["systemctl", "is-enabled", "--quiet", service_name],
            capture_output=True,
            timeout=2
        )
        service_enabled = "enabled" if result.returncode == 0 else "disabled"
    except Exception:
        # 如果没有 systemd 或权限不足，使用进程检测
        service_status = "running" if frontend_pid else "direct_mode"
    
    return {
        "uptime_seconds": uptime_seconds,
        "backend_pid": backend_pid,
        "backend_port": backend_port,
        "frontend_pid": frontend_pid,
        "frontend_port": frontend_port,
        "start_time": start_time,
        "config_file": str(PROPERTIES_FILE),
        "log_dir": str(settings.log_dir),
        "service_name": service_name,
        "service_status": service_status,
        "service_enabled": service_enabled,
        "mode": "systemd" if service_status in ["running", "stopped"] else "direct",
    }


@router.post("/admin/system/shutdown")
def api_admin_system_shutdown(
    _: Any = Depends(require_super_admin),
) -> dict[str, Any]:
    """关闭系统服务（仅超级管理员）。"""
    
    def do_shutdown():
        """在后台执行关闭操作"""
        time.sleep(1)  # 给API响应一些时间返回
        try:
            manage_script = settings.root_dir / "tools" / "manage_service.sh"
            if manage_script.exists():
                subprocess.run(
                    ["bash", str(manage_script), "stop"],
                    timeout=60,
                    cwd=str(settings.root_dir)
                )
            else:
                stop_script = settings.root_dir / "stop.sh"
                subprocess.run(
                    ["bash", str(stop_script)],
                    timeout=30,
                    cwd=str(settings.root_dir)
                )
        except Exception as e:
            logger.error(f"关闭服务失败: {e}")
    
    threading.Thread(target=do_shutdown, daemon=True).start()
    return {"message": "关闭指令已发送"}


@router.post("/admin/system/restart")
def api_admin_system_restart(
    _: Any = Depends(require_super_admin),
) -> dict[str, Any]:
    """重启系统服务（仅超级管理员）。"""
    
    def do_restart():
        """在后台执行重启操作"""
        time.sleep(1)
        try:
            manage_script = settings.root_dir / "tools" / "manage_service.sh"
            if manage_script.exists():
                subprocess.run(
                    ["bash", str(manage_script), "restart"],
                    timeout=60,
                    cwd=str(settings.root_dir)
                )
            else:
                stop_script = settings.root_dir / "stop.sh"
                start_script = settings.root_dir / "start.sh"
                
                subprocess.run(
                    ["bash", str(stop_script)],
                    timeout=30,
                    cwd=str(settings.root_dir)
                )
                time.sleep(2)
                
                subprocess.Popen(
                    ["bash", str(start_script)],
                    cwd=str(settings.root_dir),
                    start_new_session=True
                )
        except Exception as e:
            logger.error(f"重启服务失败: {e}")
    
    threading.Thread(target=do_restart, daemon=True).start()
    return {"message": "重启指令已发送"}


@router.post("/admin/system/upgrade")
def api_admin_system_upgrade(
    _: Any = Depends(require_super_admin),
) -> dict[str, Any]:
    """系统升级：从 Git 拉取最新代码并重启（仅超级管理员）。"""
    
    def do_upgrade():
        """在后台执行升级操作"""
        time.sleep(2)
        log_file = None
        try:
            update_script = settings.root_dir / "tools" / "update.sh"
            if not update_script.exists():
                logger.error("更新脚本不存在: %s", update_script)
                return

            # 显式打开日志文件并存为变量，避免在表达式中隐式堆面对象的句柄泄漏。
            # 注意：Popen 子进程仍在使用该文件，不在父进程主动 close()；
            # close_fds=True 仅会在子进程中关闭除 stdin/stdout/stderr 之外的描述符，
            # 不会影响作为 stdout 传入的日志文件。父进程上升级完成后，
            # 该文件句柄会随着 daemon 线程退出由 GC 收回。
            log_path = settings.log_dir / "upgrade.log"
            log_file = open(str(log_path), "w")
            subprocess.Popen(
                ["bash", str(update_script)],
                cwd=str(settings.root_dir),
                start_new_session=True,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                close_fds=True,
            )
            logger.info("系统升级进程已启动，日志输出: %s", log_path)
        except Exception as e:
            logger.error("系统升级异常: %s", e)
            # 异常路径下未能启动子进程，需手动关闭描述符避免泄漏
            if log_file is not None:
                try:
                    log_file.close()
                except Exception:
                    pass
    
    threading.Thread(target=do_upgrade, daemon=True).start()
    return {"message": "系统升级指令已发送，请等待 1-2 分钟"}


@router.get("/admin/system/logs")
def api_admin_system_logs(
    _: Any = Depends(require_super_admin),
) -> list[dict[str, Any]]:
    """获取日志文件列表（仅超级管理员）。"""
    log_files = []
    log_dir = settings.log_dir
    
    if not log_dir.exists():
        return []
    
    for file_path in log_dir.iterdir():
        if file_path.is_file() and file_path.suffix == '.log':
            stat = file_path.stat()
            log_files.append({
                "filename": file_path.name,
                "path": str(file_path),
                "size_bytes": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            })
    
    log_files.sort(key=lambda x: x["modified"], reverse=True)
    return log_files


@router.get("/admin/system/logs/{filename}")
def api_admin_system_logs_download(
    filename: str,
    download: bool = False,
    _: Any = Depends(require_super_admin),
) -> FileResponse:
    """下载日志文件（仅超级管理员）。"""
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(400, "非法文件名")
    
    log_dir = settings.log_dir
    file_path = log_dir / filename
    
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "日志文件不存在")
    
    if not str(file_path.resolve()).startswith(str(log_dir.resolve())):
        raise HTTPException(400, "非法文件路径")
    
    if download:
        return FileResponse(
            str(file_path),
            media_type="application/octet-stream",
            filename=filename
        )
    else:
        return FileResponse(
            str(file_path),
            media_type="text/plain"
        )
