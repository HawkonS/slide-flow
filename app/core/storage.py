from __future__ import annotations

from app.config import settings
from app.core.oss import StorageConfigurationError
from app.core.oss import oss_ref
from app.core.oss import storage as oss_storage
from fastapi import HTTPException
from fastapi import UploadFile
from pathlib import Path
import asyncio
import mimetypes
import re
import shutil
import uuid


SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._\-\u4e00-\u9fff]+")
# 仅允许形如 .pptx/.png/.ttf/.otf/.ttc 等的安全扩展名，防御非法/超长/含乱码的后缀
_SAFE_SUFFIX_RE = re.compile(r"^\.[A-Za-z0-9]{1,8}$")


def safe_filename(filename: str) -> str:
    cleaned = SAFE_FILENAME_RE.sub("_", filename.strip()).strip("._")
    return cleaned or "file"


def safe_suffix(filename: str | None, default: str = ".bin") -> str:
    """提取文件名的安全扩展名。

    规则：取 Path(filename).suffix 并转小写；若为空、含特殊字符或超长，则回退到 default。
    用于生成短磁盘名（不再保留原始文件名 stem）。
    """
    if not filename:
        return default
    suffix = Path(filename).suffix.lower()
    if not _SAFE_SUFFIX_RE.match(suffix):
        return default
    return suffix


def unique_child_dir(parent: Path) -> Path:
    path = parent / uuid.uuid4().hex
    path.mkdir(parents=True, exist_ok=False)
    return path


async def save_upload(upload: UploadFile, dest_dir: Path, prefix: str = "") -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    # 统一短命名：prefix + 10 位 hex + 安全扩展名；不再带用户原始文件名
    suffix = safe_suffix(upload.filename)
    target = dest_dir / f"{prefix}{uuid.uuid4().hex[:10]}{suffix}"
    with target.open("wb") as handle:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    await upload.seek(0)
    return target


def _upload_size(upload: UploadFile) -> int:
    """Return an upload size without consuming its seekable spool."""
    if upload.size is not None:
        return int(upload.size)
    fileobj = upload.file
    current = fileobj.tell()
    fileobj.seek(0, 2)
    size = int(fileobj.tell())
    fileobj.seek(current)
    return size


async def stage_upload_via_oss(
    upload: UploadFile,
    dest_dir: Path,
    prefix: str = "",
    *,
    max_bytes: int | None = None,
    total_bytes: int = 0,
    total_limit: int | None = None,
) -> tuple[Path, int]:
    """Upload to OSS temporary storage, then materialize for local processing.

    The temporary object lives under ``_incoming`` and is deleted as soon as
    the local staging copy has been size-verified. Final processed files are
    uploaded separately by ``persist_asset``.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    size = _upload_size(upload)
    if max_bytes is not None and size > max_bytes:
        raise HTTPException(413, "上传文件过大，请压缩后重试")
    if total_limit is not None and total_bytes + size > total_limit:
        raise HTTPException(413, "本批导入文件总大小超过 10 GB")

    suffix = safe_suffix(upload.filename)
    target = dest_dir / f"{prefix}{uuid.uuid4().hex[:10]}{suffix}"
    key = oss_storage.key("_incoming", suffix)
    ref: str | None = None
    try:
        await upload.seek(0)
        ref = await asyncio.to_thread(
            oss_storage.upload_fileobj,
            upload.file,
            key,
            content_type=mimetypes.guess_type(upload.filename or "")[0],
        )
        await asyncio.to_thread(oss_storage.download_file, ref, target)
        if target.stat().st_size != size:
            raise RuntimeError("OSS 临时对象下载不完整")
        return target, size
    except Exception:
        target.unlink(missing_ok=True)
        raise
    finally:
        await upload.seek(0)
        cleanup_ref = ref or oss_ref(key)
        if cleanup_ref:
            try:
                await asyncio.to_thread(oss_storage.delete, cleanup_ref)
            except Exception:
                # The _incoming prefix should also have an OSS lifecycle rule.
                pass


async def save_upload(
    upload: UploadFile,
    dest_dir: Path,
    prefix: str = "",
    *,
    stage_oss: bool = False,
) -> Path:
    backend = settings.storage_backend.strip().lower()
    if stage_oss:
        if backend == "oss":
            target, _ = await stage_upload_via_oss(upload, dest_dir, prefix)
            return target
        if backend != "local":
            raise StorageConfigurationError("storage.backend 只能配置为 local 或 oss")
    dest_dir.mkdir(parents=True, exist_ok=True)
    # 统一短命名：prefix + 10 位 hex + 安全扩展名；不再带用户原始文件名
    suffix = safe_suffix(upload.filename)
    target = dest_dir / f"{prefix}{uuid.uuid4().hex[:10]}{suffix}"
    with target.open("wb") as handle:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    await upload.seek(0)
    return target


def copy_into(src: Path, dest_dir: Path, prefix: str = "") -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    # 统一短命名：prefix + 10 位 hex + 安全扩展名；不再保留源文件名 stem
    suffix = safe_suffix(src.name)
    target = dest_dir / f"{prefix}{uuid.uuid4().hex[:10]}{suffix}"
    shutil.copy2(src, target)
    return target
