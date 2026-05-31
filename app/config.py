from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[1]
PROPERTIES_FILE = ROOT_DIR / "slide_flow.properties"


def _read_properties(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


# 配置项元数据：标签、分组、是否可热加载、值类型、描述
CONFIG_META: dict[str, dict[str, Any]] = {
    # 服务器
    "site.name": {"label": "站点名称", "group": "server", "hot_reload": True, "type": "str", "desc": "前端页面标题与后端服务名"},
    "server.port": {"label": "后端服务端口", "group": "server", "hot_reload": False, "type": "int", "desc": "主 API 服务端口，修改后需重启"},
    "server.web_port": {"label": "前端服务端口", "group": "server", "hot_reload": False, "type": "int", "desc": "前端开发/代理端口，修改后需重启"},
    "server.workers": {"label": "工作进程数", "group": "server", "hot_reload": False, "type": "int", "desc": "Uvicorn worker 数量"},
    "server.allowed_host": {"label": "允许的访问域名", "group": "server", "hot_reload": False, "type": "str", "desc": "Vite 开发服务器允许访问的域名，多个域名用逗号分隔"},
    # 安全
    "security.secret_key": {"label": "会话签名密钥", "group": "security", "hot_reload": False, "type": "str", "desc": "会话/演示令牌签名密钥，修改后现有会话会失效"},
    "security.default_password": {"label": "默认密码", "group": "security", "hot_reload": True, "type": "str", "desc": "新建用户及首次初始化使用的默认密码"},
    "security.session_ttl_hours": {"label": "会话有效期（小时）", "group": "security", "hot_reload": True, "type": "int", "desc": "登录会话令牌的有效时长"},
    "security.show_token_ttl_seconds": {"label": "演示令牌有效期（秒）", "group": "security", "hot_reload": True, "type": "int", "desc": "演示分享令牌的有效时长"},
    # 数据目录
    "data.dir": {"label": "数据根目录", "group": "data", "hot_reload": False, "type": "str", "desc": "包含数据库、资源文件和日志的根目录"},
    "data.db_dir": {"label": "数据库目录", "group": "data", "hot_reload": False, "type": "str", "desc": "SQLite 数据库存放目录"},
    "data.assets_dir": {"label": "资源文件根目录", "group": "data", "hot_reload": False, "type": "str", "desc": "资源文件根目录"},
    "data.resources_dir": {"label": "素材文件目录", "group": "data", "hot_reload": False, "type": "str", "desc": "素材文件目录"},
    "data.templates_dir": {"label": "模板文件目录", "group": "data", "hot_reload": False, "type": "str", "desc": "模板文件目录"},
    "data.fonts_dir": {"label": "字体文件目录", "group": "data", "hot_reload": False, "type": "str", "desc": "字体文件目录"},
    "data.thumbs_dir": {"label": "缩略图目录", "group": "data", "hot_reload": False, "type": "str", "desc": "缩略图目录"},
    "data.downloads_dir": {"label": "下载临时目录", "group": "data", "hot_reload": False, "type": "str", "desc": "下载临时文件目录"},
    # 日志
    "log.dir": {"label": "日志目录", "group": "log", "hot_reload": False, "type": "str", "desc": "日志文件目录"},
    "log.max_size_mb": {"label": "日志滚动大小上限（MB）", "group": "log", "hot_reload": False, "type": "int", "desc": "单个日志文件滚动大小上限"},
    "log.backup_count": {"label": "日志备份数量", "group": "log", "hot_reload": False, "type": "int", "desc": "保留的日志备份文件数量"},
    # 应用配置
    "app.default_resource_subject": {"label": "默认资源主题", "group": "app", "hot_reload": True, "type": "str", "desc": "新建资源默认主题（留空表示不设置）"},
    "app.default_filter_status": {"label": "状态筛选默认值", "group": "app", "hot_reload": True, "type": "str", "desc": "资源状态筛选器默认值（留空=全部；active=正常；disabled=停用）"},
    "app.default_filter_subject": {"label": "主题筛选默认值", "group": "app", "hot_reload": True, "type": "str", "desc": "资源主题筛选器默认值（留空=全部）"},
    "app.slow_request_threshold": {"label": "慢请求阈值（秒）", "group": "app", "hot_reload": True, "type": "float", "desc": "超过该阈值的请求会被记录到慢请求日志"},
    "app.split_task_timeout": {"label": "拆分任务超时（秒）", "group": "app", "hot_reload": False, "type": "int", "desc": "PPT 拆分任务超时时间"},
    "app.max_concurrent_splits": {"label": "最大并发拆分数", "group": "app", "hot_reload": False, "type": "int", "desc": "最大并发的 PPT 拆分任务数"},
    # 管理后台
    "admin.route_prefix": {"label": "管理面板路由前缀", "group": "admin", "hot_reload": False, "type": "str", "desc": "管理面板路由前缀"},
    # 外观
    "logo.svg.path": {"label": "Logo 路径", "group": "appearance", "hot_reload": True, "type": "str", "desc": "Logo SVG 文件路径"},
    "web.https": {"label": "前端启用 HTTPS", "group": "appearance", "hot_reload": True, "type": "bool", "desc": "前端是否启用 HTTPS"},
    # 飞书 SSO
    "feishu.sso_enabled": {"label": "启用飞书 SSO", "group": "feishu", "hot_reload": True, "type": "bool", "desc": "是否启用飞书单点登录"},
    "feishu.app_id": {"label": "飞书 App ID", "group": "feishu", "hot_reload": True, "type": "str", "desc": "飞书自建应用的 App ID"},
    "feishu.app_secret": {"label": "飞书 App Secret", "group": "feishu", "hot_reload": True, "type": "str", "desc": "飞书自建应用的 App Secret"},
}

CONFIG_GROUPS: list[dict[str, str]] = [
    {"key": "server", "label": "服务器配置"},
    {"key": "security", "label": "安全配置"},
    {"key": "data", "label": "数据目录"},
    {"key": "log", "label": "日志配置"},
    {"key": "app", "label": "应用配置"},
    {"key": "admin", "label": "管理后台"},
    {"key": "appearance", "label": "外观配置"},
    {"key": "feishu", "label": "飞书 SSO"},
]

# 配置项 key -> Settings 属性名
_PROP_TO_ATTR: dict[str, str] = {
    "site.name": "site_name",
    "server.port": "port",
    "server.web_port": "web_port",
    "server.workers": "workers",
    "server.allowed_host": "allowed_host",
    "security.secret_key": "secret_key",
    "security.default_password": "default_password",
    "security.session_ttl_hours": "session_ttl_hours",
    "security.show_token_ttl_seconds": "show_token_ttl_seconds",
    "data.dir": "data_dir",
    "data.db_dir": "db_dir",
    "data.assets_dir": "assets_dir",
    "data.resources_dir": "resources_dir",
    "data.templates_dir": "templates_dir",
    "data.fonts_dir": "fonts_dir",
    "data.thumbs_dir": "thumbs_dir",
    "data.downloads_dir": "downloads_dir",
    "log.dir": "log_dir",
    "log.max_size_mb": "log_max_size_mb",
    "log.backup_count": "log_backup_count",
    "app.default_resource_subject": "default_resource_subject",
    "app.default_filter_status": "default_filter_status",
    "app.default_filter_subject": "default_filter_subject",
    "app.slow_request_threshold": "slow_request_threshold",
    "app.split_task_timeout": "split_task_timeout",
    "app.max_concurrent_splits": "max_concurrent_splits",
    "admin.route_prefix": "admin_route_prefix",
    "logo.svg.path": "logo_svg_path",
    "web.https": "web_https",
    "feishu.sso_enabled": "feishu_sso_enabled",
    "feishu.app_id": "feishu_app_id",
    "feishu.app_secret": "feishu_app_secret",
}


def _resolve_path(raw: str) -> Path:
    """将路径字符串解析为绝对路径。相对路径基于 ROOT_DIR。"""
    p = Path(raw)
    if p.is_absolute():
        return p
    return ROOT_DIR / p


@dataclass
class Settings:
    root_dir: Path

    # 基础配置
    site_name: str = "页流幻灯片管理平台"
    port: int = 8088
    web_port: int = 5173
    workers: int = 4
    startup_script: str = "start.sh"
    allowed_host: str = ""

    # 安全配置
    secret_key: str = "slide-flow-local-dev-secret"
    default_password: str = "123456"
    session_ttl_hours: int = 12
    show_token_ttl_seconds: int = 7200

    # 数据目录
    data_dir: Path = field(default_factory=lambda: ROOT_DIR / "data")
    db_dir: Path = field(default_factory=lambda: ROOT_DIR / "data" / "db")
    assets_dir: Path = field(default_factory=lambda: ROOT_DIR / "data" / "assets")
    resources_dir: Path = field(default_factory=lambda: ROOT_DIR / "data" / "assets" / "resources")
    templates_dir: Path = field(default_factory=lambda: ROOT_DIR / "data" / "assets" / "templates")
    fonts_dir: Path = field(default_factory=lambda: ROOT_DIR / "data" / "assets" / "fonts")
    thumbs_dir: Path = field(default_factory=lambda: ROOT_DIR / "data" / "assets" / "thumbs")
    downloads_dir: Path = field(default_factory=lambda: ROOT_DIR / "data" / "assets" / "downloads")

    # 日志配置
    log_dir: Path = field(default_factory=lambda: ROOT_DIR / "data" / "logs")
    log_max_size_mb: int = 50
    log_backup_count: int = 5

    # 应用配置
    default_resource_subject: str = ""
    default_filter_status: str = ""
    default_filter_subject: str = ""
    slow_request_threshold: float = 1.0
    split_task_timeout: int = 600
    max_concurrent_splits: int = 2

    # 管理后台
    admin_route_prefix: str = "/admin"

    # 外观
    logo_svg_path: str = "app/static/img/logo.svg"
    web_https: bool = True

    # 飞书 SSO
    feishu_sso_enabled: bool = False
    feishu_app_id: str = ""
    feishu_app_secret: str = ""

    # 数据库路径（派生）
    db_path: Path = field(default_factory=lambda: ROOT_DIR / "data" / "db" / "slide_flow.db")

    @property
    def static_dir(self) -> Path:
        return self.root_dir / "app" / "static"

    def abs_path(self, stored_path: str | None) -> Path | None:
        if not stored_path:
            return None
        path = Path(stored_path)
        if path.is_absolute():
            return path
        return self.root_dir / path

    def store_path(self, path: Path) -> str:
        try:
            return str(path.resolve().relative_to(self.root_dir))
        except ValueError:
            return str(path.resolve())

    def ensure_dirs(self) -> None:
        """启动时自动创建所有数据子目录。"""
        for d in (
            self.data_dir,
            self.db_dir,
            self.assets_dir,
            self.resources_dir,
            self.templates_dir,
            self.fonts_dir,
            self.thumbs_dir,
            self.downloads_dir,
            self.log_dir,
        ):
            d.mkdir(parents=True, exist_ok=True)


def _parse_bool(value: str) -> bool:
    return value.lower() in ("true", "1", "yes", "on")


def _coerce_value(raw: str, value_type: str) -> Any:
    """根据 CONFIG_META 中声明的类型将原始字符串转换为实际值。"""
    if value_type == "int":
        return int(raw)
    if value_type == "float":
        return float(raw)
    if value_type == "bool":
        return _parse_bool(raw)
    return raw


def get_config_value_str(key: str) -> str:
    """返回运行时 settings 中指定配置项的字符串化值。"""
    attr = _PROP_TO_ATTR.get(key)
    if attr is None:
        return ""
    val = getattr(settings, attr, "")
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, Path):
        # 优先展示相对路径（以 ROOT_DIR 为基准）
        try:
            return str(val.resolve().relative_to(settings.root_dir))
        except ValueError:
            return str(val)
    return str(val)


def read_config_view() -> dict[str, str]:
    """读取 properties 文件中的原始值，缺失时回退到运行时 settings 值。"""
    props = _read_properties(PROPERTIES_FILE)
    out: dict[str, str] = {}
    for key in CONFIG_META:
        if key in props:
            out[key] = props[key]
        else:
            out[key] = get_config_value_str(key)
    return out


def write_properties(updates: dict[str, str]) -> None:
    """更新 slide_flow.properties 文件，保留原有注释与顺序。未出现的 key 追加到文件末尾。写入前备份为 .bak。"""
    path = PROPERTIES_FILE
    if path.exists():
        backup = path.with_suffix(path.suffix + ".bak")
        backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
        original_lines = path.read_text(encoding="utf-8").splitlines()
    else:
        original_lines = []

    remaining = dict(updates)
    new_lines: list[str] = []
    for raw in original_lines:
        stripped = raw.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            new_lines.append(raw)
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in remaining:
            new_lines.append(f"{key}={remaining.pop(key)}")
        else:
            new_lines.append(raw)

    if remaining:
        if new_lines and new_lines[-1].strip() != "":
            new_lines.append("")
        new_lines.append("# ===== 追加配置项 =====")
        for key, value in remaining.items():
            new_lines.append(f"{key}={value}")

    path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")


def reload_settings() -> set[str]:
    """重新读取 properties 文件，将可热加载的配置更新到全局 settings 中。返回已热更新的 key 集合。"""
    new_s = load_settings()
    hot_keys = {key for key, meta in CONFIG_META.items() if meta["hot_reload"]}
    for key in hot_keys:
        attr = _PROP_TO_ATTR.get(key)
        if attr is None:
            continue
        setattr(settings, attr, getattr(new_s, attr))
    # 数据库路径不可热加载，但为完整性不同步。
    return hot_keys


def load_settings() -> Settings:
    props = _read_properties(PROPERTIES_FILE)

    # 基础配置
    site_name = props.get("site.name", "页流幻灯片管理平台")
    port = int(props.get("server.port", "8088"))
    web_port = int(props.get("server.web_port", "5173"))
    workers = int(props.get("server.workers", "4"))
    allowed_host = props.get("server.allowed_host", "")
    startup_script = props.get("startup.script", "start.sh")

    # 安全配置
    secret_key = os.getenv("SLIDE_FLOW_SECRET", props.get("security.secret_key", "slide-flow-local-dev-secret"))
    default_password = props.get("security.default_password", "123456")
    session_ttl_hours = int(props.get("security.session_ttl_hours", "12"))
    show_token_ttl_seconds = int(props.get("security.show_token_ttl_seconds", "7200"))

    # 数据目录
    data_dir = _resolve_path(props.get("data.dir", "data"))
    db_dir = _resolve_path(props.get("data.db_dir", str(data_dir / "db")))
    assets_dir = _resolve_path(props.get("data.assets_dir", str(data_dir / "assets")))
    resources_dir = _resolve_path(props.get("data.resources_dir", str(assets_dir / "resources")))
    templates_dir = _resolve_path(props.get("data.templates_dir", str(assets_dir / "templates")))
    fonts_dir = _resolve_path(props.get("data.fonts_dir", str(assets_dir / "fonts")))
    thumbs_dir = _resolve_path(props.get("data.thumbs_dir", str(assets_dir / "thumbs")))
    downloads_dir = _resolve_path(props.get("data.downloads_dir", str(assets_dir / "downloads")))

    # 日志配置
    log_dir = _resolve_path(props.get("log.dir", str(data_dir / "logs")))
    log_max_size_mb = int(props.get("log.max_size_mb", "50"))
    log_backup_count = int(props.get("log.backup_count", "5"))

    # 应用配置
    default_resource_subject = props.get("app.default_resource_subject", "")
    default_filter_status = props.get("app.default_filter_status", "")
    default_filter_subject = props.get("app.default_filter_subject", "")
    slow_request_threshold = float(props.get("app.slow_request_threshold", "1.0"))
    split_task_timeout = int(props.get("app.split_task_timeout", "600"))
    max_concurrent_splits = int(props.get("app.max_concurrent_splits", "2"))

    # 管理后台
    admin_route_prefix = props.get("admin.route_prefix", "/admin")

    # 外观
    logo_svg_path = props.get("logo.svg.path", "app/static/img/logo.svg")
    web_https = _parse_bool(props.get("web.https", "true"))

    # 飞书 SSO
    feishu_sso_enabled = _parse_bool(props.get("feishu.sso_enabled", "false"))
    feishu_app_id = props.get("feishu.app_id", "")
    feishu_app_secret = props.get("feishu.app_secret", "")

    # 数据库路径
    db_path = db_dir / "slide_flow.db"

    s = Settings(
        root_dir=ROOT_DIR,
        site_name=site_name,
        port=port,
        web_port=web_port,
        workers=workers,
        startup_script=startup_script,
        allowed_host=allowed_host,
        secret_key=secret_key,
        default_password=default_password,
        session_ttl_hours=session_ttl_hours,
        show_token_ttl_seconds=show_token_ttl_seconds,
        data_dir=data_dir,
        db_dir=db_dir,
        assets_dir=assets_dir,
        resources_dir=resources_dir,
        templates_dir=templates_dir,
        fonts_dir=fonts_dir,
        thumbs_dir=thumbs_dir,
        downloads_dir=downloads_dir,
        log_dir=log_dir,
        log_max_size_mb=log_max_size_mb,
        log_backup_count=log_backup_count,
        default_resource_subject=default_resource_subject,
        default_filter_status=default_filter_status,
        default_filter_subject=default_filter_subject,
        slow_request_threshold=slow_request_threshold,
        split_task_timeout=split_task_timeout,
        max_concurrent_splits=max_concurrent_splits,
        admin_route_prefix=admin_route_prefix,
        logo_svg_path=logo_svg_path,
        web_https=web_https,
        feishu_sso_enabled=feishu_sso_enabled,
        feishu_app_id=feishu_app_id,
        feishu_app_secret=feishu_app_secret,
        db_path=db_path,
    )
    s.ensure_dirs()
    return s


settings = load_settings()
