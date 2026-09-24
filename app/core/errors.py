"""Stable user-facing error messages for external services.

SDK/network exceptions are intentionally kept in logs only.  API responses,
task records and import-session snapshots use this small public catalogue so a
vendor error or a local path can never leak into the UI.
"""

from __future__ import annotations

import errno
from typing import Any

from app.core.oss import StorageConfigurationError, StorageUnavailableError


OSS_CONFIGURATION_MESSAGE = "对象存储未配置完整，请联系管理员检查 OSS 配置"
OSS_UNAVAILABLE_MESSAGE = "对象存储暂时不可用，请稍后重试；如持续失败，请联系管理员检查 OSS 网络"
RENDERER_UNAVAILABLE_MESSAGE = "图片转换服务暂时不可用，请检查 Windows 转换节点、网络或隧道后重试"
RENDERER_TIMEOUT_MESSAGE = "图片转换超时，请检查 Windows 转换节点并稍后重试，或减少 PPT 页数"
RENDERER_DISK_MESSAGE = "Windows 转换节点可用磁盘不足，清理空间后再重试"
RENDERER_AUTH_MESSAGE = "图片转换服务鉴权失败，请联系管理员检查渲染密钥"
RENDERER_GENERIC_MESSAGE = "图片转换失败，请检查 Windows 转换节点后重试"
IMPORT_GENERIC_MESSAGE = "上传任务处理失败，请重试或联系管理员"

PUBLIC_ERROR_MESSAGES = frozenset({
    OSS_CONFIGURATION_MESSAGE,
    OSS_UNAVAILABLE_MESSAGE,
    RENDERER_UNAVAILABLE_MESSAGE,
    RENDERER_TIMEOUT_MESSAGE,
    RENDERER_DISK_MESSAGE,
    RENDERER_AUTH_MESSAGE,
    RENDERER_GENERIC_MESSAGE,
    IMPORT_GENERIC_MESSAGE,
    "Windows 转换节点多次超时，请重试",
    "Windows 转换节点多次未响应，请检查节点在线状态后重试",
    "Windows 转换服务已重启，请重新渲染",
    "Windows 渲染队列已满，请稍后重试",
    "Windows 转换服务正在维护，请稍后重试",
    "渲染任务不存在，请重新生成图片",
    "该图片渲染任务已取消，请重新生成",
})


def _exception_chain(exc: BaseException):
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def is_storage_transient_error(exc: BaseException) -> bool:
    """Return whether an exception represents a temporary OSS/network fault."""
    if isinstance(exc, StorageUnavailableError):
        return True
    for item in _exception_chain(exc):
        module = type(item).__module__
        name = type(item).__name__
        if module.startswith("oss2") and name in {"RequestError", "ServerError"}:
            status = getattr(item, "status", 0) or 0
            if name == "RequestError" or status >= 500:
                return True
        if name in {"TransportError", "ConnectError", "ReadTimeout", "ConnectTimeout"}:
            return True
        if isinstance(item, (ConnectionError, TimeoutError)):
            return True
        if isinstance(item, OSError) and getattr(item, "errno", None) in {
            errno.ECONNREFUSED, errno.ETIMEDOUT, errno.ENETUNREACH,
            errno.EHOSTUNREACH, errno.ECONNRESET, errno.EPIPE,
        }:
            return True
    return False


def storage_public_message(exc: BaseException) -> str | None:
    if isinstance(exc, StorageConfigurationError):
        return OSS_CONFIGURATION_MESSAGE
    if is_storage_transient_error(exc):
        return OSS_UNAVAILABLE_MESSAGE
    return None


def render_public_message(code: Any = None) -> str:
    """Map renderer error codes to bounded, actionable Chinese copy."""
    value = str(code or "").strip().lower()
    return {
        "network_error": RENDERER_UNAVAILABLE_MESSAGE,
        "renderer_unavailable": RENDERER_UNAVAILABLE_MESSAGE,
        "worker_unavailable": RENDERER_UNAVAILABLE_MESSAGE,
        "temporary_oss_error": OSS_UNAVAILABLE_MESSAGE,
        "render_timeout": RENDERER_TIMEOUT_MESSAGE,
        "lease_exhausted": "Windows 转换节点多次未响应，请检查节点在线状态后重试",
        "worker_restarted": "Windows 转换服务已重启，请重新渲染",
        "disk_pressure": RENDERER_DISK_MESSAGE,
        "unauthorized": RENDERER_AUTH_MESSAGE,
        "queue_full": "Windows 渲染队列已满，请稍后重试",
        "renderer_draining": "Windows 转换服务正在维护，请稍后重试",
        "internal_error": RENDERER_GENERIC_MESSAGE,
        "render_failed": RENDERER_GENERIC_MESSAGE,
    }.get(value, RENDERER_GENERIC_MESSAGE)


def import_public_message(exc: BaseException, *, rendering: bool = False) -> str:
    """Map a background import exception without exposing SDK details."""
    storage_message = storage_public_message(exc)
    if storage_message:
        return storage_message
    if rendering:
        return RENDERER_GENERIC_MESSAGE
    return IMPORT_GENERIC_MESSAGE
