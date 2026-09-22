"""Middleware / resource import."""

from __future__ import annotations

from app.services.resource_import.limits import (
    RESOURCE_IMPORT_MAX_TOTAL_BYTES,
)
from fastapi import HTTPException
from starlette.formparsers import MultiPartException
import json


class ResourceImportRequestGuard:
    """Bound request streams before multipart parsing spools them to disk."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/resource-import/") or scope.get("method") not in {"POST", "DELETE"}:
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        multipart = headers.get(b"content-type", b"").startswith(b"multipart/form-data")
        limit = RESOURCE_IMPORT_MAX_TOTAL_BYTES + 1024 * 1024 if multipart else 512 * 1024
        try:
            length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            length = limit + 1
        if length > limit:
            await send({"type": "http.response.start", "status": 413, "headers": [(b"content-type", b"application/json")]})
            return await send({"type": "http.response.body", "body": json.dumps({"detail": "导入请求体积超过限制"}, ensure_ascii=False).encode()})
        total = 0
        exceeded = False

        async def bounded_receive():
            nonlocal total, exceeded
            message = await receive()
            total += len(message.get("body", b""))
            if total > limit:
                exceeded = True
                if multipart:
                    # This particular exception makes Starlette close every
                    # already-spooled upload instead of leaking temporary files.
                    raise MultiPartException("导入请求体积超过限制")
                raise HTTPException(413, "导入请求体积超过限制")
            return message

        async def bounded_send(message):
            if exceeded and message["type"] == "http.response.start":
                message = {**message, "status": 413}
            await send(message)

        await self.app(scope, bounded_receive, bounded_send)
