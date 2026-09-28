"""Embed licensed font files into a PowerPoint package."""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
import hashlib
import json
import logging
import os
import posixpath
import sqlite3
import struct
import threading
import zipfile
import xml.etree.ElementTree as ET

from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTCollection, TTFont, newTable

from app.config import settings
from app.core.oss import is_oss_ref, storage as oss_storage
from app.core.fonts import normalize_font_name
from app.db import now_iso
from app.services.files import _uploaded_font_abs


P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
FONT_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"
FONT_CONTENT_TYPE = "application/x-fontdata"
EMBEDDED_FONT_CACHE_VERSION = "v1"

ET.register_namespace("p", P_NS)
ET.register_namespace("r", R_NS)
ET.register_namespace("", REL_NS)

logger = logging.getLogger(__name__)
_EMBEDDED_CACHE_LOCK = threading.RLock()


class FontEmbeddingError(ValueError):
    """The resource cannot be safely packaged with all referenced fonts."""


@dataclass(frozen=True)
class FontRow:
    family_name: str
    aliases: tuple[str, ...]
    path: Path
    font_id: int | None = None


def _font_rows(db: sqlite3.Connection) -> tuple[dict[str, FontRow], list[FontRow]]:
    rows = db.execute("SELECT id, family_name, aliases, file_path FROM fonts ORDER BY id").fetchall()
    by_alias: dict[str, FontRow] = {}
    all_rows: list[FontRow] = []
    for row in rows:
        path = _uploaded_font_abs(row["file_path"])
        if path is None:
            continue
        source_available = path.is_file()
        if not source_available:
            try:
                source_available = db.execute(
                    "SELECT 1 FROM embedded_font_cache WHERE font_id=? AND status='ready' "
                    "AND converter_version=? LIMIT 1",
                    (int(row["id"]), EMBEDDED_FONT_CACHE_VERSION),
                ).fetchone() is not None
            except sqlite3.OperationalError:
                source_available = False
        if not source_available:
            continue
        try:
            aliases_raw = json.loads(row["aliases"] or "[]")
        except (ValueError, TypeError):
            aliases_raw = []
        aliases = tuple(
            dict.fromkeys(
                name.strip()
                for name in [row["family_name"], *(aliases_raw if isinstance(aliases_raw, list) else [])]
                if isinstance(name, str) and name.strip()
            )
        )
        font_row = FontRow(row["family_name"] or "", aliases, path, int(row["id"]))
        all_rows.append(font_row)
        for alias in aliases:
            by_alias.setdefault(normalize_font_name(alias), font_row)
    return by_alias, all_rows


def _names(font: TTFont) -> set[str]:
    found: set[str] = set()
    if "name" not in font:
        return found
    for record in font["name"].names:
        if record.nameID not in {1, 4, 6, 16}:
            continue
        try:
            value = record.toUnicode().strip()
        except Exception:
            continue
        if value:
            found.add(normalize_font_name(value))
    return found


@dataclass(frozen=True)
class FontFaceProfile:
    """A concrete face in a font file and the names that resolve to it."""

    face_key: str
    target_name: str
    aliases: tuple[str, ...]


def _face_name_values(font: TTFont) -> tuple[str, ...]:
    values: dict[int, list[str]] = {}
    if "name" not in font:
        return ()
    for record in font["name"].names:
        if record.nameID not in {1, 4, 6, 16}:
            continue
        try:
            value = record.toUnicode().strip()
        except Exception:
            continue
        if value:
            values.setdefault(record.nameID, []).append(value)
    ordered: list[str] = []
    for name_id in (4, 16, 1, 6):
        for value in values.get(name_id, []):
            if value not in ordered:
                ordered.append(value)
    return tuple(ordered)


def _font_face_profiles(row: FontRow) -> tuple[FontFaceProfile, ...]:
    """Return all concrete faces and aliases in a font or font collection."""
    faces: list[TTFont]
    collection: TTCollection | None = None
    try:
        if row.path.suffix.lower() in {".ttc", ".otc"}:
            collection = TTCollection(str(row.path), lazy=False)
            faces = list(collection.fonts)
        else:
            faces = [TTFont(str(row.path), lazy=False)]
        profiles: list[FontFaceProfile] = []
        used_keys: set[str] = set()
        for index, face in enumerate(faces):
            names = _face_name_values(face)
            target_name = (
                row.family_name
                if len(faces) == 1 and row.family_name
                else (names[0] if names else row.family_name)
            )
            if not target_name:
                raise FontEmbeddingError(f"字体「{row.family_name}」缺少可识别的字形名称")
            aliases = list(dict.fromkeys(names))
            if len(faces) == 1:
                aliases.extend(row.aliases)
            else:
                normalized_names = {normalize_font_name(name) for name in names}
                aliases.extend(
                    alias for alias in row.aliases
                    if normalize_font_name(alias) in normalized_names
                )
            normalized_aliases = tuple(
                dict.fromkeys(
                    normalize_font_name(alias)
                    for alias in [target_name, *aliases]
                    if normalize_font_name(alias)
                )
            )
            face_key = normalize_font_name(target_name) or f"face{index}"
            if face_key in used_keys:
                face_key = f"{face_key}-{index}"
            used_keys.add(face_key)
            profiles.append(FontFaceProfile(face_key, target_name, normalized_aliases))
        return tuple(profiles)
    except FontEmbeddingError:
        raise
    except Exception as exc:
        raise FontEmbeddingError(f"字体「{row.family_name}」文件无法解析，无法准备嵌入缓存") from exc
    finally:
        if collection is not None:
            collection.close()
        else:
            for face in locals().get("faces", []):
                face.close()


def _font_source_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _cache_face_token(face_key: str) -> str:
    return hashlib.sha256(face_key.encode("utf-8")).hexdigest()[:24]


def _embedded_cache_oss_key(source_sha256: str, face_key: str) -> str:
    prefix = (settings.oss_prefix or "").strip("/")
    parts = [
        prefix,
        "fonts",
        "embedded",
        source_sha256,
        _cache_face_token(face_key),
        f"{EMBEDDED_FONT_CACHE_VERSION}.fntdata",
    ]
    return "/".join(part for part in parts if part)


def _embedded_cache_local_path(source_sha256: str, face_key: str) -> Path:
    return (
        settings.fonts_dir
        / ".embedded-cache"
        / source_sha256
        / f"{_cache_face_token(face_key)}-{EMBEDDED_FONT_CACHE_VERSION}.fntdata"
    )


def _store_embedded_font_data(data: bytes, source_sha256: str, face_key: str) -> str:
    if oss_storage.enabled:
        return oss_storage.upload_bytes(
            data,
            _embedded_cache_oss_key(source_sha256, face_key),
            content_type=FONT_CONTENT_TYPE,
        )
    destination = _embedded_cache_local_path(source_sha256, face_key)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    temporary.write_bytes(data)
    os.replace(temporary, destination)
    return settings.store_path(destination)


def _read_embedded_font_data(cache_ref: str) -> bytes | None:
    if not cache_ref:
        return None
    if is_oss_ref(cache_ref):
        temporary = None
        try:
            temporary = oss_storage.materialize(cache_ref, suffix=".fntdata")
            return temporary.read_bytes()
        except Exception:
            logger.warning("读取 OSS 嵌入字体缓存失败: %s", cache_ref, exc_info=False)
            return None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    path = settings.abs_path(cache_ref)
    try:
        return path.read_bytes() if path and path.is_file() else None
    except OSError:
        return None


def _cache_rows(db: sqlite3.Connection, font_id: int) -> list[sqlite3.Row]:
    try:
        return db.execute(
            "SELECT * FROM embedded_font_cache WHERE font_id=? AND status='ready' "
            "AND converter_version=? ORDER BY id",
            (font_id, EMBEDDED_FONT_CACHE_VERSION),
        ).fetchall()
    except sqlite3.OperationalError:
        return []


def _cached_font_data(db: sqlite3.Connection, row: FontRow, target_name: str) -> tuple[bytes, str] | None:
    if row.font_id is None:
        return None
    requested = normalize_font_name(target_name)
    rows = _cache_rows(db, row.font_id)
    for cached in rows:
        try:
            aliases = json.loads(cached["aliases"] or "[]")
        except (TypeError, ValueError):
            aliases = []
        aliases = {normalize_font_name(alias) for alias in aliases if isinstance(alias, str)}
        if requested not in aliases and not (len(rows) == 1 and not aliases):
            continue
        data = _read_embedded_font_data(str(cached["cache_ref"] or ""))
        if data:
            return data, str(cached["variant"] or "regular")
    return None


def _upsert_embedded_cache(
    db: sqlite3.Connection,
    row: FontRow,
    source_sha256: str,
    profile: FontFaceProfile,
    variant: str,
    cache_ref: str,
    status: str = "ready",
    error_message: str | None = None,
) -> None:
    if row.font_id is None:
        return
    now = now_iso()
    db.execute(
        "INSERT INTO embedded_font_cache "
        "(font_id,source_sha256,face_key,aliases,variant,cache_ref,status,converter_version,"
        "error_message,created_at,updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(font_id,source_sha256,face_key,converter_version) DO UPDATE SET "
        "aliases=excluded.aliases,variant=excluded.variant,cache_ref=excluded.cache_ref,status=excluded.status,"
        "error_message=excluded.error_message,updated_at=excluded.updated_at",
        (
            row.font_id,
            source_sha256,
            profile.face_key,
            json.dumps(profile.aliases, ensure_ascii=False),
            variant,
            cache_ref,
            status,
            EMBEDDED_FONT_CACHE_VERSION,
            error_message,
            now,
            now,
        ),
    )


def _font_row_from_db_row(row: sqlite3.Row) -> FontRow | None:
    path = _uploaded_font_abs(row["file_path"])
    if path is None or not path.is_file():
        return None
    try:
        aliases_raw = json.loads(row["aliases"] or "[]")
    except (ValueError, TypeError):
        aliases_raw = []
    aliases = tuple(
        dict.fromkeys(
            name.strip()
            for name in [row["family_name"], *(aliases_raw if isinstance(aliases_raw, list) else [])]
            if isinstance(name, str) and name.strip()
        )
    )
    return FontRow(row["family_name"] or "", aliases, path, int(row["id"]))


def _open_face(path: Path, target_name: str, aliases: tuple[str, ...]) -> tuple[TTFont, bool]:
    """Open a face from a single font or collection; bool indicates ownership."""
    try:
        if path.suffix.lower() in {".ttc", ".otc"}:
            collection = TTCollection(str(path), lazy=False)
            targets = {normalize_font_name(name) for name in (target_name, *aliases)}
            selected = next((face for face in collection.fonts if _names(face) & targets), None)
            if selected is None:
                collection.close()
                raise FontEmbeddingError(f"字体库文件中找不到「{target_name}」对应字形")
            return selected, True
        return TTFont(str(path), lazy=False), True
    except FontEmbeddingError:
        raise
    except Exception as exc:
        raise FontEmbeddingError(f"字体「{target_name}」文件无法解析，无法嵌入") from exc


def _convert_cff_to_truetype(font: TTFont) -> None:
    """Convert CFF/CFF2 outlines to quadratic TrueType outlines in memory.

    PowerPoint's ``fntdata`` package expects a TrueType payload. Standard font
    libraries commonly contain OpenType fonts with CFF outlines, so rejecting
    those files would incorrectly block otherwise approved fonts.
    """
    if "glyf" in font:
        return
    if "CFF " not in font and "CFF2" not in font:
        raise FontEmbeddingError("字体不是可嵌入的 TrueType 或 OpenType 字形格式")

    try:
        glyph_order = font.getGlyphOrder()
        glyph_set = font.getGlyphSet()
        glyphs = {}
        for glyph_name in glyph_order:
            tt_pen = TTGlyphPen(glyph_set)
            quad_pen = Cu2QuPen(tt_pen, max_err=1.0, all_quadratic=True)
            glyph_set[glyph_name].draw(quad_pen)
            glyphs[glyph_name] = tt_pen.glyph()

        glyf = newTable("glyf")
        glyf.glyphs = glyphs
        glyf.glyphOrder = glyph_order
        font["glyf"] = glyf
        font["loca"] = newTable("loca")
        font["loca"].locations = []

        maxp = font["maxp"]
        maxp.tableVersion = 0x00010000
        maxp.numGlyphs = len(glyph_order)
        # CFF maxp tables only contain numGlyphs. These fields are required by
        # the TrueType maxp schema; fontTools recalculates glyph limits on save.
        for field, value in {
            "maxPoints": 0,
            "maxContours": 0,
            "maxCompositePoints": 0,
            "maxCompositeContours": 0,
            "maxZones": 2,
            "maxTwilightPoints": 0,
            "maxStorage": 0,
            "maxFunctionDefs": 0,
            "maxInstructionDefs": 0,
            "maxStackElements": 0,
            "maxSizeOfInstructions": 0,
            "maxComponentElements": 0,
            "maxComponentDepth": 0,
        }.items():
            setattr(maxp, field, value)
        font["head"].indexToLocFormat = 1
        font.sfntVersion = "\x00\x01\x00\x00"
        if "CFF " in font:
            del font["CFF "]
        if "CFF2" in font:
            del font["CFF2"]
    except FontEmbeddingError:
        raise
    except Exception as exc:
        raise FontEmbeddingError("字体的 OpenType 字形无法转换为 TrueType 格式") from exc


def _font_data(row: FontRow, target_name: str) -> tuple[bytes, str]:
    font, should_close = _open_face(row.path, target_name, row.aliases)
    try:
        os2 = font["OS/2"] if "OS/2" in font else None
        fs_type = int(os2.fsType) if os2 is not None else 0
        if "glyf" not in font:
            _convert_cff_to_truetype(font)
        weight = int(os2.usWeightClass) if os2 is not None else 400
        is_bold = weight >= 600 or bool(os2 and int(os2.fsSelection) & 0x20)
        italic_angle = float(font["post"].italicAngle) if "post" in font else 0
        is_italic = italic_angle != 0 or bool(os2 and int(os2.fsSelection) & 0x01)
        variant = "boldItalic" if is_bold and is_italic else "bold" if is_bold else "italic" if is_italic else "regular"
        output = BytesIO()
        try:
            font.save(output)
        except Exception as exc:
            raise FontEmbeddingError(f"字体「{target_name}」无法转换为 PowerPoint 字体格式") from exc
        ttf_data = output.getvalue()
        if not ttf_data.startswith(b"\x00\x01\x00\x00"):
            raise FontEmbeddingError(f"字体「{target_name}」必须是 TTF/TrueType 字形格式")
        # Fonts in the standard library are approved for this product's
        # embedding workflow. Do not carry source-level restricted/bitmap-only
        # flags into the generated editable package.
        return _wrap_as_eot(ttf_data, font, target_name, fs_type & ~0x0202, weight, is_italic), variant
    finally:
        if should_close:
            font.close()


def _ensure_embedded_cache_table(db: sqlite3.Connection) -> None:
    db.execute(
        "CREATE TABLE IF NOT EXISTS embedded_font_cache ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "font_id INTEGER NOT NULL REFERENCES fonts(id) ON DELETE CASCADE,"
        "source_sha256 TEXT NOT NULL,"
        "face_key TEXT NOT NULL,"
        "aliases TEXT NOT NULL DEFAULT '[]',"
        "variant TEXT NOT NULL,"
        "cache_ref TEXT NOT NULL,"
        "status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('queued','processing','ready','failed')),"
        "converter_version TEXT NOT NULL,"
        "error_message TEXT,"
        "created_at TEXT NOT NULL,"
        "updated_at TEXT NOT NULL,"
        "UNIQUE(font_id,source_sha256,face_key,converter_version)"
        ")"
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_embedded_font_cache_lookup "
        "ON embedded_font_cache(font_id,status,converter_version)"
    )


def _profile_for_target(row: FontRow, target_name: str) -> FontFaceProfile:
    profiles = _font_face_profiles(row)
    requested = normalize_font_name(target_name)
    for profile in profiles:
        if requested in profile.aliases:
            return profile
    if len(profiles) == 1:
        return profiles[0]
    raise FontEmbeddingError(f"字体库文件中找不到「{target_name}」对应字形")


def _persist_generated_cache(row: FontRow, target_name: str, data: bytes, variant: str) -> None:
    """Best-effort lazy backfill for legacy fonts whose cache is missing."""
    if row.font_id is None:
        return
    try:
        from app.db import get_db

        source_sha256 = _font_source_sha256(row.path)
        profile = _profile_for_target(row, target_name)
        with _EMBEDDED_CACHE_LOCK, get_db() as db:
            _ensure_embedded_cache_table(db)
            db.execute(
                "UPDATE embedded_font_cache SET status='failed', error_message='源字体已更新', updated_at=? "
                "WHERE font_id=? AND source_sha256<>? AND status='ready'",
                (now_iso(), row.font_id, source_sha256),
            )
            cache_ref = _store_embedded_font_data(data, source_sha256, profile.face_key)
            _upsert_embedded_cache(db, row, source_sha256, profile, variant, cache_ref)
    except Exception:
        logger.warning("回填字体嵌入缓存失败: font_id=%s", row.font_id, exc_info=False)


def prepare_embedded_font_cache(db: sqlite3.Connection, font_id: int) -> dict[str, object]:
    """Generate and persist all faces for one maintained standard font."""
    with _EMBEDDED_CACHE_LOCK:
        _ensure_embedded_cache_table(db)
        stored = db.execute("SELECT * FROM fonts WHERE id=?", (font_id,)).fetchone()
        if stored is None:
            raise FontEmbeddingError(f"字体不存在：{font_id}")
        row = _font_row_from_db_row(stored)
        if row is None:
            raise FontEmbeddingError(f"字体「{stored['family_name']}」文件不存在")
        source_sha256 = _font_source_sha256(row.path)
        db.execute(
            "UPDATE embedded_font_cache SET status='failed', error_message='源字体已更新', updated_at=? "
            "WHERE font_id=? AND source_sha256<>? AND status='ready'",
            (now_iso(), font_id, source_sha256),
        )
        profiles = _font_face_profiles(row)
        ready = 0
        failed = 0
        for profile in profiles:
            existing = db.execute(
                "SELECT cache_ref FROM embedded_font_cache WHERE font_id=? AND source_sha256=? "
                "AND face_key=? AND converter_version=? AND status='ready'",
                (font_id, source_sha256, profile.face_key, EMBEDDED_FONT_CACHE_VERSION),
            ).fetchone()
            if existing is not None and _read_embedded_font_data(str(existing["cache_ref"] or "")):
                ready += 1
                continue
            try:
                data, variant = _font_data(row, profile.target_name)
                cache_ref = _store_embedded_font_data(data, source_sha256, profile.face_key)
                _upsert_embedded_cache(db, row, source_sha256, profile, variant, cache_ref)
                ready += 1
            except Exception as exc:
                failed += 1
                _upsert_embedded_cache(
                    db,
                    row,
                    source_sha256,
                    profile,
                    "regular",
                    "",
                    status="failed",
                    error_message=str(exc)[:1000],
                )
                logger.warning("准备字体嵌入缓存失败: font_id=%s face=%s", font_id, profile.target_name, exc_info=False)
        return {"font_id": font_id, "ready": ready, "failed": failed, "total": len(profiles)}


def prepare_embedded_font_cache_for_font(font_id: int) -> None:
    """Background-task entry point used by the standard-font maintenance route."""
    try:
        from app.db import get_db

        with get_db() as db:
            prepare_embedded_font_cache(db, font_id)
    except Exception:
        logger.exception("准备标准字体嵌入缓存失败: font_id=%s", font_id)


def embedded_font_cache_status(db: sqlite3.Connection, font_id: int) -> str:
    """Return a compact status for the standard-font maintenance screen."""
    try:
        rows = db.execute(
            "SELECT status FROM embedded_font_cache WHERE font_id=? AND converter_version=?",
            (font_id, EMBEDDED_FONT_CACHE_VERSION),
        ).fetchall()
    except sqlite3.OperationalError:
        return "pending"
    if not rows:
        return "pending"
    statuses = {str(row["status"]) for row in rows}
    if "processing" in statuses or "queued" in statuses:
        return "processing"
    if "ready" in statuses:
        return "ready"
    if "failed" in statuses:
        return "failed"
    return "pending"


def _panose_bytes(font: TTFont) -> bytes:
    os2 = font["OS/2"] if "OS/2" in font else None
    panose = getattr(os2, "panose", None)
    names = (
        "bFamilyType",
        "bSerifStyle",
        "bWeight",
        "bProportion",
        "bContrast",
        "bStrokeVariation",
        "bArmStyle",
        "bLetterForm",
        "bMidline",
        "bXHeight",
    )
    return bytes(max(0, min(255, int(getattr(panose, name, 0)))) for name in names)


def _wrap_as_eot(
    font_data: bytes,
    font: TTFont,
    family_name: str,
    fs_type: int,
    weight: int,
    italic: bool,
) -> bytes:
    """Wrap TrueType outlines in the Embedded OpenType container PowerPoint expects."""
    os2 = font["OS/2"] if "OS/2" in font else None
    code_page_1 = int(getattr(os2, "ulCodePageRange1", 0))
    code_page_2 = int(getattr(os2, "ulCodePageRange2", 0))
    unicode_ranges = [int(getattr(os2, f"ulUnicodeRange{index}", 0)) for index in range(1, 5)]
    charset = next(
        (
            value
            for mask, value in (
                (1 << 18, 134),
                (1 << 17, 136),
                (1 << 19, 128),
                (1 << 20, 129),
                (1 << 21, 130),
            )
            if code_page_1 & mask
        ),
        0,
    )
    check_sum_adjustment = int(getattr(font["head"], "checkSumAdjustment", 0)) if "head" in font else 0
    family = family_name.encode("utf-16le")
    style_record = font["name"].getDebugName(2) if "name" in font else None
    style = (style_record or ("Italic" if italic else "Regular")).encode("utf-16le")
    version = "Version 1.0".encode("utf-16le")
    full_name = (font["name"].getDebugName(4) if "name" in font else None) or family_name
    full = full_name.encode("utf-16le")

    header = bytearray()
    header.extend(b"\0" * 4)  # EOT size, filled once the strings are appended.
    header.extend(struct.pack("<II", len(font_data), 0x00020001))
    header.extend(struct.pack("<I", 0))  # EOT flags
    header.extend(_panose_bytes(font))
    header.extend(struct.pack("<BBIHH", charset, int(italic), weight, fs_type, 0x504C))
    header.extend(struct.pack("<IIIIII", *unicode_ranges, code_page_1, code_page_2))
    header.extend(struct.pack("<I", check_sum_adjustment))
    header.extend(b"\0" * 16)  # Reserved1..Reserved4
    for value in (family, style, version, full):
        header.extend(struct.pack("<H", 0))  # Padding
        header.extend(struct.pack("<H", len(value)))
        header.extend(value)
    header.extend(struct.pack("<HH", 0, 0))  # Padding5 and Padding6
    total_size = len(header) + len(font_data)
    struct.pack_into("<I", header, 0, total_size)
    return bytes(header) + font_data


def _next_relationship_id(root: ET.Element) -> str:
    existing = {rel.attrib.get("Id") for rel in root}
    index = 1
    while f"rIdSlideFlowFont{index}" in existing:
        index += 1
    return f"rIdSlideFlowFont{index}"


def _remove_existing_fonts(parts: dict[str, bytes], presentation: ET.Element) -> ET.Element:
    presentation_rels_path = "ppt/_rels/presentation.xml.rels"
    rels_root = ET.fromstring(parts[presentation_rels_path])
    removed_targets: list[str] = []
    for rel in list(rels_root):
        if rel.attrib.get("Type") != FONT_REL_TYPE:
            continue
        target = rel.attrib.get("Target", "")
        if target and rel.attrib.get("TargetMode", "Internal") != "External":
            removed_targets.append(posixpath.normpath(posixpath.join("ppt", target)))
        rels_root.remove(rel)
    for target in removed_targets:
        parts.pop(target, None)

    existing = presentation.find(f"{{{P_NS}}}embeddedFontLst")
    if existing is not None:
        presentation.remove(existing)
    presentation.attrib.pop("embedTrueTypeFonts", None)
    presentation.attrib.pop("saveSubsetFonts", None)
    parts[presentation_rels_path] = ET.tostring(rels_root, encoding="utf-8", xml_declaration=True)
    return rels_root


def _font_metadata(name: str) -> ET.Element:
    return ET.Element(
        f"{{{P_NS}}}font",
        {"typeface": name, "pitchFamily": "34", "charset": "0"},
    )


def embed_fonts_in_pptx(
    ppt_path: Path,
    db: sqlite3.Connection,
    font_names: list[str],
) -> bytes:
    """Return a PPTX with referenced, embeddable fonts stored in its package."""
    requested = list(
        dict.fromkeys(
            name.strip()
            for name in font_names
            if name and name.strip() and not name.startswith("+")
        )
    )
    if not requested:
        return ppt_path.read_bytes()
    try:
        with zipfile.ZipFile(ppt_path) as source:
            parts = {name: source.read(name) for name in source.namelist()}
    except (OSError, zipfile.BadZipFile) as exc:
        raise FontEmbeddingError("PPT 文件损坏，无法嵌入字体") from exc

    presentation_xml = parts.get("ppt/presentation.xml")
    rels_xml = parts.get("ppt/_rels/presentation.xml.rels")
    if presentation_xml is None or rels_xml is None:
        raise FontEmbeddingError("PPT 文件缺少字体嵌入所需的结构")
    try:
        presentation = ET.fromstring(presentation_xml)
        rels_root = _remove_existing_fonts(parts, presentation)
    except ET.ParseError as exc:
        raise FontEmbeddingError("PPT 字体结构无法解析，无法嵌入字体") from exc

    alias_rows, _ = _font_rows(db)
    missing = [name for name in requested if normalize_font_name(name) not in alias_rows]
    if missing:
        raise FontEmbeddingError("字体库中缺少：" + "、".join(missing))

    embedded = ET.Element(f"{{{P_NS}}}embeddedFontLst")
    file_relationships: dict[tuple[Path, str], tuple[str, str, str]] = {}
    font_index = 1
    for name in requested:
        row = alias_rows[normalize_font_name(name)]
        cached = _cached_font_data(db, row, name)
        if cached is None:
            with _EMBEDDED_CACHE_LOCK:
                cached = _cached_font_data(db, row, name)
                if cached is None:
                    profile = _profile_for_target(row, name)
                    data, variant = _font_data(row, profile.target_name)
                    _persist_generated_cache(row, profile.target_name, data, variant)
                else:
                    data, variant = cached
        else:
            data, variant = cached
        relationship_key = (row.path, hashlib.sha256(data).hexdigest())
        relationship = file_relationships.get(relationship_key)
        if relationship is None:
            part_name = f"ppt/fonts/font{font_index}.fntdata"
            rel_id = _next_relationship_id(rels_root)
            rels_root.append(
                ET.Element(
                    f"{{{REL_NS}}}Relationship",
                    {"Id": rel_id, "Type": FONT_REL_TYPE, "Target": f"fonts/font{font_index}.fntdata"},
                )
            )
            parts[part_name] = data
            relationship = (rel_id, part_name, variant)
            file_relationships[relationship_key] = relationship
            font_index += 1
        rel_id, _, variant = relationship
        entry = ET.SubElement(embedded, f"{{{P_NS}}}embeddedFont")
        entry.append(_font_metadata(name))
        ET.SubElement(entry, f"{{{P_NS}}}{variant}", {f"{{{R_NS}}}id": rel_id})

    if requested:
        presentation.set("embedTrueTypeFonts", "1")
        presentation.set("saveSubsetFonts", "0")
        insert_before = {
            f"{{{P_NS}}}{name}"
            for name in (
                "custShowLst",
                "photoAlbum",
                "custDataLst",
                "kinsoku",
                "defaultTextStyle",
                "modifyVerifier",
                "extLst",
            )
        }
        children = list(presentation)
        next_index = next(
            (index for index, child in enumerate(children) if child.tag in insert_before),
            len(children),
        )
        presentation.insert(next_index, embedded)

    parts["ppt/presentation.xml"] = ET.tostring(presentation, encoding="utf-8", xml_declaration=True)
    parts["ppt/_rels/presentation.xml.rels"] = ET.tostring(rels_root, encoding="utf-8", xml_declaration=True)

    content_types_path = "[Content_Types].xml"
    try:
        content_types = ET.fromstring(parts[content_types_path])
    except (KeyError, ET.ParseError) as exc:
        raise FontEmbeddingError("PPT 缺少有效的内容类型清单，无法嵌入字体") from exc
    if not any(
        node.tag == f"{{{CT_NS}}}Default" and node.attrib.get("Extension", "").lower() == "fntdata"
        for node in content_types
    ):
        content_types.append(
            ET.Element(
                f"{{{CT_NS}}}Default",
                {"Extension": "fntdata", "ContentType": FONT_CONTENT_TYPE},
            )
        )
    parts[content_types_path] = ET.tostring(content_types, encoding="utf-8", xml_declaration=True)

    output = BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as package:
        for name, data in parts.items():
            package.writestr(name, data)
    return output.getvalue()
