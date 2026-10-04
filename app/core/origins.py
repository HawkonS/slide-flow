"""Browser request origins shared by CORS and mutation protection."""

from urllib.parse import urlsplit

from fastapi import HTTPException
from starlette.requests import HTTPConnection

from app.config import settings


def _origin(value: str) -> tuple[str, str, int] | None:
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            return None
        if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            return None
        return parsed.scheme, parsed.hostname.lower(), parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError:
        return None


def allowed_api_origins() -> list[str]:
    # Bare hostnames configure Vite only. A wildcard never grants cookie access.
    return [value.strip().rstrip("/") for value in settings.allowed_host.split(",") if _origin(value.strip())]


def require_browser_origin(request: HTTPConnection) -> None:
    site = request.headers.get("sec-fetch-site", "").lower()
    # Browser-owned metadata survives reverse/dev proxies rewriting Host.
    if site == "same-origin":
        return
    source = request.headers.get("origin", "").strip()
    if not source:
        if site == "cross-site":
            raise HTTPException(403, "请求来源不受信任，请从本站页面重新操作")
        return  # Command-line and authenticated renderer clients have no Origin.
    origin = _origin(source)
    scheme = {"ws": "http", "wss": "https"}.get(request.url.scheme, request.url.scheme)
    same_origin = _origin(f"{scheme}://{request.headers.get('host', '')}")
    if origin is None or (origin != same_origin and origin not in {_origin(value) for value in allowed_api_origins()}):
        raise HTTPException(403, "请求来源不受信任，请从本站页面重新操作")
