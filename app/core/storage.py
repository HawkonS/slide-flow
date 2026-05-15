from __future__ import annotations

import re
import shutil
import uuid
from pathlib import Path

from fastapi import UploadFile


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


def copy_into(src: Path, dest_dir: Path, prefix: str = "") -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    # 统一短命名：prefix + 10 位 hex + 安全扩展名；不再保留源文件名 stem
    suffix = safe_suffix(src.name)
    target = dest_dir / f"{prefix}{uuid.uuid4().hex[:10]}{suffix}"
    shutil.copy2(src, target)
    return target
