"""Services / downloads / cache."""

from __future__ import annotations

from app.config import settings
from pathlib import Path
from typing import Any
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import time


_DOWNLOAD_CACHE_DIR = settings.downloads_dir / "cache"


_DOWNLOAD_CACHE_TTL = 24 * 3600  # 24 小时


def _show_download_cache_key(
    show_id: int, dl_type: str, resources: list[dict[str, Any]],
    *, show_name: str = "", db: sqlite3.Connection | None = None,
) -> str:
    """Key only the authorized, ordered fixed versions used by this export.

    Metadata includes hidden flags, filenames and asset references so edits do
    not reuse stale output. Font changes and the name inside a font bundle
    also invalidate the cache. v3 excludes potentially incomplete old exports.
    """
    fonts = []
    if db is not None and dl_type in {"pptx_fonts", "zip_fonts", "pptx_embedded"}:
        fonts = [tuple(row) for row in db.execute(
            "SELECT family_name, aliases, file_path FROM fonts ORDER BY family_name, aliases, file_path"
        )]
    content = json.dumps([show_name, resources, fonts], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()[:24]
    return f"show_{show_id}_{dl_type}_v3_{content_hash}"


def _get_cached_download(cache_key: str, ext: str) -> Path | None:
    """如果缓存命中且未过期，返回缓存文件路径；否则返回 None。"""
    _DOWNLOAD_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached = _DOWNLOAD_CACHE_DIR / f"{cache_key}.{ext}"
    try:
        stat = cached.stat()
    except FileNotFoundError:
        return None
    age = time.time() - stat.st_mtime
    if age > _DOWNLOAD_CACHE_TTL or stat.st_size == 0:
        # Do not unlink here: a concurrent writer may already have published
        # a fresh replacement under the same name. Maintenance owns eviction.
        return None
    return cached


def _save_to_cache(src: Path, cache_key: str, ext: str) -> Path:
    """将生成的文件复制到缓存目录并返回缓存路径。"""
    _DOWNLOAD_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached = _DOWNLOAD_CACHE_DIR / f"{cache_key}.{ext}"
    fd, name = tempfile.mkstemp(prefix='.export-', suffix='.tmp', dir=_DOWNLOAD_CACHE_DIR)
    os.close(fd)
    staged = Path(name)
    try:
        shutil.copyfile(src, staged)
        os.replace(staged, cached)
    finally:
        staged.unlink(missing_ok=True)
    return cached


def _cleanup_expired_cache():
    """清理过期的下载缓存文件。"""
    if not _DOWNLOAD_CACHE_DIR.exists():
        return
    now = time.time()
    for f in _DOWNLOAD_CACHE_DIR.iterdir():
        try:
            if f.is_file() and (now - f.stat().st_mtime) > _DOWNLOAD_CACHE_TTL:
                f.unlink(missing_ok=True)
        except FileNotFoundError:
            continue  # Another worker may have evicted the same entry.
