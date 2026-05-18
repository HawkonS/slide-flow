"""
配置管理路由模块
处理系统配置的读取和更新
"""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.config import CONFIG_GROUPS, CONFIG_META, PROPERTIES_FILE, _coerce_value, read_config_view, write_properties
from app.core.permissions import require_super_admin


router = APIRouter()


class AdminConfigUpdatePayload(BaseModel):
    items: dict[str, str]


@router.get("/admin/config")
def api_admin_config_get(
    _: Any = Depends(require_super_admin),
) -> dict[str, Any]:
    """读取全部可管理的配置项及其元数据（仅超级管理员）。"""
    values = read_config_view()
    config: dict[str, dict[str, Any]] = {}
    for key, meta in CONFIG_META.items():
        config[key] = {
            "value": values.get(key, ""),
            "label": meta["label"],
            "group": meta["group"],
            "hot_reload": meta["hot_reload"],
            "type": meta["type"],
            "desc": meta["desc"],
        }
    return {"config": config, "groups": CONFIG_GROUPS}


@router.put("/admin/config")
def api_admin_config_put(
    payload: AdminConfigUpdatePayload,
    _: Any = Depends(require_super_admin),
) -> dict[str, Any]:
    """修改配置项（仅超级管理员）。所有配置修改需重启服务后生效。"""
    invalid = [k for k in payload.items.keys() if k not in CONFIG_META]
    if invalid:
        raise HTTPException(400, f"未知配置项: {', '.join(invalid)}")

    # 类型校验
    for key, raw in payload.items.items():
        meta = CONFIG_META[key]
        try:
            _coerce_value(raw, meta["type"])
        except Exception:
            raise HTTPException(400, f"配置项 {key} 类型不正确，应为 {meta['type']}")

    if not payload.items:
        return {"applied": [], "pending_restart": []}

    write_properties(payload.items)

    # 所有配置都需要重启生效
    pending: list[str] = list(payload.items.keys())

    return {"applied": [], "pending_restart": pending}


@router.get("/config")
def api_config() -> dict[str, Any]:
    """获取公开配置（无需登录）"""
    from app.config import settings
    
    logo_path = settings.logo_svg_path.lstrip("/")
    if logo_path.startswith("app/static/"):
        logo_url = "/static/" + logo_path.removeprefix("app/static/")
    elif logo_path.startswith("static/"):
        logo_url = "/" + logo_path
    else:
        logo_url = "/" + logo_path
    return {
        "site_name": settings.site_name,
        "port": settings.port,
        "startup_script": settings.startup_script,
        "logo_svg_path": logo_url,
        "default_filter_status": settings.default_filter_status,
        "default_filter_subject": settings.default_filter_subject,
    }
