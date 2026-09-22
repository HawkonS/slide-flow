"""Services / downloads / fonts."""

from __future__ import annotations

from app.core.fonts import normalize_font_name
from app.services.files import (
    _uploaded_font_abs,
)
from pathlib import Path
import json
import sqlite3
import zipfile


def _font_aliases_from_row(row: sqlite3.Row) -> list[str]:
    """从 fonts 表行读取当前格式的别名 JSON 列表。"""
    raw = row["aliases"]
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
