"""
页面路由模块
处理首页 SPA 路由
"""
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse

from app.config import settings

router = APIRouter()

SPA_INDEX = settings.static_dir / "dist" / "index.html"


def _serve_spa() -> FileResponse:
    """提供 SPA 单页应用入口"""
    if not SPA_INDEX.exists():
        raise HTTPException(
            503,
            "前端尚未构建，请在 web/ 下执行 `npm install && npm run build`",
        )
    return FileResponse(SPA_INDEX)


@router.get("/", response_class=HTMLResponse)
def spa_index() -> FileResponse:
    """首页 - 返回 Vue/React SPA 入口"""
    return _serve_spa()
