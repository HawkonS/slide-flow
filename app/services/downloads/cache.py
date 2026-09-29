"""Services / downloads / cache."""

from __future__ import annotations

from app.config import settings
from pathlib import Path
from typing import Any
import hashlib
import json
import shutil
import time


_DOWNLOAD_CACHE_DIR = settings.downloads_dir / "cache"


_DOWNLOAD_CACHE_TTL = 24 * 3600  # 24 小时


def _show_download_cache_key(show_id: int, dl_type: str, resources: list[dict[str, Any]]) -> str:
    """Key only the authorized, ordered fixed versions used by this export.

    Metadata includes hidden flags, filenames and asset references so edits do
    not reuse stale output. The v2 namespace excludes legacy shared caches,
    which may contain another user's broader or narrower resource selection.
    """
    content = json.dumps(resources, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()[:24]
    return f"show_{show_id}_{dl_type}_v2_{content_hash}"


def _get_cached_download(cache_key: str, ext: str) -> Path | None:
    """如果缓存命中且未过期，返回缓存文件路径；否则返回 None。"""
    _DOWNLOAD_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached = _DOWNLOAD_CACHE_DIR / f"{cache_key}.{ext}"
    if not cached.exists():
        return None
    age = time.time() - cached.stat().st_mtime
    if age > _DOWNLOAD_CACHE_TTL:
        cached.unlink(missing_ok=True)
        return None
    return cached


def _save_to_cache(src: Path, cache_key: str, ext: str) -> Path:
    """将生成的文件复制到缓存目录并返回缓存路径。"""
    _DOWNLOAD_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached = _DOWNLOAD_CACHE_DIR / f"{cache_key}.{ext}"
    shutil.copy2(src, cached)
    return cached


def _cleanup_expired_cache():
    """清理过期的下载缓存文件。"""
    if not _DOWNLOAD_CACHE_DIR.exists():
        return
    now = time.time()
    for f in _DOWNLOAD_CACHE_DIR.iterdir():
        if f.is_file() and (now - f.stat().st_mtime) > _DOWNLOAD_CACHE_TTL:
            f.unlink(missing_ok=True)
