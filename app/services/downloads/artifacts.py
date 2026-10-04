"""Validate complete exports and keep archive member names unambiguous."""

from __future__ import annotations

from pathlib import Path
from typing import Any
import unicodedata

from fastapi import HTTPException

from app.core.storage import safe_filename
from app.services.files import _resource_file_abs


def require_export_asset(ref: str | None) -> Path:
    path = _resource_file_abs(ref)
    if path is None or not path.is_file():
        raise HTTPException(409, "放映中的文件缺失或暂时无法读取，未生成不完整下载；请重试或联系管理员修复素材")
    return path


def export_archive_names(items: list[dict[str, Any]]) -> list[str]:
    """Preserve normal names and disambiguate collisions on Windows/macOS too."""
    bases = [f"{safe_filename(item['name'])}_v{item['version_no']}" for item in items]
    key = lambda value: unicodedata.normalize('NFC', value).casefold()
    reserved = {key(base) for base in bases}
    used: set[str] = set()
    result = []
    for base in bases:
        name = base
        suffix = 2
        while key(name) in used or (name != base and key(name) in reserved):
            name = f"{base}_{suffix}"
            suffix += 1
        used.add(key(name))
        result.append(name + '.pptx')
    return result
