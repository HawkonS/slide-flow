"""Middleware / http."""

from __future__ import annotations

from app.config import settings
from app.core.oss import public_asset_origin
from app.core.origins import require_browser_origin
from fastapi import HTTPException, Request
from starlette.responses import JSONResponse
import logging
import re
import time

logger = logging.getLogger(__name__)

_SHARE_PATH_RE = re.compile(r"(/(?:api/resource-shares|share/resources|api/show-shares|share/shows)/)[^/?#]+")


def _redact_sensitive_path(path: str) -> str:
    """Keep opaque share tokens out of application request logs."""
    return _SHARE_PATH_RE.sub(r"\1<redacted>", path)


class BrowserOriginMiddleware:
    """Reject cross-site browser mutations before multipart bodies are read."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope.get("path", "").startswith("/api/") and scope.get("method") not in {"GET", "HEAD", "OPTIONS"}:
            try:
                require_browser_origin(Request(scope))
            except HTTPException as exc:
                response = JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers={"Cache-Control": "no-store"})
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


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
                    _redact_sensitive_path(scope.get("path", "")),
                    duration,
                    status_holder["code"],
                )


class ResponseCacheMiddleware:
    """Keep authenticated API data out of persistent browser HTTP caches."""

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

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = {
                    key.lower(): value for key, value in message.get("headers", [])
                }
                # 业务路由若已明确设置缓存策略则保留，避免重复响应头。
                if b"cache-control" in headers:
                    await send(message)
                    return
                # In-session response reuse is handled by the frontend query cache.
                raw_headers = list(message.get("headers", []))
                raw_headers.append(
                    (b"cache-control", b"private, no-store")
                )
                message = {**message, "headers": raw_headers}
            await send(message)

        await self.app(scope, receive, send_wrapper)


class SecurityHeadersMiddleware:
    """为所有 HTTP 响应添加安全响应头（纯 ASGI，不触碰 receive 流）"""

    def __init__(self, app):
        self.app = app
        oss_origin = public_asset_origin() if settings.storage_backend.lower() == "oss" else None
        # User avatars may come from Feishu's signed CDN URLs. Restrict the
        # stored value to http(s) in the user API and keep this exception to
        # images only; scripts, frames and connections remain same-origin.
        img_sources = "'self' data: blob:" + (f" {oss_origin}" if oss_origin else "") + " https:"
        connect_sources = "'self' ws: wss:" + (f" {oss_origin}" if oss_origin else "")
        self._content_security_policy = (
            "default-src 'self'; script-src 'self'; object-src 'none'; "
            "base-uri 'self'; frame-ancestors 'self'; "
            f"img-src {img_sources}; style-src 'self' 'unsafe-inline'; "
            f"connect-src {connect_sources}; font-src 'self' data:"
        ).encode("ascii")
        self._no_store_prefixes = (
            "/share/",
            "/api/auth",
            "/api/admin",
            "/api/me",
            "/api/user",
            "/api/tasks",
            "/api/downloads",
            "/api/resource-shares",
            "/api/show-shares",
            "/api/resource-share-links",
            "/api/show-share-links",
        )

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                raw_headers = list(message.get("headers", []))
                raw_headers.append((b"x-content-type-options", b"nosniff"))
                if not any(key.lower() == b"referrer-policy" for key, _ in raw_headers):
                    raw_headers.append((b"referrer-policy", b"no-referrer" if scope.get("path", "").startswith(("/share/", "/api/show-shares/", "/api/resource-shares/")) else b"strict-origin-when-cross-origin"))
                raw_headers.append((b"x-xss-protection", b"1; mode=block"))
                raw_headers.append((b"x-frame-options", b"SAMEORIGIN"))
                raw_headers.append(
                    (
                        b"content-security-policy",
                        self._content_security_policy,
                    )
                )
                if (
                    any(scope.get("path", "").startswith(p) for p in self._no_store_prefixes)
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
