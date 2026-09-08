"""
配置管理路由模块
处理系统配置的读取和更新
"""
import json
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from app.config import CONFIG_GROUPS, CONFIG_META, PROPERTIES_FILE, ROOT_DIR, _coerce_value, read_config_view, settings, write_properties
from app.core.permissions import require_system_admin
from app.routers.dependencies import ApiPayload
router = APIRouter()
logger = logging.getLogger(__name__)


class AdminConfigUpdatePayload(ApiPayload):
    items: dict[str, str]


@router.get("/admin/config")
def api_admin_config_get(
    _: Any = Depends(require_system_admin),
) -> dict[str, Any]:
    """读取全部可管理的配置项及其元数据（仅系统管理员）。"""
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
    _: Any = Depends(require_system_admin),
) -> dict[str, Any]:
    """修改配置项（仅系统管理员）。所有配置修改需重启服务后生效。"""
    invalid = [k for k in payload.items.keys() if k not in CONFIG_META]
    if invalid:
        raise HTTPException(400, f"未知配置项: {', '.join(invalid)}")

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
        "logo_svg_path": logo_url,
        "default_filter_status": settings.default_filter_status,
        "default_filter_subject": settings.default_filter_subject,
        "feishu_sso_enabled": settings.feishu_sso_enabled,
        "feishu_app_id": settings.feishu_app_id if settings.feishu_sso_enabled else "",
        "user_custom_tags": settings.user_custom_tags,
    }


@router.get("/version")
def api_version() -> dict[str, str]:
    """获取版本信息（无需登录）"""
    version_file: Path = ROOT_DIR / "data" / ".version_info"
    if version_file.exists():
        try:
            data = json.loads(version_file.read_text(encoding="utf-8"))
            return {
                "commit": data.get("commit", "unknown"),
                "updated_at": data.get("updated_at", ""),
            }
        except Exception as e:
            logger.warning("读取版本文件失败: %s", e)
    return {"commit": "unknown", "updated_at": ""}
