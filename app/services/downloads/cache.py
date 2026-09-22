"""Services / downloads / cache."""

from __future__ import annotations

from app.config import settings
from pathlib import Path
import shutil
import sqlite3
import time


_DOWNLOAD_CACHE_DIR = settings.downloads_dir / "cache"


_DOWNLOAD_CACHE_TTL = 24 * 3600  # 24 小时


def _show_download_cache_key(show_id: int, dl_type: str, db: sqlite3.Connection) -> str:
    """基于 show_id + 资源版本列表生成缓存文件名。"""
    import hashlib
    rows = db.execute(
        "SELECT sr.resource_id, sr.version_no FROM show_resources sr WHERE sr.show_id = ? ORDER BY sr.sort_order",
        (show_id,),
    ).fetchall()
    parts = [f"{r['resource_id']}v{r['version_no']}" for r in rows]
    content_hash = hashlib.md5("|".join(parts).encode()).hexdigest()[:12]
    return f"show_{show_id}_{dl_type}_{content_hash}"


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
