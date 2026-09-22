"""Middleware / http."""

from __future__ import annotations

from app.config import settings
from app.core.oss import public_asset_origin
import logging
import time

logger = logging.getLogger(__name__)


class SlowRequestLogger:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        start = time.time()
        status_holder = {"code": 0}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status_holder["code"] = message.get("status", 0)
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            duration = time.time() - start
            if duration > settings.slow_request_threshold:
                logger.warning(
                    "Slow request: %s %s took %.1fs status=%s",
                    scope.get("method"),
                    scope.get("path"),
                    duration,
                    status_holder["code"],
                )


class ResponseCacheMiddleware:
    """为 GET API 请求添加 Cache-Control 头，减少前端重复请求"""

    # 不缓存的路径前缀（需要实时性的接口）
    _NO_CACHE_PATHS = (
        "/api/tasks",
        "/api/me",
        "/api/auth",
        "/api/admin",
        "/api/user",
        "/api/downloads",
    )

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "")
        path = scope.get("path", "")

        # 所有 GET API 都明确声明缓存策略；用户/管理员/下载接口一律禁止缓存。
        is_get_api = method == "GET" and path.startswith("/api/")
        if not is_get_api:
            await self.app(scope, receive, send)
            return
        no_store = any(path.startswith(p) for p in self._NO_CACHE_PATHS)

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = {
                    key.lower(): value for key, value in message.get("headers", [])
                }
                # 业务路由若已明确设置缓存策略则保留，避免重复响应头。
                if b"cache-control" in headers:
                    await send(message)
                    return
                # 添加 5 秒私有缓存，或对敏感接口彻底禁止缓存。
                raw_headers = list(message.get("headers", []))
                raw_headers.append(
                    (b"cache-control", b"private, no-store" if no_store else b"private, max-age=5")
                )
                message = {**message, "headers": raw_headers}
            await send(message)

        await self.app(scope, receive, send_wrapper)


class SecurityHeadersMiddleware:
    """为所有 HTTP 响应添加安全响应头（纯 ASGI，不触碰 receive 流）"""

    def __init__(self, app):
        self.app = app
        oss_origin = public_asset_origin() if settings.storage_backend.lower() == "oss" else None
        img_sources = "'self' data: blob:" + (f" {oss_origin}" if oss_origin else "")
        connect_sources = "'self' ws: wss:" + (f" {oss_origin}" if oss_origin else "")
        self._content_security_policy = (
            "default-src 'self'; script-src 'self'; object-src 'none'; "
            "base-uri 'self'; frame-ancestors 'self'; "
            f"img-src {img_sources}; style-src 'self' 'unsafe-inline'; "
            f"connect-src {connect_sources}; font-src 'self' data:"
        ).encode("ascii")
        self._no_store_prefixes = (
            "/api/admin",
            "/api/me",
            "/api/user",
            "/api/tasks",
            "/api/downloads",
        )

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                raw_headers = list(message.get("headers", []))
                raw_headers.append((b"x-content-type-options", b"nosniff"))
                raw_headers.append((b"referrer-policy", b"strict-origin-when-cross-origin"))
                raw_headers.append((b"x-xss-protection", b"1; mode=block"))
                raw_headers.append((b"x-frame-options", b"SAMEORIGIN"))
                raw_headers.append(
                    (
                        b"content-security-policy",
                        self._content_security_policy,
                    )
                )
                if (
                    scope.get("method") == "GET"
                    and any(scope.get("path", "").startswith(p) for p in self._no_store_prefixes)
                    and not any(k.lower() == b"cache-control" for k, _ in raw_headers)
                ):
                    raw_headers.append((b"cache-control", b"private, no-store"))
                if settings.web_https:
                    raw_headers.append(
                        (b"strict-transport-security", b"max-age=31536000")
                    )
                message = {**message, "headers": raw_headers}
            await send(message)

        await self.app(scope, receive, send_wrapper)
