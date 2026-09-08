"""
路由模块统一导出
"""
from app.routers import (
    pages,
    config,
    system,
    auth,
    user_center,
    users,
    fonts,
    download_records,
    tags,
    feishu_auth,
)

__all__ = [
    "pages",
    "config", 
    "system",
    "auth",
    "user_center",
    "users",
    "fonts",
    "download_records",
    "tags",
    "feishu_auth",
]
