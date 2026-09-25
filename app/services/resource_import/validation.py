"""Services / resource import / validation."""

from __future__ import annotations

from PIL import Image
from app.config import settings
from app.core.fonts import normalize_font_name
from app.core.oss import StorageConfigurationError
from app.core.storage import safe_suffix
from app.core.storage import stage_upload_via_oss
from app.services.resource_import.limits import (
    RESOURCE_IMPORT_MAX_IMAGE_PIXELS,
    RESOURCE_IMPORT_MAX_NAME_LENGTH,
    RESOURCE_IMPORT_MAX_PPT_ENTRIES,
    RESOURCE_IMPORT_MAX_PPT_UNCOMPRESSED_BYTES,
    RESOURCE_IMPORT_MAX_SCOPE_USERS,
    RESOURCE_IMPORT_MAX_TAGS_LENGTH,
    RESOURCE_IMPORT_MAX_TOTAL_BYTES,
)
from app.services.resources import _normalise_scope_tags
from fastapi import HTTPException
from fastapi import Request
from fastapi import UploadFile
from pathlib import Path
from typing import Any
import sqlite3
import uuid
import zipfile


# Keep the origin allow-list beside the origin validator.  The application
# factory uses the same setting for CORS, while this dependency protects the
# state-changing wizard endpoints before they reach business logic.
_allowed_origins = [
    origin.strip()
    for origin in settings.allowed_host.split(",")
    if origin.strip()
]


async def _save_resource_import_upload(
    upload: UploadFile,
    dest_dir: Path,
    prefix: str,
    *,
    max_bytes: int,
    total_bytes: int,
    stage_oss: bool = False,
) -> tuple[Path, int]:
    """Save one wizard upload with a hard per-file and batch byte limit.

    ``UploadFile`` is streamed in chunks so the limit applies even when the
    client omits a Content-Length header.  The partially written file is
    removed on every failure; callers can safely remove the whole temp
    session afterwards.
    """
    if stage_oss:
        backend = settings.storage_backend.strip().lower()
        if backend == "oss":
            return await stage_upload_via_oss(
                upload,
                dest_dir,
                prefix,
                max_bytes=max_bytes,
                total_bytes=total_bytes,
                total_limit=RESOURCE_IMPORT_MAX_TOTAL_BYTES,
            )
        if backend != "local":
            raise StorageConfigurationError("storage.backend 只能配置为 local 或 oss")
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / f"{prefix}{uuid.uuid4().hex[:10]}{safe_suffix(upload.filename)}"
    written = 0
    try:
        with target.open("wb") as handle:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    raise HTTPException(413, "导入文件过大，请压缩后重试")
                if total_bytes + written > RESOURCE_IMPORT_MAX_TOTAL_BYTES:
                    raise HTTPException(413, "本批导入文件总大小超过 10 GB")
                handle.write(chunk)
        await upload.seek(0)
        return target, written
    except Exception:
        target.unlink(missing_ok=True)
        raise


def _validate_import_ppt_package(path: Path) -> None:
    """Reject zip bombs/path-like entries before PPT parsing/rendering."""
    try:
        with zipfile.ZipFile(path) as package:
            infos = package.infolist()
            if len(infos) > RESOURCE_IMPORT_MAX_PPT_ENTRIES:
                raise HTTPException(413, "PPT 内部文件数量过多，无法安全导入")
            total_uncompressed = 0
            seen = set()
            for info in infos:
                name = str(info.filename).replace("\\", "/")
                if name in seen or info.flag_bits & 1 or (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise HTTPException(400, "PPT 包含重复、加密或符号链接内容")
                seen.add(name)
                # The import pipeline never needs absolute or parent-relative
                # package members. Reject them rather than allowing a later
                # converter/library to interpret them unexpectedly.
                if name.startswith("/") or name == ".." or name.startswith("../") or "/../" in name:
                    raise HTTPException(400, "PPT 包含非法文件路径")
                total_uncompressed += max(0, int(info.file_size))
                if total_uncompressed > RESOURCE_IMPORT_MAX_PPT_UNCOMPRESSED_BYTES:
                    raise HTTPException(413, "PPT 解压后体积过大，无法安全导入")
                if name.lower().endswith((".xml", ".rels")):
                    if info.file_size > 16 * 1024 * 1024:
                        raise HTTPException(413, "PPT 单个 XML 文件过大")
                    content = package.read(info).replace(b"\x00", b"")
                    if b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
                        raise HTTPException(400, "PPT XML 含不安全的实体声明")
                    if name.lower().endswith(".rels"):
                        from xml.etree import ElementTree as ET
                        for rel in ET.fromstring(package.read(info)):
                            if rel.get("TargetMode", "").lower() == "external" and not rel.get("Type", "").endswith("/hyperlink"):
                                raise HTTPException(400, "PPT 包含外部链接资源，请嵌入资源后重试")
                if name.lower().endswith("vbaproject.bin") or "/activex/" in name.lower():
                    raise HTTPException(400, "PPT 包含宏或活动控件，无法安全导入")
    except HTTPException:
        raise
    except (OSError, zipfile.BadZipFile, ValueError) as exc:
        # Keep the existing parser's useful handling for malformed legacy
        # files, but do not allow an unreadable package into the renderer.
        raise HTTPException(400, "PPT 文件损坏或格式不正确") from exc


def _validate_import_image(path: Path) -> None:
    """Verify image magic/format and bound decoded pixel count."""
    try:
        with Image.open(path) as image:
            width, height = image.size
            if width <= 0 or height <= 0 or width * height > RESOURCE_IMPORT_MAX_IMAGE_PIXELS:
                raise HTTPException(413, "图片分辨率过大，请压缩后重试")
            expected_format = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".webp": "WEBP"}.get(path.suffix.lower())
            if (image.format or "").upper() != expected_format:
                raise HTTPException(400, "图片内容与扩展名不匹配，仅支持 PNG/JPG/JPEG/WEBP")
            image.verify()
        # ``verify`` alone does not decode JPEG/WebP pixel data and can miss
        # truncated files. Pixel and byte limits have already bounded this.
        with Image.open(path) as image:
            image.load()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, "图片内容无法解析，请重新选择图片") from exc


def _validate_resource_import_replacements(
    session: dict[str, Any], replacements: dict[str, str], known_aliases: set[str],
) -> dict[str, str]:
    """Allow only bounded substitutions for fonts detected in this source."""
    if not replacements or len(replacements) > 500:
        raise HTTPException(400, "请选择要替换的字体，每次最多替换 500 项")
    source_fonts = set(session.get("fonts", []))
    result: dict[str, str] = {}
    for old, new in replacements.items():
        if not isinstance(old, str) or not isinstance(new, str) or not old or not new or len(old) > 256 or len(new) > 256:
            raise HTTPException(400, "字体替换名称不正确")
        if old not in source_fonts:
            raise HTTPException(400, "只能替换此 PPT 中检测到的字体，请重新检测后重试")
        if normalize_font_name(new) not in known_aliases:
            raise HTTPException(400, "字体替换目标必须来自标准字体库")
        if old != new:
            result[old] = new
    if not result:
        raise HTTPException(400, "请选择与原字体不同的替换目标")
    return result


def _validate_resource_import_payload(payload: dict[str, Any], db: sqlite3.Connection) -> dict[str, Any]:
    """Validate metadata before any split/output/database work is started."""
    field_limits = {
        "name_prefix": (RESOURCE_IMPORT_MAX_NAME_LENGTH, "名称前缀"),
        "subject": (80, "主体"),
        "tags": (RESOURCE_IMPORT_MAX_TAGS_LENGTH, "标签"),
        "remark_html": (100_000, "备注"),
        "secrecy_level": (32, "密级"),
        "status": (32, "状态"),
        "visibility_scope": (32, "可见范围"),
        "management_scope": (32, "管理范围"),
    }
    for key, (limit, label) in field_limits.items():
        if key in payload and (not isinstance(payload[key], str) or len(payload[key]) > limit):
            raise HTTPException(400, f"{label}格式不正确或超过 {limit} 个字符")
    checked = dict(payload)
    for field, label in (("visible_user_ids", "可见用户"), ("manage_user_ids", "管理用户")):
        values = payload.get(field, [])
        if not isinstance(values, list) or len(values) > RESOURCE_IMPORT_MAX_SCOPE_USERS or any(type(value) is not int or value <= 0 for value in values):
            raise HTTPException(400, f"{label}必须是用户 ID 列表，且不能超过 {RESOURCE_IMPORT_MAX_SCOPE_USERS} 人")
        ids = sorted(set(values))
        if ids:
            placeholders = ",".join("?" for _ in ids)
            existing = {int(row["id"]) for row in db.execute(f"SELECT id FROM users WHERE id IN ({placeholders})", ids).fetchall()}
            if existing != set(ids):
                raise HTTPException(400, f"{label}中存在已删除或无效的用户，请重新选择")
        checked[field] = ids
    for field in ("visible_user_tags", "manage_user_tags"):
        values = payload.get(field, [])
        checked[field] = _normalise_scope_tags(db, values)
    return checked


def _require_resource_import_origin(request: Request) -> None:
    """Reject cross-site cookie requests for the state-changing wizard APIs."""
    origin = request.headers.get("origin", "").strip()
    fetch_site = request.headers.get("sec-fetch-site", "").strip().lower()
    if fetch_site == "same-origin":
        # Browser-controlled metadata preserves the original origin through
        # trusted dev/reverse proxies that rewrite the backend Host header.
        return
    if not origin:
        if fetch_site == "cross-site":
            raise HTTPException(403, "跨站请求已拒绝")
        return
    host = request.headers.get("host", "").strip()
    same_origin = f"{request.url.scheme}://{host}" if host else ""
    if origin != same_origin and origin not in _allowed_origins:
        raise HTTPException(403, "请求来源不受信任，请刷新页面后重试")
