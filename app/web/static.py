"""Web / static."""

from __future__ import annotations

from app.config import settings
from fastapi import APIRouter
from fastapi import HTTPException
from fastapi.responses import FileResponse
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import os
import re
from pathlib import Path

router = APIRouter()


_HASHED_ASSET_RE = re.compile(
    r"[-.][0-9A-Za-z_-]{8,}\.(?:js|css|woff2?|png|svg|map)$"
)


class _StaticFilesWithHashedCache(StaticFiles):
    """静态资源挂载：dist/ 下带 content-hash 的构建产物附加一年期不可变
    缓存头（文件名变化即内容变化，浏览器可永久复用无需协商）；
    index.html 等未 hash 化文件保持 StaticFiles 默认缓存行为"""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        full_path = args[0] if args else kwargs.get("full_path")
        if full_path is not None and f"{os.sep}dist{os.sep}" in str(full_path):
            name = os.path.basename(str(full_path))
            if _HASHED_ASSET_RE.search(name):
                response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


SPA_INDEX = settings.static_dir / "dist" / "index.html"


def _serve_spa() -> FileResponse:
    if not SPA_INDEX.exists():
        raise HTTPException(
            503,
            "前端尚未构建，请在 web/ 下执行 `npm install && npm run build`",
        )
    # index.html 文件名不带 hash，必须每次协商校验，避免浏览器缓存旧入口
    return FileResponse(SPA_INDEX, headers={
        "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff",
    })


def _dist_file(relative: str, *, media_type: str | None = None, headers: dict | None = None) -> FileResponse:
    # Missing/malformed assets must be 404, never a successful HTML response.
    # Besides breaking module loading, an HTML fallback could poison a PWA
    # installation. Resolve against dist itself, not the broader static tree.
    if any(ord(c) < 0x20 for c in relative) or "\\" in relative:
        raise HTTPException(404)
    root = (settings.static_dir / "dist").resolve()
    try:
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file():
            raise HTTPException(404)
    except (ValueError, OSError):
        raise HTTPException(404) from None
    response_headers = {"Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"}
    if _HASHED_ASSET_RE.search(candidate.name):
        response_headers["Cache-Control"] = "public, max-age=31536000, immutable"
    if headers:
        response_headers.update(headers)
    return FileResponse(candidate, media_type=media_type, headers=response_headers)


@router.api_route("/sw.js", methods=["GET", "HEAD"], include_in_schema=False)
def service_worker() -> FileResponse:
    return _dist_file("sw.js", media_type="text/javascript", headers={
        "Cache-Control": "no-cache, max-age=0, must-revalidate",
        "Service-Worker-Allowed": "/",
    })


@router.api_route("/manifest.webmanifest", methods=["GET", "HEAD"], include_in_schema=False)
def web_manifest() -> FileResponse:
    return _dist_file("manifest.webmanifest", media_type="application/manifest+json")


@router.get("/{full_path:path}", response_class=HTMLResponse, include_in_schema=False)
def spa_fallback(full_path: str) -> FileResponse:
    if (
        full_path.startswith("api/")
        or full_path == "api"
        or full_path == "static" or full_path.startswith("static/")
        or full_path == "storage" or full_path.startswith("storage/")
        or full_path == "ws" or full_path.startswith("ws/")
    ):
        raise HTTPException(404)
    if any(ord(c) < 0x20 for c in full_path) or "\\" in full_path:
        raise HTTPException(404)
    # Keep the legacy /dist/assets alias, with the same strict dist boundary.
    if full_path.startswith("dist/"):
        return _dist_file(full_path.removeprefix("dist/"))
    if full_path.startswith(("assets/", "pwa/")):
        return _dist_file(full_path)
    if full_path in {"assets", "dist", "pwa"} or (Path(full_path).suffix and full_path != "index.html"):
        raise HTTPException(404)
    return _serve_spa()
