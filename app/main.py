from __future__ import annotations

import asyncio
import base64
import copy
import io
import json
import logging
import os
import re
import random
import shutil
import sqlite3
import string
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import psutil
from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
# PPT 渲染产生的 PNG 是受信任的内部资源，分辨率可能很大，
# 这里解除 PIL 的 DecompressionBomb 限制，避免 _ensure_preview_thumb 静默失败导致离线缓存缩略图丢失。
Image.MAX_IMAGE_PIXELS = None
from pydantic import BaseModel

from app.config import (
    CONFIG_GROUPS,
    CONFIG_META,
    PROPERTIES_FILE,
    _coerce_value,
    read_config_view,
    reload_settings,
    settings,
    write_properties,
)
from app.core.fonts import (
    missing_fonts,
    normalize_font_name,
    validate_font_file,
)
from app.core.permissions import (
    ADMIN_ROLES,
    ROLE_ADMIN,
    ROLE_SUPER_ADMIN,
    ROLE_USER,
    can_manage_link,
    can_manage_resource,
    can_manage_show,
    can_view_link,
    can_view_resource,
    can_view_show,
    is_admin,
    is_super_admin,
)
from app.core.ppt import build_image_pptx, detect_ppt_fonts, merge_pptx_files, slide_count, split_pptx_to_single_pages
from app.core.security import create_present_token, create_session_token, hash_password, read_session_token, verify_password, verify_present_token
from app.core.storage import copy_into, safe_filename, save_upload, unique_child_dir
from app.db import get_db, init_db, known_font_aliases, now_iso

# ── 任务取消标志: task_id -> threading.Event ──
_task_cancel_flags: dict[int, threading.Event] = {}
_pending_task_futures: dict[int, asyncio.Future] = {}  # type: ignore[type-arg]

# ── 并发控制：最多同时执行 N 个拆分任务 ──
_split_semaphore = asyncio.Semaphore(settings.max_concurrent_splits)

# ── 拆分任务超时（秒）──
SPLIT_TASK_TIMEOUT = settings.split_task_timeout


SESSION_COOKIE = "slide_flow_session"
PPT_EXTENSIONS = {".pptx"}
OFFICE_EXTENSIONS = {".ppt", ".pptx", ".pot", ".potx", ".pps", ".ppsx"}

app = FastAPI(title=settings.site_name)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

logger = logging.getLogger(__name__)


# 注意：不要用 @app.middleware("http")（BaseHTTPMiddleware）来记录慢请求，
# 它与大体积 multipart 上传存在已知不兼容（会阻断 body 流导致
# handler 收不到请求体）。这里使用纯 ASGI 中间件只包装 send，不触碰 receive 流。
class SlowRequestLogger:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        start = time.time()
        status_holder = {"code": 0}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status_holder["code"] = message.get("status", 0)
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            duration = time.time() - start
            if duration > settings.slow_request_threshold:
                logger.warning(
                    "Slow request: %s %s took %.1fs status=%s",
                    scope.get("method"),
                    scope.get("path"),
                    duration,
                    status_holder["code"],
                )


app.add_middleware(SlowRequestLogger)

DEFAULT_RESOURCE_SUBJECT = settings.default_resource_subject
app.mount("/static", StaticFiles(directory=settings.static_dir), name="static")


class LoginPayload(BaseModel):
    username: str
    password: str


class UserPayload(BaseModel):
    name: str
    username: str
    password: str | None = None
    feishu_id: str = ""
    role: str = "user"


class MetadataPayload(BaseModel):
    name: str
    subject: str = ""
    tags: str = ""
    status: str = "active"
    visibility_scope: str
    visible_user_ids: list[int] = []
    management_scope: str
    manage_user_ids: list[int] = []
    secrecy_level: str


class CommonRemarkPayload(BaseModel):
    content_html: str
    apply_scope: str = "latest"
    version_id: int | None = None


class PersonalRemarkPayload(BaseModel):
    content_html: str
    version_id: int | None = None


class SplitUploadPayload(BaseModel):
    name_prefix: str = "拆分页"
    subject: str = ""
    tags: str = ""
    status: str = "active"
    visibility_scope: str = "private"
    visible_user_ids: list[int] = []
    management_scope: str = "private"
    manage_user_ids: list[int] = []
    secrecy_level: str = "public"


class FontDeletePayload(BaseModel):
    font_ids: list[int]


class UserDeletePayload(BaseModel):
    user_ids: list[int]


class TaskDeletePayload(BaseModel):
    task_ids: list[int]


class TemplateDeletePayload(BaseModel):
    template_ids: list[int]


class LinkDeletePayload(BaseModel):
    link_ids: list[int]


class TemplatePayload(BaseModel):
    name: str = ""
    series: str
    subject: str
    platform: str
    ratio: str
    template_type: str
    visibility_scope: str
    visible_user_ids: list[int] = []
    management_scope: str
    manage_user_ids: list[int] = []


class TemplateSeriesOrderPayload(BaseModel):
    series: str
    template_ids: list[int]


class TemplateSubjectOrderPayload(BaseModel):
    subject: str
    series: list[TemplateSeriesOrderPayload]


class TemplateOrderPayload(BaseModel):
    template_ids: list[int] = []
    subjects: list[TemplateSubjectOrderPayload] = []


class ShowCreatePayload(BaseModel):
    name: str
    subject: str = ""
    tags: str = ""
    status: str = "active"
    secrecy_level: str = "public"
    visibility_scope: str = "private"
    management_scope: str = "private"
    visible_user_ids: list[int] = []
    manage_user_ids: list[int] = []
    resource_ids: list[int] = []
    change_note: str = ""


class ShowUpdatePayload(BaseModel):
    name: str
    subject: str = ""
    tags: str = ""
    status: str = "active"
    secrecy_level: str = "public"
    visibility_scope: str = "private"
    management_scope: str = "private"
    visible_user_ids: list[int] = []
    manage_user_ids: list[int] = []


class ShowResourcesPayload(BaseModel):
    resource_ids: list[int] = []


class ShowResourceHiddenPayload(BaseModel):
    hidden: bool


class ShowDuplicatePayload(BaseModel):
    name: str


class ShowIteratePayload(BaseModel):
    change_note: str = ""
    name: str | None = None
    resource_ids: list[int] | None = None


class ShowUpgradePayload(BaseModel):
    resource_ids: list[int] = []


class ShowIterateUpgradePayload(BaseModel):
    resource_ids: list[int] = []          # 要升级的资源ID列表
    remarks: dict[str, str] = {}          # {resource_id: remark_html} 放映备注
    change_note: str = ""                 # 版本变更说明


class ShowRemarkPayload(BaseModel):
    content_html: str = ""


class LinkCreatePayload(BaseModel):
    name: str
    url: str
    memo: str = ""
    visibility_scope: str = "public"
    management_scope: str = "private"
    visible_user_ids: list[int] = []
    manage_user_ids: list[int] = []
    is_enabled: bool = True
    network_env: str = "public_net"


class LinkUpdatePayload(BaseModel):
    name: str
    url: str
    memo: str = ""
    visibility_scope: str = "public"
    management_scope: str = "private"
    visible_user_ids: list[int] = []
    manage_user_ids: list[int] = []
    is_enabled: bool = True
    network_env: str = "public_net"


class LinkSelectionPayload(BaseModel):
    link_ids: list[int] = []


class LinkOrderPayload(BaseModel):
    link_ids: list[int] = []


class UserPreferencesPayload(BaseModel):
    preferences: dict[str, str] = {}


def db_dep():
    db = get_db()
    try:
        yield db
    finally:
        db.close()


SPA_INDEX = settings.static_dir / "dist" / "index.html"


def _serve_spa() -> FileResponse:
    if not SPA_INDEX.exists():
        raise HTTPException(
            503,
            "前端尚未构建，请在 web/ 下执行 `npm install && npm run build`",
        )
    return FileResponse(SPA_INDEX)


@app.on_event("startup")
def on_startup() -> None:
    init_db()


@app.get("/", response_class=HTMLResponse)
def spa_index() -> FileResponse:
    return _serve_spa()


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def _font_aliases_from_row(row: sqlite3.Row) -> list[str]:
    """从 fonts 表行读取别名 JSON 列表，兼容早期 ' / ' 分隔格式。"""
    raw = row["aliases"] if "aliases" in row.keys() else ""
    aliases: list[str] = []
    seen: set[str] = set()
    try:
        parsed = json.loads(raw) if raw else []
    except (ValueError, TypeError):
        parsed = []
    if isinstance(parsed, list):
        for item in parsed:
            if not isinstance(item, str):
                continue
            alias = item.strip()
            key = alias.lower()
            if alias and key not in seen:
                aliases.append(alias)
                seen.add(key)
    if not aliases:
        for alias in (row["family_name"] or "").split(" / "):
            alias = alias.strip()
            key = alias.lower()
            if alias and key not in seen:
                aliases.append(alias)
                seen.add(key)
    return aliases


def _font_alias_map(font_names: list[str], db: sqlite3.Connection) -> dict[str, list[str]]:
    """为 PPT 中引用的每个字体名，查找已上传字体中匹配项的全部别名。"""
    font_rows = db.execute("SELECT family_name, aliases FROM fonts").fetchall()
    alias_groups: list[list[str]] = []
    normalized_to_group: dict[str, int] = {}
    for row in font_rows:
        aliases = _font_aliases_from_row(row)
        if not aliases:
            continue
        index = len(alias_groups)
        alias_groups.append(aliases)
        for alias in aliases:
            normalized_to_group.setdefault(normalize_font_name(alias), index)

    result: dict[str, list[str]] = {}
    for font_name in font_names:
        key = normalize_font_name(font_name)
        group_index = normalized_to_group.get(key)
        if group_index is None:
            result[font_name] = [font_name] if font_name else []
            continue
        merged: list[str] = []
        seen: set[str] = set()
        for alias in [font_name, *alias_groups[group_index]]:
            cleaned = alias.strip()
            low = cleaned.lower()
            if cleaned and low not in seen:
                merged.append(cleaned)
                seen.add(low)
        result[font_name] = merged
    return result


def _json_loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except Exception:
        return default


def _parse_id_list(raw: str | None) -> list[int]:
    if not raw:
        return []
    raw = raw.strip()
    if not raw:
        return []
    try:
        value = json.loads(raw)
        if isinstance(value, list):
            return [int(item) for item in value]
    except Exception:
        pass
    return [int(item) for item in raw.split(",") if item.strip().isdigit()]


def _validate_scope(scope: str) -> str:
    if scope not in {"public", "partial", "private"}:
        raise HTTPException(400, "权限范围不正确")
    return scope


def _validate_secrecy(level: str) -> str:
    if level not in {"public", "confidential", "secret"}:
        raise HTTPException(400, "涉密等级不正确")
    return level


def _validate_resource_status(status: str | None) -> str:
    value = (status or "active").strip()
    if value not in {"active", "disabled"}:
        raise HTTPException(400, "资源状态不正确")
    return value


def _validate_template_type(resource_type: str, template_type: str | None) -> str | None:
    if resource_type == "template":
        if template_type not in {"cover", "catalog", "content"}:
            raise HTTPException(400, "模板类型不正确")
        return template_type
    return None


def _validate_template_subject(resource_type: str, subject: str | None) -> str:
    value = (subject or "").strip()
    if resource_type != "template" and not value:
        value = DEFAULT_RESOURCE_SUBJECT
    if not value:
        raise HTTPException(400, "请填写主体")
    if any(separator in value for separator in [",", "，", ";", "；", "\n", "\r"]):
        raise HTTPException(400, "主体只能填写一个")
    if len(value) > 80:
        raise HTTPException(400, "主体不能超过 80 个字符")
    return value


def _validate_template_platform(platform: str) -> str:
    if platform not in {"wps", "microsoft"}:
        raise HTTPException(400, "模板平台不正确")
    return platform


def _validate_template_ratio(ratio: str) -> str:
    if ratio not in {"16:9", "4:3"}:
        raise HTTPException(400, "模板比例不正确")
    return ratio


def _validate_standalone_template_type(template_type: str) -> str:
    if template_type not in {"cover", "catalog", "content", "other"}:
        raise HTTPException(400, "模板类型不正确")
    return template_type


def _validate_standalone_template_subject(subject: str | None) -> str:
    value = (subject or "").strip()
    if not value:
        raise HTTPException(400, "请填写模板主体")
    if any(separator in value for separator in [",", "，", ";", "；", "\n", "\r"]):
        raise HTTPException(400, "主体只能填写一个")
    if len(value) > 80:
        raise HTTPException(400, "主体不能超过 80 个字符")
    return value


def _validate_template_series(series: str | None) -> str:
    value = (series or "").strip()
    if not value:
        raise HTTPException(400, "请填写模板系列")
    if any(separator in value for separator in [",", "，", ";", "；", "\n", "\r"]):
        raise HTTPException(400, "系列只能填写一个")
    if len(value) > 80:
        raise HTTPException(400, "系列不能超过 80 个字符")
    return value


def _template_display_name(series: str, subject: str, platform: str, ratio: str, template_type: str) -> str:
    type_labels = {"cover": "封面", "catalog": "目录", "content": "正文", "other": "其他"}
    platform_labels = {"wps": "WPS", "microsoft": "Microsoft"}
    return f"{subject}-{series}-{type_labels.get(template_type, template_type)}-{platform_labels.get(platform, platform)}-{ratio}"


def _template_office_file_name(series: str, subject: str, platform: str, ratio: str, template_type: str, suffix: str) -> str:
    return safe_filename(f"{_template_display_name(series, subject, platform, ratio, template_type)}{suffix.lower() or '.pptx'}")


def _template_preview_file_name(series: str, subject: str, platform: str, ratio: str, template_type: str) -> str:
    return safe_filename(f"{_template_display_name(series, subject, platform, ratio, template_type)}_预览.png")


def _rename_template_file(path: Path, file_name: str) -> Path:
    target = path.with_name(file_name)
    if path.resolve() == target.resolve():
        return path
    if target.exists():
        target = path.with_name(f"{target.stem}_{path.stem[-6:]}{target.suffix}")
    path.rename(target)
    return target


def _template_group_order_values(db: sqlite3.Connection, subject: str, series: str) -> tuple[int, int, int]:
    subject_row = db.execute(
        "SELECT MIN(subject_order) AS value FROM templates WHERE subject = ?",
        (subject,),
    ).fetchone()
    subject_order = int(subject_row["value"]) if subject_row and subject_row["value"] is not None else 0
    if not subject_order:
        subject_order = int(db.execute("SELECT COALESCE(MAX(subject_order), 0) + 10 AS value FROM templates").fetchone()["value"])

    series_row = db.execute(
        "SELECT MIN(series_order) AS value FROM templates WHERE subject = ? AND series = ?",
        (subject, series),
    ).fetchone()
    series_order = int(series_row["value"]) if series_row and series_row["value"] is not None else 0
    if not series_order:
        series_order = int(
            db.execute(
                "SELECT COALESCE(MAX(series_order), 0) + 10 AS value FROM templates WHERE subject = ?",
                (subject,),
            ).fetchone()["value"]
        )

    sort_order = int(
        db.execute(
            "SELECT COALESCE(MAX(sort_order), 0) + 10 AS value FROM templates WHERE subject = ? AND series = ?",
            (subject, series),
        ).fetchone()["value"]
    )
    return subject_order, series_order, sort_order


def _validate_office_upload(upload: UploadFile) -> None:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in OFFICE_EXTENSIONS:
        raise HTTPException(400, "请上传 PPT/PPTX/POT/POTX/PPS/PPSX Office 文件")


def _validate_png_upload(upload: UploadFile) -> None:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix != ".png":
        raise HTTPException(400, "请上传 PNG 文件")


def _set_scope_users(db: sqlite3.Connection, table: str, resource_id: int, user_ids: list[int]) -> None:
    db.execute(f"DELETE FROM {table} WHERE resource_id = ?", (resource_id,))
    for user_id in sorted(set(user_ids)):
        db.execute(f"INSERT OR IGNORE INTO {table} (resource_id, user_id) VALUES (?, ?)", (resource_id, user_id))


def _set_template_scope_users(db: sqlite3.Connection, table: str, template_id: int, user_ids: list[int]) -> None:
    db.execute(f"DELETE FROM {table} WHERE template_id = ?", (template_id,))
    for user_id in sorted(set(user_ids)):
        db.execute(f"INSERT OR IGNORE INTO {table} (template_id, user_id) VALUES (?, ?)", (template_id, user_id))


def _scope_user_ids(db: sqlite3.Connection, table: str, resource_id: int) -> list[int]:
    rows = db.execute(f"SELECT user_id FROM {table} WHERE resource_id = ? ORDER BY user_id", (resource_id,)).fetchall()
    return [int(row["user_id"]) for row in rows]


def _template_scope_user_ids(db: sqlite3.Connection, table: str, template_id: int) -> list[int]:
    rows = db.execute(f"SELECT user_id FROM {table} WHERE template_id = ? ORDER BY user_id", (template_id,)).fetchall()
    return [int(row["user_id"]) for row in rows]


def _current_user_from_request(request: Request, db: sqlite3.Connection) -> sqlite3.Row | None:
    user_id = read_session_token(request.cookies.get(SESSION_COOKIE), settings.secret_key)
    if not user_id:
        return None
    return db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def require_user(request: Request, db: sqlite3.Connection = Depends(db_dep)) -> sqlite3.Row:
    user = _current_user_from_request(request, db)
    if user is None:
        raise HTTPException(401, "请先登录")
    return user


def require_admin(user: sqlite3.Row = Depends(require_user)) -> sqlite3.Row:
    if not is_admin(user):
        raise HTTPException(403, "需要管理员权限")
    return user


def require_super_admin(user: sqlite3.Row = Depends(require_user)) -> sqlite3.Row:
    if not is_super_admin(user):
        raise HTTPException(403, "需要超级管理员权限")
    return user


def _generate_track_code(db: sqlite3.Connection) -> str:
    """生成唯一的6位追踪码（大小写字母+数字）"""
    chars = string.ascii_letters + string.digits
    for _ in range(100):
        code = ''.join(random.choices(chars, k=6))
        exists = db.execute("SELECT 1 FROM download_records WHERE track_code = ?", (code,)).fetchone()
        if not exists:
            return code
    raise RuntimeError("无法生成唯一追踪码")


def _record_download(db: sqlite3.Connection, user: sqlite3.Row, request: Request, show_id: int, download_type: str) -> str:
    """记录下载并返回追踪码"""
    track_code = _generate_track_code(db)
    client_ip = request.headers.get("X-Forwarded-For", "").split(",")[0].strip() or (request.client.host if request.client else "")
    db.execute(
        "INSERT INTO download_records (track_code, user_id, show_id, download_type, client_ip, downloaded_at) VALUES (?, ?, ?, ?, ?, ?)",
        (track_code, user["id"], show_id, download_type, client_ip, datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    )
    db.commit()
    return track_code


def _safe_abs(stored_path: str | None) -> Path | None:
    path = settings.abs_path(stored_path)
    if path is None:
        return None
    try:
        path.resolve().relative_to(settings.root_dir)
    except ValueError:
        # System font downloads intentionally live outside project root.
        pass
    return path


def _uploaded_font_abs(stored_path: str | None) -> Path | None:
    path = settings.abs_path(stored_path)
    if path is None:
        return None
    try:
        path.resolve().relative_to(settings.fonts_dir.resolve())
    except ValueError:
        return None
    return path


def _font_path_by_name(db: sqlite3.Connection, font_name: str) -> Path | None:
    """根据 PPT 引用的字体名，在已上传字体中按别名匹配出对应文件路径。"""
    key = normalize_font_name(font_name)
    if not key:
        return None
    rows = db.execute("SELECT file_path, aliases, family_name FROM fonts").fetchall()
    for row in rows:
        for alias in _font_aliases_from_row(row):
            if normalize_font_name(alias) == key:
                return _uploaded_font_abs(row["file_path"])
    return None


def _build_fonts_bundle(
    db: sqlite3.Connection, font_names: list[str]
) -> tuple[list[Path], list[str]]:
    """按 font_names 在字体库里查找 (已上传文件路径列表, 缺失字体名列表)，均去重保序。"""
    found: list[Path] = []
    seen_paths: set[Path] = set()
    missing: list[str] = []
    seen_missing: set[str] = set()
    for name in font_names:
        cleaned = (name or "").strip()
        if not cleaned or cleaned.startswith("+"):
            continue
        path = _font_path_by_name(db, cleaned)
        if path is not None and path.exists():
            if path not in seen_paths:
                found.append(path)
                seen_paths.add(path)
            continue
        key = cleaned.lower()
        if key not in seen_missing:
            missing.append(cleaned)
            seen_missing.add(key)
    return found, missing


def _write_fonts_into_zip(
    zf: zipfile.ZipFile, fonts: list[Path], missing: list[str]
) -> None:
    """把字体文件和缺失清单写入已打开的 ZipFile（若为空则跳过）。"""
    for font_path in fonts:
        zf.write(font_path, arcname=f"fonts/{font_path.name}")
    if missing:
        zf.writestr("missing_fonts.txt", "\n".join(missing))


def _resource_file_abs(stored_path: str | None) -> Path | None:
    path = settings.abs_path(stored_path)
    if path is None:
        return None
    try:
        path.resolve().relative_to(settings.assets_dir.resolve())
    except ValueError:
        return None
    return path


def _delete_resource_files(paths: list[Path | None], version_ids: list[int]) -> None:
    parents: set[Path] = set()
    for path in paths:
        if path is None:
            continue
        parents.add(path.parent)
        path.unlink(missing_ok=True)
    thumbs_dir = settings.thumbs_dir
    for version_id in version_ids:
        for thumb in thumbs_dir.glob(f"preview_v{version_id}_*.jpg"):
            thumb.unlink(missing_ok=True)
    resources_dir = settings.resources_dir.resolve()
    for parent in sorted(parents, key=lambda item: len(item.parts), reverse=True):
        current = parent
        while True:
            try:
                current.resolve().relative_to(resources_dir)
            except ValueError:
                break
            if current == resources_dir:
                break
            try:
                current.rmdir()
            except OSError:
                break
            current = current.parent


def _delete_template_files(paths: list[Path | None]) -> None:
    parents: set[Path] = set()
    for path in paths:
        if path is None:
            continue
        parents.add(path.parent)
        path.unlink(missing_ok=True)
    templates_dir = settings.templates_dir.resolve()
    for parent in sorted(parents, key=lambda item: len(item.parts), reverse=True):
        current = parent
        while True:
            try:
                current.resolve().relative_to(templates_dir)
            except ValueError:
                break
            if current.resolve() == templates_dir:
                break
            try:
                current.rmdir()
            except OSError:
                break
            current = current.parent


def _content_disposition(filename: str) -> str:
    quoted = quote(filename)
    return f"attachment; filename*=UTF-8''{quoted}"


def _preview_thumb_path(source_path: Path, version_id: int) -> Path:
    thumbs_dir = settings.thumbs_dir
    thumbs_dir.mkdir(parents=True, exist_ok=True)
    mtime = source_path.stat().st_mtime_ns
    return thumbs_dir / f"preview_v{version_id}_{mtime}_640x360_q74.jpg"


def _ensure_preview_thumb(source_path: Path, version_id: int) -> Path:
    target = _preview_thumb_path(source_path, version_id)
    if target.exists():
        return target
    with Image.open(source_path) as image:
        image.thumbnail((640, 360), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (640, 360), (248, 250, 252))
        if image.mode not in {"RGB", "RGBA"}:
            image = image.convert("RGBA")
        elif image.mode == "RGB":
            image = image.convert("RGBA")
        left = (640 - image.width) // 2
        top = (360 - image.height) // 2
        canvas.paste(image, (left, top), image)
        canvas.save(target, format="JPEG", quality=74, optimize=True, progressive=True)
    return target


def _resource_row(db: sqlite3.Connection, resource_id: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM resources WHERE id = ?", (resource_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "资源不存在")
    return row


def _template_row(db: sqlite3.Connection, template_id: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM templates WHERE id = ?", (template_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "模板不存在")
    return row


def _linked_template_user_ids(db: sqlite3.Connection, table: str, template_id: int) -> set[int]:
    rows = db.execute(f"SELECT user_id FROM {table} WHERE template_id = ?", (template_id,)).fetchall()
    return {int(row["user_id"]) for row in rows}


def can_view_template(db: sqlite3.Connection, template: sqlite3.Row, user: sqlite3.Row) -> bool:
    if is_super_admin(user):
        return True
    if int(template["owner_id"]) == int(user["id"]):
        return True
    scope = template["visibility_scope"]
    if scope == "public":
        return True
    if scope == "private":
        return False
    if scope == "partial":
        return int(user["id"]) in _linked_template_user_ids(db, "template_visibility", int(template["id"]))
    return False


def can_manage_template(db: sqlite3.Connection, template: sqlite3.Row, user: sqlite3.Row) -> bool:
    if is_super_admin(user):
        return True
    # 模板仅允许管理员级别（系统管理员 / 超级管理员）维护
    if not is_admin(user):
        return False
    if int(template["owner_id"]) == int(user["id"]):
        return True
    scope = template["management_scope"]
    if scope == "public":
        return True
    if scope == "private":
        return False
    if scope == "partial":
        return int(user["id"]) in _linked_template_user_ids(db, "template_management", int(template["id"]))
    return False


def _version_row(db: sqlite3.Connection, resource_id: int, version_id: int | None = None) -> sqlite3.Row:
    if version_id:
        row = db.execute(
            "SELECT * FROM resource_versions WHERE id = ? AND resource_id = ?",
            (version_id, resource_id),
        ).fetchone()
    else:
        row = db.execute(
            """
            SELECT v.* FROM resource_versions v
            JOIN resources r ON r.id = v.resource_id AND r.current_version = v.version_no
            WHERE v.resource_id = ?
            """,
            (resource_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(404, "版本不存在")
    return row


def _serialize_user(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "username": row["username"],
        "feishu_id": row["feishu_id"],
        "role": row["role"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _serialize_version(resource_id: int, version: sqlite3.Row, db: sqlite3.Connection) -> dict[str, Any]:
    font_names = _json_loads(version["font_names"], [])
    return {
        "id": version["id"],
        "version_no": version["version_no"],
        "font_names": font_names,
        "font_aliases": _font_alias_map(font_names, db),
        "missing_fonts": _json_loads(version["missing_fonts"], []),
        "common_remark_html": version["common_remark_html"],
        "change_note": version["change_note"],
        "created_by": version["created_by"],
        "created_at": version["created_at"],
        "preview_url": f"/api/resources/{resource_id}/preview-thumb?version_id={version['id']}&profile=card2"
        if version["png_path"]
        else None,
        "original_preview_url": f"/api/resources/{resource_id}/preview?version_id={version['id']}"
        if version["png_path"]
        else None,
    }


_HTML_TAG_RE = re.compile(r"<[^>]*>")


def _has_personal_remark(
    db: sqlite3.Connection, resource_id: int, user_id: int
) -> bool:
    """严格判定：去掉 HTML 标签和空白后有实际文本方为真。

    富文本编辑器清空后可能留下 `<p><br></p>` 之类的空壳，
    不能用 TRIM(content_html) 简单判定。
    """
    rows = db.execute(
        "SELECT content_html FROM personal_remarks WHERE resource_id = ? AND user_id = ?",
        (resource_id, user_id),
    ).fetchall()
    for r in rows:
        html = r["content_html"] or ""
        plain = _HTML_TAG_RE.sub("", html).replace("\xa0", " ").strip()
        if plain:
            return True
    return False


def _is_resource_pinned(db: sqlite3.Connection, resource_id: int, user_id: int) -> bool:
    return db.execute(
        "SELECT 1 FROM user_pinned_resources WHERE user_id = ? AND resource_id = ?",
        (user_id, resource_id),
    ).fetchone() is not None


def _is_show_pinned(db: sqlite3.Connection, show_id: int, user_id: int) -> bool:
    return db.execute(
        "SELECT 1 FROM user_pinned_shows WHERE user_id = ? AND show_id = ?",
        (user_id, show_id),
    ).fetchone() is not None


def _serialize_resource(db: sqlite3.Connection, row: sqlite3.Row, user: sqlite3.Row) -> dict[str, Any]:
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    updated_by_user = None
    if row["updated_by"]:
        updated_by_user = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["updated_by"],)).fetchone()
    current_version = _version_row(db, int(row["id"]))
    version_rows = db.execute(
        "SELECT * FROM resource_versions WHERE resource_id = ? ORDER BY version_no DESC, id DESC",
        (row["id"],),
    ).fetchall()
    versions = [_serialize_version(int(row["id"]), item, db) for item in version_rows]
    current = next((item for item in versions if int(item["id"]) == int(current_version["id"])), None)
    if current is None:
        current = _serialize_version(int(row["id"]), current_version, db)
    payload = _row_to_dict(row)
    payload.update(
        {
            "owner": _row_to_dict(owner) if owner else None,
            "updated_by": _row_to_dict(updated_by_user) if updated_by_user else None,
            "can_manage": can_manage_resource(db, row, user)
            and not (row["resource_type"] == "template" and not is_admin(user)),
            "visible_user_ids": _scope_user_ids(db, "resource_visibility", int(row["id"])),
            "manage_user_ids": _scope_user_ids(db, "resource_management", int(row["id"])),
            "current": current,
            "versions": versions,
            "has_personal_remark": _has_personal_remark(
                db, int(row["id"]), int(user["id"])
            ),
            "is_pinned": _is_resource_pinned(db, int(row["id"]), int(user["id"])),
        }
    )
    return payload


def _serialize_template(db: sqlite3.Connection, row: sqlite3.Row, user: sqlite3.Row) -> dict[str, Any]:
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    font_names = _json_loads(row["font_names"], []) if "font_names" in row.keys() else []
    payload = _row_to_dict(row)
    payload.pop("office_path", None)
    payload.pop("png_path", None)
    payload.update(
        {
            "owner": _row_to_dict(owner) if owner else None,
            "can_manage": can_manage_template(db, row, user),
            "visible_user_ids": _template_scope_user_ids(db, "template_visibility", int(row["id"])),
            "manage_user_ids": _template_scope_user_ids(db, "template_management", int(row["id"])),
            "preview_url": f"/api/templates/{row['id']}/preview-thumb" if row["png_path"] else None,
            "original_preview_url": f"/api/templates/{row['id']}/preview" if row["png_path"] else None,
            "download_url": f"/api/templates/{row['id']}/download",
            "font_names": font_names,
            "font_aliases": _font_alias_map(font_names, db),
            "missing_fonts": _json_loads(row["missing_fonts"], []) if "missing_fonts" in row.keys() else [],
        }
    )
    return payload


def _insert_version(
    db: sqlite3.Connection,
    *,
    resource_id: int,
    version_no: int,
    ppt_path: Path,
    png_path: Path | None,
    common_remark_html: str,
    change_note: str,
    created_by: int,
) -> sqlite3.Row:
    fonts = detect_ppt_fonts(ppt_path)
    missing = missing_fonts(fonts, known_font_aliases(db))
    ts = now_iso()
    db.execute(
        """
        INSERT INTO resource_versions (
            resource_id, version_no, ppt_path, png_path, font_names, missing_fonts,
            common_remark_html, change_note, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            resource_id,
            version_no,
            settings.store_path(ppt_path),
            settings.store_path(png_path) if png_path else None,
            json.dumps(fonts, ensure_ascii=False),
            json.dumps(missing, ensure_ascii=False),
            common_remark_html,
            change_note,
            created_by,
            ts,
        ),
    )
    return _version_row(db, resource_id)


def _validate_ppt_upload(upload: UploadFile) -> None:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in PPT_EXTENSIONS:
        raise HTTPException(400, "目前仅支持上传 PPTX 文件")


def _require_template_admin(resource: sqlite3.Row, user: sqlite3.Row) -> None:
    if resource["resource_type"] == "template" and not is_admin(user):
        raise HTTPException(403, "模板只能由管理员维护")


def _show_scope_user_ids(db: sqlite3.Connection, table: str, show_id: int) -> list[int]:
    rows = db.execute(f"SELECT user_id FROM {table} WHERE show_id = ? ORDER BY user_id", (show_id,)).fetchall()
    return [int(row["user_id"]) for row in rows]


def _set_show_scope_users(db: sqlite3.Connection, table: str, show_id: int, user_ids: list[int]) -> None:
    db.execute(f"DELETE FROM {table} WHERE show_id = ?", (show_id,))
    for uid in sorted(set(user_ids)):
        db.execute(f"INSERT OR IGNORE INTO {table} (show_id, user_id) VALUES (?, ?)", (show_id, uid))


def _show_row(db: sqlite3.Connection, show_id: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM shows WHERE id = ?", (show_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "放映不存在")
    return row


def _serialize_show_resource(db: sqlite3.Connection, resource_id: int, version_no: int, user: sqlite3.Row, is_hidden: int = 0) -> dict[str, Any] | None:
    resource = db.execute("SELECT * FROM resources WHERE id = ?", (resource_id,)).fetchone()
    if resource is None:
        return None
    if can_view_resource(db, resource, user):
        latest_version_no = int(resource["current_version"])
        version_row = db.execute(
            "SELECT id, png_path FROM resource_versions WHERE resource_id = ? AND version_no = ?",
            (resource_id, version_no),
        ).fetchone()
        version_id = version_row["id"] if version_row else None
        png_path = version_row["png_path"] if version_row else None
        return {
            "id": resource_id,
            "accessible": True,
            "name": resource["name"],
            "secrecy_level": resource["secrecy_level"],
            "version_no": version_no,
            "latest_version_no": latest_version_no,
            "preview_url": f"/api/resources/{resource_id}/preview-thumb?version_id={version_id}" if png_path else None,
            "original_preview_url": f"/api/resources/{resource_id}/preview?version_id={version_id}" if png_path else None,
            "hidden": bool(is_hidden),
        }
    else:
        owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (resource["owner_id"],)).fetchone()
        managers: list[dict[str, Any]] = []
        if owner:
            managers.append({"id": owner["id"], "name": owner["name"], "username": owner["username"]})
        manage_rows = db.execute(
            "SELECT u.id, u.name, u.username FROM resource_management rm JOIN users u ON u.id = rm.user_id WHERE rm.resource_id = ?",
            (resource_id,),
        ).fetchall()
        for mrow in manage_rows:
            mid = int(mrow["id"])
            if not any(m["id"] == mid for m in managers):
                managers.append({"id": mid, "name": mrow["name"], "username": mrow["username"]})
        return {
            "id": resource_id,
            "accessible": False,
            "name": f"资源 #{resource_id}",
            "secrecy_level": resource["secrecy_level"],
            "managers": managers,
            "hidden": bool(is_hidden),
        }


def _serialize_show(db: sqlite3.Connection, row: sqlite3.Row, user: sqlite3.Row) -> dict[str, Any]:
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    visible_user_ids = _show_scope_user_ids(db, "show_visibility", int(row["id"]))
    manage_user_ids = _show_scope_user_ids(db, "show_management", int(row["id"]))
    sr_rows = db.execute(
        "SELECT resource_id, version_no, is_hidden FROM show_resources WHERE show_id = ? ORDER BY sort_order",
        (row["id"],),
    ).fetchall()
    resources = []
    for sr in sr_rows:
        sres = _serialize_show_resource(db, int(sr["resource_id"]), int(sr["version_no"]), user, int(sr["is_hidden"]))
        if sres is not None:
            resources.append(sres)
    updated_by_user = None
    if row["updated_by"]:
        updated_by_user = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["updated_by"],)).fetchone()
    return {
        "id": row["id"],
        "name": row["name"],
        "owner_id": row["owner_id"],
        "owner": _row_to_dict(owner) if owner else None,
        "updated_by": _row_to_dict(updated_by_user) if updated_by_user else None,
        "subject": row["subject"],
        "tags": row["tags"],
        "status": row["status"],
        "visibility_scope": row["visibility_scope"],
        "management_scope": row["management_scope"],
        "secrecy_level": row["secrecy_level"],
        "series_id": row["series_id"],
        "version_no": row["version_no"],
        "change_note": row["change_note"],
        "has_other_versions": db.execute(
            "SELECT COUNT(*) FROM shows WHERE series_id = ? AND id != ?",
            (row["series_id"], row["id"]),
        ).fetchone()[0] > 0,
        "can_manage": can_manage_show(db, row, user),
        "visible_user_ids": visible_user_ids,
        "manage_user_ids": manage_user_ids,
        "resources": resources,
        "is_pinned": _is_show_pinned(db, int(row["id"]), int(user["id"])),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _link_scope_user_ids(db: sqlite3.Connection, table: str, link_id: int) -> list[int]:
    rows = db.execute(f"SELECT user_id FROM {table} WHERE link_id = ? ORDER BY user_id", (link_id,)).fetchall()
    return [int(row["user_id"]) for row in rows]


def _set_link_scope_users(db: sqlite3.Connection, table: str, link_id: int, user_ids: list[int]) -> None:
    db.execute(f"DELETE FROM {table} WHERE link_id = ?", (link_id,))
    for uid in sorted(set(user_ids)):
        db.execute(f"INSERT OR IGNORE INTO {table} (link_id, user_id) VALUES (?, ?)", (link_id, uid))


def _link_row(db: sqlite3.Connection, link_id: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM links WHERE id = ?", (link_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "链接不存在")
    return row


def _serialize_link(db: sqlite3.Connection, row: sqlite3.Row, user: sqlite3.Row) -> dict[str, Any]:
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    visible_user_ids = _link_scope_user_ids(db, "link_visibility", int(row["id"]))
    manage_user_ids = _link_scope_user_ids(db, "link_management", int(row["id"]))
    return {
        "id": row["id"],
        "name": row["name"],
        "url": row["url"],
        "memo": row["memo"],
        "owner_id": row["owner_id"],
        "owner": _row_to_dict(owner) if owner else None,
        "visibility_scope": row["visibility_scope"],
        "management_scope": row["management_scope"],
        "is_enabled": bool(row["is_enabled"]),
        "network_env": row["networkEnv"] if "networkEnv" in row.keys() else "public_net",
        "sort_order": int(row["sort_order"]) if "sort_order" in row.keys() else 0,
        "can_manage": can_manage_link(db, row, user),
        "visible_user_ids": visible_user_ids,
        "manage_user_ids": manage_user_ids,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@app.get("/api/admin/config")
def api_admin_config_get(
    _: sqlite3.Row = Depends(require_super_admin),
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


# ==================== 系统管理 API ====================

@app.get("/api/admin/system/status")
def api_admin_system_status(
    _: sqlite3.Row = Depends(require_super_admin),
) -> dict[str, Any]:
    """获取系统运行状态（仅超级管理员）。集成 manage_service.sh 服务管理。"""
    # 获取当前进程信息
    backend_pid = os.getpid()
    backend_port = settings.port
    frontend_port = settings.web_port
    
    # 尝试获取前端进程（通过端口查找）
    frontend_pid = None
    try:
        result = subprocess.run(
            ["lsof", "-ti", f"tcp:{frontend_port}"],
            capture_output=True,
            text=True,
            timeout=2
        )
        if result.returncode == 0 and result.stdout.strip():
            frontend_pid = int(result.stdout.strip().split('\n')[0])
    except Exception:
        pass
    
    # 计算运行时长
    try:
        process_start_time = psutil.Process(backend_pid).create_time()
        uptime_seconds = int(time.time() - process_start_time)
        start_time = datetime.fromtimestamp(process_start_time).isoformat()
    except Exception:
        uptime_seconds = 0
        start_time = datetime.now().isoformat()
    
    # 检查 systemd 服务状态
    service_name = "slide-flow"
    service_status = "unknown"
    service_enabled = "unknown"
    
    try:
        # 检查服务是否运行
        result = subprocess.run(
            ["systemctl", "is-active", "--quiet", service_name],
            capture_output=True,
            timeout=2
        )
        service_status = "running" if result.returncode == 0 else "stopped"
        
        # 检查是否开机自启
        result = subprocess.run(
            ["systemctl", "is-enabled", "--quiet", service_name],
            capture_output=True,
            timeout=2
        )
        service_enabled = "enabled" if result.returncode == 0 else "disabled"
    except Exception:
        # 如果没有 systemd 或权限不足，使用进程检测
        service_status = "running" if frontend_pid else "direct_mode"
    
    return {
        "uptime_seconds": uptime_seconds,
        "backend_pid": backend_pid,
        "backend_port": backend_port,
        "frontend_pid": frontend_pid,
        "frontend_port": frontend_port,
        "start_time": start_time,
        "config_file": str(PROPERTIES_FILE),
        "log_dir": str(settings.log_dir),
        "service_name": service_name,
        "service_status": service_status,
        "service_enabled": service_enabled,
        "mode": "systemd" if service_status in ["running", "stopped"] else "direct",
    }


@app.post("/api/admin/system/shutdown")
def api_admin_system_shutdown(
    _: sqlite3.Row = Depends(require_super_admin),
) -> dict[str, Any]:
    """关闭系统服务（仅超级管理员）。使用 manage_service.sh 脚本。"""
    
    def do_shutdown():
        """在后台执行关闭操作"""
        time.sleep(1)  # 给API响应一些时间返回
        try:
            manage_script = settings.root_dir / "tools" / "manage_service.sh"
            if manage_script.exists():
                # 使用 manage_service.sh 停止服务
                subprocess.run(
                    ["bash", str(manage_script), "stop"],
                    timeout=60,
                    cwd=str(settings.root_dir)
                )
            else:
                # 回退到 stop.sh
                stop_script = settings.root_dir / "stop.sh"
                subprocess.run(
                    ["bash", str(stop_script)],
                    timeout=30,
                    cwd=str(settings.root_dir)
                )
        except Exception as e:
            logger.error(f"关闭服务失败: {e}")
    
    # 在后台线程执行关闭
    threading.Thread(target=do_shutdown, daemon=True).start()
    
    return {"message": "关闭指令已发送"}


@app.post("/api/admin/system/restart")
def api_admin_system_restart(
    _: sqlite3.Row = Depends(require_super_admin),
) -> dict[str, Any]:
    """重启系统服务（仅超级管理员）。使用 manage_service.sh 脚本。"""
    
    def do_restart():
        """在后台执行重启操作"""
        time.sleep(1)  # 给API响应一些时间返回
        try:
            manage_script = settings.root_dir / "tools" / "manage_service.sh"
            if manage_script.exists():
                # 使用 manage_service.sh 重启服务
                subprocess.run(
                    ["bash", str(manage_script), "restart"],
                    timeout=60,
                    cwd=str(settings.root_dir)
                )
            else:
                # 回退到 stop.sh + start.sh
                stop_script = settings.root_dir / "stop.sh"
                start_script = settings.root_dir / "start.sh"
                
                subprocess.run(
                    ["bash", str(stop_script)],
                    timeout=30,
                    cwd=str(settings.root_dir)
                )
                time.sleep(2)
                
                subprocess.Popen(
                    ["bash", str(start_script)],
                    cwd=str(settings.root_dir),
                    start_new_session=True
                )
        except Exception as e:
            logger.error(f"重启服务失败: {e}")
    
    # 在后台线程执行重启
    threading.Thread(target=do_restart, daemon=True).start()
    
    return {"message": "重启指令已发送"}


@app.post("/api/admin/system/upgrade")
def api_admin_system_upgrade(
    _: sqlite3.Row = Depends(require_super_admin),
) -> dict[str, Any]:
    """系统升级：从 Git 拉取最新代码并重启（仅超级管理员）。使用 update.sh 脚本。"""
    
    def do_upgrade():
        """在后台执行升级操作"""
        time.sleep(2)  # 给API响应一些时间返回
        try:
            update_script = settings.root_dir / "tools" / "update.sh"
            if not update_script.exists():
                logger.error("更新脚本不存在: %s", update_script)
                return
            
            # 使用 Popen 启动 update.sh，完全独立于当前进程
            subprocess.Popen(
                ["bash", str(update_script)],
                cwd=str(settings.root_dir),
                start_new_session=True,  # 创建新的会话，完全独立
                stdout=open(str(settings.log_dir / "upgrade.log"), "w"),
                stderr=subprocess.STDOUT
            )
            logger.info("系统升级进程已启动")
        except Exception as e:
            logger.error("系统升级异常: %s", e)
    
    # 在后台线程执行升级
    threading.Thread(target=do_upgrade, daemon=True).start()
    
    return {"message": "系统升级指令已发送，请等待 1-2 分钟"}


@app.get("/api/admin/system/logs")
def api_admin_system_logs(
    _: sqlite3.Row = Depends(require_super_admin),
) -> list[dict[str, Any]]:
    """获取日志文件列表（仅超级管理员）。"""
    log_files = []
    log_dir = settings.log_dir
    
    if not log_dir.exists():
        return []
    
    for file_path in log_dir.iterdir():
        if file_path.is_file() and file_path.suffix == '.log':
            stat = file_path.stat()
            log_files.append({
                "filename": file_path.name,
                "path": str(file_path),
                "size_bytes": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            })
    
    # 按修改时间倒序排列
    log_files.sort(key=lambda x: x["modified"], reverse=True)
    
    return log_files


@app.get("/api/admin/system/logs/{filename}")
def api_admin_system_logs_download(
    filename: str,
    download: bool = False,
    _: sqlite3.Row = Depends(require_super_admin),
) -> FileResponse:
    """下载日志文件（仅超级管理员）。"""
    # 防止目录遍历攻击
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(400, "非法文件名")
    
    log_dir = settings.log_dir
    file_path = log_dir / filename
    
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "日志文件不存在")
    
    # 确保文件在日志目录内
    if not str(file_path.resolve()).startswith(str(log_dir.resolve())):
        raise HTTPException(400, "非法文件路径")
    
    if download:
        return FileResponse(
            str(file_path),
            media_type="application/octet-stream",
            filename=filename
        )
    else:
        return FileResponse(
            str(file_path),
            media_type="text/plain"
        )


class AdminConfigUpdatePayload(BaseModel):
    items: dict[str, str]


@app.put("/api/admin/config")
def api_admin_config_put(
    payload: AdminConfigUpdatePayload,
    _: sqlite3.Row = Depends(require_super_admin),
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


@app.get("/api/config")
def api_config() -> dict[str, Any]:
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


@app.post("/api/auth/login")
def login(payload: LoginPayload, response: Response, db: sqlite3.Connection = Depends(db_dep)) -> dict[str, Any]:
    user = db.execute("SELECT * FROM users WHERE username = ?", (payload.username,)).fetchone()
    if user is None or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(401, "用户名或密码错误")
    token = create_session_token(int(user["id"]), settings.secret_key, ttl_seconds=settings.session_ttl_hours * 3600)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        max_age=settings.session_ttl_hours * 3600,
    )
    return {"user": _serialize_user(user)}


@app.post("/api/auth/logout")
def logout(response: Response) -> dict[str, bool]:
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


@app.get("/api/me")
def me(user: sqlite3.Row = Depends(require_user)) -> dict[str, Any]:
    return {"user": _serialize_user(user)}


@app.get("/api/user/preferences")
def get_user_preferences(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    rows = db.execute(
        "SELECT pref_key, pref_value FROM user_preferences WHERE user_id = ?",
        (int(user["id"]),),
    ).fetchall()
    preferences: dict[str, str] = {}
    for row in rows:
        preferences[row["pref_key"]] = row["pref_value"]
    return {"preferences": preferences}


@app.put("/api/user/preferences")
def update_user_preferences(
    payload: UserPreferencesPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    user_id = int(user["id"])
    ts = now_iso()
    for key, value in payload.preferences.items():
        db.execute(
            """
            INSERT INTO user_preferences (user_id, pref_key, pref_value, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, pref_key) DO UPDATE SET
                pref_value = excluded.pref_value,
                updated_at = excluded.updated_at
            """,
            (user_id, key, value, ts),
        )
    db.commit()
    return get_user_preferences(user, db)


@app.get("/api/users/options")
def user_options(
    _: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    rows = db.execute("SELECT id, name, username, role FROM users ORDER BY role, name").fetchall()
    return {"users": [_row_to_dict(row) for row in rows]}


@app.get("/api/me/personal-remarks")
def my_personal_remark_summary(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """当前用户有非空个人备注的资源 id 汇总（前端筛选用）。"""
    rows = db.execute(
        "SELECT DISTINCT resource_id, content_html FROM personal_remarks WHERE user_id = ?",
        (int(user["id"]),),
    ).fetchall()
    ids: set[int] = set()
    for r in rows:
        html = r["content_html"] or ""
        plain = _HTML_TAG_RE.sub("", html).replace("\xa0", " ").strip()
        if plain:
            ids.add(int(r["resource_id"]))
    return {"resource_ids": sorted(ids)}


# ────────────────────────────── 首页置顶 / 概览 ──────────────────────────────


@app.post("/api/me/pins/resources/{resource_id}")
def pin_resource(
    resource_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _resource_row(db, resource_id)
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无权访问该资源")
    db.execute(
        "INSERT OR IGNORE INTO user_pinned_resources (user_id, resource_id, pinned_at) VALUES (?, ?, ?)",
        (int(user["id"]), resource_id, now_iso()),
    )
    db.commit()
    return {"ok": True, "is_pinned": True}


@app.delete("/api/me/pins/resources/{resource_id}")
def unpin_resource(
    resource_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    db.execute(
        "DELETE FROM user_pinned_resources WHERE user_id = ? AND resource_id = ?",
        (int(user["id"]), resource_id),
    )
    db.commit()
    return {"ok": True, "is_pinned": False}


@app.post("/api/me/pins/shows/{show_id}")
def pin_show(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无权访问该放映")
    db.execute(
        "INSERT OR IGNORE INTO user_pinned_shows (user_id, show_id, pinned_at) VALUES (?, ?, ?)",
        (int(user["id"]), show_id, now_iso()),
    )
    db.commit()
    return {"ok": True, "is_pinned": True}


@app.delete("/api/me/pins/shows/{show_id}")
def unpin_show(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    db.execute(
        "DELETE FROM user_pinned_shows WHERE user_id = ? AND show_id = ?",
        (int(user["id"]), show_id),
    )
    db.commit()
    return {"ok": True, "is_pinned": False}


@app.get("/api/me/pins")
def list_my_pins(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """返回当前用户置顶的资源 / 放映；不再可见的项自动过滤。"""
    res_rows = db.execute(
        """
        SELECT r.* FROM user_pinned_resources p
        JOIN resources r ON r.id = p.resource_id
        WHERE p.user_id = ?
        ORDER BY p.pinned_at DESC
        """,
        (int(user["id"]),),
    ).fetchall()
    resources: list[dict[str, Any]] = []
    for row in res_rows:
        if not can_view_resource(db, row, user):
            continue
        resources.append(_serialize_resource(db, row, user))

    show_rows = db.execute(
        """
        SELECT s.* FROM user_pinned_shows p
        JOIN shows s ON s.id = p.show_id
        WHERE p.user_id = ?
        ORDER BY p.pinned_at DESC
        """,
        (int(user["id"]),),
    ).fetchall()
    shows: list[dict[str, Any]] = []
    for row in show_rows:
        if not can_view_show(db, row, user):
            continue
        shows.append(_serialize_show(db, row, user))

    return {"resources": resources, "shows": shows}


@app.get("/api/me/home/stats")
def my_home_stats(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """首页数据概览：仅统计当前用户可见范围；超管看到全部。"""
    user_id = int(user["id"])
    super_admin = is_super_admin(user)

    def _visible_count(table: str, vis_table: str, vis_fk: str, *, where_extra: str = "") -> int:
        if super_admin:
            sql = f"SELECT COUNT(*) FROM {table} t"
            if where_extra:
                sql += f" WHERE {where_extra}"
            return int(db.execute(sql).fetchone()[0])
        sql = f"""
            SELECT COUNT(*) FROM {table} t
            WHERE (
                t.owner_id = ?
                OR t.visibility_scope = 'public'
                OR (t.visibility_scope = 'partial' AND EXISTS (
                    SELECT 1 FROM {vis_table} v WHERE v.{vis_fk} = t.id AND v.user_id = ?
                ))
            )
        """
        if where_extra:
            sql += f" AND ({where_extra})"
        return int(db.execute(sql, (user_id, user_id)).fetchone()[0])

    def _mine_count(table: str, *, where_extra: str = "") -> int:
        sql = f"SELECT COUNT(*) FROM {table} WHERE owner_id = ?"
        if where_extra:
            sql += f" AND ({where_extra})"
        return int(db.execute(sql, (user_id,)).fetchone()[0])

    resources_total = _visible_count(
        "resources", "resource_visibility", "resource_id",
        where_extra="t.resource_type = 'asset'",
    )
    resources_mine = _mine_count("resources", where_extra="resource_type = 'asset'")

    shows_total = _visible_count("shows", "show_visibility", "show_id")
    shows_mine = _mine_count("shows")

    templates_total = int(db.execute("SELECT COUNT(*) FROM templates").fetchone()[0])
    fonts_total = int(db.execute("SELECT COUNT(*) FROM fonts").fetchone()[0])

    return {
        "resources": {"total": resources_total, "mine": resources_mine},
        "shows": {"total": shows_total, "mine": shows_mine},
        "templates": {"total": templates_total},
        "fonts": {"total": fonts_total},
    }


@app.get("/api/admin/users")
def list_users(
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    rows = db.execute("SELECT * FROM users ORDER BY id").fetchall()
    return {"users": [_serialize_user(row) for row in rows]}


@app.get("/api/admin/download-records")
def list_download_records(
    track_code: str = Query(""),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    user: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
):
    """查询下载记录（管理员）"""
    base_query = """
        FROM download_records dr
        LEFT JOIN users u ON dr.user_id = u.id
        LEFT JOIN shows s ON dr.show_id = s.id
    """
    conditions = []
    params = []

    if track_code.strip():
        conditions.append("dr.track_code = ?")
        params.append(track_code.strip())

    where_clause = (" WHERE " + " AND ".join(conditions)) if conditions else ""

    # 总数
    count_row = db.execute(f"SELECT COUNT(*) as total {base_query}{where_clause}", params).fetchone()
    total = count_row["total"]

    # 分页数据
    offset = (page - 1) * page_size
    rows = db.execute(f"""
        SELECT dr.id, dr.track_code, dr.download_type, dr.client_ip, dr.downloaded_at,
               u.name as user_name, u.username as user_username,
               s.name as show_name, s.id as show_id
        {base_query}{where_clause}
        ORDER BY dr.downloaded_at DESC
        LIMIT ? OFFSET ?
    """, params + [page_size, offset]).fetchall()

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [
            {
                "id": r["id"],
                "track_code": r["track_code"],
                "user_name": r["user_name"] or "已删除用户",
                "user_username": r["user_username"] or "",
                "show_name": r["show_name"] or "已删除放映组",
                "show_id": r["show_id"],
                "download_type": r["download_type"],
                "client_ip": r["client_ip"],
                "downloaded_at": r["downloaded_at"],
            }
            for r in rows
        ],
    }


@app.post("/api/admin/users")
def create_user(
    payload: UserPayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    if payload.role not in {ROLE_SUPER_ADMIN, ROLE_ADMIN, ROLE_USER}:
        raise HTTPException(400, "角色不正确")
    if payload.role == ROLE_SUPER_ADMIN and not is_super_admin(admin):
        raise HTTPException(403, "只有超级管理员能创建超级管理员")
    if not payload.password:
        raise HTTPException(400, "新用户需要设置密码")
    ts = now_iso()
    try:
        db.execute(
            """
            INSERT INTO users (name, username, password_hash, feishu_id, role, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (payload.name, payload.username, hash_password(payload.password), payload.feishu_id, payload.role, ts, ts),
        )
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "用户名已存在") from None
    user = db.execute("SELECT * FROM users WHERE username = ?", (payload.username,)).fetchone()
    return {"user": _serialize_user(user)}


@app.put("/api/admin/users/{user_id}")
def update_user(
    user_id: int,
    payload: UserPayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    if payload.role not in {ROLE_SUPER_ADMIN, ROLE_ADMIN, ROLE_USER}:
        raise HTTPException(400, "角色不正确")
    existing = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if existing is None:
        raise HTTPException(404, "用户不存在")
    # 超级管理员的身份只能由超级管理员授予/撤销
    if not is_super_admin(admin):
        if existing["role"] == ROLE_SUPER_ADMIN:
            raise HTTPException(403, "只有超级管理员能修改超级管理员账号")
        if payload.role == ROLE_SUPER_ADMIN:
            raise HTTPException(403, "只有超级管理员能授予超级管理员角色")
    if int(existing["id"]) == int(admin["id"]) and payload.role not in ADMIN_ROLES:
        raise HTTPException(400, "不能取消自己的管理员角色")
    if (
        int(existing["id"]) == int(admin["id"])
        and existing["role"] == ROLE_SUPER_ADMIN
        and payload.role != ROLE_SUPER_ADMIN
    ):
        raise HTTPException(400, "不能取消自己的超级管理员角色")
    fields: list[Any] = [payload.name, payload.username, payload.feishu_id, payload.role, now_iso()]
    sql = "UPDATE users SET name = ?, username = ?, feishu_id = ?, role = ?, updated_at = ?"
    if payload.password:
        sql += ", password_hash = ?"
        fields.append(hash_password(payload.password))
    sql += " WHERE id = ?"
    fields.append(user_id)
    try:
        db.execute(sql, fields)
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(400, "用户名已存在") from None
    user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return {"user": _serialize_user(user)}


@app.delete("/api/admin/users/{user_id}")
def delete_user(
    user_id: int,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, bool]:
    if user_id == int(admin["id"]):
        raise HTTPException(400, "不能删除当前登录用户")
    target = db.execute("SELECT role FROM users WHERE id = ?", (user_id,)).fetchone()
    if target is not None and target["role"] == ROLE_SUPER_ADMIN and not is_super_admin(admin):
        raise HTTPException(403, "只有超级管理员能删除超级管理员账号")
    db.execute("DELETE FROM users WHERE id = ?", (user_id,))
    db.commit()
    return {"ok": True}


@app.post("/api/admin/users/bulk-delete")
def bulk_delete_users(
    payload: UserDeletePayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    user_ids = sorted({int(uid) for uid in payload.user_ids if int(uid) > 0})
    if not user_ids:
        raise HTTPException(400, "请选择要删除的用户")
    current_user_id = int(admin["id"])
    if current_user_id in user_ids:
        raise HTTPException(400, "不能删除当前登录用户")
    placeholders = ",".join("?" for _ in user_ids)
    rows = db.execute(f"SELECT id FROM users WHERE id IN ({placeholders})", user_ids).fetchall()
    if not rows:
        raise HTTPException(404, "未找到可删除的用户")
    deleted_ids = [int(row["id"]) for row in rows]
    db.execute(f"DELETE FROM users WHERE id IN ({placeholders})", user_ids)
    db.commit()
    return {"ok": True, "deleted": len(deleted_ids)}


@app.delete("/api/admin/templates/{template_id}")
def delete_template(
    template_id: int,
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _template_row(db, template_id)
    paths = [_resource_file_abs(row["office_path"]), _resource_file_abs(row["png_path"])]
    db.execute("DELETE FROM templates WHERE id = ?", (template_id,))
    db.commit()
    _delete_template_files(paths)
    return {"ok": True, "deleted": 1}


@app.post("/api/admin/templates/bulk-delete")
def bulk_delete_templates(
    payload: TemplateDeletePayload,
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    template_ids = sorted({int(tid) for tid in payload.template_ids if int(tid) > 0})
    if not template_ids:
        raise HTTPException(400, "请选择要删除的模板")
    placeholders = ",".join("?" for _ in template_ids)
    rows = db.execute(f"SELECT * FROM templates WHERE id IN ({placeholders})", template_ids).fetchall()
    if not rows:
        raise HTTPException(404, "未找到可删除的模板")
    paths: list[Path | None] = []
    for row in rows:
        paths.append(_resource_file_abs(row["office_path"]))
        paths.append(_resource_file_abs(row["png_path"]))
    db.execute(f"DELETE FROM templates WHERE id IN ({placeholders})", template_ids)
    db.commit()
    _delete_template_files(paths)
    return {"ok": True, "deleted": len(rows)}


@app.put("/api/admin/templates/order")
def reorder_templates(
    payload: TemplateOrderPayload,
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    if payload.subjects:
        template_ids: list[int] = []
        for subject in payload.subjects:
            for series in subject.series:
                template_ids.extend(int(template_id) for template_id in series.template_ids)
    else:
        template_ids = [int(template_id) for template_id in payload.template_ids]
    if not template_ids:
        raise HTTPException(400, "请选择需要排序的模板")
    if len(template_ids) != len(set(template_ids)):
        raise HTTPException(400, "排序列表存在重复模板")
    placeholders = ",".join("?" for _ in template_ids)
    rows = db.execute(f"SELECT id, subject, series FROM templates WHERE id IN ({placeholders})", template_ids).fetchall()
    existing = {int(row["id"]) for row in rows}
    missing = [template_id for template_id in template_ids if template_id not in existing]
    if missing:
        raise HTTPException(404, "部分模板不存在")
    now = now_iso()
    if payload.subjects:
        rows_by_id = {int(row["id"]): row for row in rows}
        for subject_index, subject in enumerate(payload.subjects, start=1):
            for series_index, series in enumerate(subject.series, start=1):
                for template_index, template_id in enumerate(series.template_ids, start=1):
                    row = rows_by_id[int(template_id)]
                    if row["subject"] != subject.subject or row["series"] != series.series:
                        raise HTTPException(400, "排序数据与当前模板分组不一致，请刷新后重试")
                    db.execute(
                        """
                        UPDATE templates
                        SET subject_order = ?, series_order = ?, sort_order = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (subject_index * 10, series_index * 10, template_index * 10, now, int(template_id)),
                    )
    else:
        for index, template_id in enumerate(template_ids, start=1):
            db.execute(
                "UPDATE templates SET sort_order = ?, updated_at = ? WHERE id = ?",
                (index * 10, now, template_id),
            )
    db.commit()
    return {"ok": True, "ordered": len(template_ids)}


@app.get("/api/templates")
def list_templates(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    rows = db.execute(
        """
        SELECT * FROM templates
        ORDER BY
            subject_order ASC,
            subject COLLATE NOCASE,
            series_order ASC,
            series COLLATE NOCASE,
            sort_order ASC,
            platform COLLATE NOCASE,
            CASE template_type
                WHEN 'cover' THEN 1
                WHEN 'catalog' THEN 2
                WHEN 'content' THEN 3
                ELSE 4
            END,
            ratio DESC,
            updated_at DESC,
            id DESC
        """
    ).fetchall()
    templates = [_serialize_template(db, row, user) for row in rows if can_view_template(db, row, user)]
    return {"templates": templates}


@app.post("/api/templates")
async def create_template(
    name: str = Form(""),
    series: str = Form(...),
    subject: str = Form(...),
    platform: str = Form("wps"),
    ratio: str = Form(...),
    template_type: str = Form(...),
    visibility_scope: str = Form("public"),
    visible_user_ids: str = Form(""),
    management_scope: str = Form("private"),
    manage_user_ids: str = Form(""),
    office_file: UploadFile = File(...),
    png_file: UploadFile | None = File(None),
    user: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    series = _validate_template_series(series)
    subject = _validate_standalone_template_subject(subject)
    platform = _validate_template_platform(platform)
    ratio = _validate_template_ratio(ratio)
    template_type = _validate_standalone_template_type(template_type)
    visibility_scope = _validate_scope(visibility_scope)
    management_scope = _validate_scope(management_scope)
    _validate_office_upload(office_file)
    template_dir = unique_child_dir(settings.templates_dir)
    office_path = await save_upload(office_file, template_dir, "office_")
    font_names = await asyncio.to_thread(detect_ppt_fonts, office_path)
    missing = missing_fonts(font_names, known_font_aliases(db))
    office_file_name = _template_office_file_name(series, subject, platform, ratio, template_type, Path(office_file.filename or "").suffix)
    office_path = _rename_template_file(office_path, office_file_name)
    png_path = None
    if png_file is not None and png_file.filename:
        _validate_png_upload(png_file)
        png_path = _rename_template_file(
            await save_upload(png_file, template_dir, "preview_"),
            _template_preview_file_name(series, subject, platform, ratio, template_type),
        )
    display_name = _template_display_name(series, subject, platform, ratio, template_type)
    subject_order, series_order, sort_order = _template_group_order_values(db, subject, series)
    ts = now_iso()
    db.execute(
        """
        INSERT INTO templates (
            name, series, subject, platform, ratio, template_type,
            office_file_name, office_path, png_path, font_names, missing_fonts,
            subject_order, series_order, sort_order,
            visibility_scope, management_scope, owner_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            display_name,
            series,
            subject,
            platform,
            ratio,
            template_type,
            office_file_name,
            settings.store_path(office_path),
            settings.store_path(png_path) if png_path else None,
            json.dumps(font_names, ensure_ascii=False),
            json.dumps(missing, ensure_ascii=False),
            subject_order,
            series_order,
            sort_order,
            visibility_scope,
            management_scope,
            user["id"],
            ts,
            ts,
        ),
    )
    template_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    _set_template_scope_users(db, "template_visibility", template_id, _parse_id_list(visible_user_ids))
    _set_template_scope_users(db, "template_management", template_id, _parse_id_list(manage_user_ids))
    db.commit()
    return {"template": _serialize_template(db, _template_row(db, template_id), user)}


@app.put("/api/templates/{template_id}")
async def update_template(
    template_id: int,
    name: str = Form(""),
    series: str = Form(...),
    subject: str = Form(...),
    platform: str = Form("wps"),
    ratio: str = Form(...),
    template_type: str = Form(...),
    visibility_scope: str = Form("public"),
    visible_user_ids: str = Form(""),
    management_scope: str = Form("private"),
    manage_user_ids: str = Form(""),
    office_file: UploadFile | None = File(None),
    png_file: UploadFile | None = File(None),
    user: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _template_row(db, template_id)
    series = _validate_template_series(series)
    subject = _validate_standalone_template_subject(subject)
    platform = _validate_template_platform(platform)
    ratio = _validate_template_ratio(ratio)
    template_type = _validate_standalone_template_type(template_type)
    visibility_scope = _validate_scope(visibility_scope)
    management_scope = _validate_scope(management_scope)
    template_dir: Path | None = None

    def _ensure_template_dir() -> Path:
        nonlocal template_dir
        if template_dir is None:
            template_dir = unique_child_dir(settings.templates_dir)
        return template_dir

    old_paths: list[Path | None] = []
    office_path = row["office_path"]
    current_suffix = Path(row["office_file_name"] or row["office_path"]).suffix
    office_name = _template_office_file_name(series, subject, platform, ratio, template_type, current_suffix)
    font_names = _json_loads(row["font_names"], [])
    missing = _json_loads(row["missing_fonts"], [])
    if office_file is not None and office_file.filename:
        _validate_office_upload(office_file)
        new_office = await save_upload(office_file, _ensure_template_dir(), "office_")
        font_names = detect_ppt_fonts(new_office)
        missing = missing_fonts(font_names, known_font_aliases(db))
        old_paths.append(_resource_file_abs(row["office_path"]))
        office_name = _template_office_file_name(series, subject, platform, ratio, template_type, Path(office_file.filename or "").suffix)
        office_path = settings.store_path(_rename_template_file(new_office, office_name))
    else:
        current_office = _resource_file_abs(row["office_path"])
        if current_office is not None and current_office.exists():
            office_path = settings.store_path(_rename_template_file(current_office, office_name))
    png_path = row["png_path"]
    if png_file is not None and png_file.filename:
        _validate_png_upload(png_file)
        new_png = await save_upload(png_file, _ensure_template_dir(), "preview_")
        old_paths.append(_resource_file_abs(row["png_path"]))
        png_path = settings.store_path(
            _rename_template_file(new_png, _template_preview_file_name(series, subject, platform, ratio, template_type))
        )
    else:
        current_png = _resource_file_abs(row["png_path"])
        if current_png is not None and current_png.exists():
            png_path = settings.store_path(
                _rename_template_file(current_png, _template_preview_file_name(series, subject, platform, ratio, template_type))
            )
    display_name = _template_display_name(series, subject, platform, ratio, template_type)
    if row["subject"] != subject or row["series"] != series:
        subject_order, series_order, sort_order = _template_group_order_values(db, subject, series)
    else:
        subject_order = int(row["subject_order"] or 0) if "subject_order" in row.keys() else 0
        series_order = int(row["series_order"] or 0) if "series_order" in row.keys() else 0
        sort_order = int(row["sort_order"] or 0) if "sort_order" in row.keys() else 0
        if not subject_order or not series_order or not sort_order:
            fallback_subject_order, fallback_series_order, fallback_sort_order = _template_group_order_values(db, subject, series)
            subject_order = subject_order or fallback_subject_order
            series_order = series_order or fallback_series_order
            sort_order = sort_order or fallback_sort_order
    db.execute(
        """
        UPDATE templates
        SET name = ?, series = ?, subject = ?, platform = ?, ratio = ?, template_type = ?,
            office_file_name = ?, office_path = ?, png_path = ?, font_names = ?, missing_fonts = ?,
            subject_order = ?, series_order = ?, sort_order = ?,
            visibility_scope = ?, management_scope = ?, updated_at = ?
        WHERE id = ?
        """,
        (
            display_name,
            series,
            subject,
            platform,
            ratio,
            template_type,
            office_name,
            office_path,
            png_path,
            json.dumps(font_names, ensure_ascii=False),
            json.dumps(missing, ensure_ascii=False),
            subject_order,
            series_order,
            sort_order,
            visibility_scope,
            management_scope,
            now_iso(),
            template_id,
        ),
    )
    _set_template_scope_users(db, "template_visibility", template_id, _parse_id_list(visible_user_ids))
    _set_template_scope_users(db, "template_management", template_id, _parse_id_list(manage_user_ids))
    db.commit()
    _delete_template_files(old_paths)
    return {"template": _serialize_template(db, _template_row(db, template_id), user)}


@app.get("/api/templates/{template_id}/preview")
def template_preview(
    template_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> FileResponse:
    row = _template_row(db, template_id)
    if not can_view_template(db, row, user):
        raise HTTPException(403, "无可见权限")
    path = _resource_file_abs(row["png_path"])
    if path is None or not path.exists():
        raise HTTPException(404, "预览图不存在")
    return FileResponse(path)


@app.get("/api/templates/{template_id}/preview-thumb")
def template_preview_thumb(
    template_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> FileResponse:
    row = _template_row(db, template_id)
    if not can_view_template(db, row, user):
        raise HTTPException(403, "无可见权限")
    path = _resource_file_abs(row["png_path"])
    if path is None or not path.exists():
        raise HTTPException(404, "预览图不存在")
    try:
        thumb = _ensure_preview_thumb(path, 900000000 + int(template_id))
    except Exception:
        return FileResponse(path, headers={"Cache-Control": "private, max-age=3600"})
    return FileResponse(thumb, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/templates/{template_id}/download")
def download_template(
    template_id: int,
    with_fonts: bool = Query(False),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
):
    row = _template_row(db, template_id)
    if not can_view_template(db, row, user):
        raise HTTPException(403, "无可见权限")
    path = _resource_file_abs(row["office_path"])
    if path is None or not path.exists():
        raise HTTPException(404, "模板文件不存在")
    filename = row["office_file_name"] or path.name
    if not with_fonts:
        return FileResponse(path, headers={"Content-Disposition": _content_disposition(filename)})

    font_names = _json_loads(row["font_names"], [])
    fonts, _ = _build_fonts_bundle(db, font_names)
    missing = _json_loads(row["missing_fonts"], [])
    filename_base = Path(filename).stem
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as package:
        package.write(path, arcname=filename)
        _write_fonts_into_zip(package, fonts, missing)
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(f"{filename_base}_with_fonts.zip")},
    )


@app.get("/api/resources")
def list_resources(
    resource_type: str = Query("asset"),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    if resource_type != "asset":
        raise HTTPException(400, "模板请使用 /api/templates")
    rows = db.execute(
        "SELECT * FROM resources WHERE resource_type = ? ORDER BY updated_at DESC, id DESC",
        (resource_type,),
    ).fetchall()
    resources = [_serialize_resource(db, row, user) for row in rows if can_view_resource(db, row, user)]
    return {"resources": resources}


def _parse_csv(value: str) -> list[str]:
    """将逗号分隔（中英文逗号）的字符串解析为去重去空的列表，保持出现顺序"""
    if not value:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for piece in value.replace("，", ",").split(","):
        piece = piece.strip()
        if piece and piece not in seen:
            seen.add(piece)
            out.append(piece)
    return out


def _row_tag_set(row: sqlite3.Row) -> set[str]:
    """提取资源行的标签集合（去空白）"""
    return {t for t in _parse_csv(row["tags"] or "")}


_PICK_SORT_KEYS = {
    "updated_desc",
    "updated_asc",
    "created_desc",
    "created_asc",
    "name_desc",
    "name_asc",
}


def _apply_pick_filters(
    db: sqlite3.Connection,
    rows: list[sqlite3.Row],
    user: sqlite3.Row,
    *,
    search: str,
    subject: str,
    status: str,
    secrecy: str,
    permission: str,
    remark_common: str,
    remark_personal: str,
    tag: str,            # 兼容旧参数：单标签包含
    tags: str,           # 新：逗号分隔多标签
    tags_mode: str,      # any | all
    sort: str,
) -> list[sqlite3.Row]:
    result = list(rows)

    # status
    if status and status != "all":
        result = [r for r in result if (r["status"] or "active") == status]
    # subject
    if subject and subject != "all":
        result = [r for r in result if (r["subject"] or "") == subject]
    # secrecy
    if secrecy and secrecy != "all":
        result = [r for r in result if (r["secrecy_level"] or "") == secrecy]
    # permission
    if permission == "created":
        uid = int(user["id"])
        result = [r for r in result if int(r["owner_id"]) == uid]
    elif permission == "managed":
        result = [r for r in result if can_manage_resource(db, r, user)]
    # search
    q = search.strip().lower()
    if q:
        result = [
            r for r in result
            if q in (r["name"] or "").lower() or q in (r["subject"] or "").lower()
        ]
    # tags（新参数优先；为空则回退旧 tag）
    tag_list = _parse_csv(tags)
    if not tag_list and tag.strip():
        tag_list = [tag.strip()]
    if tag_list:
        mode = (tags_mode or "any").lower()
        wanted = set(tag_list)
        if mode == "all":
            result = [r for r in result if wanted.issubset(_row_tag_set(r))]
        else:
            result = [r for r in result if wanted & _row_tag_set(r)]
    # 通用备注（基于当前版本 common_remark_html）
    if remark_common in {"has", "none"}:
        def _has_common(rid: int, cur_ver: int) -> bool:
            ver = db.execute(
                "SELECT common_remark_html FROM resource_versions WHERE resource_id = ? AND version_no = ?",
                (rid, cur_ver),
            ).fetchone()
            html = (ver["common_remark_html"] if ver else "") or ""
            plain = _HTML_TAG_RE.sub("", html).replace("\xa0", " ").strip()
            return bool(plain)
        if remark_common == "has":
            result = [r for r in result if _has_common(int(r["id"]), int(r["current_version"]))]
        else:
            result = [r for r in result if not _has_common(int(r["id"]), int(r["current_version"]))]
    # 个人备注
    if remark_personal in {"has", "none"}:
        if remark_personal == "has":
            result = [r for r in result if _has_personal_remark(db, int(r["id"]), int(user["id"]))]
        else:
            result = [r for r in result if not _has_personal_remark(db, int(r["id"]), int(user["id"]))]

    # 排序
    sort_key = sort if sort in _PICK_SORT_KEYS else "updated_desc"
    if sort_key.startswith("name"):
        result.sort(key=lambda r: (r["name"] or "").lower(), reverse=sort_key.endswith("_desc"))
    elif sort_key.startswith("created"):
        result.sort(key=lambda r: (r["created_at"] or "", int(r["id"])), reverse=sort_key.endswith("_desc"))
    else:  # updated
        result.sort(key=lambda r: (r["updated_at"] or "", int(r["id"])), reverse=sort_key.endswith("_desc"))
    return result


@app.get("/api/resources/pick")
def pick_resources(
    page: int = Query(1, ge=1),
    page_size: int = Query(30, ge=1, le=100),
    search: str = Query(""),
    tag: str = Query(""),
    tags: str = Query(""),
    tags_mode: str = Query("any"),
    subject: str = Query(""),
    status: str = Query("active"),
    secrecy: str = Query("all"),
    permission: str = Query("all"),
    remark_common: str = Query("all"),
    remark_personal: str = Query("all"),
    sort: str = Query("updated_desc"),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """轻量级资源选择接口：分页 + 多维筛选 + 排序，返回最小数据集"""
    rows = db.execute(
        "SELECT * FROM resources WHERE resource_type = 'asset'",
    ).fetchall()
    visible = [row for row in rows if can_view_resource(db, row, user)]

    # 收集可见资源的标签 / 主体（用于前端筛选下拉）
    all_tags_set: set[str] = set()
    all_subjects_set: set[str] = set()
    for row in visible:
        all_tags_set.update(_row_tag_set(row))
        if row["subject"]:
            all_subjects_set.add(row["subject"])
    all_tags = sorted(all_tags_set)
    all_subjects = sorted(all_subjects_set)

    filtered = _apply_pick_filters(
        db, visible, user,
        search=search, subject=subject, status=status, secrecy=secrecy,
        permission=permission, remark_common=remark_common,
        remark_personal=remark_personal, tag=tag, tags=tags, tags_mode=tags_mode,
        sort=sort,
    )

    total = len(filtered)
    offset = (page - 1) * page_size
    page_items = filtered[offset:offset + page_size]

    # 构造轻量结果
    items = []
    for row in page_items:
        # 获取当前版本的缩略图
        ver = db.execute(
            "SELECT id, png_path FROM resource_versions WHERE resource_id = ? AND version_no = ?",
            (row["id"], row["current_version"]),
        ).fetchone()
        preview_url = None
        if ver and ver["png_path"]:
            preview_url = f"/api/resources/{row['id']}/preview-thumb?version_id={ver['id']}"
        items.append({
            "id": int(row["id"]),
            "name": row["name"],
            "tags": row["tags"],
            "subject": row["subject"] or "",
            "updated_at": row["updated_at"],
            "created_at": row["created_at"],
            "preview_url": preview_url,
        })

    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "all_tags": all_tags,
        "all_subjects": all_subjects,
    }


@app.get("/api/resources/pick-ids")
def pick_resources_all_ids(
    search: str = Query(""),
    tag: str = Query(""),
    tags: str = Query(""),
    tags_mode: str = Query("any"),
    subject: str = Query(""),
    status: str = Query("active"),
    secrecy: str = Query("all"),
    permission: str = Query("all"),
    remark_common: str = Query("all"),
    remark_personal: str = Query("all"),
    sort: str = Query("updated_desc"),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """返回当前筛选条件下所有资源的 ID 列表（用于全部全选），与 /pick 同套筛选逻辑"""
    rows = db.execute(
        "SELECT * FROM resources WHERE resource_type = 'asset'",
    ).fetchall()
    visible = [row for row in rows if can_view_resource(db, row, user)]
    filtered = _apply_pick_filters(
        db, visible, user,
        search=search, subject=subject, status=status, secrecy=secrecy,
        permission=permission, remark_common=remark_common,
        remark_personal=remark_personal, tag=tag, tags=tags, tags_mode=tags_mode,
        sort=sort,
    )
    return {"ids": [int(r["id"]) for r in filtered]}


@app.post("/api/resources")
async def create_resource(
    name: str = Form(...),
    remark_html: str = Form(""),
    tags: str = Form(""),
    visibility_scope: str = Form("private"),
    visible_user_ids: str = Form(""),
    management_scope: str = Form("private"),
    manage_user_ids: str = Form(""),
    secrecy_level: str = Form("public"),
    status: str = Form("active"),
    resource_type: str = Form("asset"),
    template_type: str | None = Form(None),
    subject: str = Form(DEFAULT_RESOURCE_SUBJECT),
    ppt_file: UploadFile = File(...),
    png_file: UploadFile | None = File(None),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    if resource_type != "asset":
        raise HTTPException(400, "资源类型不正确")
    _validate_ppt_upload(ppt_file)
    visibility_scope = _validate_scope(visibility_scope)
    management_scope = _validate_scope(management_scope)
    secrecy_level = _validate_secrecy(secrecy_level)
    status = _validate_resource_status(status)
    template_type = None
    subject = _validate_template_subject(resource_type, subject)

    resource_dir = unique_child_dir(settings.resources_dir)
    ppt_path = await save_upload(ppt_file, resource_dir, "v1_")
    if await asyncio.to_thread(slide_count, ppt_path) > 1:
        ppt_path.unlink(missing_ok=True)
        raise HTTPException(400, "资源导入只接收单页 PPTX，多页文件请使用「拆分导入」")
    png_path = await save_upload(png_file, resource_dir, "preview_") if png_file else None
    ts = now_iso()
    db.execute(
        """
        INSERT INTO resources (
            name, owner_id, resource_type, template_type, subject, tags, status,
            visibility_scope, management_scope, secrecy_level,
            current_version, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        """,
        (
            name,
            user["id"],
            resource_type,
            template_type,
            subject,
            tags,
            status,
            visibility_scope,
            management_scope,
            secrecy_level,
            user["id"],
            ts,
            ts,
        ),
    )
    resource_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    _set_scope_users(db, "resource_visibility", resource_id, _parse_id_list(visible_user_ids))
    _set_scope_users(db, "resource_management", resource_id, _parse_id_list(manage_user_ids))
    await asyncio.to_thread(
        _insert_version,
        db,
        resource_id=resource_id,
        version_no=1,
        ppt_path=ppt_path,
        png_path=png_path,
        common_remark_html=remark_html,
        change_note="创建资源",
        created_by=int(user["id"]),
    )
    db.commit()
    row = _resource_row(db, resource_id)
    return {"resource": _serialize_resource(db, row, user)}


@app.post("/api/resources/split")
async def split_upload_to_resources(
    name_prefix: str = Form("拆分页"),
    subject: str = Form(DEFAULT_RESOURCE_SUBJECT),
    tags: str = Form(""),
    status: str = Form("active"),
    visibility_scope: str = Form("private"),
    visible_user_ids: str = Form(""),
    management_scope: str = Form("private"),
    manage_user_ids: str = Form(""),
    secrecy_level: str = Form("public"),
    ppt_file: UploadFile = File(...),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    _validate_ppt_upload(ppt_file)
    visibility_scope = _validate_scope(visibility_scope)
    management_scope = _validate_scope(management_scope)
    secrecy_level = _validate_secrecy(secrecy_level)
    status = _validate_resource_status(status)
    subject = _validate_template_subject("asset", subject)

    upload_dir = unique_child_dir(settings.resources_dir)
    source_path = await save_upload(ppt_file, upload_dir, "source_")
    split_dir = upload_dir / "split"

    def _do_split_and_insert():
        split_files = split_pptx_to_single_pages(source_path, split_dir)
        if not split_files:
            return None
        created: list[dict[str, Any]] = []
        BATCH_SIZE = 10
        for index, ppt_path in enumerate(split_files, start=1):
            ts = now_iso()
            db.execute(
                """
                INSERT INTO resources (
                    name, owner_id, resource_type, template_type, subject, tags, status,
                    visibility_scope, management_scope, secrecy_level,
                    current_version, updated_by, created_at, updated_at
                ) VALUES (?, ?, 'asset', NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                """,
                (
                    f"{name_prefix}-{index:02d}",
                    user["id"],
                    subject,
                    tags,
                    status,
                    visibility_scope,
                    management_scope,
                    secrecy_level,
                    user["id"],
                    ts,
                    ts,
                ),
            )
            resource_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
            _set_scope_users(db, "resource_visibility", resource_id, _parse_id_list(visible_user_ids))
            _set_scope_users(db, "resource_management", resource_id, _parse_id_list(manage_user_ids))
            _insert_version(
                db,
                resource_id=resource_id,
                version_no=1,
                ppt_path=ppt_path,
                png_path=None,
                common_remark_html=remark_html or "",
                change_note="拆分导入",
                created_by=int(user["id"]),
            )
            created.append(_serialize_resource(db, _resource_row(db, resource_id), user))
            if index % BATCH_SIZE == 0:
                db.commit()
        db.commit()
        return created

    async with _split_semaphore:
        created = await asyncio.to_thread(_do_split_and_insert)
    if created is None:
        raise HTTPException(400, "未能拆分 PPTX")
    return {"resources": created}


def _natural_sort_key(filename: str) -> list:
    """将文件名转换为自然排序的key，正确处理数字序列。"""
    return [int(part) if part.isdigit() else part.lower()
            for part in re.split(r'(\d+)', filename)]


@app.post("/api/resources/batch-split-import")
async def batch_split_import(
    name_prefix: str = Form(...),
    subject: str = Form(DEFAULT_RESOURCE_SUBJECT),
    secrecy_level: str = Form("public"),
    status: str = Form("active"),
    tags: str = Form(""),
    visibility_scope: str = Form("public"),
    visible_user_ids: str = Form(""),
    management_scope: str = Form("private"),
    manage_user_ids: str = Form(""),
    remark_html: str = Form(""),
    ppt_file: UploadFile = File(...),
    images: list[UploadFile] = File(...),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    _validate_ppt_upload(ppt_file)
    visibility_scope = _validate_scope(visibility_scope)
    management_scope = _validate_scope(management_scope)
    secrecy_level = _validate_secrecy(secrecy_level)
    status = _validate_resource_status(status)
    subject = _validate_template_subject("asset", subject)

    images = sorted(images, key=lambda f: _natural_sort_key(f.filename or ""))
    temp_dir = Path(tempfile.mkdtemp(prefix="batch_split_"))
    resource_ids: list[int] = []

    try:
        ppt_path = await save_upload(ppt_file, temp_dir, "source_")
        n_slides = slide_count(ppt_path)
        if n_slides == 0:
            raise HTTPException(400, "无法读取 PPT 页数")
        if len(images) != n_slides:
            raise HTTPException(
                400,
                f"PPT 共 {n_slides} 页，但提供了 {len(images)} 张图片，数量不一致",
            )

        split_dir = temp_dir / "split"
        split_files = split_pptx_to_single_pages(ppt_path, split_dir)
        if len(split_files) != n_slides:
            raise HTTPException(400, "PPT 拆分结果与页数不一致")

        # 编号至少保留 2 位（1→"01"、…、99→"99"、100→"100"），与用户图片名号规则对齐
        for index, (split_ppt, image) in enumerate(zip(split_files, images), start=1):
            resource_dir = unique_child_dir(settings.resources_dir)
            v1_path = copy_into(split_ppt, resource_dir, "v1_")
            png_path = await save_upload(image, resource_dir, "preview_")

            ts = now_iso()
            db.execute(
                """
                INSERT INTO resources (
                    name, owner_id, resource_type, template_type, subject, tags, status,
                    visibility_scope, management_scope, secrecy_level,
                    current_version, updated_by, created_at, updated_at
                ) VALUES (?, ?, 'asset', NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                """,
                (
                    f"{name_prefix}_{index:02d}",
                    user["id"],
                    subject,
                    tags,
                    status,
                    visibility_scope,
                    management_scope,
                    secrecy_level,
                    user["id"],
                    ts,
                    ts,
                ),
            )
            resource_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
            resource_ids.append(resource_id)
            _set_scope_users(db, "resource_visibility", resource_id, _parse_id_list(visible_user_ids))
            _set_scope_users(db, "resource_management", resource_id, _parse_id_list(manage_user_ids))
            _insert_version(
                db,
                resource_id=resource_id,
                version_no=1,
                ppt_path=v1_path,
                png_path=png_path,
                common_remark_html=remark_html,
                change_note="批量拆分导入",
                created_by=int(user["id"]),
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return {"total": n_slides, "created": len(resource_ids), "resource_ids": resource_ids}


@app.get("/api/resources/{resource_id}")
def get_resource(
    resource_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _resource_row(db, resource_id)
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无可见权限")
    return {"resource": _serialize_resource(db, row, user)}


@app.put("/api/resources/{resource_id}/metadata")
def update_resource_metadata(
    resource_id: int,
    payload: MetadataPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _resource_row(db, resource_id)
    if not can_manage_resource(db, row, user):
        raise HTTPException(403, "无管理权限")
    _require_template_admin(row, user)
    subject = _validate_template_subject(row["resource_type"], payload.subject)
    status = _validate_resource_status(payload.status)
    db.execute(
        """
        UPDATE resources
        SET name = ?, subject = ?, tags = ?, status = ?, visibility_scope = ?, management_scope = ?, secrecy_level = ?, updated_by = ?, updated_at = ?
        WHERE id = ?
        """,
        (
            payload.name,
            subject,
            payload.tags,
            status,
            _validate_scope(payload.visibility_scope),
            _validate_scope(payload.management_scope),
            _validate_secrecy(payload.secrecy_level),
            user["id"],
            now_iso(),
            resource_id,
        ),
    )
    _set_scope_users(db, "resource_visibility", resource_id, payload.visible_user_ids)
    _set_scope_users(db, "resource_management", resource_id, payload.manage_user_ids)
    db.commit()
    return {"resource": _serialize_resource(db, _resource_row(db, resource_id), user)}


@app.post("/api/resources/{resource_id}/versions")
async def create_resource_version(
    resource_id: int,
    mode: str = Form("iterate"),
    change_note: str = Form(""),
    common_remark_html: str = Form(""),
    inherit_personal_remarks: bool = Form(True),
    ppt_file: UploadFile | None = File(None),
    png_file: UploadFile | None = File(None),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _resource_row(db, resource_id)
    if not can_manage_resource(db, row, user):
        raise HTTPException(403, "无管理权限")
    _require_template_admin(row, user)
    mode_aliases = {"edit": "iterate", "reupload": "iterate", "image": "replace"}
    mode = mode_aliases.get(mode, mode)
    if mode not in {"iterate", "replace"}:
        raise HTTPException(400, "版本模式不正确")
    latest = _version_row(db, resource_id)
    has_ppt = bool(ppt_file is not None and ppt_file.filename)
    has_png = bool(png_file is not None and png_file.filename)
    version_dir = unique_child_dir(settings.resources_dir / str(resource_id))

    if mode == "replace":
        if not has_ppt and not has_png:
            raise HTTPException(400, "重传请至少上传 PPTX 或 PNG")
        ppt_path = settings.abs_path(latest["ppt_path"])
        assert ppt_path is not None
        png_path = settings.abs_path(latest["png_path"]) if latest["png_path"] else None
        font_names = _json_loads(latest["font_names"], [])
        missing = _json_loads(latest["missing_fonts"], [])
        old_paths: list[Path | None] = []
        if has_ppt:
            assert ppt_file is not None
            _validate_ppt_upload(ppt_file)
            new_ppt = await save_upload(ppt_file, version_dir, f"v{latest['version_no']}_replace_")
            if slide_count(new_ppt) > 1:
                new_ppt.unlink(missing_ok=True)
                raise HTTPException(400, "重传只接收单页 PPTX")
            old_paths.append(settings.abs_path(latest["ppt_path"]))
            ppt_path = new_ppt
            font_names = detect_ppt_fonts(ppt_path)
            missing = missing_fonts(font_names, known_font_aliases(db))
        if has_png:
            assert png_file is not None
            _validate_png_upload(png_file)
            old_paths.append(settings.abs_path(latest["png_path"]) if latest["png_path"] else None)
            png_path = await save_upload(png_file, version_dir, "preview_replace_")
        db.execute(
            """
            UPDATE resource_versions
            SET ppt_path = ?, png_path = ?, font_names = ?, missing_fonts = ?, change_note = ?
            WHERE id = ?
            """,
            (
                settings.store_path(ppt_path),
                settings.store_path(png_path) if png_path else None,
                json.dumps(font_names, ensure_ascii=False),
                json.dumps(missing, ensure_ascii=False),
                change_note or "重传文件",
                latest["id"],
            ),
        )
        db.execute("UPDATE resources SET updated_by = ?, updated_at = ? WHERE id = ?", (user["id"], now_iso(), resource_id))
        db.commit()
        _delete_resource_files(old_paths, [int(latest["id"])] if has_png else [])
        return {"resource": _serialize_resource(db, _resource_row(db, resource_id), user)}

    version_no = int(row["current_version"]) + 1
    if not has_ppt:
        raise HTTPException(400, "迭代模式请上传新版 PPTX")
    assert ppt_file is not None
    _validate_ppt_upload(ppt_file)
    ppt_path = await save_upload(ppt_file, version_dir, f"v{version_no}_")
    if slide_count(ppt_path) > 1:
        ppt_path.unlink(missing_ok=True)
        raise HTTPException(400, "版本迭代只接收单页 PPTX")

    if has_png:
        assert png_file is not None
        _validate_png_upload(png_file)
        png_path = await save_upload(png_file, version_dir, "preview_")
    elif latest["png_path"]:
        previous_png = settings.abs_path(latest["png_path"])
        png_path = copy_into(previous_png, version_dir, "preview_") if previous_png else None
    else:
        png_path = None

    new_ver = _insert_version(
        db,
        resource_id=resource_id,
        version_no=version_no,
        ppt_path=ppt_path,
        png_path=png_path,
        common_remark_html=common_remark_html or "",
        change_note=change_note or "迭代",
        created_by=int(user["id"]),
    )
    # 按选项继承上一版本的个人备注
    if inherit_personal_remarks:
        old_version_id = latest["id"]
        new_version_id = new_ver["id"]
        db.execute(
            """
            INSERT INTO personal_remarks (resource_id, version_id, user_id, content_html, updated_at)
            SELECT resource_id, ?, user_id, content_html, ?
            FROM personal_remarks
            WHERE resource_id = ? AND version_id = ?
            """,
            (new_version_id, now_iso(), resource_id, old_version_id),
        )
    db.execute("UPDATE resources SET current_version = ?, updated_by = ?, updated_at = ? WHERE id = ?", (version_no, user["id"], now_iso(), resource_id))
    db.commit()
    return {"resource": _serialize_resource(db, _resource_row(db, resource_id), user)}


@app.post("/api/resources/{resource_id}/versions/rollback")
def rollback_resource_version(
    resource_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """删除当前最新版本，回退到上一版本；仅剩 1 个版本时拒绝。"""
    row = _resource_row(db, resource_id)
    if not can_manage_resource(db, row, user):
        raise HTTPException(403, "无管理权限")
    _require_template_admin(row, user)
    versions = db.execute(
        "SELECT id, version_no, ppt_path, png_path FROM resource_versions "
        "WHERE resource_id = ? ORDER BY version_no DESC",
        (resource_id,),
    ).fetchall()
    if len(versions) <= 1:
        raise HTTPException(400, "仅剩 1 个版本，无法继续回退；如需清空请使用删除资源")
    latest = versions[0]
    prev_version_no = int(versions[1]["version_no"])
    latest_version_id = int(latest["id"])
    db.execute("DELETE FROM resource_versions WHERE id = ?", (latest_version_id,))
    db.execute(
        "UPDATE resources SET current_version = ?, updated_at = ? WHERE id = ?",
        (prev_version_no, now_iso(), resource_id),
    )
    db.commit()
    _delete_resource_files(
        [_resource_file_abs(latest["ppt_path"]), _resource_file_abs(latest["png_path"])],
        [latest_version_id],
    )
    return {"resource": _serialize_resource(db, _resource_row(db, resource_id), user)}


@app.put("/api/resources/batch")
def batch_update_resources(
    body: dict = Body(...),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict:
    """批量编辑资源元数据。"""
    resource_ids = body.get("resource_ids", [])
    fields = body.get("fields", {})
    if not resource_ids:
        raise HTTPException(400, "resource_ids 不能为空")
    if not fields:
        raise HTTPException(400, "fields 不能为空")

    # 允许更新的字段白名单
    allowed_scalar = {
        "tags": None,
        "subject": None,
        "secrecy_level": _validate_secrecy,
        "status": _validate_resource_status,
        "visibility_scope": _validate_scope,
        "management_scope": _validate_scope,
    }
    allowed_relational = {"visible_user_ids", "manage_user_ids"}

    invalid = set(fields.keys()) - set(allowed_scalar.keys()) - allowed_relational
    if invalid:
        raise HTTPException(400, f"不支持的字段: {', '.join(sorted(invalid))}")

    # 预先检查权限并收集资源行
    rows: dict[int, sqlite3.Row] = {}
    for rid in resource_ids:
        row = _resource_row(db, rid)
        if not can_manage_resource(db, row, user):
            raise HTTPException(403, f"资源 {rid} 无管理权限")
        _require_template_admin(row, user)
        rows[rid] = row

    updated = 0
    for rid, row in rows.items():
        set_clauses: list[str] = []
        set_values: list[Any] = []
        for key, validator in allowed_scalar.items():
            if key in fields:
                value = fields[key]
                if key == "subject":
                    value = _validate_template_subject(row["resource_type"], value)
                elif validator is not None:
                    value = validator(value)
                set_clauses.append(f"{key} = ?")
                set_values.append(value)

        if set_clauses:
            set_clauses.append("updated_at = ?")
            set_values.append(now_iso())
            set_values.append(rid)
            db.execute(
                f"UPDATE resources SET {', '.join(set_clauses)} WHERE id = ?",
                tuple(set_values),
            )

        # 处理关联表字段
        if "visible_user_ids" in fields:
            _set_scope_users(db, "resource_visibility", rid, fields["visible_user_ids"])
        if "manage_user_ids" in fields:
            _set_scope_users(db, "resource_management", rid, fields["manage_user_ids"])

        updated += 1

    db.commit()
    return {"updated": updated}


@app.delete("/api/resources/batch")
def batch_delete_resources(
    body: dict = Body(...),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict:
    """批量删除资源及其全部版本（含物理文件与缩略图）。"""
    resource_ids = body.get("resource_ids", [])
    if not resource_ids:
        raise HTTPException(400, "resource_ids 不能为空")

    deleted = 0
    all_paths: list[Path | None] = []
    all_version_ids: list[int] = []

    for rid in resource_ids:
        row = _resource_row(db, rid)
        if not can_manage_resource(db, row, user):
            raise HTTPException(403, f"资源 {rid} 无管理权限")
        _require_template_admin(row, user)

        versions = db.execute(
            "SELECT id, ppt_path, png_path FROM resource_versions WHERE resource_id = ?",
            (rid,),
        ).fetchall()
        for v in versions:
            all_paths.append(_resource_file_abs(v["ppt_path"]))
            all_paths.append(_resource_file_abs(v["png_path"]))
            all_version_ids.append(int(v["id"]))

        # ON DELETE CASCADE 会自动清理 resource_versions / resource_visibility /
        # resource_management / personal_remarks 四张关联表
        db.execute("DELETE FROM resources WHERE id = ?", (rid,))
        deleted += 1

    db.commit()
    _delete_resource_files(all_paths, all_version_ids)
    return {"deleted": deleted}


@app.delete("/api/resources/{resource_id}")
def delete_resource(
    resource_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """删除资源及其全部版本（含物理文件与缩略图）。"""
    row = _resource_row(db, resource_id)
    if not can_manage_resource(db, row, user):
        raise HTTPException(403, "无管理权限")
    _require_template_admin(row, user)
    versions = db.execute(
        "SELECT id, ppt_path, png_path FROM resource_versions WHERE resource_id = ?",
        (resource_id,),
    ).fetchall()
    paths: list[Path | None] = []
    version_ids: list[int] = []
    for v in versions:
        paths.append(_resource_file_abs(v["ppt_path"]))
        paths.append(_resource_file_abs(v["png_path"]))
        version_ids.append(int(v["id"]))
    # ON DELETE CASCADE 会自动清理 resource_versions / resource_visibility /
    # resource_management / personal_remarks 四张关联表
    db.execute("DELETE FROM resources WHERE id = ?", (resource_id,))
    db.commit()
    _delete_resource_files(paths, version_ids)
    return {"ok": True, "deleted": 1}


@app.post("/api/resources/{resource_id}/common-remark")
def update_common_remark(
    resource_id: int,
    payload: CommonRemarkPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _resource_row(db, resource_id)
    if not can_manage_resource(db, row, user):
        raise HTTPException(403, "无管理权限")
    if payload.apply_scope not in {"latest", "all", "selected"}:
        raise HTTPException(400, "应用范围不正确")
    if payload.apply_scope == "all":
        db.execute(
            "UPDATE resource_versions SET common_remark_html = ? WHERE resource_id = ?",
            (payload.content_html, resource_id),
        )
    elif payload.apply_scope == "selected":
        if payload.version_id is None:
            raise HTTPException(400, "请选择版本")
        version = _version_row(db, resource_id, payload.version_id)
        db.execute(
            "UPDATE resource_versions SET common_remark_html = ? WHERE id = ?",
            (payload.content_html, version["id"]),
        )
    else:
        latest = _version_row(db, resource_id)
        db.execute(
            "UPDATE resource_versions SET common_remark_html = ? WHERE id = ?",
            (payload.content_html, latest["id"]),
        )
    db.execute("UPDATE resources SET updated_at = ? WHERE id = ?", (now_iso(), resource_id))
    db.commit()
    return {"resource": _serialize_resource(db, row, user)}


@app.get("/api/resources/{resource_id}/personal-remark")
def get_personal_remark(
    resource_id: int,
    version_id: int | None = Query(None),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _resource_row(db, resource_id)
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无可见权限")
    version = _version_row(db, resource_id, version_id)
    remark = db.execute(
        """
        SELECT * FROM personal_remarks
        WHERE resource_id = ? AND version_id = ? AND user_id = ?
        """,
        (resource_id, version["id"], user["id"]),
    ).fetchone()
    return {
        "content_html": remark["content_html"] if remark else "",
        "version_id": version["id"],
    }


@app.put("/api/resources/{resource_id}/personal-remark")
def update_personal_remark(
    resource_id: int,
    payload: PersonalRemarkPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, bool]:
    row = _resource_row(db, resource_id)
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无可见权限")
    version = _version_row(db, resource_id, payload.version_id)
    db.execute(
        """
        INSERT INTO personal_remarks (resource_id, version_id, user_id, content_html, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(resource_id, version_id, user_id)
        DO UPDATE SET content_html = excluded.content_html, updated_at = excluded.updated_at
        """,
        (resource_id, version["id"], user["id"], payload.content_html, now_iso()),
    )
    db.commit()
    return {"ok": True}


@app.get("/api/resources/{resource_id}/preview")
def resource_preview(
    resource_id: int,
    version_id: int | None = Query(None),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> FileResponse:
    row = _resource_row(db, resource_id)
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无可见权限")
    version = _version_row(db, resource_id, version_id)
    path = _safe_abs(version["png_path"])
    if path is None or not path.exists():
        raise HTTPException(404, "预览图不存在")
    return FileResponse(path)


@app.get("/api/resources/{resource_id}/preview-thumb")
def resource_preview_thumb(
    resource_id: int,
    version_id: int | None = Query(None),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> FileResponse:
    row = _resource_row(db, resource_id)
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无可见权限")
    version = _version_row(db, resource_id, version_id)
    path = _safe_abs(version["png_path"])
    if path is None or not path.exists():
        raise HTTPException(404, "预览图不存在")
    try:
        thumb = _ensure_preview_thumb(path, int(version["id"]))
    except Exception:
        return FileResponse(path, headers={"Cache-Control": "private, max-age=3600"})
    return FileResponse(thumb, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/resources/{resource_id}/download")
def download_resource(
    resource_id: int,
    with_fonts: bool = Query(False),
    version_id: int | None = Query(None),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
):
    row = _resource_row(db, resource_id)
    if row["resource_type"] == "asset":
        if not can_manage_resource(db, row, user):
            raise HTTPException(403, "无管理权限，不能下载素材")
    elif not can_view_resource(db, row, user):
        raise HTTPException(403, "无可见权限")
    version = _version_row(db, resource_id, version_id)
    ppt_path = _safe_abs(version["ppt_path"])
    if ppt_path is None or not ppt_path.exists():
        raise HTTPException(404, "PPT 文件不存在")
    filename_base = f"{row['name']}_v{version['version_no']}"
    if not with_fonts:
        return FileResponse(
            ppt_path,
            media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            headers={"Content-Disposition": _content_disposition(f"{filename_base}.pptx")},
        )

    font_names = _json_loads(version["font_names"], [])
    fonts, _ = _build_fonts_bundle(db, font_names)
    missing = _json_loads(version["missing_fonts"], [])
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as package:
        package.write(ppt_path, arcname=ppt_path.name)
        _write_fonts_into_zip(package, fonts, missing)
    content = buffer.getvalue()
    return Response(
        content=content,
        media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(f"{filename_base}_with_fonts.zip")},
    )


@app.get("/api/fonts")
def list_fonts(
    _: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    rows = db.execute("SELECT * FROM fonts ORDER BY created_at DESC, id DESC").fetchall()
    items: list[dict[str, Any]] = []
    for row in rows:
        aliases = _font_aliases_from_row(row)
        family = row["family_name"] or (aliases[0] if aliases else row["file_name"])
        items.append(
            {
                "id": row["id"],
                "family": family,
                "aliases": aliases,
                "file_name": row["file_name"],
                "download_url": f"/api/fonts/{row['id']}/download",
                "created_at": row["created_at"],
            }
        )
    return {"fonts": items}


@app.post("/api/fonts/upload")
async def upload_font(
    font_file: UploadFile = File(...),
    user: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    target_dir = settings.fonts_dir
    path = await save_upload(font_file, target_dir, "font_")
    valid, names = validate_font_file(path)
    if not valid:
        path.unlink(missing_ok=True)
        raise HTTPException(400, "只能上传可解析的字体文件（TTF/OTF/TTC/OTC）")
    aliases = sorted({name.strip() for name in names if name and name.strip()}, key=str.lower)
    display = aliases[0] if aliases else Path(font_file.filename or path.name).stem
    ts = now_iso()
    db.execute(
        """
        INSERT INTO fonts (family_name, aliases, file_name, file_path, uploaded_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            display,
            json.dumps(aliases, ensure_ascii=False),
            font_file.filename or path.name,
            settings.store_path(path),
            user["id"],
            ts,
        ),
    )
    db.commit()
    return {"ok": True, "family": display, "aliases": aliases}


@app.delete("/api/admin/fonts/{font_id}")
def delete_font(
    font_id: int,
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = db.execute("SELECT * FROM fonts WHERE id = ?", (font_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "字体不存在")
    path = _uploaded_font_abs(row["file_path"])
    db.execute("DELETE FROM fonts WHERE id = ?", (font_id,))
    db.commit()
    if path is not None:
        path.unlink(missing_ok=True)
    return {"ok": True, "deleted": 1}


@app.post("/api/admin/fonts/bulk-delete")
def bulk_delete_fonts(
    payload: FontDeletePayload,
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    font_ids = sorted({int(font_id) for font_id in payload.font_ids if int(font_id) > 0})
    if not font_ids:
        raise HTTPException(400, "请选择要删除的字体")
    placeholders = ",".join("?" for _ in font_ids)
    rows = db.execute(f"SELECT * FROM fonts WHERE id IN ({placeholders})", font_ids).fetchall()
    if not rows:
        raise HTTPException(404, "未找到可删除的字体")
    paths = [_uploaded_font_abs(row["file_path"]) for row in rows]
    db.execute(f"DELETE FROM fonts WHERE id IN ({placeholders})", font_ids)
    db.commit()
    for path in paths:
        if path is not None:
            path.unlink(missing_ok=True)
    return {"ok": True, "deleted": len(rows)}


@app.get("/api/fonts/{font_id}/download")
def download_uploaded_font(
    font_id: int,
    _: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> FileResponse:
    row = db.execute("SELECT * FROM fonts WHERE id = ?", (font_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "字体不存在")
    path = _uploaded_font_abs(row["file_path"])
    if path is None or not path.exists():
        raise HTTPException(404, "字体文件不存在")
    return FileResponse(path, headers={"Content-Disposition": _content_disposition(row["file_name"])})


@app.get("/api/shows")
def list_shows(
    series_id: str | None = None,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    rows = db.execute("SELECT * FROM shows ORDER BY updated_at DESC, id DESC").fetchall()
    visible = [row for row in rows if can_view_show(db, row, user)]
    if series_id is not None:
        shows = [_serialize_show(db, row, user) for row in visible if row["series_id"] == series_id]
    else:
        # 每个series只保留version_no最大的版本
        best: dict[str, sqlite3.Row] = {}
        for row in visible:
            sid = row["series_id"]
            if sid not in best or (row["version_no"] is not None and (best[sid]["version_no"] is None or row["version_no"] > best[sid]["version_no"])):
                best[sid] = row
        shows = [_serialize_show(db, row, user) for row in best.values()]
    return {"shows": shows}


@app.post("/api/shows")
def create_show(
    payload: ShowCreatePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    visibility_scope = _validate_scope(payload.visibility_scope)
    management_scope = _validate_scope(payload.management_scope)
    secrecy_level = _validate_secrecy(payload.secrecy_level)
    status = _validate_resource_status(payload.status)
    for rid in payload.resource_ids:
        _resource_row(db, rid)
    ts = now_iso()
    series_id = uuid.uuid4().hex[:10]
    db.execute(
        """
        INSERT INTO shows (name, owner_id, subject, tags, status, visibility_scope, management_scope, secrecy_level, series_id, version_no, change_note, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (payload.name, user["id"], payload.subject, payload.tags, status, visibility_scope, management_scope, secrecy_level, series_id, 1, payload.change_note, user["id"], ts, ts),
    )
    show_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    _set_show_scope_users(db, "show_visibility", show_id, payload.visible_user_ids)
    _set_show_scope_users(db, "show_management", show_id, payload.manage_user_ids)
    for index, rid in enumerate(payload.resource_ids):
        res_row = db.execute("SELECT current_version FROM resources WHERE id = ?", (rid,)).fetchone()
        version_no = int(res_row["current_version"]) if res_row else 1
        db.execute(
            "INSERT OR IGNORE INTO show_resources (show_id, resource_id, version_no, sort_order) VALUES (?, ?, ?, ?)",
            (show_id, rid, version_no, index),
        )
    db.commit()
    row = _show_row(db, show_id)
    return {"show": _serialize_show(db, row, user)}


@app.get("/api/shows/{show_id}")
def get_show(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    return {"show": _serialize_show(db, row, user)}


@app.put("/api/shows/{show_id}")
def update_show(
    show_id: int,
    payload: ShowUpdatePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_manage_show(db, row, user):
        raise HTTPException(403, "无管理权限")
    visibility_scope = _validate_scope(payload.visibility_scope)
    management_scope = _validate_scope(payload.management_scope)
    secrecy_level = _validate_secrecy(payload.secrecy_level)
    status = _validate_resource_status(payload.status)
    db.execute(
        """
        UPDATE shows
        SET name = ?, subject = ?, tags = ?, status = ?, visibility_scope = ?, management_scope = ?, secrecy_level = ?, updated_by = ?, updated_at = ?
        WHERE id = ?
        """,
        (payload.name, payload.subject, payload.tags, status, visibility_scope, management_scope, secrecy_level, user["id"], now_iso(), show_id),
    )
    _set_show_scope_users(db, "show_visibility", show_id, payload.visible_user_ids)
    _set_show_scope_users(db, "show_management", show_id, payload.manage_user_ids)
    db.commit()
    return {"show": _serialize_show(db, _show_row(db, show_id), user)}


@app.delete("/api/shows/{show_id}")
def delete_show(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_manage_show(db, row, user):
        raise HTTPException(403, "无管理权限")
    db.execute("DELETE FROM shows WHERE id = ?", (show_id,))
    db.commit()
    return {"ok": True, "deleted": 1}


@app.patch("/api/shows/{show_id}/resources/{resource_id}/hidden")
def update_show_resource_hidden(
    show_id: int,
    resource_id: int,
    payload: ShowResourceHiddenPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_manage_show(db, row, user):
        raise HTTPException(403, "无管理权限")
    sr = db.execute(
        "SELECT 1 FROM show_resources WHERE show_id = ? AND resource_id = ?",
        (show_id, resource_id),
    ).fetchone()
    if sr is None:
        raise HTTPException(404, "放映中未找到该资源")
    db.execute(
        "UPDATE show_resources SET is_hidden = ? WHERE show_id = ? AND resource_id = ?",
        (1 if payload.hidden else 0, show_id, resource_id),
    )
    db.commit()
    return {"ok": True}


@app.put("/api/shows/{show_id}/resources")
def update_show_resources(
    show_id: int,
    payload: ShowResourcesPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_manage_show(db, row, user):
        raise HTTPException(403, "无管理权限")
    for rid in payload.resource_ids:
        _resource_row(db, rid)
    existing = {
        int(r["resource_id"]): int(r["version_no"])
        for r in db.execute("SELECT resource_id, version_no FROM show_resources WHERE show_id = ?", (show_id,)).fetchall()
    }
    existing_hidden = {
        int(r["resource_id"]): int(r["is_hidden"])
        for r in db.execute("SELECT resource_id, is_hidden FROM show_resources WHERE show_id = ?", (show_id,)).fetchall()
    }
    db.execute("DELETE FROM show_resources WHERE show_id = ?", (show_id,))
    for index, rid in enumerate(payload.resource_ids):
        version_no = existing.get(rid)
        if version_no is None:
            res_row = db.execute("SELECT current_version FROM resources WHERE id = ?", (rid,)).fetchone()
            version_no = int(res_row["current_version"]) if res_row else 1
        is_hidden = existing_hidden.get(rid, 0)
        db.execute(
            "INSERT OR IGNORE INTO show_resources (show_id, resource_id, version_no, sort_order, is_hidden) VALUES (?, ?, ?, ?, ?)",
            (show_id, rid, version_no, index, is_hidden),
        )
    db.execute("UPDATE shows SET updated_by = ?, updated_at = ? WHERE id = ?", (user["id"], now_iso(), show_id))
    db.commit()
    return {"show": _serialize_show(db, _show_row(db, show_id), user)}


@app.post("/api/shows/{show_id}/duplicate")
def duplicate_show(
    show_id: int,
    payload: ShowDuplicatePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    ts = now_iso()
    db.execute(
        """
        INSERT INTO shows (name, owner_id, subject, tags, status, visibility_scope, management_scope, secrecy_level, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (payload.name, user["id"], row["subject"], row["tags"], row["status"], row["visibility_scope"], row["management_scope"], row["secrecy_level"], user["id"], ts, ts),
    )
    new_show_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    visible_ids = _show_scope_user_ids(db, "show_visibility", show_id)
    manage_ids = _show_scope_user_ids(db, "show_management", show_id)
    _set_show_scope_users(db, "show_visibility", new_show_id, visible_ids)
    _set_show_scope_users(db, "show_management", new_show_id, manage_ids)
    resource_rows = db.execute(
        "SELECT resource_id, version_no, sort_order, is_hidden FROM show_resources WHERE show_id = ? ORDER BY sort_order",
        (show_id,),
    ).fetchall()
    for sr in resource_rows:
        db.execute(
            "INSERT OR IGNORE INTO show_resources (show_id, resource_id, version_no, sort_order, is_hidden) VALUES (?, ?, ?, ?, ?)",
            (new_show_id, sr["resource_id"], sr["version_no"], sr["sort_order"], sr["is_hidden"]),
        )
    db.commit()
    return {"show": _serialize_show(db, _show_row(db, new_show_id), user)}


@app.post("/api/shows/{show_id}/iterate")
def iterate_show(
    show_id: int,
    payload: ShowIteratePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_manage_show(db, row, user):
        raise HTTPException(403, "无管理权限")
    series_id = row["series_id"]
    max_ver_row = db.execute("SELECT MAX(version_no) FROM shows WHERE series_id = ?", (series_id,)).fetchone()
    max_version = int(max_ver_row[0]) if max_ver_row[0] is not None else 0
    new_version_no = max_version + 1
    new_name = payload.name if payload.name is not None else row["name"]
    ts = now_iso()
    db.execute(
        """
        INSERT INTO shows (name, owner_id, subject, tags, status, secrecy_level, visibility_scope, management_scope, series_id, version_no, change_note, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (new_name, user["id"], row["subject"], row["tags"], row["status"], row["secrecy_level"], row["visibility_scope"], row["management_scope"], series_id, new_version_no, payload.change_note, user["id"], ts, ts),
    )
    new_show_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    # 复制权限记录
    visible_ids = _show_scope_user_ids(db, "show_visibility", show_id)
    manage_ids = _show_scope_user_ids(db, "show_management", show_id)
    _set_show_scope_users(db, "show_visibility", new_show_id, visible_ids)
    _set_show_scope_users(db, "show_management", new_show_id, manage_ids)
    # 复制资源
    if payload.resource_ids is None:
        # 复制源 show 的所有 show_resources
        resource_rows = db.execute(
            "SELECT resource_id, version_no, sort_order, is_hidden FROM show_resources WHERE show_id = ? ORDER BY sort_order",
            (show_id,),
        ).fetchall()
        for sr in resource_rows:
            db.execute(
                "INSERT OR IGNORE INTO show_resources (show_id, resource_id, version_no, sort_order, is_hidden) VALUES (?, ?, ?, ?, ?)",
                (new_show_id, sr["resource_id"], sr["version_no"], sr["sort_order"], sr["is_hidden"]),
            )
    else:
        # 为每个 resource_id 插入，获取当前版本
        for index, rid in enumerate(payload.resource_ids):
            res_row = db.execute("SELECT current_version FROM resources WHERE id = ?", (rid,)).fetchone()
            if res_row is None:
                raise HTTPException(404, f"资源 #{rid} 不存在")
            version_no = int(res_row["current_version"]) if res_row["current_version"] else 1
            db.execute(
                "INSERT OR IGNORE INTO show_resources (show_id, resource_id, version_no, sort_order) VALUES (?, ?, ?, ?)",
                (new_show_id, rid, version_no, index),
            )
    db.commit()
    return {"show": _serialize_show(db, _show_row(db, new_show_id), user)}


@app.get("/api/shows/{show_id}/versions")
def show_versions(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    series_id = row["series_id"]
    version_rows = db.execute(
        "SELECT * FROM shows WHERE series_id = ? ORDER BY version_no DESC",
        (series_id,),
    ).fetchall()
    versions = []
    for vrow in version_rows:
        if not can_view_show(db, vrow, user):
            continue
        owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (vrow["owner_id"],)).fetchone()
        resource_count = db.execute(
            "SELECT COUNT(*) FROM show_resources WHERE show_id = ?", (vrow["id"],)
        ).fetchone()[0]
        versions.append({
            "id": vrow["id"],
            "version_no": vrow["version_no"],
            "name": vrow["name"],
            "change_note": vrow["change_note"],
            "resource_count": resource_count,
            "created_at": vrow["created_at"],
            "owner": {"id": owner["id"], "username": owner["username"], "name": owner["name"]} if owner else None,
        })
    return {"versions": versions, "current_version_no": row["version_no"]}


@app.get("/api/shows/{show_id}/check-updates")
def check_show_updates(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    updates = []
    sr_rows = db.execute(
        """
        SELECT sr.resource_id, sr.version_no, r.current_version, r.name
        FROM show_resources sr
        JOIN resources r ON r.id = sr.resource_id
        WHERE sr.show_id = ?
        ORDER BY sr.sort_order
        """,
        (show_id,),
    ).fetchall()
    for sr in sr_rows:
        current = int(sr["version_no"])
        latest = int(sr["current_version"])
        if latest > current:
            version_row = db.execute(
                "SELECT id, png_path, common_remark_html FROM resource_versions WHERE resource_id = ? AND version_no = ?",
                (sr["resource_id"], latest),
            ).fetchone()
            current_version_row = db.execute(
                "SELECT id, png_path, common_remark_html FROM resource_versions WHERE resource_id = ? AND version_no = ?",
                (sr["resource_id"], current),
            ).fetchone()
            preview_url = None
            if version_row and version_row["png_path"]:
                preview_url = f"/api/resources/{sr['resource_id']}/preview-thumb?version_id={version_row['id']}"
            current_preview_url = None
            if current_version_row and current_version_row["png_path"]:
                current_preview_url = f"/api/resources/{sr['resource_id']}/preview-thumb?version_id={current_version_row['id']}"
            latest_remark = version_row["common_remark_html"] if version_row else None
            current_remark = current_version_row["common_remark_html"] if current_version_row else None
            has_remark_change = (latest_remark or None) != (current_remark or None)
            updates.append({
                "resource_id": sr["resource_id"],
                "current_version_no": current,
                "latest_version_no": latest,
                "name": sr["name"],
                "preview_url": preview_url,
                "has_remark_change": has_remark_change,
                "version_gap": latest - current,
                "current_preview_url": current_preview_url,
            })
    return {"updates": updates}


@app.post("/api/shows/{show_id}/upgrade")
def upgrade_show_resources(
    show_id: int,
    payload: ShowUpgradePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_manage_show(db, row, user):
        raise HTTPException(403, "无管理权限")
    target_ids = set(payload.resource_ids)
    sr_rows = db.execute(
        "SELECT resource_id, version_no FROM show_resources WHERE show_id = ?",
        (show_id,),
    ).fetchall()
    upgraded = []
    for sr in sr_rows:
        rid = int(sr["resource_id"])
        if target_ids and rid not in target_ids:
            continue
        res_row = db.execute("SELECT current_version, name FROM resources WHERE id = ?", (rid,)).fetchone()
        if res_row is None:
            continue
        latest = int(res_row["current_version"])
        current = int(sr["version_no"])
        if latest > current:
            db.execute(
                "UPDATE show_resources SET version_no = ? WHERE show_id = ? AND resource_id = ?",
                (latest, show_id, rid),
            )
            upgraded.append({
                "resource_id": rid,
                "name": res_row["name"],
                "old_version_no": current,
                "new_version_no": latest,
            })
    if upgraded:
        db.execute("UPDATE shows SET updated_by = ?, updated_at = ? WHERE id = ?", (user["id"], now_iso(), show_id))
    db.commit()
    return {"upgraded": upgraded}


@app.post("/api/shows/{show_id}/iterate-upgrade")
def iterate_upgrade_show(
    show_id: int,
    payload: ShowIterateUpgradePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """迭代式升级：创建新版本 + 升级选中资源 + 迁移备注"""
    row = _show_row(db, show_id)
    if not can_manage_show(db, row, user):
        raise HTTPException(403, "无管理权限")
    # 1. 创建新 show 版本
    series_id = row["series_id"]
    max_ver_row = db.execute("SELECT MAX(version_no) FROM shows WHERE series_id = ?", (series_id,)).fetchone()
    max_version = int(max_ver_row[0]) if max_ver_row[0] is not None else 0
    new_version_no = max_version + 1
    ts = now_iso()
    db.execute(
        """
        INSERT INTO shows (name, owner_id, subject, tags, status, secrecy_level, visibility_scope, management_scope, series_id, version_no, change_note, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (row["name"], user["id"], row["subject"], row["tags"], row["status"], row["secrecy_level"], row["visibility_scope"], row["management_scope"], series_id, new_version_no, payload.change_note, user["id"], ts, ts),
    )
    new_show_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    # 2. 复制权限记录
    visible_ids = _show_scope_user_ids(db, "show_visibility", show_id)
    manage_ids = _show_scope_user_ids(db, "show_management", show_id)
    _set_show_scope_users(db, "show_visibility", new_show_id, visible_ids)
    _set_show_scope_users(db, "show_management", new_show_id, manage_ids)
    # 3. 复制 show_resources 并升级选中资源
    upgrade_target_ids = set(payload.resource_ids)
    resource_rows = db.execute(
        "SELECT resource_id, version_no, sort_order, is_hidden FROM show_resources WHERE show_id = ? ORDER BY sort_order",
        (show_id,),
    ).fetchall()
    upgraded = []
    for sr in resource_rows:
        rid = int(sr["resource_id"])
        old_vno = int(sr["version_no"])
        new_vno = old_vno
        if rid in upgrade_target_ids:
            res_row = db.execute("SELECT current_version, name FROM resources WHERE id = ?", (rid,)).fetchone()
            if res_row:
                latest = int(res_row["current_version"])
                if latest > old_vno:
                    new_vno = latest
                    upgraded.append({
                        "resource_id": rid,
                        "name": res_row["name"],
                        "old_version_no": old_vno,
                        "new_version_no": latest,
                    })
        db.execute(
            "INSERT OR IGNORE INTO show_resources (show_id, resource_id, version_no, sort_order, is_hidden) VALUES (?, ?, ?, ?, ?)",
            (new_show_id, rid, new_vno, sr["sort_order"], sr["is_hidden"]),
        )
    # 4. 迁移 show_remarks
    old_remarks = db.execute(
        "SELECT resource_id, user_id, content_html, updated_at FROM show_remarks WHERE show_id = ?",
        (show_id,),
    ).fetchall()
    for rm in old_remarks:
        db.execute(
            """INSERT INTO show_remarks (show_id, resource_id, user_id, content_html, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(show_id, resource_id, user_id) DO UPDATE SET content_html = excluded.content_html, updated_at = excluded.updated_at""",
            (new_show_id, rm["resource_id"], rm["user_id"], rm["content_html"], rm["updated_at"]),
        )
    # 覆盖当前用户指定资源的备注
    for res_id_str, remark_html in payload.remarks.items():
        res_id = int(res_id_str)
        db.execute(
            """INSERT INTO show_remarks (show_id, resource_id, user_id, content_html, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(show_id, resource_id, user_id) DO UPDATE SET content_html = excluded.content_html, updated_at = excluded.updated_at""",
            (new_show_id, res_id, user["id"], remark_html, ts),
        )
    # 5. 提交并返回
    db.commit()
    new_row = _show_row(db, new_show_id)
    return {"show": _serialize_show(db, new_row, user), "upgraded": upgraded}


@app.get("/api/shows/{show_id}/resource-diff/{resource_id}")
def get_resource_diff(
    show_id: int,
    resource_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    # 获取 show_resources 中当前版本
    sr = db.execute(
        "SELECT version_no FROM show_resources WHERE show_id = ? AND resource_id = ?",
        (show_id, resource_id),
    ).fetchone()
    if sr is None:
        raise HTTPException(404, "放映中不存在该资源")
    current_version_no = int(sr["version_no"])
    # 获取资源信息
    resource = db.execute(
        "SELECT id, name, current_version FROM resources WHERE id = ?",
        (resource_id,),
    ).fetchone()
    if resource is None:
        raise HTTPException(404, "资源不存在")
    latest_version_no = int(resource["current_version"])
    # 获取当前版本和最新版本的 version id
    current_ver = db.execute(
        "SELECT id, common_remark_html FROM resource_versions WHERE resource_id = ? AND version_no = ?",
        (resource_id, current_version_no),
    ).fetchone()
    latest_ver = db.execute(
        "SELECT id, common_remark_html FROM resource_versions WHERE resource_id = ? AND version_no = ?",
        (resource_id, latest_version_no),
    ).fetchone()
    current_version_id = current_ver["id"] if current_ver else None
    latest_version_id = latest_ver["id"] if latest_ver else None
    # 构造预览 URL
    current_preview_url = f"/api/resources/{resource_id}/preview-thumb?version_id={current_version_id}" if current_version_id else None
    latest_preview_url = f"/api/resources/{resource_id}/preview-thumb?version_id={latest_version_id}" if latest_version_id else None
    current_original_preview_url = f"/api/resources/{resource_id}/preview?version_id={current_version_id}" if current_version_id else None
    latest_original_preview_url = f"/api/resources/{resource_id}/preview?version_id={latest_version_id}" if latest_version_id else None
    # 查询当前版本和最新版本之间的所有版本记录（不含当前版本，含最新版本）
    versions_between_rows = db.execute(
        "SELECT version_no, change_note, created_at FROM resource_versions WHERE resource_id = ? AND version_no > ? AND version_no <= ? ORDER BY version_no ASC",
        (resource_id, current_version_no, latest_version_no),
    ).fetchall()
    versions_between = [
        {
            "version_no": int(v["version_no"]),
            "change_note": v["change_note"],
            "created_at": v["created_at"],
        }
        for v in versions_between_rows
    ]
    # common_remark 对比
    common_remark_diff = {
        "current_html": current_ver["common_remark_html"] if current_ver else "",
        "latest_html": latest_ver["common_remark_html"] if latest_ver else "",
    }
    # 获取当前用户的放映备注
    remark_row = db.execute(
        "SELECT content_html FROM show_remarks WHERE show_id = ? AND resource_id = ? AND user_id = ?",
        (show_id, resource_id, user["id"]),
    ).fetchone()
    show_remark_html = remark_row["content_html"] if remark_row else ""
    return {
        "resource_id": resource_id,
        "resource_name": resource["name"],
        "current_version_no": current_version_no,
        "latest_version_no": latest_version_no,
        "current_preview_url": current_preview_url,
        "latest_preview_url": latest_preview_url,
        "current_original_preview_url": current_original_preview_url,
        "latest_original_preview_url": latest_original_preview_url,
        "versions_between": versions_between,
        "common_remark_diff": common_remark_diff,
        "show_remark_html": show_remark_html,
    }


@app.get("/api/shows/{show_id}/remarks/{resource_id}")
def get_show_remark(
    show_id: int,
    resource_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    remark_row = db.execute(
        "SELECT content_html FROM show_remarks WHERE show_id = ? AND resource_id = ? AND user_id = ?",
        (show_id, resource_id, user["id"]),
    ).fetchone()
    return {"content_html": remark_row["content_html"] if remark_row else ""}


@app.put("/api/shows/{show_id}/remarks/{resource_id}")
def update_show_remark(
    show_id: int,
    resource_id: int,
    payload: ShowRemarkPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    ts = now_iso()
    db.execute(
        """
        INSERT INTO show_remarks (show_id, resource_id, user_id, content_html, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(show_id, resource_id, user_id) DO UPDATE SET content_html = excluded.content_html, updated_at = excluded.updated_at
        """,
        (show_id, resource_id, user["id"], payload.content_html, ts),
    )
    db.commit()
    return {"content_html": payload.content_html}


@app.get("/api/shows/{show_id}/download/pdf")
def download_show_pdf(
    show_id: int,
    request: Request,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> FileResponse:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    sr_rows = db.execute(
        """
        SELECT sr.resource_id, sr.version_no, r.name
        FROM show_resources sr
        JOIN resources r ON r.id = sr.resource_id
        WHERE sr.show_id = ?
        ORDER BY sr.sort_order
        """,
        (show_id,),
    ).fetchall()
    images = []
    for sr in sr_rows:
        resource = db.execute("SELECT * FROM resources WHERE id = ?", (sr["resource_id"],)).fetchone()
        if resource is None or not can_view_resource(db, resource, user):
            continue
        version_row = db.execute(
            "SELECT png_path FROM resource_versions WHERE resource_id = ? AND version_no = ?",
            (sr["resource_id"], sr["version_no"]),
        ).fetchone()
        if version_row and version_row["png_path"]:
            path = _safe_abs(version_row["png_path"])
            if path and path.exists():
                images.append(Image.open(path).convert("RGB"))
    if not images:
        raise HTTPException(404, "没有可下载的预览图")
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    first = images[0]
    rest = images[1:]
    first.save(tmp_path, "PDF", save_all=True, append_images=rest)
    for img in images:
        img.close()
    _record_download(db, user, request, show_id, "pdf")
    return FileResponse(
        tmp_path,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(f"{row['name']}.pdf")},
    )


@app.get("/api/shows/{show_id}/download/pptx-images")
def download_show_pptx_images(
    show_id: int,
    request: Request,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> FileResponse:
    """将放映组中所有可见资源的高清预览图生成为 PPTX，每张图一页。"""
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    sr_rows = db.execute(
        """
        SELECT sr.resource_id, sr.version_no, r.name
        FROM show_resources sr
        JOIN resources r ON r.id = sr.resource_id
        WHERE sr.show_id = ?
        ORDER BY sr.sort_order
        """,
        (show_id,),
    ).fetchall()
    image_paths: list[Path] = []
    for sr in sr_rows:
        resource = db.execute("SELECT * FROM resources WHERE id = ?", (sr["resource_id"],)).fetchone()
        if resource is None or not can_view_resource(db, resource, user):
            continue
        version_row = db.execute(
            "SELECT png_path FROM resource_versions WHERE resource_id = ? AND version_no = ?",
            (sr["resource_id"], sr["version_no"]),
        ).fetchone()
        if version_row and version_row["png_path"]:
            path = _safe_abs(version_row["png_path"])
            if path and path.exists():
                image_paths.append(path)
    if not image_paths:
        raise HTTPException(404, "没有可下载的预览图")
    tmp = tempfile.NamedTemporaryFile(suffix=".pptx", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    try:
        build_image_pptx(image_paths, tmp_path)
    except Exception as exc:
        tmp_path.unlink(missing_ok=True)
        logger.exception("生成纯图 PPTX 失败 show_id=%s", show_id)
        raise HTTPException(500, f"生成纯图 PPT 失败：{exc}") from exc
    _record_download(db, user, request, show_id, "pptx_images")
    return FileResponse(
        tmp_path,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": _content_disposition(f"{row['name']}_纯图.pptx")},
    )


def _collect_show_accessible_resources(
    db: sqlite3.Connection, show_id: int, user: sqlite3.Row
) -> list[dict[str, Any]]:
    """按当前用户权限，返回放映下可见资源的当前版本信息（按 sort_order）。"""
    sr_rows = db.execute(
        """
        SELECT sr.resource_id, sr.version_no, sr.is_hidden, r.name
        FROM show_resources sr
        JOIN resources r ON r.id = sr.resource_id
        WHERE sr.show_id = ?
        ORDER BY sr.sort_order
        """,
        (show_id,),
    ).fetchall()
    items: list[dict[str, Any]] = []
    for sr in sr_rows:
        resource = db.execute(
            "SELECT * FROM resources WHERE id = ?", (sr["resource_id"],)
        ).fetchone()
        if resource is None or not can_view_resource(db, resource, user):
            continue
        version_row = db.execute(
            "SELECT ppt_path, font_names, missing_fonts FROM resource_versions"
            " WHERE resource_id = ? AND version_no = ?",
            (sr["resource_id"], sr["version_no"]),
        ).fetchone()
        if not version_row:
            continue
        items.append(
            {
                "resource_id": sr["resource_id"],
                "name": sr["name"],
                "version_no": sr["version_no"],
                "ppt_path": version_row["ppt_path"],
                "font_names": _json_loads(version_row["font_names"], []),
                "missing_fonts": _json_loads(version_row["missing_fonts"], []),
                "is_hidden": bool(sr["is_hidden"]),
            }
        )
    return items


def _aggregate_show_fonts(
    db: sqlite3.Connection, items: list[dict[str, Any]]
) -> dict[str, Any]:
    """聚合多个资源版本的字体名/别名/缺失清单。"""
    names: list[str] = []
    seen_names: set[str] = set()
    missing: list[str] = []
    seen_missing: set[str] = set()
    for item in items:
        for name in item["font_names"]:
            cleaned = (name or "").strip()
            if not cleaned:
                continue
            key = cleaned.lower()
            if key not in seen_names:
                names.append(cleaned)
                seen_names.add(key)
        for name in item["missing_fonts"]:
            cleaned = (name or "").strip()
            if not cleaned:
                continue
            key = cleaned.lower()
            if key not in seen_missing:
                missing.append(cleaned)
                seen_missing.add(key)
    return {
        "font_names": names,
        "font_aliases": _font_alias_map(names, db),
        "missing_fonts": missing,
    }


@app.get("/api/shows/{show_id}/fonts")
def show_fonts(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    items = _collect_show_accessible_resources(db, show_id, user)
    return _aggregate_show_fonts(db, items)


@app.get("/api/shows/{show_id}/download/pptx")
def download_show_pptx(
    show_id: int,
    request: Request,
    with_fonts: bool = Query(False),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> FileResponse:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    items = _collect_show_accessible_resources(db, show_id, user)
    input_paths: list[Path] = []
    hidden_flags: list[bool] = []
    for item in items:
        if not item["ppt_path"]:
            continue
        ppt_path = _safe_abs(item["ppt_path"])
        if not ppt_path or not ppt_path.exists():
            continue
        input_paths.append(ppt_path)
        hidden_flags.append(item.get("is_hidden", False))
    if not input_paths:
        raise HTTPException(404, "没有可下载的内容")
    tmp = tempfile.NamedTemporaryFile(suffix=".pptx", delete=False)
    merged_path = Path(tmp.name)
    tmp.close()
    merge_pptx_files(input_paths, merged_path, hidden_flags=hidden_flags)
    if not with_fonts:
        _record_download(db, user, request, show_id, "pptx")
        return FileResponse(
            merged_path,
            media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            headers={"Content-Disposition": _content_disposition(f"{row['name']}.pptx")},
        )
    _record_download(db, user, request, show_id, "pptx_fonts")
    agg = _aggregate_show_fonts(db, items)
    fonts, _ = _build_fonts_bundle(db, agg["font_names"])
    zip_tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    zip_path = Path(zip_tmp.name)
    zip_tmp.close()
    try:
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(merged_path, arcname=f"{row['name']}.pptx")
            _write_fonts_into_zip(zf, fonts, agg["missing_fonts"])
    finally:
        merged_path.unlink(missing_ok=True)
    return FileResponse(
        zip_path,
        media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(f"{row['name']}_with_fonts.zip")},
    )


@app.get("/api/shows/{show_id}/download/zip")
def download_show_zip(
    show_id: int,
    request: Request,
    with_fonts: bool = Query(False),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> FileResponse:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    items = _collect_show_accessible_resources(db, show_id, user)
    written = 0
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()
    with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in items:
            if not item["ppt_path"]:
                continue
            ppt_path = _safe_abs(item["ppt_path"])
            if not ppt_path or not ppt_path.exists():
                continue
            arcname = f"{item['name']}_v{item['version_no']}.pptx"
            zf.write(ppt_path, arcname)
            written += 1
        if not written:
            tmp_path.unlink(missing_ok=True)
            raise HTTPException(404, "没有可下载的内容")
        agg = _aggregate_show_fonts(db, items)
        fonts_info = {
            "fonts": sorted(agg["font_names"], key=str.lower),
            "missing_fonts": sorted(agg["missing_fonts"], key=str.lower),
        }
        zf.writestr("fonts.json", json.dumps(fonts_info, ensure_ascii=False, indent=2))
        if with_fonts:
            fonts, _ = _build_fonts_bundle(db, agg["font_names"])
            _write_fonts_into_zip(zf, fonts, agg["missing_fonts"])
    filename = f"{row['name']}_with_fonts.zip" if with_fonts else f"{row['name']}.zip"
    _record_download(db, user, request, show_id, "zip_fonts" if with_fonts else "zip")
    return FileResponse(
        tmp_path,
        media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(filename)},
    )


# ---------- 离线缓存 API ----------


@app.get("/api/shows/{show_id}/offline-package")
def get_show_offline_package(
    show_id: int,
    auth_mode: str = "none",
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    sr_rows = db.execute(
        """
        SELECT sr.resource_id, sr.version_no, sr.is_hidden, rv.png_path, r.name AS resource_name,
               rv.id AS version_id, rv.common_remark_html
        FROM show_resources sr
        JOIN resource_versions rv ON rv.resource_id = sr.resource_id AND rv.version_no = sr.version_no
        JOIN resources r ON r.id = sr.resource_id
        WHERE sr.show_id = ?
        ORDER BY sr.sort_order
        """,
        (show_id,),
    ).fetchall()
    resources = []
    slide_index = 0
    for r in sr_rows:
        if r["is_hidden"]:
            continue
        png_path = r["png_path"]
        if not png_path:
            slide_index += 1
            continue
        abs_png = _safe_abs(png_path)
        if abs_png is None or not abs_png.exists():
            slide_index += 1
            continue
        png_data = abs_png.read_bytes()
        image_base64 = base64.b64encode(png_data).decode("ascii")
        resource_id = r["resource_id"]
        version_id = r["version_id"]
        try:
            thumb_path = _ensure_preview_thumb(abs_png, version_id)
            thumb_data = thumb_path.read_bytes()
            thumb_base64 = base64.b64encode(thumb_data).decode("ascii")
        except Exception:
            logger.exception(
                "离线缓存：生成资源缩略图失败 show_id=%s resource_id=%s version_id=%s png=%s",
                show_id, resource_id, version_id, abs_png,
            )
            thumb_base64 = ""
        common_remark_html = r["common_remark_html"] or ""
        pr = db.execute(
            "SELECT content_html FROM personal_remarks WHERE resource_id = ? AND version_id = ? AND user_id = ?",
            (resource_id, version_id, user["id"]),
        ).fetchone()
        personal_remark_html = pr["content_html"] if pr else ""
        sr_remark = db.execute(
            "SELECT content_html FROM show_remarks WHERE show_id = ? AND resource_id = ? AND user_id = ?",
            (show_id, resource_id, user["id"]),
        ).fetchone()
        show_remark_html = sr_remark["content_html"] if sr_remark else ""
        resources.append({
            "id": resource_id,
            "name": r["resource_name"],
            "version_no": r["version_no"],
            "slide_index": slide_index,
            "image_base64": image_base64,
            "thumb_base64": thumb_base64,
            "common_remark_html": common_remark_html,
            "personal_remark_html": personal_remark_html,
            "show_remark_html": show_remark_html,
        })
        slide_index += 1
    auth_hash = None
    auth_username = None
    if auth_mode == "required":
        auth_hash = user["password_hash"]
        auth_username = user["username"]

    # --- 元数据字段 ---
    tags_raw = row["tags"] or ""
    tags_list = [t.strip() for t in tags_raw.split(",") if t.strip()] if tags_raw else []

    owner_name = None
    owner_id = row["owner_id"]
    if owner_id:
        owner_row = db.execute("SELECT username, name FROM users WHERE id = ?", (owner_id,)).fetchone()
        if owner_row:
            owner_name = owner_row["name"] if owner_row["name"] else owner_row["username"]

    # --- 封面图片字段 ---
    cover_thumb_base64 = None
    cover_hd_base64 = None
    # 取第一个非 hidden 且有 png_path 的资源
    for r in sr_rows:
        if r["is_hidden"]:
            continue
        png_path = r["png_path"]
        if not png_path:
            continue
        abs_png = _safe_abs(png_path)
        if abs_png is None or not abs_png.exists():
            continue
        # HD: 原始 PNG 的 base64
        try:
            cover_hd_base64 = base64.b64encode(abs_png.read_bytes()).decode("ascii")
        except Exception:
            cover_hd_base64 = None
        # Thumb: 640x360 JPEG 的 base64
        try:
            thumb_path = _ensure_preview_thumb(abs_png, r["version_id"])
            cover_thumb_base64 = base64.b64encode(thumb_path.read_bytes()).decode("ascii")
        except Exception:
            cover_thumb_base64 = None
        break

    return {
        "show_id": show_id,
        "name": row["name"],
        "subject": row["subject"],
        "tags": tags_list,
        "status": row["status"],
        "secrecy_level": row["secrecy_level"],
        "owner_name": owner_name,
        "version_no": row["version_no"],
        "series_id": row["series_id"],
        "updated_at": row["updated_at"],
        "auth_mode": auth_mode,
        "auth_hash": auth_hash,
        "auth_username": auth_username,
        "cover_thumb_base64": cover_thumb_base64,
        "cover_hd_base64": cover_hd_base64,
        "resources": resources,
    }


@app.get("/api/shows/{show_id}/offline-version")
def get_show_offline_version(
    show_id: int,
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = db.execute("SELECT * FROM shows WHERE id = ?", (show_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "放映不存在")
    # 同一 series 的迭代版本是新的 shows 行（新 id、递增 version_no），
    # 需要按 series_id 查找系列中的最新版本，否则离线缓存的旧 show_id
    # 永远无法检测到系列中发布的新版本。
    series_id = row["series_id"]
    latest_row = db.execute(
        "SELECT * FROM shows WHERE series_id = ? ORDER BY version_no DESC LIMIT 1",
        (series_id,),
    ).fetchone()
    if latest_row is None:
        latest_row = row
    latest_show_id = int(latest_row["id"])
    sr_rows = db.execute(
        "SELECT resource_id, version_no FROM show_resources WHERE show_id = ?",
        (latest_show_id,),
    ).fetchall()
    return {
        # 兼容旧字段：show_id 始终指向系列中最新版本的 show_id，
        # 前端据此拉取 offline-package 和更新 manifest。
        "show_id": latest_show_id,
        "queried_show_id": int(show_id),
        "series_id": series_id,
        "version_no": int(latest_row["version_no"]),
        "updated_at": latest_row["updated_at"],
        "name": latest_row["name"],
        "resource_versions": {str(r["resource_id"]): r["version_no"] for r in sr_rows},
    }


@app.post("/api/auth/verify-offline")
async def verify_offline_auth(
    request: Request,
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, bool]:
    try:
        body = await request.json()
    except Exception:
        return {"valid": False}
    username = body.get("username")
    password = body.get("password")
    show_id = body.get("show_id")
    if not username or not password or show_id is None:
        return {"valid": False}
    user_row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if user_row is None or not verify_password(password, user_row["password_hash"]):
        return {"valid": False}
    show_row = db.execute("SELECT * FROM shows WHERE id = ?", (show_id,)).fetchone()
    if show_row is None or not can_view_show(db, show_row, user_row):
        return {"valid": False}
    return {"valid": True}


# ---------- 放映会话图片签名 API ----------


@app.post("/api/shows/{show_id}/present-session")
def create_present_session(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    token = create_present_token(show_id, int(user["id"]), settings.secret_key)
    return {"session_token": token, "expires_in": settings.show_token_ttl_seconds}


@app.get("/api/slides/{resource_id}/image")
def slide_image(
    resource_id: int,
    session_token: str = Query(...),
    db: sqlite3.Connection = Depends(db_dep),
) -> FileResponse:
    claims = verify_present_token(session_token, settings.secret_key)
    if claims is None:
        raise HTTPException(401, "会话token无效或已过期")
    show_id = claims["show_id"]
    # 验证该 resource_id 属于 token 中的 show_id
    sr = db.execute(
        "SELECT resource_id, version_no FROM show_resources WHERE show_id = ? AND resource_id = ?",
        (show_id, resource_id),
    ).fetchone()
    if sr is None:
        raise HTTPException(403, "该资源不属于此放映")
    # 获取资源的预览图
    version = _version_row(db, resource_id, None)
    path = _safe_abs(version["png_path"])
    if path is None or not path.exists():
        raise HTTPException(404, "预览图不存在")
    return FileResponse(path, media_type="image/png")


# ---------- links ----------

@app.get("/api/links")
def list_links(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    rows = db.execute("SELECT * FROM links ORDER BY sort_order ASC, updated_at DESC, id DESC").fetchall()
    links = [_serialize_link(db, row, user) for row in rows if can_view_link(db, row, user)]
    return {"links": links}


@app.post("/api/links")
def create_link(
    payload: LinkCreatePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    visibility_scope = _validate_scope(payload.visibility_scope)
    management_scope = _validate_scope(payload.management_scope)
    ts = now_iso()
    db.execute(
        """
        INSERT INTO links (name, url, memo, owner_id, visibility_scope, management_scope, is_enabled, networkEnv, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (payload.name, payload.url, payload.memo, user["id"], visibility_scope, management_scope, 1 if payload.is_enabled else 0, payload.network_env, ts, ts),
    )
    link_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    _set_link_scope_users(db, "link_visibility", link_id, payload.visible_user_ids)
    _set_link_scope_users(db, "link_management", link_id, payload.manage_user_ids)
    db.commit()
    row = _link_row(db, link_id)
    return {"link": _serialize_link(db, row, user)}


@app.put("/api/links/{link_id}")
def update_link(
    link_id: int,
    payload: LinkUpdatePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _link_row(db, link_id)
    if not can_manage_link(db, row, user):
        raise HTTPException(403, "无管理权限")
    visibility_scope = _validate_scope(payload.visibility_scope)
    management_scope = _validate_scope(payload.management_scope)
    db.execute(
        """
        UPDATE links
        SET name = ?, url = ?, memo = ?, visibility_scope = ?, management_scope = ?, is_enabled = ?, networkEnv = ?, updated_at = ?
        WHERE id = ?
        """,
        (payload.name, payload.url, payload.memo, visibility_scope, management_scope, 1 if payload.is_enabled else 0, payload.network_env, now_iso(), link_id),
    )
    _set_link_scope_users(db, "link_visibility", link_id, payload.visible_user_ids)
    _set_link_scope_users(db, "link_management", link_id, payload.manage_user_ids)
    db.commit()
    return {"link": _serialize_link(db, _link_row(db, link_id), user)}


@app.delete("/api/links/{link_id}")
def delete_link(
    link_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _link_row(db, link_id)
    if not can_manage_link(db, row, user):
        raise HTTPException(403, "无管理权限")
    db.execute("DELETE FROM links WHERE id = ?", (link_id,))
    db.commit()
    return {"ok": True, "deleted": 1}


@app.post("/api/admin/links/bulk-delete")
def bulk_delete_links(
    payload: LinkDeletePayload,
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    link_ids = sorted({int(lid) for lid in payload.link_ids if int(lid) > 0})
    if not link_ids:
        raise HTTPException(400, "请选择要删除的链接")
    placeholders = ",".join("?" for _ in link_ids)
    rows = db.execute(f"SELECT id FROM links WHERE id IN ({placeholders})", link_ids).fetchall()
    if not rows:
        raise HTTPException(404, "未找到可删除的链接")
    db.execute(f"DELETE FROM links WHERE id IN ({placeholders})", link_ids)
    db.commit()
    return {"ok": True, "deleted": len(rows)}


@app.put("/api/admin/links/order")
def reorder_links(
    payload: LinkOrderPayload,
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    link_ids = [int(lid) for lid in payload.link_ids]
    if not link_ids:
        raise HTTPException(400, "请选择需要排序的链接")
    if len(link_ids) != len(set(link_ids)):
        raise HTTPException(400, "排序列表存在重复链接")
    placeholders = ",".join("?" for _ in link_ids)
    rows = db.execute(f"SELECT id FROM links WHERE id IN ({placeholders})", link_ids).fetchall()
    existing = {int(row["id"]) for row in rows}
    missing = [lid for lid in link_ids if lid not in existing]
    if missing:
        raise HTTPException(404, "部分链接不存在")
    now = now_iso()
    for index, lid in enumerate(link_ids, start=1):
        db.execute(
            "UPDATE links SET sort_order = ?, updated_at = ? WHERE id = ?",
            (index * 10, now, lid),
        )
    db.commit()
    return {"ok": True, "ordered": len(link_ids)}


@app.get("/api/links/my-selection")
def get_my_link_selection(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    # 讲演者快捷链接统一由管理员后台维护，用户不再自行选择
    rows = db.execute(
        """
        SELECT l.* FROM links l
        JOIN default_selected_links dsl ON dsl.link_id = l.id
        ORDER BY dsl.sort_order
        """,
    ).fetchall()
    links = [_serialize_link(db, row, user) for row in rows if can_view_link(db, row, user)]
    return {"links": links}


@app.get("/api/links/admin/defaults")
def get_default_link_selection(
    user: sqlite3.Row = Depends(require_super_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    rows = db.execute(
        """
        SELECT l.* FROM links l
        JOIN default_selected_links dsl ON dsl.link_id = l.id
        ORDER BY dsl.sort_order
        """,
    ).fetchall()
    links = [_serialize_link(db, row, user) for row in rows]
    return {"links": links}


@app.put("/api/links/admin/defaults")
def set_default_link_selection(
    payload: LinkSelectionPayload,
    user: sqlite3.Row = Depends(require_super_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    if len(payload.link_ids) > 5:
        raise HTTPException(400, "最多设置5个默认链接")
    for lid in payload.link_ids:
        _link_row(db, lid)
    db.execute("DELETE FROM default_selected_links")
    for index, lid in enumerate(payload.link_ids):
        db.execute(
            "INSERT OR IGNORE INTO default_selected_links (link_id, sort_order) VALUES (?, ?)",
            (lid, index),
        )
    db.commit()
    return get_default_link_selection(user, db)


# ---------- 代理 ----------


@app.get("/api/proxy/webpage")
def proxy_webpage(
    url: str = Query(...),
    session_token: str = Query(...),
) -> Response:
    claims = verify_present_token(session_token, settings.secret_key)
    if claims is None:
        raise HTTPException(401, "会话token无效或已过期")

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(400, "仅支持 http/https URL")

    hostname = (parsed.hostname or "").lower()
    if hostname in ("localhost", "127.0.0.1", "0.0.0.0", "::1"):
        raise HTTPException(400, "禁止访问本地地址")

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; SlideFlowProxy/1.0)"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read()
            content_type = resp.headers.get("Content-Type", "text/html; charset=utf-8")
    except Exception as exc:
        error_html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>代理错误</title></head>
<body style="padding:2rem;font-family:sans-serif;">
<h2>无法加载页面</h2>
<p>{url}</p>
<p style="color:#888;">{type(exc).__name__}: {exc}</p>
</body>
</html>"""
        return Response(content=error_html.encode("utf-8"), media_type="text/html")

    # 仅对 HTML 内容移除 X-Frame-Options 和 CSP 限制，并注入 <base> 标签以修复相对路径资源加载
    if "text/html" in content_type:
        try:
            text = content.decode("utf-8", errors="replace")
            # 移除 X-Frame-Options meta 和 header 注入
            text = re.sub(r"<meta[^>]*http-equiv=[\"']?X-Frame-Options[\"']?[^>]*>", "", text, flags=re.IGNORECASE)
            # 移除 CSP meta
            text = re.sub(r"<meta[^>]*http-equiv=[\"']?Content-Security-Policy[\"']?[^>]*>", "", text, flags=re.IGNORECASE)

            # 提取 origin，注入 <base> 标签让相对路径资源（CSS/JS/图片）能正确加载
            origin = f"{parsed.scheme}://{parsed.netloc}"
            base_tag = f'<base href="{origin}/">'

            # 如果已有 <base> 标签，替换其 href 为绝对路径
            existing_base = re.search(r"<base[^>]*href=[\"'][^\"']*[\"'][^>]*>", text, re.IGNORECASE)
            if existing_base:
                text = re.sub(
                    r"<base([^>]*?)href=[\"'][^\"']*[\"']",
                    f"<base\\1href=\"{origin}/\"",
                    text,
                    count=1,
                    flags=re.IGNORECASE,
                )
            elif "<head>" in text:
                text = text.replace("<head>", f"<head>\n{base_tag}", 1)
            elif "<HEAD>" in text:
                text = text.replace("<HEAD>", f"<HEAD>\n{base_tag}", 1)
            else:
                text = base_tag + "\n" + text

            # 在 <head> 后注入允许 frame 的 meta
            if "<head>" in text:
                text = text.replace("<head>", '<head>\n<meta http-equiv="Content-Security-Policy" content="frame-ancestors *;">', 1)
            content = text.encode("utf-8")
        except Exception:
            pass

    return Response(content=content, media_type=content_type)


# ──────────────────────────────────────────────────────────────
# 任务管理 API
# ──────────────────────────────────────────────────────────────


def _execute_split_task(
    task_id: int,
    source_path: str,
    image_paths: list[str],
    params: dict,
) -> None:
    """在后台线程中执行拆分导入任务"""
    logger.info("Task %d: starting split import", task_id)
    cancel_event = _task_cancel_flags.get(task_id)
    start_time = time.time()
    db = get_db()
    db.execute("PRAGMA busy_timeout = 30000")  # 后台线程使用更长超时，避免被轮询请求阻塞
    try:
        # 更新状态为 processing，附带消息告知用户正在拆分
        db.execute(
            "UPDATE tasks SET status = 'processing',"
            " message = '正在拆分 PPT 文件...',"
            " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
            " WHERE id = ?",
            (task_id,),
        )
        db.commit()

        # 拆分 PPT（带进度回调）
        ppt_path = Path(source_path)
        split_dir = ppt_path.parent / "split"
        logger.info("Task %d: splitting PPT %s (%d bytes)", task_id, ppt_path.name, ppt_path.stat().st_size)

        def on_split_progress(current: int, total: int) -> None:
            db.execute(
                "UPDATE tasks SET message = ? WHERE id = ?",
                (f"正在拆分 PPT 文件... ({current}/{total})", task_id),
            )
            db.commit()

        split_files = split_pptx_to_single_pages(ppt_path, split_dir, progress_callback=on_split_progress)
        if not split_files:
            db.execute(
                "UPDATE tasks SET status = 'failed', error_message = '未能拆分 PPTX',"
                " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
                " WHERE id = ?",
                (task_id,),
            )
            db.commit()
            return

        total = len(split_files)
        db.execute(
            "UPDATE tasks SET total = ?, message = '正在创建资源...',"
            " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
            " WHERE id = ?",
            (total, task_id),
        )
        db.commit()
        logger.info("Task %d: split complete, %d pages, starting resource creation", task_id, total)

        # 参数提取
        name_prefix = params.get("name_prefix", "拆分页")
        subject = params.get("subject", DEFAULT_RESOURCE_SUBJECT)
        tags = params.get("tags", "")
        resource_status = params.get("status", "active")
        secrecy_level = params.get("secrecy_level", "public")
        visibility_scope = params.get("visibility_scope", "public")
        visible_user_ids = params.get("visible_user_ids", "")
        management_scope = params.get("management_scope", "private")
        manage_user_ids = params.get("manage_user_ids", "")
        remark_html = params.get("remark_html", "")
        owner_id = params.get("owner_id", 1)
        has_images = bool(image_paths)

        resource_ids: list[int] = []
        BATCH_COMMIT = 5
        progress = 0

        for index, split_ppt in enumerate(split_files, start=1):
            # 检查超时
            if time.time() - start_time > SPLIT_TASK_TIMEOUT:
                raise TimeoutError("PPT拆分任务超时")

            # 检查取消标志
            if cancel_event and cancel_event.is_set():
                logger.info("Task %d: cancelled by user at progress %d/%d", task_id, progress, total)
                db.execute(
                    "UPDATE tasks SET status = 'cancelled',"
                    " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
                    " WHERE id = ?",
                    (task_id,),
                )
                db.commit()
                return

            # 创建资源目录并复制拆分文件
            resource_dir = unique_child_dir(settings.resources_dir)
            v1_path = copy_into(split_ppt, resource_dir, "v1_")
            png_path: Path | None = None
            if has_images and index <= len(image_paths):
                img_src = Path(image_paths[index - 1])
                if img_src.exists():
                    png_path = copy_into(img_src, resource_dir, "preview_")

            ts = now_iso()
            db.execute(
                """
                INSERT INTO resources (
                    name, owner_id, resource_type, template_type, subject, tags, status,
                    visibility_scope, management_scope, secrecy_level,
                    current_version, updated_by, created_at, updated_at
                ) VALUES (?, ?, 'asset', NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                """,
                (
                    f"{name_prefix}_{index:02d}",
                    owner_id,
                    subject,
                    tags,
                    resource_status,
                    visibility_scope,
                    management_scope,
                    secrecy_level,
                    owner_id,
                    ts,
                    ts,
                ),
            )
            resource_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
            if resource_id <= 0:
                raise ValueError(f"Failed to insert resource, got invalid id: {resource_id}")
            resource_ids.append(resource_id)
            _set_scope_users(db, "resource_visibility", resource_id, _parse_id_list(visible_user_ids))
            _set_scope_users(db, "resource_management", resource_id, _parse_id_list(manage_user_ids))
            _insert_version(
                db,
                resource_id=resource_id,
                version_no=1,
                ppt_path=v1_path,
                png_path=png_path,
                common_remark_html=remark_html or "",
                change_note="批量拆分导入",
                created_by=int(owner_id),
            )

            # 首条资源立即提交，给用户即时反馈；之后每 BATCH_COMMIT 页提交一次
            progress = index
            if index == 1 or index % BATCH_COMMIT == 0 or index == total:
                db.commit()
                db.execute(
                    "UPDATE tasks SET progress = ?,"
                    " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
                    " WHERE id = ?",
                    (progress, task_id),
                )
                db.commit()
                logger.info("Task %d: progress %d/%d", task_id, progress, total)

        # 任务完成
        result = {"total": total, "created": len(resource_ids), "resource_ids": resource_ids}
        db.execute(
            "UPDATE tasks SET status = 'completed', progress = ?, message = '',"
            " result_data = ?,"
            " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime'),"
            " completed_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
            " WHERE id = ?",
            (total, json.dumps(result, ensure_ascii=False), task_id),
        )
        db.commit()
        logger.info("Task %d: completed, created %d resources", task_id, len(resource_ids))

    except Exception as e:
        logger.exception("Task %d failed: %s", task_id, e)
        db.rollback()
        try:
            db.execute(
                "UPDATE tasks SET status = 'failed', error_message = ?,"
                " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
                " WHERE id = ?",
                (str(e)[:500], task_id),
            )
            db.commit()
        except Exception as inner_e:
            logger.error("Task %d: failed to update error status: %s", task_id, inner_e)
    finally:
        _task_cancel_flags.pop(task_id, None)
        _pending_task_futures.pop(task_id, None)
        # 清理临时目录
        temp_dir_str = params.get("temp_dir")
        if temp_dir_str:
            shutil.rmtree(Path(temp_dir_str), ignore_errors=True)
        db.close()


# 任务参数中仅对前端暴露的安全字段（过滤掉文件系统路径等内部信息）
_TASK_PARAMS_PUBLIC_KEYS = (
    "name_prefix",
    "subject",
    "tags",
    "resource_type",
    "secrecy_level",
    "visibility_scope",
    "visible_user_ids",
    "management_scope",
    "manage_user_ids",
    "remark_html",
    "status",
    "owner_id",
)


def _owner_brief(db: sqlite3.Connection, owner_id: int) -> dict[str, Any] | None:
    row = db.execute(
        "SELECT id, username, name FROM users WHERE id = ?",
        (owner_id,),
    ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "name": row["name"],
        "display_name": row["name"],
    }


def _serialize_task(row: sqlite3.Row, db: sqlite3.Connection | None = None) -> dict[str, Any]:
    """将任务行序列化为前端可用的字典"""
    raw_params = json.loads(row["params"] or "{}")
    safe_params = {k: raw_params[k] for k in _TASK_PARAMS_PUBLIC_KEYS if k in raw_params}
    # 附加图片数量（若存在）但不暴露原始路径
    if isinstance(raw_params.get("image_paths"), list):
        safe_params["image_count"] = len(raw_params["image_paths"])
    owner = _owner_brief(db, int(row["owner_id"])) if db is not None else None
    return {
        "id": row["id"],
        "task_type": row["task_type"],
        "status": row["status"],
        "owner_id": row["owner_id"],
        "owner": owner,
        "progress": row["progress"],
        "upload_progress": row["upload_progress"],
        "total": row["total"],
        "message": row["message"],
        "result_data": json.loads(row["result_data"] or "{}"),
        "error_message": row["error_message"],
        "params": safe_params,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "completed_at": row["completed_at"],
    }


@app.get("/api/tasks")
def list_tasks(
    status: str | None = Query(None),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """获取当前用户的任务列表，支持 status 过滤，按 created_at DESC 排序"""
    if is_admin(user):
        sql = "SELECT * FROM tasks"
        params_list: list[Any] = []
        if status and status in {"uploading", "pending", "processing", "completed", "failed", "cancelled"}:
            sql += " WHERE status = ?"
            params_list.append(status)
        sql += " ORDER BY created_at DESC"
        rows = db.execute(sql, params_list).fetchall()
    else:
        sql = "SELECT * FROM tasks WHERE owner_id = ?"
        params_list: list[Any] = [int(user["id"])]
        if status and status in {"uploading", "pending", "processing", "completed", "failed", "cancelled"}:
            sql += " AND status = ?"
            params_list.append(status)
        sql += " ORDER BY created_at DESC"
        rows = db.execute(sql, params_list).fetchall()
    return {"tasks": [_serialize_task(row, db) for row in rows]}


@app.get("/api/tasks/{task_id}")
def get_task(
    task_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """获取单个任务详情。只能查看自己的任务（管理员可查看所有）"""
    row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "任务不存在")
    if not is_admin(user) and int(row["owner_id"]) != int(user["id"]):
        raise HTTPException(403, "无权查看此任务")
    return _serialize_task(row, db)


@app.post("/api/tasks/split-import")
async def create_split_import_task(
    name_prefix: str = Form(...),
    subject: str = Form(DEFAULT_RESOURCE_SUBJECT),
    tags: str = Form(""),
    resource_type: str = Form("asset"),
    secrecy_level: str = Form("public"),
    visibility_scope: str = Form("public"),
    visible_to_users: str = Form(""),
    management_scope: str = Form("private"),
    managed_by_users: str = Form(""),
    remark_html: str = Form(""),
    ppt_file: UploadFile = File(...),
    images: list[UploadFile] = File(...),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """异步批量拆分导入：创建任务记录后立即返回，后台线程执行拆分"""
    _validate_ppt_upload(ppt_file)
    visibility_scope = _validate_scope(visibility_scope)
    management_scope = _validate_scope(management_scope)
    secrecy_level = _validate_secrecy(secrecy_level)
    subject = _validate_template_subject("asset", subject)
    if resource_type not in {"asset", "template"}:
        raise HTTPException(400, "资源类型不正确")

    images = sorted(images, key=lambda f: _natural_sort_key(f.filename or ""))
    temp_dir = Path(tempfile.mkdtemp(prefix="task_split_"))

    # 保存上传文件到临时目录
    source_path = await save_upload(ppt_file, temp_dir, "source_")
    image_paths: list[str] = []
    for img in images:
        img_path = await save_upload(img, temp_dir, "img_")
        image_paths.append(str(img_path))

    # 校验 PPT 页数与图片数量
    n_slides = slide_count(source_path)
    if n_slides == 0:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(400, "无法读取 PPT 页数")
    if len(image_paths) != 0 and len(image_paths) != n_slides:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(400, f"PPT 共 {n_slides} 页，但提供了 {len(image_paths)} 张图片，数量不一致")

    # 创建 task 记录
    params = {
        "name_prefix": name_prefix,
        "subject": subject,
        "tags": tags,
        "resource_type": resource_type,
        "secrecy_level": secrecy_level,
        "visibility_scope": visibility_scope,
        "visible_user_ids": visible_to_users,
        "management_scope": management_scope,
        "manage_user_ids": managed_by_users,
        "remark_html": remark_html,
        "owner_id": int(user["id"]),
        "source_path": str(source_path),
        "image_paths": image_paths,
        "temp_dir": str(temp_dir),
        "status": "active",
    }
    db.execute(
        """
        INSERT INTO tasks (task_type, status, owner_id, params, progress, total)
        VALUES ('batch_split_import', 'pending', ?, ?, 0, 0)
        """,
        (int(user["id"]), json.dumps(params, ensure_ascii=False)),
    )
    task_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    db.commit()

    # 注册取消标志
    cancel_event = threading.Event()
    _task_cancel_flags[task_id] = cancel_event

    # 启动后台任务（带信号量控制）
    async def _run_with_semaphore() -> None:
        # 等待信号量前更新状态为排队中
        db_q = get_db()
        db_q.execute(
            "UPDATE tasks SET message = '排队中...', updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id = ?",
            (task_id,),
        )
        db_q.commit()
        db_q.close()

        async with _split_semaphore:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(
                None,
                _execute_split_task,
                task_id,
                str(source_path),
                image_paths,
                params,
            )

    future = asyncio.ensure_future(_run_with_semaphore())

    # 保留引用防止GC，并记录未捕获的异常
    def _on_task_done(f: asyncio.Future) -> None:  # type: ignore[type-arg]
        try:
            f.result()
        except Exception as e:
            logger.error("Background task %d failed with unhandled error: %s", task_id, e)

    future.add_done_callback(_on_task_done)
    _pending_task_futures[task_id] = future

    return {"task_id": task_id, "status": "pending"}


@app.post("/api/tasks/{task_id}/cancel")
def cancel_task(
    task_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """取消正在执行的任务"""
    row = db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "任务不存在")
    # 仅系统管理员/超级管理员可维护（取消）任务
    if not is_admin(user):
        raise HTTPException(403, "仅系统管理员可取消任务")
    if row["status"] not in {"uploading", "pending", "processing"}:
        raise HTTPException(400, f"任务状态为 {row['status']}，无法取消")

    # 设置取消标志
    cancel_event = _task_cancel_flags.get(task_id)
    if cancel_event:
        cancel_event.set()

    # uploading 状态时清理临时上传目录
    if row["status"] == "uploading":
        try:
            params = json.loads(row["params"] or "{}")
            temp_dir_str = params.get("temp_dir")
            if temp_dir_str:
                shutil.rmtree(Path(temp_dir_str), ignore_errors=True)
        except Exception:
            pass

    # 更新数据库状态
    db.execute(
        "UPDATE tasks SET status = 'cancelled',"
        " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
        " WHERE id = ?",
        (task_id,),
    )
    db.commit()
    return {"task_id": task_id, "status": "cancelled"}


@app.post("/api/admin/tasks/bulk-delete")
def bulk_delete_tasks(
    payload: TaskDeletePayload,
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """批量删除任务记录（仅删除数据库记录，不清理文件）"""
    task_ids = sorted({int(tid) for tid in payload.task_ids if int(tid) > 0})
    if not task_ids:
        raise HTTPException(400, "请选择要删除的任务")
    placeholders = ",".join("?" for _ in task_ids)
    cur = db.execute(f"DELETE FROM tasks WHERE id IN ({placeholders})", task_ids)
    db.commit()
    return {"ok": True, "deleted": cur.rowcount}


@app.delete("/api/admin/tasks/{task_id}")
def delete_task(
    task_id: int,
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """删除单个任务记录（仅删除数据库记录，不清理文件）"""
    row = db.execute("SELECT id FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "任务不存在")
    db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    db.commit()
    return {"ok": True}


# SPA fallback: 所有非 /api /static /storage 的 GET 都返回前端入口。
@app.get("/{full_path:path}", response_class=HTMLResponse, include_in_schema=False)
def spa_fallback(full_path: str) -> FileResponse:
    if (
        full_path.startswith("api/")
        or full_path == "api"
        or full_path.startswith("static/")
        or full_path.startswith("storage/")
    ):
        raise HTTPException(404)
    return _serve_spa()
