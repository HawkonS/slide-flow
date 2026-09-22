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
    return FileResponse(SPA_INDEX, headers={"Cache-Control": "no-cache"})


@router.get("/{full_path:path}", response_class=HTMLResponse, include_in_schema=False)
def spa_fallback(full_path: str) -> FileResponse:
    if (
        full_path.startswith("api/")
        or full_path == "api"
        or full_path.startswith("static/")
        or full_path.startswith("storage/")
    ):
        raise HTTPException(404)
    # dist/ 下的真实文件（如 dist/assets/index-xxx.js）以及 index.html
    # 引用的 /assets/xxx.js，直接返回构建产物并附加一年期不可变缓存
    # （文件名带 hash，内容变则文件名变）
    candidate_rel = None
    if full_path.startswith("dist/"):
        candidate_rel = full_path
    elif full_path.startswith("assets/"):
        candidate_rel = f"dist/{full_path}"
    if candidate_rel:
        # URL 解码后的控制字符（如 %00）会让底层 os.stat 抛 ValueError 返回 500，
        # 在进入文件系统操作前直接回退 index.html
        if any(ord(c) < 0x20 for c in candidate_rel):
            return _serve_spa()
        candidate = (settings.static_dir / candidate_rel).resolve()
        dist_root = settings.static_dir.resolve()
        if (
            candidate.is_file()
            and candidate.is_relative_to(dist_root)
            and candidate_rel.rpartition("/")[0] != "dist"
        ):
            # 仅 hash 化产物附加一年期不可变缓存，其余保持默认
            headers = {}
            if _HASHED_ASSET_RE.search(os.path.basename(candidate_rel)):
                headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return FileResponse(candidate, headers=headers)
    return _serve_spa()
