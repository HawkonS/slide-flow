"""
导航配置模块
管理侧边栏导航标签名称与排序的可配置化
配置项以 nav.* 命名空间存储在 slide_flow.properties 中
"""
from __future__ import annotations

from typing import Any

from app.config import PROPERTIES_FILE, _read_properties


# ─────────────────────────────────────────────
# 导航项注册表（声明顺序即默认排序）
# ─────────────────────────────────────────────
NAV_REGISTRY: list[dict[str, Any]] = [
    # 首页（单独入口，不属于任何分组）
    {"key": "home",             "path": "/home",                "default_label": "首页",     "section": None,       "admin": False, "super_admin": False},
    # ── 素材分组 ──
    {"key": "resources",        "path": "/resources",           "default_label": "资源仓库", "section": "material", "admin": False, "super_admin": False},
    {"key": "templates",        "path": "/templates",           "default_label": "模板仓库", "section": "material", "admin": False, "super_admin": False},
    {"key": "shows",            "path": "/shows",               "default_label": "放映仓库", "section": "material", "admin": False, "super_admin": False},
    {"key": "fonts",            "path": "/fonts",               "default_label": "字体仓库", "section": "material", "admin": False, "super_admin": False},
    {"key": "links",            "path": "/links",               "default_label": "链接仓库", "section": "material", "admin": False, "super_admin": False},
    # ── 维护分组 ──
    {"key": "manage_resources", "path": "/manage/resources",    "default_label": "资源管理", "section": "manage",   "admin": False, "super_admin": False},
    {"key": "manage_tasks",     "path": "/manage/tasks",        "default_label": "任务管理", "section": "manage",   "admin": False, "super_admin": False},
    {"key": "manage_offline",   "path": "/manage/offline-cache","default_label": "离线缓存", "section": "manage",   "admin": False, "super_admin": False},
    {"key": "manage_downloads", "path": "/manage/downloads",    "default_label": "下载记录", "section": "manage",   "admin": True,  "super_admin": False},
    {"key": "manage_tags",      "path": "/manage/tags",        "default_label": "标签管理", "section": "manage",   "admin": True,  "super_admin": False},
    # ── 系统分组 ──
    {"key": "admin_users",      "path": "/admin/users",         "default_label": "用户管理", "section": "system",   "admin": True,  "super_admin": False},
    {"key": "admin_templates",  "path": "/admin/templates",     "default_label": "模板管理", "section": "system",   "admin": True,  "super_admin": False},
    {"key": "admin_fonts",      "path": "/admin/fonts",         "default_label": "字体管理", "section": "system",   "admin": True,  "super_admin": False},
    {"key": "admin_links",      "path": "/admin/links",         "default_label": "链接管理", "section": "system",   "admin": True,  "super_admin": False},
    {"key": "admin_system",     "path": "/admin/system",        "default_label": "系统管理", "section": "system",   "admin": True,  "super_admin": True},
]

SECTION_REGISTRY: list[dict[str, str]] = [
    {"key": "material", "default_label": "素材"},
    {"key": "manage",   "default_label": "维护"},
    {"key": "system",   "default_label": "系统"},
]

# 合法 key 集合（用于 API 校验）
VALID_NAV_KEYS: set[str] = {item["key"] for item in NAV_REGISTRY}
VALID_SECTION_KEYS: set[str] = {s["key"] for s in SECTION_REGISTRY}


def _default_order(key: str, section: str | None) -> int:
    """返回注册表中的声明顺序作为默认排序值。"""
    # 按分组内的声明顺序
    section_items = [
        item for item in NAV_REGISTRY
        if item["section"] == section
    ]
    for i, item in enumerate(section_items):
        if item["key"] == key:
            return i
    # home 等无分组的项
    for i, item in enumerate(NAV_REGISTRY):
        if item["key"] == key:
            return i
    return 99


def load_nav_config() -> dict[str, Any]:
    """
    从 slide_flow.properties 读取 nav.* 配置，与注册表默认值合并。

    返回格式：
    {
        "labels": {"home": "首页", "resources": "资源仓库", ..., "section_material": "素材", ...},
        "order":  {"resources": 0, "templates": 1, ...},
    }
    """
    props = _read_properties(PROPERTIES_FILE)

    labels: dict[str, str] = {}
    order: dict[str, int] = {}

    # 导航项标签与排序
    for item in NAV_REGISTRY:
        key = item["key"]
        label_prop = f"nav.label.{key}"
        order_prop = f"nav.order.{key}"

        labels[key] = props.get(label_prop, item["default_label"])
        try:
            order[key] = int(props.get(order_prop, str(_default_order(key, item["section"]))))
        except ValueError:
            order[key] = _default_order(key, item["section"])

    # 分组标签（用 section_{key} 作为 labels 的 key）
    for section in SECTION_REGISTRY:
        sk = section["key"]
        section_prop = f"nav.section.{sk}"
        labels[f"section_{sk}"] = props.get(section_prop, section["default_label"])

    return {"labels": labels, "order": order}


def get_nav_config_items_for_admin() -> list[dict[str, Any]]:
    """
    生成供 GET /api/admin/config 使用的虚拟配置项列表。
    每个 nav.label.*、nav.order.*、nav.section.* 均返回一个与 CONFIG_META 格式一致的字典。
    """
    props = _read_properties(PROPERTIES_FILE)
    items: list[dict[str, Any]] = []

    # 导航项标签
    for item in NAV_REGISTRY:
        key = item["key"]
        prop_key = f"nav.label.{key}"
        items.append({
            "config_key": prop_key,
            "value": props.get(prop_key, item["default_label"]),
            "label": f"导航标签 · {item['default_label']}",
            "group": "navigation",
            "hot_reload": False,
            "type": "str",
            "desc": f"导航项「{item['default_label']}」的显示名称（路径: {item['path']}）",
        })

    # 分组标签
    for section in SECTION_REGISTRY:
        sk = section["key"]
        prop_key = f"nav.section.{sk}"
        items.append({
            "config_key": prop_key,
            "value": props.get(prop_key, section["default_label"]),
            "label": f"分组标题 · {section['default_label']}",
            "group": "navigation",
            "hot_reload": False,
            "type": "str",
            "desc": f"侧边栏分组「{section['default_label']}」的标题",
        })

    # 导航项排序（按分组组织）
    current_section = None
    for item in NAV_REGISTRY:
        key = item["key"]
        section = item["section"]
        # 跳过首页（无需排序，固定在顶部）
        if section is None:
            continue
        prop_key = f"nav.order.{key}"
        default = _default_order(key, section)
        raw = props.get(prop_key, str(default))
        try:
            value = int(raw)
        except ValueError:
            value = default
        items.append({
            "config_key": prop_key,
            "value": str(value),
            "label": f"排序 · {item['default_label']}",
            "group": "navigation",
            "hot_reload": False,
            "type": "int",
            "desc": f"在「{_section_label(section)}」分组中的排列顺序，数值越小越靠前",
        })

    return items


def _section_label(section: str | None) -> str:
    for s in SECTION_REGISTRY:
        if s["key"] == section:
            return s["default_label"]
    return section or ""


def is_valid_nav_key(key: str) -> bool:
    """校验 nav.* 配置项的 key 是否合法。"""
    if key.startswith("nav.label."):
        return key[len("nav.label."):] in VALID_NAV_KEYS
    if key.startswith("nav.section."):
        return key[len("nav.section."):] in VALID_SECTION_KEYS
    if key.startswith("nav.order."):
        return key[len("nav.order."):] in VALID_NAV_KEYS
    return False


# 启动时加载并缓存
nav_config: dict[str, Any] = load_nav_config()
