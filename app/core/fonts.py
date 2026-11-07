from __future__ import annotations

from pathlib import Path
from dataclasses import dataclass
from functools import lru_cache

from fontTools.ttLib import TTCollection, TTFont


FONT_EXTENSIONS = {".ttf", ".otf", ".ttc", ".otc"}


class FontResolutionError(ValueError):
    """A known alias cannot safely identify a font face."""


@dataclass(frozen=True)
class FontFaceNames:
    index: int
    family: str
    aliases: tuple[str, ...]
    specific_aliases: tuple[str, ...]


def preferred_font_name(font: TTFont, name_id: int) -> str:
    """Use a consistent Windows/English name record for Office metadata."""
    candidates = []
    for record in font["name"].names:
        if record.nameID != name_id:
            continue
        try:
            value = record.toUnicode().strip()
        except Exception:
            continue
        if value:
            candidates.append((record, value))
    candidates.sort(key=lambda item: (
        item[0].platformID != 3, item[0].langID != 0x409,
        item[0].langID, item[1],
    ))
    return candidates[0][1] if candidates else ""


def describe_font_names(font: TTFont, index: int = 0) -> FontFaceNames:
    records = []
    for record in font["name"].names:
        if record.nameID not in {1, 4, 6, 16}:
            continue
        try:
            name = record.toUnicode().strip()
        except Exception:
            continue
        if name:
            records.append((record, name))
    # Name ID 1 is the style-linked family Office can actually select. ID 16
    # may span many weights with distinct ID 1 families; filenames and custom
    # display labels are lookup aliases only, never output typefaces.
    family = preferred_font_name(font, 1)
    if not family:
        raise FontResolutionError("字体文件缺少真实家族名称（name ID 1）")
    return FontFaceNames(
        index, family,
        tuple(dict.fromkeys(name for _, name in records)),
        tuple(dict.fromkeys(name for record, name in records if record.nameID in {1, 4, 6})),
    )


@lru_cache(maxsize=256)
def _cached_font_faces(path: str, size: int, modified: int) -> tuple[FontFaceNames, ...]:
    if Path(path).suffix.lower() in {".ttc", ".otc"}:
        with TTCollection(path, lazy=True) as collection:
            return tuple(describe_font_names(font, index) for index, font in enumerate(collection.fonts))
    with TTFont(path, lazy=True) as font:
        return (describe_font_names(font),)


def read_font_faces(path: Path) -> tuple[FontFaceNames, ...]:
    stat = path.stat()
    return _cached_font_faces(str(path.resolve()), stat.st_size, stat.st_mtime_ns)


def normalize_font_name(name: str) -> str:
    """归一化字体名：小写、去连字符/下划线、压缩空白，便于匹配。"""
    return "".join(name.lstrip("@").casefold().replace("-", "").replace("_", "").split())


def is_font_extension(path: Path) -> bool:
    return path.suffix.lower() in FONT_EXTENSIONS


def _names_from_ttfont(font: TTFont) -> set[str]:
    names: set[str] = set()
    for record in font["name"].names:
        if record.nameID not in {1, 4, 6, 16}:
            continue
        try:
            text = record.toUnicode().strip()
        except Exception:
            continue
        if text:
            names.add(text)
    return names


def read_font_names(path: Path) -> set[str]:
    """解析字体文件，返回所有可识别的别名集合（含文件名 stem）。"""
    if not is_font_extension(path):
        return set()
    names: set[str] = set()
    try:
        if path.suffix.lower() in {".ttc", ".otc"}:
            with TTCollection(str(path)) as collection:
                for font in collection.fonts:
                    names.update(_names_from_ttfont(font))
        else:
            font = TTFont(str(path), lazy=True)
            names.update(_names_from_ttfont(font))
            font.close()
    except Exception:
        return set()
    names.add(path.stem)
    return {name for name in names if name}


def validate_font_file(path: Path) -> tuple[bool, set[str]]:
    names = read_font_names(path)
    return bool(names), names


def missing_fonts(font_names: list[str], known_aliases: set[str]) -> list[str]:
    """检测 PPT 引用字体中，在已上传字体（known_aliases：归一化别名集合）里缺失的项。"""
    missing: list[str] = []
    for name in font_names:
        cleaned = name.strip()
        if not cleaned or cleaned.startswith("+"):
            continue
        if normalize_font_name(cleaned) not in known_aliases:
            missing.append(cleaned)
    return sorted(set(missing), key=str.lower)
