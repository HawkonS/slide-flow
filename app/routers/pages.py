"""
页面路由模块
处理首页 SPA 路由
"""
from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from app.web.static import _serve_spa

router = APIRouter()


@router.get("/", response_class=HTMLResponse)
def spa_index() -> HTMLResponse:
    """首页 - 返回 Vue/React SPA 入口"""
    return _serve_spa()
