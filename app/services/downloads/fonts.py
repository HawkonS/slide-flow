"""Services / downloads / fonts."""

from __future__ import annotations

from app.core.fonts import FontResolutionError, normalize_font_name, read_font_faces
from app.core.ppt_modules.fonts import FONT_NAMESPACES, replace_typefaces, strip_embedded_fonts
from app.services.files import (
    _uploaded_font_abs,
)
from pathlib import Path
from dataclasses import dataclass
from io import BytesIO
import json
import sqlite3
import zipfile
import xml.etree.ElementTree as ET


@dataclass(frozen=True)
class FontMatch:
    source_index: int
    face_index: int
    typeface: str


def resolve_font_typefaces(
    names: list[str], sources: list[tuple[str, tuple[str, ...], Path]],
) -> dict[str, tuple[FontMatch, ...]]:
    """Resolve aliases through the name table, rejecting ambiguous weights."""
    candidates = []
    for index, (display_name, aliases, path) in enumerate(sources):
        if not path.is_file():
            continue
        try:
            faces = read_font_faces(path)
        except Exception as exc:
            # A broken unrelated library entry must not prevent other exports.
            if any(normalize_font_name(name) in {normalize_font_name(a) for a in (display_name, *aliases)} for name in names):
                raise FontResolutionError(f"字体「{display_name}」文件无法解析") from exc
            continue
        for face in faces:
            actual = {normalize_font_name(name) for name in face.aliases}
            specific = {normalize_font_name(name) for name in face.specific_aliases}
            stored = {normalize_font_name(name) for name in (display_name, *aliases)}
            # A collection's display alias cannot select an arbitrary face.
            candidates.append((FontMatch(index, face.index, face.family), specific, actual, stored))
    result = {}
    for name in names:
        key = normalize_font_name(name)
        if not key or name.lstrip("@").startswith("+"):
            continue
        exact = [match for match, specific, _, _ in candidates if key in specific]
        actual = [match for match, _, aliases, _ in candidates if key in aliases]
        stored = [match for match, _, _, aliases in candidates if key in aliases]
        matches = exact or actual or stored
        if not matches:
            continue
        if len({normalize_font_name(match.typeface) for match in matches}) != 1:
            raise FontResolutionError(f"字体「{name}」对应多个字重或家族，请指定具体字体名称")
        result[name] = tuple(matches)
    return result


def normalized_pptx_bytes(ppt_path: Path, db: sqlite3.Connection) -> bytes:
    """Return an export copy with actual families in every font declaration."""
    content = ppt_path.read_bytes()
    rows = db.execute("SELECT family_name, aliases, file_path FROM fonts").fetchall()
    sources = []
    for row in rows:
        path = _uploaded_font_abs(row["file_path"])
        if path is not None:
            sources.append((row["family_name"] or "", tuple(_font_aliases_from_row(row)), path))
    # Legacy callers can serve non-ZIP files; name repair only applies to PPTX.
    if not zipfile.is_zipfile(BytesIO(content)):
        return content
    with zipfile.ZipFile(BytesIO(content)) as original:
        parts = {info.filename: original.read(info.filename) for info in original.infolist()}
        changed = strip_embedded_fonts(parts)
        names = set()
        for name, data in parts.items():
            if name.startswith("ppt/") and name.lower().endswith(".xml"):
                for node in ET.fromstring(data).iter():
                    namespace, _, local = node.tag.rpartition("}")
                    if namespace.removeprefix("{") in FONT_NAMESPACES and local in {"latin", "ea", "cs", "sym", "font", "buFont"}:
                        if value := node.get("typeface"):
                            names.add(value)
        resolved = resolve_font_typefaces(sorted(names), sources)
        replacements = {name: matches[0].typeface for name, matches in resolved.items()}
        for name, data in parts.items():
            if name.startswith("ppt/") and name.lower().endswith(".xml"):
                parts[name] = replace_typefaces(data, replacements)
                changed |= parts[name] != data
        if not changed:
            return content
        output = BytesIO()
        with zipfile.ZipFile(output, "w") as package:
            package.comment = original.comment
            for info in original.infolist():
                if info.filename in parts:
                    package.writestr(info, parts[info.filename])
        return output.getvalue()


def normalize_export_fonts(ppt_path: Path, db: sqlite3.Connection) -> None:
    """Normalize a generated temporary export, never a stored source asset."""
    content = normalized_pptx_bytes(ppt_path, db)
    ppt_path.write_bytes(content)


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
