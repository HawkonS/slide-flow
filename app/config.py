from __future__ import annotations

import os
import secrets
import stat
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[1]
PROPERTIES_FILE = ROOT_DIR / "slide_flow.properties"


def read_properties(path: Path = PROPERTIES_FILE) -> dict[str, str]:
    values: dict[str, str] = {}
    if path == PROPERTIES_FILE:
        ensure_properties_file(path)
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    # New settings are additive: an existing installation must not lose its
    # settings/secrets or require deletion of its properties file.
    for key, default in DEFAULT_PROPERTIES.items():
        values.setdefault(key, default)
    return values


# 配置 Schema 是默认值、后台配置元数据和首次生成文件的唯一来源。
CONFIG_SCHEMA: list[dict[str, Any]] = [
    {
        "key": "server",
        "label": "服务器配置",
        "items": [
            {"key": "site.name", "label": "站点名称", "default": "页流幻灯片管理平台", "type": "str", "hot_reload": True, "desc": "前端页面标题与后端服务名"},
            {"key": "server.port", "label": "后端服务端口", "default": "8088", "type": "int", "hot_reload": False, "desc": "主 API 服务端口，修改后需重启"},
            {"key": "server.web_port", "label": "前端服务端口", "default": "5173", "type": "int", "hot_reload": False, "desc": "前端开发端口，仅 --dev 开发模式启动 Vite 时生效；生产模式前端由后端静态托管，访问入口为 server.port"},
            {"key": "server.workers", "label": "工作进程数", "default": "4", "type": "int", "hot_reload": False, "desc": "Gunicorn/Uvicorn ASGI worker 数量；任务事件通过 SQLite 跨进程分发"},
            {"key": "server.allowed_host", "label": "允许的访问域名", "default": "", "type": "str", "hot_reload": False, "desc": "Vite 开发服务器允许访问的域名，多个域名用逗号分隔"},
            {"key": "server.db_pool_size", "label": "数据库连接池大小", "default": "10", "type": "int", "hot_reload": False, "desc": "每个 worker 进程的数据库连接池容量"},
            {"key": "server.thread_pool_size", "label": "线程池大小", "default": "20", "type": "int", "hot_reload": False, "desc": "处理并发同步请求的默认线程池容量"},
            {"key": "server.response_cache", "label": "启用响应缓存", "default": "true", "type": "bool", "hot_reload": True, "desc": "为 GET API 请求添加 Cache-Control 头以减少重复请求"},
            {"key": "web.https", "label": "前端启用 HTTPS", "default": "false", "type": "bool", "hot_reload": True, "desc": "是否部署在 HTTPS 反向代理之后（影响 Secure Cookie 与 HSTS），应用服务器本身不终结 TLS"},
        ],
    },
    {
        "key": "security",
        "label": "安全配置",
        "items": [
            {"key": "security.secret_key", "label": "会话签名密钥", "default": "slide-flow-local-dev-secret", "type": "str", "hot_reload": False, "secret": True, "desc": "会话/演示令牌签名密钥，也可通过环境变量 SLIDE_FLOW_SECRET 覆盖"},
            {"key": "security.session_ttl_hours", "label": "会话有效期（小时）", "default": "12", "type": "int", "hot_reload": True, "desc": "登录会话令牌的有效时长"},
            {"key": "security.show_token_ttl_seconds", "label": "演示令牌有效期（秒）", "default": "7200", "type": "int", "hot_reload": True, "desc": "演示分享令牌的有效时长"},
        ],
    },
    {
        "key": "data",
        "label": "数据目录",
        "items": [
            {"key": "data.dir", "label": "数据根目录", "default": "data", "type": "str", "hot_reload": False, "desc": "包含数据库、资源文件和日志的根目录"},
            {"key": "data.db_dir", "label": "数据库目录", "default": "data/db", "type": "str", "hot_reload": False, "desc": "SQLite 数据库存放目录"},
            {"key": "data.assets_dir", "label": "本地工作目录", "default": "data/assets", "type": "str", "hot_reload": False, "desc": "字体、下载缓存和 OSS 临时处理文件的本地根目录"},
            {"key": "data.resources_dir", "label": "素材兼容目录", "default": "data/assets/resources", "type": "str", "hot_reload": False, "desc": "仅用于读取历史本地素材；新 PPT/PNG 持久化到 OSS"},
            {"key": "data.templates_dir", "label": "模板兼容目录", "default": "data/assets/templates", "type": "str", "hot_reload": False, "desc": "仅用于读取历史本地模板；新 PPT/PNG 持久化到 OSS"},
            {"key": "data.fonts_dir", "label": "字体文件目录", "default": "data/assets/fonts", "type": "str", "hot_reload": False, "desc": "字体文件目录"},
            {"key": "data.thumbs_dir", "label": "历史缩略图缓存目录", "default": "data/assets/thumbs", "type": "str", "hot_reload": False, "desc": "兼容历史本地图片及离线包；在线小图使用 OSS 图片处理"},
            {"key": "data.downloads_dir", "label": "下载临时目录", "default": "data/assets/downloads", "type": "str", "hot_reload": False, "desc": "下载临时文件目录"},
        ],
    },
    {
        "key": "storage",
        "label": "对象存储",
        "items": [
            {"key": "storage.backend", "label": "资源存储后端", "default": "oss", "type": "str", "hot_reload": False, "desc": "PPT/PNG 持久化后端；使用 OSS 时上传默认先落 OSS 临时目录，再下载到本地临时目录处理，最终结果回传 OSS"},
            {"key": "oss.endpoint", "label": "OSS 外网 Endpoint", "default": "", "type": "str", "hot_reload": False, "desc": "服务端内网访问失败时的回退地址，也是默认外网地址，例如 https://oss-cn-hangzhou.aliyuncs.com"},
            {"key": "oss.internal_endpoint", "label": "OSS 内网 Endpoint", "default": "", "type": "str", "hot_reload": False, "desc": "服务端读写首选的同地域内网 Endpoint；网络类故障自动回退到 oss.endpoint，留空则直接使用外网"},
            {"key": "oss.public_endpoint", "label": "OSS 展示 Endpoint", "default": "", "type": "str", "hot_reload": False, "desc": "仅用于浏览器访问图片和下载签名 URL 的 Endpoint 或自定义域名；留空使用 oss.endpoint，不能填写内网地址"},
            {"key": "oss.bucket", "label": "OSS Bucket", "default": "", "type": "str", "hot_reload": False, "desc": "存放 PPT 和 PNG 的 Bucket 名称"},
            {"key": "oss.prefix", "label": "OSS Bucket 内目录", "default": "slide-flow_test", "type": "str", "hot_reload": False, "desc": "Bucket 内的对象目录/前缀，支持多级目录（例如 prod/slide-flow）；留空则直接写入 Bucket 根目录"},
            {"key": "oss.connect_timeout_seconds", "label": "OSS 连接超时（秒）", "default": "3", "type": "int", "hot_reload": False, "desc": "连接内网或外网 Endpoint 的超时；内网不可达时到期后自动尝试外网，建议 2–5 秒"},
            {"key": "oss.access_key_id", "label": "OSS AccessKey ID", "default": "", "type": "str", "hot_reload": False, "secret": True, "desc": "推荐使用环境变量 ALIBABA_CLOUD_ACCESS_KEY_ID，或在 ECS 上使用 ALIBABA_CLOUD_RAM_ROLE_NAME"},
            {"key": "oss.access_key_secret", "label": "OSS AccessKey Secret", "default": "", "type": "str", "hot_reload": False, "secret": True, "desc": "推荐使用环境变量 ALIBABA_CLOUD_ACCESS_KEY_SECRET；不要提交到 Git"},
            {"key": "oss.url_expire_seconds", "label": "签名 URL 有效期（秒）", "default": "900", "type": "int", "hot_reload": False, "desc": "前台图片和下载链接的有效期"},
        ],
    },
    {
        "key": "log",
        "label": "日志配置",
        "items": [
            {"key": "log.dir", "label": "日志目录", "default": "data/logs", "type": "str", "hot_reload": False, "desc": "日志文件目录"},
            {"key": "log.max_size_mb", "label": "日志滚动大小上限（MB）", "default": "50", "type": "int", "hot_reload": False, "desc": "单个日志文件滚动大小上限"},
            {"key": "log.backup_count", "label": "日志备份数量", "default": "5", "type": "int", "hot_reload": False, "desc": "保留的日志备份文件数量"},
        ],
    },
    {
        "key": "app",
        "label": "应用配置",
        "items": [
            {"key": "app.default_resource_subject", "label": "默认资源主题", "default": "", "type": "str", "hot_reload": True, "desc": "新建资源默认主题（留空表示不设置）"},
            {"key": "app.default_filter_status", "label": "状态筛选默认值", "default": "active", "type": "str", "hot_reload": True, "desc": "资源状态筛选器默认值（留空=全部；active=正常；disabled=停用）"},
            {"key": "app.default_filter_subject", "label": "主题筛选默认值", "default": "", "type": "str", "hot_reload": True, "desc": "资源主题筛选器默认值（留空=全部）"},
            {"key": "app.slow_request_threshold", "label": "慢请求阈值（秒）", "default": "1.0", "type": "float", "hot_reload": True, "desc": "超过该阈值的请求会被记录到慢请求日志"},
            {"key": "app.split_task_timeout", "label": "拆分任务超时（秒）", "default": "600", "type": "int", "hot_reload": False, "desc": "PPT 拆分任务超时时间"},
            {"key": "app.max_concurrent_splits", "label": "最大并发拆分数", "default": "2", "type": "int", "hot_reload": False, "desc": "最大并发的 PPT 拆分任务数"},
            {"key": "app.user_custom_tags", "label": "允许用户自定义标签", "default": "false", "type": "bool", "hot_reload": True, "desc": "开启后用户可自由创建标签；关闭后只能选择管理员预设标签"},
        ],
    },
    {
        "key": "image",
        "label": "图片配置",
        "items": [
            {"key": "image.hd.max_resolution", "label": "高清图最大分辨率", "default": "3840", "type": "int", "hot_reload": False, "desc": "仅保留一张 4K PNG，图片最长边像素上限；小图由 OSS 图片处理参数生成"},
            {"key": "image.hd.dpi", "label": "高清图 DPI", "default": "288", "type": "int", "hot_reload": False, "desc": "4K PNG 的 DPI 元数据"},
            {"key": "image.hd.format", "label": "高清图格式", "default": "png", "type": "str", "hot_reload": False, "desc": "兼容配置；OSS 原图固定保存为 PNG"},
            {"key": "image.hd.quality", "label": "高清图质量", "default": "90", "type": "int", "hot_reload": False, "desc": "兼容配置；PNG 原图使用无损编码"},
            {"key": "image.thumb.width", "label": "OSS 小图宽度", "default": "640", "type": "int", "hot_reload": False, "desc": "OSS 图片处理参数中的目标宽度（像素）"},
            {"key": "image.thumb.height", "label": "OSS 小图高度", "default": "360", "type": "int", "hot_reload": False, "desc": "OSS 图片处理参数中的目标高度（像素）"},
            {"key": "image.thumb.quality", "label": "OSS 小图质量", "default": "74", "type": "int", "hot_reload": False, "desc": "OSS 输出 JPEG 小图的质量（1-100）"},
        ],
    },
    {
        "key": "render",
        "label": "Windows WPS 渲染服务",
        "items": [
            {"key": "render.url", "label": "渲染服务地址", "default": "", "type": "str", "hot_reload": False, "desc": "例如 https://10.0.2.15:8766（内网 IP 证书须含 IP SAN）；HTTP 仅允许本机 SSH 隧道。留空时禁用自动转图，不回退其他引擎"},
            {"key": "render.token", "label": "渲染服务密钥", "default": "", "type": "str", "hot_reload": False, "secret": True, "desc": "与 Windows WPS_RENDER_TOKEN 一致；推荐环境变量 SLIDE_FLOW_RENDER_TOKEN"},
            {"key": "render.token_file", "label": "渲染密钥文件", "default": "", "type": "str", "hot_reload": False, "desc": "可选，权限受限的 UTF-8 密钥文件路径；优先级：环境变量 > token_file > render.token"},
            {"key": "render.ca_file", "label": "TLS CA 证书", "default": "", "type": "str", "hot_reload": False, "desc": "私有 CA 文件绝对路径；留空使用系统信任库，不允许关闭证书校验"},
            {"key": "render.connect_timeout", "label": "连接超时（秒）", "default": "5", "type": "int", "hot_reload": False, "desc": "单次连接超时"},
            {"key": "render.read_timeout", "label": "传输超时（秒）", "default": "30", "type": "int", "hot_reload": False, "desc": "单次读写空闲超时"},
            {"key": "render.total_timeout", "label": "整批总超时（秒）", "default": "1800", "type": "int", "hot_reload": False, "desc": "含排队及重试的整个导入渲染时间上限"},
            {"key": "render.retries", "label": "网络重试次数", "default": "2", "type": "int", "hot_reload": False, "desc": "仅重试可恢复网络/服务忙错误，使用幂等键避免重复执行"},
            {"key": "render.batch_size", "label": "每批页数", "default": "2", "type": "int", "hot_reload": False, "desc": "1–4 页；低配 Windows 建议 1 或 2 页，串行提交"},
            {"key": "render.dpi", "label": "渲染 DPI", "default": "288", "type": "int", "hot_reload": False, "desc": "72–300，默认 288；按 4K PNG 渲染，前台小图由 OSS 图片处理参数生成"},
        ],
    },
    {
        "key": "appearance",
        "label": "外观配置",
        "items": [
            {"key": "logo.svg.path", "label": "Logo 路径", "default": "app/static/img/logo.svg", "type": "str", "hot_reload": True, "desc": "Logo SVG 文件路径"},
        ],
    },
    {
        "key": "feishu",
        "label": "飞书 SSO",
        "items": [
            {"key": "feishu.sso_enabled", "label": "启用飞书 SSO", "default": "false", "type": "bool", "hot_reload": True, "desc": "是否启用飞书单点登录"},
            {"key": "feishu.app_id", "label": "飞书 App ID", "default": "", "type": "str", "hot_reload": True, "desc": "飞书自建应用的 App ID"},
            {"key": "feishu.app_secret", "label": "飞书 App Secret", "default": "", "type": "str", "hot_reload": True, "secret": True, "desc": "飞书自建应用的 App Secret，也可通过 FEISHU_APP_SECRET 环境变量提供"},
        ],
    },
]

# 运维脚本使用但不在管理后台展示的配置。
OPERATION_CONFIG_SCHEMA: list[dict[str, Any]] = [
    {
        "key": "system",
        "label": "系统管理配置",
        "items": [
            {"key": "startup.script", "default": "run.sh", "desc": "后台执行启动/重启时使用的脚本"},
            {"key": "system.sudo_password", "default": "", "desc": "免交互执行 systemd 操作的 sudo 密码；留空时由 sudo 自行认证"},
            {"key": "system.service_name", "default": "slide-flow", "desc": "systemd 服务名"},
        ],
    },
]

CONFIG_GROUPS: list[dict[str, str]] = [
    {"key": group["key"], "label": group["label"]} for group in CONFIG_SCHEMA
]
CONFIG_META: dict[str, dict[str, Any]] = {
    item["key"]: {**item, "group": group["key"]}
    for group in CONFIG_SCHEMA
    for item in group["items"]
}
DEFAULT_PROPERTIES: dict[str, str] = {
    item["key"]: str(item["default"])
    for group in (*CONFIG_SCHEMA, *OPERATION_CONFIG_SCHEMA)
    for item in group["items"]
}
LEGACY_CONFIG_KEYS = {"security.default_password"}


def _render_properties(values: dict[str, str]) -> str:
    lines = [
        "# =============================================",
        "# SlideFlow 配置文件",
        "# 由 app/config.py 在首次启动时自动生成",
        "# 所有相对路径均基于项目根目录解析",
        "# =============================================",
        "",
    ]
    for group in (*CONFIG_SCHEMA, *OPERATION_CONFIG_SCHEMA):
        lines.append(f"# ===== {group['label']} =====")
        for item in group["items"]:
            lines.append(f"{item['key']}={values[item['key']]}")
        lines.append("")
    return "\n".join(lines)


def _render_default_properties() -> str:
    values = dict(DEFAULT_PROPERTIES)
    # Never materialize the documented development secret in a new
    # installation. Existing files remain untouched so upgrades do not rotate
    # sessions unexpectedly; production deployments can still override it via
    # SLIDE_FLOW_SECRET or a secret manager.
    values["security.secret_key"] = secrets.token_urlsafe(48)
    return _render_properties(values)


def _validate_properties(values: dict[str, str]) -> None:
    expected = set(DEFAULT_PROPERTIES)
    actual = set(values) - LEGACY_CONFIG_KEYS
    missing = sorted(expected - actual)
    unknown = sorted(actual - expected)
    errors: list[str] = []
    if missing:
        errors.append(f"缺少配置项: {', '.join(missing)}")
    if unknown:
        errors.append(f"包含未知配置项: {', '.join(unknown)}")
    if errors:
        raise ValueError(
            "slide_flow.properties 不符合当前版本配置格式；"
            + "；".join(errors)
            + "。请修正文件，或删除后重新启动以生成新配置。"
        )


def _write_text_atomic(path: Path, content: str) -> None:
    real_path = Path(os.path.realpath(path))
    real_path.parent.mkdir(parents=True, exist_ok=True)
    old_stat = None
    try:
        old_stat = real_path.stat()
    except OSError:
        pass

    fd, temp_name = tempfile.mkstemp(
        prefix=f".{real_path.name}.", suffix=".tmp", dir=real_path.parent
    )
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_path, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(temp_path, real_path)
        os.chmod(real_path, stat.S_IRUSR | stat.S_IWUSR)
        if old_stat is not None:
            try:
                os.chown(real_path, old_stat.st_uid, old_stat.st_gid)
            except (AttributeError, PermissionError, OSError):
                pass
    finally:
        temp_path.unlink(missing_ok=True)


def ensure_properties_file(path: Path = PROPERTIES_FILE) -> bool:
    """确保配置文件存在并限制为仅当前用户可读写；新建时返回 True。"""
    real_path = Path(os.path.realpath(path))
    if real_path.exists():
        try:
            os.chmod(real_path, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass
        return False
    _write_text_atomic(path, _render_default_properties())
    return True

# 配置项 key -> Settings 属性名
_PROP_TO_ATTR: dict[str, str] = {
    "site.name": "site_name",
    "server.port": "port",
    "server.web_port": "web_port",
    "server.workers": "workers",
    "server.allowed_host": "allowed_host",
    "server.db_pool_size": "db_pool_size",
    "server.thread_pool_size": "thread_pool_size",
    "server.response_cache": "response_cache_enabled",
    "security.secret_key": "secret_key",
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
    "storage.backend": "storage_backend",
    "oss.endpoint": "oss_endpoint",
    "oss.internal_endpoint": "oss_internal_endpoint",
    "oss.public_endpoint": "oss_public_endpoint",
    "oss.bucket": "oss_bucket",
    "oss.prefix": "oss_prefix",
    "oss.connect_timeout_seconds": "oss_connect_timeout_seconds",
    "oss.access_key_id": "oss_access_key_id",
    "oss.access_key_secret": "oss_access_key_secret",
    "oss.url_expire_seconds": "oss_url_expire_seconds",
    "log.dir": "log_dir",
    "log.max_size_mb": "log_max_size_mb",
    "log.backup_count": "log_backup_count",
    "app.default_resource_subject": "default_resource_subject",
    "app.default_filter_status": "default_filter_status",
    "app.default_filter_subject": "default_filter_subject",
    "app.slow_request_threshold": "slow_request_threshold",
    "app.split_task_timeout": "split_task_timeout",
    "app.max_concurrent_splits": "max_concurrent_splits",
    "app.user_custom_tags": "user_custom_tags",
    "image.hd.max_resolution": "image_hd_max_resolution",
    "image.hd.dpi": "image_hd_dpi",
    "image.hd.format": "image_hd_format",
    "image.hd.quality": "image_hd_quality",
    "image.thumb.width": "image_thumb_width",
    "image.thumb.height": "image_thumb_height",
    "image.thumb.quality": "image_thumb_quality",
    "logo.svg.path": "logo_svg_path",
    "web.https": "web_https",
    "feishu.sso_enabled": "feishu_sso_enabled",
    "feishu.app_id": "feishu_app_id",
    "feishu.app_secret": "feishu_app_secret",
}


def _parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    raise ValueError(f"布尔配置只能填写 true 或 false，当前值为: {value!r}")


def _resolve_path(raw: str) -> Path:
    """将路径字符串解析为绝对路径。相对路径基于 ROOT_DIR。"""
    p = Path(raw)
    if p.is_absolute():
        return p
    return ROOT_DIR / p


@dataclass
class Settings:
    root_dir: Path

    render_url: str = ""
    render_token: str = field(default="", repr=False)
    render_ca_file: str = ""
    render_connect_timeout: int = 5
    render_read_timeout: int = 30
    render_total_timeout: int = 1800
    render_retries: int = 2
    render_batch_size: int = 2
    render_dpi: int = int(DEFAULT_PROPERTIES["render.dpi"])

    # 基础配置
    site_name: str = DEFAULT_PROPERTIES["site.name"]
    port: int = int(DEFAULT_PROPERTIES["server.port"])
    web_port: int = int(DEFAULT_PROPERTIES["server.web_port"])
    workers: int = int(DEFAULT_PROPERTIES["server.workers"])
    startup_script: str = DEFAULT_PROPERTIES["startup.script"]
    allowed_host: str = DEFAULT_PROPERTIES["server.allowed_host"]
    # 是否部署在 HTTPS 反向代理之后（影响 Secure Cookie 与 HSTS），缺省 false 避免纯 HTTP 部署丢失登录态
    web_https: bool = _parse_bool(DEFAULT_PROPERTIES["web.https"])

    # 并发配置
    db_pool_size: int = int(DEFAULT_PROPERTIES["server.db_pool_size"])
    thread_pool_size: int = int(DEFAULT_PROPERTIES["server.thread_pool_size"])
    response_cache_enabled: bool = _parse_bool(DEFAULT_PROPERTIES["server.response_cache"])

    # 安全配置
    secret_key: str = DEFAULT_PROPERTIES["security.secret_key"]
    session_ttl_hours: int = int(DEFAULT_PROPERTIES["security.session_ttl_hours"])
    show_token_ttl_seconds: int = int(DEFAULT_PROPERTIES["security.show_token_ttl_seconds"])

    # 数据目录
    data_dir: Path = field(default_factory=lambda: _resolve_path(DEFAULT_PROPERTIES["data.dir"]))
    db_dir: Path = field(default_factory=lambda: _resolve_path(DEFAULT_PROPERTIES["data.db_dir"]))
    assets_dir: Path = field(default_factory=lambda: _resolve_path(DEFAULT_PROPERTIES["data.assets_dir"]))
    resources_dir: Path = field(default_factory=lambda: _resolve_path(DEFAULT_PROPERTIES["data.resources_dir"]))
    templates_dir: Path = field(default_factory=lambda: _resolve_path(DEFAULT_PROPERTIES["data.templates_dir"]))
    fonts_dir: Path = field(default_factory=lambda: _resolve_path(DEFAULT_PROPERTIES["data.fonts_dir"]))
    thumbs_dir: Path = field(default_factory=lambda: _resolve_path(DEFAULT_PROPERTIES["data.thumbs_dir"]))
    downloads_dir: Path = field(default_factory=lambda: _resolve_path(DEFAULT_PROPERTIES["data.downloads_dir"]))

    # Object storage.  Only transient validation/export files use the local filesystem.
    storage_backend: str = DEFAULT_PROPERTIES["storage.backend"]
    oss_endpoint: str = DEFAULT_PROPERTIES["oss.endpoint"]
    oss_internal_endpoint: str = DEFAULT_PROPERTIES["oss.internal_endpoint"]
    oss_public_endpoint: str = DEFAULT_PROPERTIES["oss.public_endpoint"]
    oss_bucket: str = DEFAULT_PROPERTIES["oss.bucket"]
    oss_prefix: str = DEFAULT_PROPERTIES["oss.prefix"]
    oss_connect_timeout_seconds: int = int(DEFAULT_PROPERTIES["oss.connect_timeout_seconds"])
    oss_access_key_id: str = field(default=DEFAULT_PROPERTIES["oss.access_key_id"], repr=False)
    oss_access_key_secret: str = field(default=DEFAULT_PROPERTIES["oss.access_key_secret"], repr=False)
    oss_url_expire_seconds: int = int(DEFAULT_PROPERTIES["oss.url_expire_seconds"])

    # 日志配置
    log_dir: Path = field(default_factory=lambda: _resolve_path(DEFAULT_PROPERTIES["log.dir"]))
    log_max_size_mb: int = int(DEFAULT_PROPERTIES["log.max_size_mb"])
    log_backup_count: int = int(DEFAULT_PROPERTIES["log.backup_count"])

    # 应用配置
    default_resource_subject: str = DEFAULT_PROPERTIES["app.default_resource_subject"]
    default_filter_status: str = DEFAULT_PROPERTIES["app.default_filter_status"]
    default_filter_subject: str = DEFAULT_PROPERTIES["app.default_filter_subject"]
    slow_request_threshold: float = float(DEFAULT_PROPERTIES["app.slow_request_threshold"])
    split_task_timeout: int = int(DEFAULT_PROPERTIES["app.split_task_timeout"])
    max_concurrent_splits: int = int(DEFAULT_PROPERTIES["app.max_concurrent_splits"])
    user_custom_tags: bool = _parse_bool(DEFAULT_PROPERTIES["app.user_custom_tags"])

    # 图片压缩配置
    image_hd_max_resolution: int = int(DEFAULT_PROPERTIES["image.hd.max_resolution"])
    image_hd_dpi: int = int(DEFAULT_PROPERTIES["image.hd.dpi"])
    image_hd_format: str = DEFAULT_PROPERTIES["image.hd.format"]
    image_hd_quality: int = int(DEFAULT_PROPERTIES["image.hd.quality"])
    image_thumb_width: int = int(DEFAULT_PROPERTIES["image.thumb.width"])
    image_thumb_height: int = int(DEFAULT_PROPERTIES["image.thumb.height"])
    image_thumb_quality: int = int(DEFAULT_PROPERTIES["image.thumb.quality"])

    # 外观
    logo_svg_path: str = DEFAULT_PROPERTIES["logo.svg.path"]

    # 飞书 SSO
    feishu_sso_enabled: bool = _parse_bool(DEFAULT_PROPERTIES["feishu.sso_enabled"])
    feishu_app_id: str = DEFAULT_PROPERTIES["feishu.app_id"]
    feishu_app_secret: str = DEFAULT_PROPERTIES["feishu.app_secret"]

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

def _coerce_value(raw: str, value_type: str) -> Any:
    """根据 CONFIG_META 中声明的类型将原始字符串转换为实际值。"""
    if value_type == "int":
        return int(raw)
    if value_type == "float":
        return float(raw)
    if value_type == "bool":
        return _parse_bool(raw)
    return raw


CONFIG_SECRET_MASK = "********"


def read_config_view(*, mask_secrets: bool = True) -> dict[str, str]:
    """读取当前版本 properties 文件中的后台可管理配置。

    敏感配置默认只返回掩码，避免后台列表、浏览器缓存或代理日志意外暴露密钥。
    """
    props = read_properties(PROPERTIES_FILE)
    _validate_properties(props)
    result: dict[str, str] = {}
    for key in CONFIG_META:
        if mask_secrets and CONFIG_META[key].get("secret"):
            result[key] = CONFIG_SECRET_MASK
        else:
            result[key] = props[key]
    return result


def read_config_secret(key: str) -> str:
    """读取单个敏感配置的真实值，仅供受保护的显式查询接口使用。"""
    meta = CONFIG_META.get(key)
    if meta is None or not meta.get("secret"):
        raise KeyError(key)
    props = read_properties(PROPERTIES_FILE)
    _validate_properties(props)
    env_overrides = {
        "security.secret_key": "SLIDE_FLOW_SECRET",
        "feishu.app_secret": "FEISHU_APP_SECRET",
        "render.token": "SLIDE_FLOW_RENDER_TOKEN",
        "oss.access_key_id": "ALIBABA_CLOUD_ACCESS_KEY_ID",
        "oss.access_key_secret": "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
    }
    env_name = env_overrides.get(key)
    if key == "render.token" and props.get("render.token_file") and "SLIDE_FLOW_RENDER_TOKEN" not in os.environ:
        return _resolve_path(props["render.token_file"]).read_text(encoding="utf-8").strip()
    if env_name:
        # 环境变量覆盖值才是实际生效的配置。
        return os.getenv(env_name, props[key])
    return props[key]


def write_properties(updates: dict[str, str]) -> None:
    """按当前 schema 重写配置文件，写入前备份为 .bak。"""
    path = PROPERTIES_FILE
    ensure_properties_file(path)
    original = path.read_text(encoding="utf-8")
    backup = path.with_suffix(path.suffix + ".bak")
    _write_text_atomic(backup, original)
    values = read_properties(path)
    _validate_properties(values)
    unknown = sorted(set(updates) - set(DEFAULT_PROPERTIES))
    if unknown:
        raise ValueError(f"不支持的配置项: {', '.join(unknown)}")
    values.update(updates)
    _write_text_atomic(path, _render_properties(values))


def legacy_default_password_candidates() -> list[str]:
    """Return upgrade-only shared-password candidates, never used for new accounts."""
    props = read_properties(PROPERTIES_FILE)
    candidates = [
        os.getenv("SLIDE_FLOW_DEFAULT_PASSWORD", ""),
        props.get("security.default_password", ""),
        "123456",
    ]
    return list(dict.fromkeys(value for value in candidates if value))


def remove_legacy_default_password_config() -> None:
    """Remove the retired shared password from local config and its backup."""
    for path in (PROPERTIES_FILE, PROPERTIES_FILE.with_suffix(PROPERTIES_FILE.suffix + ".bak")):
        if not path.exists():
            continue
        lines = [
            line for line in path.read_text(encoding="utf-8").splitlines()
            if not line.strip().startswith("security.default_password=")
        ]
        _write_text_atomic(path, "\n".join(lines).rstrip() + "\n")


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
    props = read_properties(PROPERTIES_FILE)
    _validate_properties(props)

    def get_value(key: str) -> str:
        return props[key]

    # 基础配置
    site_name = get_value("site.name")
    port = int(get_value("server.port"))
    web_port = int(get_value("server.web_port"))
    workers = int(get_value("server.workers"))
    allowed_host = get_value("server.allowed_host")
    startup_script = get_value("startup.script")

    # 并发配置
    db_pool_size = int(get_value("server.db_pool_size"))
    thread_pool_size = int(get_value("server.thread_pool_size"))
    response_cache_enabled = _parse_bool(get_value("server.response_cache"))

    # 安全配置
    secret_key = os.getenv("SLIDE_FLOW_SECRET", get_value("security.secret_key"))
    session_ttl_hours = int(get_value("security.session_ttl_hours"))
    show_token_ttl_seconds = int(get_value("security.show_token_ttl_seconds"))

    # 数据目录
    data_dir = _resolve_path(get_value("data.dir"))
    db_dir = _resolve_path(get_value("data.db_dir"))
    assets_dir = _resolve_path(get_value("data.assets_dir"))
    resources_dir = _resolve_path(get_value("data.resources_dir"))
    templates_dir = _resolve_path(get_value("data.templates_dir"))
    fonts_dir = _resolve_path(get_value("data.fonts_dir"))
    thumbs_dir = _resolve_path(get_value("data.thumbs_dir"))
    downloads_dir = _resolve_path(get_value("data.downloads_dir"))

    # 日志配置
    log_dir = _resolve_path(get_value("log.dir"))
    log_max_size_mb = int(get_value("log.max_size_mb"))
    log_backup_count = int(get_value("log.backup_count"))

    # 应用配置
    default_resource_subject = get_value("app.default_resource_subject")
    default_filter_status = get_value("app.default_filter_status")
    default_filter_subject = get_value("app.default_filter_subject")
    slow_request_threshold = float(get_value("app.slow_request_threshold"))
    split_task_timeout = int(get_value("app.split_task_timeout"))
    max_concurrent_splits = int(get_value("app.max_concurrent_splits"))
    user_custom_tags = _parse_bool(get_value("app.user_custom_tags"))

    # 图片压缩配置
    image_hd_max_resolution = int(get_value("image.hd.max_resolution"))
    image_hd_dpi = int(get_value("image.hd.dpi"))
    image_hd_format = get_value("image.hd.format")
    image_hd_quality = int(get_value("image.hd.quality"))
    image_thumb_width = int(get_value("image.thumb.width"))
    image_thumb_height = int(get_value("image.thumb.height"))
    image_thumb_quality = int(get_value("image.thumb.quality"))

    # 外观
    logo_svg_path = get_value("logo.svg.path")

    # HTTPS 反向代理标记（缺省 false：纯 HTTP 部署时不发 Secure Cookie）
    web_https = _parse_bool(get_value("web.https"))

    # 飞书 SSO
    feishu_sso_enabled = _parse_bool(get_value("feishu.sso_enabled"))
    feishu_app_id = get_value("feishu.app_id")
    feishu_app_secret = os.getenv("FEISHU_APP_SECRET", get_value("feishu.app_secret"))

    # OSS credentials may come from the instance RAM role or environment.
    storage_backend = get_value("storage.backend")
    oss_endpoint = get_value("oss.endpoint")
    oss_internal_endpoint = get_value("oss.internal_endpoint")
    oss_public_endpoint = get_value("oss.public_endpoint")
    oss_bucket = get_value("oss.bucket")
    oss_prefix = get_value("oss.prefix")
    oss_connect_timeout_seconds = int(get_value("oss.connect_timeout_seconds"))
    oss_access_key_id = os.getenv("ALIBABA_CLOUD_ACCESS_KEY_ID", get_value("oss.access_key_id"))
    oss_access_key_secret = os.getenv("ALIBABA_CLOUD_ACCESS_KEY_SECRET", get_value("oss.access_key_secret"))
    oss_url_expire_seconds = int(get_value("oss.url_expire_seconds"))

    # 数据库路径
    db_path = db_dir / "slide_flow.db"

    render_token = get_value("render.token")
    if get_value("render.token_file") and "SLIDE_FLOW_RENDER_TOKEN" not in os.environ:
        render_token = _resolve_path(get_value("render.token_file")).read_text(encoding="utf-8").strip()
    render_token = os.getenv("SLIDE_FLOW_RENDER_TOKEN", render_token)

    s = Settings(
        root_dir=ROOT_DIR,
        render_url=os.getenv("SLIDE_FLOW_RENDER_URL", get_value("render.url")),
        render_token=render_token,
        render_ca_file=str(_resolve_path(get_value("render.ca_file"))) if get_value("render.ca_file") else "",
        render_connect_timeout=int(get_value("render.connect_timeout")),
        render_read_timeout=int(get_value("render.read_timeout")),
        render_total_timeout=int(get_value("render.total_timeout")),
        render_retries=int(get_value("render.retries")),
        render_batch_size=int(get_value("render.batch_size")),
        render_dpi=int(get_value("render.dpi")),
        site_name=site_name,
        port=port,
        web_port=web_port,
        workers=workers,
        startup_script=startup_script,
        allowed_host=allowed_host,
        db_pool_size=db_pool_size,
        thread_pool_size=thread_pool_size,
        response_cache_enabled=response_cache_enabled,
        secret_key=secret_key,
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
        storage_backend=storage_backend,
        oss_endpoint=oss_endpoint,
        oss_internal_endpoint=oss_internal_endpoint,
        oss_public_endpoint=oss_public_endpoint,
        oss_bucket=oss_bucket,
        oss_prefix=oss_prefix,
        oss_connect_timeout_seconds=oss_connect_timeout_seconds,
        oss_access_key_id=oss_access_key_id,
        oss_access_key_secret=oss_access_key_secret,
        oss_url_expire_seconds=oss_url_expire_seconds,
        log_dir=log_dir,
        log_max_size_mb=log_max_size_mb,
        log_backup_count=log_backup_count,
        default_resource_subject=default_resource_subject,
        default_filter_status=default_filter_status,
        default_filter_subject=default_filter_subject,
        slow_request_threshold=slow_request_threshold,
        split_task_timeout=split_task_timeout,
        max_concurrent_splits=max_concurrent_splits,
        user_custom_tags=user_custom_tags,
        image_hd_max_resolution=image_hd_max_resolution,
        image_hd_dpi=image_hd_dpi,
        image_hd_format=image_hd_format,
        image_hd_quality=image_hd_quality,
        image_thumb_width=image_thumb_width,
        image_thumb_height=image_thumb_height,
        image_thumb_quality=image_thumb_quality,
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
