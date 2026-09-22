"""Snapshot trusted standard-font files for the remote rendering attempt."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import struct
import uuid
from pathlib import Path

from app.config import settings
from app.core.fonts import normalize_font_name
from app.db import get_db
from fontTools.ttLib import TTFont, TTCollection


MAX_FONT_BYTES = 64 * 1024 * 1024
MAX_FONT_TOTAL_BYTES = 96 * 1024 * 1024


def sha256_file(path: Path, check=None) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            if check:
                check()
            digest.update(chunk)
    return digest.hexdigest()


def _font_metadata(path):
    fonts, collection, source = [], None, None
    try:
        # Own the stream even when the fontTools constructor raises before
        # returning a font object (malformed input otherwise leaks its handle).
        source = path.open("rb")
        if path.suffix.lower() in {".ttc", ".otc"}:
            header = source.read(12)
            if len(header) != 12 or header[:4] != b"ttcf" or not 1 <= struct.unpack(">I", header[8:12])[0] <= 64:
                raise ValueError("Invalid font collection size")
            source.seek(0)
            collection = TTCollection(source, lazy=True)
            fonts = collection.fonts
        else:
            fonts = [TTFont(source, lazy=True)]
        if not 1 <= len(fonts) <= 64:
            raise ValueError("Invalid font collection")
        names, faces = set(), set()
        for font in fonts:
            if any(table not in font for table in ("name", "head", "maxp")):
                raise ValueError("Missing required font tables")
            for record in font["name"].names:
                if record.nameID not in {1, 4, 6, 16}:
                    continue
                name = record.toUnicode().strip()
                if not name:
                    continue
                if len(name) > 256 or any(ord(char) < 32 for char in name):
                    raise ValueError("Invalid font name")
                names.add(name)
                if record.nameID in {4, 6}:
                    faces.add(name)
        if not names or not faces or len(names) > 128 or len(faces) > 128:
            raise ValueError("Invalid font metadata")
        return sorted(names), sorted(faces)
    except Exception as exc:
        raise RuntimeError("标准字体文件损坏或名称无效，请管理员重新上传字体") from exc
    finally:
        for font in fonts:
            font.close()
        if collection is not None:
            collection.close()
        if source is not None:
            source.close()


def font_faces(path):
    return _font_metadata(path)[1]


def _copy_snapshot(source, temporary, check):
    """Bound actual bytes, and reject replacement/in-place edits while copying."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(source, flags)
        with os.fdopen(descriptor, "rb") as content, temporary.open("xb") as output:
            before = os.fstat(content.fileno())
            if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_FONT_BYTES:
                raise RuntimeError("标准字体文件不是有效的普通文件或超过 64 MiB")
            digest, size = hashlib.sha256(), 0
            for chunk in iter(lambda: content.read(1024 * 1024), b""):
                check()
                size += len(chunk)
                if size > MAX_FONT_BYTES:
                    raise RuntimeError("标准字体文件超过 64 MiB")
                output.write(chunk)
                digest.update(chunk)
            after = os.fstat(content.fileno())
            if size != before.st_size or (before.st_mtime_ns, before.st_ctime_ns) != (after.st_mtime_ns, after.st_ctime_ns):
                raise RuntimeError("标准字体在复制期间发生变化，请重新渲染")
            return digest.hexdigest(), size
    except RuntimeError:
        raise
    except OSError as exc:
        raise RuntimeError("标准字体文件不可读取，请管理员重新上传字体") from exc


def snapshot_fonts(names: list[str], directory: Path, *, check=None) -> list[dict]:
    """Include every matching style/collection, not an arbitrary first family.

    Copies are attempt-local so deleting/changing the standard font library
    while a job queues cannot change the inputs halfway through a render.
    Custom display names are not evidence that a font actually has that name.
    """
    check = check or (lambda: None)
    check()
    if not isinstance(names, list) or len(names) > 128 or any(
        not isinstance(n, str) or not n.strip() or len(n) > 256 for n in names
    ):
        raise RuntimeError("本次所需字体名称过多或格式无效")
    wanted = {normalize_font_name(n): n for n in names if not n.startswith("+")}
    if not wanted:
        return []
    db = get_db()
    try:
        rows = db.execute("SELECT aliases, file_path FROM fonts").fetchall()
    finally:
        db.close()
    directory.mkdir(parents=True, exist_ok=True)
    files, found, total, faces, created = {}, set(), 0, {}, []
    root = settings.fonts_dir.resolve()
    try:
        for row in rows:
            check()
            try:
                aliases = json.loads(row["aliases"] or "[]")
            except (ValueError, TypeError):
                continue
            if not isinstance(aliases, list) or not wanted.keys() & {normalize_font_name(n) for n in aliases if isinstance(n, str)}:
                continue
            source = settings.abs_path(row["file_path"])
            if source is None or source.is_symlink():
                raise RuntimeError("标准字体文件不可读取，请管理员重新上传字体")
            try:
                source = source.resolve(strict=True)
                source.relative_to(root)
            except (ValueError, OSError) as exc:
                raise RuntimeError("标准字体文件路径无效") from exc
            if source.suffix.lower() not in {".ttf", ".otf", ".ttc", ".otc"}:
                raise RuntimeError("标准字体文件格式无效")
            if shutil.disk_usage(directory).free < MAX_FONT_BYTES + 256 * 1024 * 1024:
                raise RuntimeError("主服务器临时空间不足，无法固定字体文件")
            temporary = directory / (uuid.uuid4().hex + source.suffix.lower())
            created.append(temporary)
            sha, size = _copy_snapshot(source, temporary, check)
            if sha in files:
                temporary.unlink()
                continue
            total += size
            if total > MAX_FONT_TOTAL_BYTES or len(files) >= 64:
                raise RuntimeError("本次所需字体包过大，请减少字体种类")
            aliases, font_face_names = _font_metadata(temporary)
            for face in font_face_names:
                # Match the renderer's face identity; family names may be shared
                # by regular/bold/italic styles, full face names may not.
                key = " ".join(face.lstrip("@").split()).casefold()
                if key in faces and faces[key] != sha:
                    raise RuntimeError("标准字体库含同名但版本不同的字体，请统一后重试")
                faces[key] = sha
            found.update(normalize_font_name(n) for n in aliases)
            files[sha] = {"path": temporary, "sha256": sha, "names": aliases, "faces": font_face_names}
        missing = wanted.keys() - found
        if missing:
            raise RuntimeError("标准字体的真实名称与 PPT 不匹配或文件缺失：" + "、".join(wanted[n] for n in sorted(missing)))
        check()
        return list(files.values())
    except BaseException:
        for path in created:
            path.unlink(missing_ok=True)
        raise
