from __future__ import annotations

from pathlib import Path

from fontTools.ttLib import TTCollection, TTFont


FONT_EXTENSIONS = {".ttf", ".otf", ".ttc", ".otc"}


def normalize_font_name(name: str) -> str:
    """归一化字体名：小写、去连字符/下划线、压缩空白，便于匹配。"""
    return "".join(name.lower().replace("-", "").replace("_", "").split())


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
            collection = TTCollection(str(path))
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
