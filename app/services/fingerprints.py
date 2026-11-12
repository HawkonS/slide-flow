"""Perceptual fingerprints for duplicate single-page resources.

Each current resource version gets a 64-bit difference hash (dHash) computed
from its preview image. Comparing two hashes with Hamming distance tolerates a
page being re-exported or re-rendered while keeping the comparison cheap.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

from app.config import settings
from app.core.oss import is_oss_ref
from app.core.oss import storage as oss_storage
from app.db import now_iso
import io
import logging
import sqlite3
from typing import Any, Iterable

logger = logging.getLogger(__name__)

DHASH_EDGE = 8
"""dHash is 8x8 comparisons, i.e. 64 bits."""

MAX_DUPLICATE_DISTANCE = 6
"""Hamming distance considered a likely duplicate (0 is byte-identical looking)."""

HASH_VERSION = 2
"""Bump when the image pipeline changes; cached fingerprints are then recomputed."""

def compute_dhash_bytes(data: bytes) -> int:
    with Image.open(io.BytesIO(data)) as image:
        return _dhash(image)


def compute_dhash_path(path: Path) -> int:
    with Image.open(path) as image:
        return _dhash(image)


def _dhash(image: Image.Image) -> int:
    # Normalise both OSS-thumbnails and full-resolution previews through the
    # same 96px intermediate so their hashes stay comparable.
    gray = image.convert("L")
    if gray.width != 96:
        height = max(1, round(96 * gray.height / gray.width))
        gray = gray.resize((96, height), Image.Resampling.LANCZOS)
    gray = gray.resize((DHASH_EDGE + 1, DHASH_EDGE), Image.Resampling.LANCZOS)
    pixels = gray.tobytes()
    bits = 0
    for row in range(DHASH_EDGE):
        offset = row * (DHASH_EDGE + 1)
        for column in range(DHASH_EDGE):
            bits = (bits << 1) | (1 if pixels[offset + column] > pixels[offset + column + 1] else 0)
    return bits


def dhash_hex(value: int) -> str:
    return f"{value:016x}"


def parse_dhash(value: str) -> int:
    return int(value, 16)


def hamming_distance(left: int, right: int) -> int:
    return (left ^ right).bit_count()


class TransientFingerprintError(RuntimeError):
    """The source could not be read right now; retry instead of caching empty."""


def _missing_object(exc: BaseException) -> bool:
    """Best-effort 404 detection across OSS SDK wrappers."""
    current: BaseException | None = exc
    for _ in range(4):
        if current is None:
            break
        if getattr(current, "status", None) == 404 or getattr(current, "status_code", None) == 404:
            return True
        if getattr(current, "code", None) in {"NoSuchKey", "NotFound", "NoSuchObject"}:
            return True
        if isinstance(current, FileNotFoundError):
            return True
        current = current.__cause__
    return False


def image_bytes(ref: str | None) -> bytes | None:
    """Read enough pixels for a dHash, preferring a tiny OSS-resized image."""
    if not ref:
        return None
    if is_oss_ref(ref):
        try:
            return oss_storage.read_bytes(ref, process="image/resize,w_96")
        except Exception as exc:
            # A deleted object will never succeed; do not keep a scan warming
            # forever. Other failures stay pending and are retried.
            if _missing_object(exc):
                logger.warning("OSS 指纹小图不存在: %s", ref)
                return None
            logger.warning("读取 OSS 指纹小图失败: %s", ref, exc_info=True)
            raise TransientFingerprintError(str(exc)) from exc
    path = settings.abs_path(ref)
    if path is None or not path.exists():
        return None
    try:
        return path.read_bytes()
    except OSError:
        logger.warning("读取本地指纹图片失败: %s", ref, exc_info=True)
        return None


def fingerprint_ref(ref: str | None) -> str | None:
    """Return a hex dHash, "" when permanently unavailable, or None on retryable failure."""
    try:
        data = image_bytes(ref)
    except TransientFingerprintError:
        return None
    if not data:
        return ""
    try:
        return dhash_hex(compute_dhash_bytes(data))
    except Exception:
        logger.warning("计算图片指纹失败（文件损坏）: %s", ref, exc_info=True)
        return ""


def store_fingerprint(db: sqlite3.Connection, resource_id: int, version_no: int, dhash: str) -> None:
    db.execute(
        """INSERT INTO resource_fingerprints (resource_id, version_no, dhash, hash_version, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(resource_id) DO UPDATE SET
             version_no = excluded.version_no,
             dhash = excluded.dhash,
             hash_version = excluded.hash_version,
             updated_at = excluded.updated_at""",
        (resource_id, version_no, dhash, HASH_VERSION, now_iso()),
    )


def store_fingerprint_from_path(db: sqlite3.Connection, resource_id: int, version_no: int, path: Path | None) -> None:
    if path is None:
        return
    try:
        value = dhash_hex(compute_dhash_path(path))
        store_fingerprint(db, resource_id, version_no, value)
    except Exception:
        # Fingerprints are an optimization; never fail an import over them.
        logger.warning("保存导入页面指纹失败: resource_id=%s", resource_id, exc_info=True)


def ensure_fingerprints(
    db: sqlite3.Connection,
    rows: Iterable[sqlite3.Row],
    *,
    limit: int = 120,
    workers: int = 8,
) -> tuple[int, int]:
    """Fill missing/stale fingerprints for current versions.

    ``rows`` must expose ``resource_id``, ``version_no``, ``png_path``,
    ``fp_version`` and ``fp_dhash``. Returns ``(processed, remaining)`` so the
    caller can show progress while a large library warms up.
    """
    pending = [
        row for row in rows
        if row["png_path"]
        and (
            row["fp_dhash"] is None
            or int(row["fp_version"] or -1) != int(row["version_no"])
            or int(row["fp_hash_version"] or 0) != HASH_VERSION
        )
    ]
    batch = pending[:limit]
    if not batch:
        return 0, len(pending)

    def compute(row: sqlite3.Row) -> tuple[int, int, str | None]:
        return int(row["resource_id"]), int(row["version_no"]), fingerprint_ref(row["png_path"])

    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        results = list(executor.map(compute, batch))
    stored = 0
    for resource_id, version_no, value in results:
        if value is None:
            continue
        store_fingerprint(db, resource_id, version_no, value)
        stored += 1
    return stored, max(0, len(pending) - stored)


def match_fingerprints(
    page_hashes: Iterable[int],
    candidates: Iterable[tuple[int, int, int]],
    *,
    max_distance: int = MAX_DUPLICATE_DISTANCE,
    per_page: int = 3,
) -> list[list[tuple[int, int, int]]]:
    """Return up to ``per_page`` ``(resource_id, version_no, distance)`` per page."""
    candidate_list = list(candidates)
    matches: list[list[tuple[int, int, int]]] = []
    for page_hash in page_hashes:
        distances: list[tuple[int, int, int]] = []
        for resource_id, version_no, candidate_hash in candidate_list:
            distance = hamming_distance(page_hash, candidate_hash)
            if distance <= max_distance:
                distances.append((resource_id, version_no, distance))
        distances.sort(key=lambda item: (item[2], item[0]))
        matches.append(distances[:per_page])
    return matches


def normalize_slide_text(text: str) -> str:
    import re
    import unicodedata

    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text)).strip().casefold()


def _iter_shapes(shapes):
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    for shape in shapes:
        if getattr(shape, "shape_type", None) == MSO_SHAPE_TYPE.GROUP:
            yield from _iter_shapes(shape.shapes)
        else:
            yield shape


def extract_pptx_text(path: Path) -> str:
    """Collect normalized visible text from every shape on every slide."""
    from pptx import Presentation

    parts: list[str] = []
    presentation = Presentation(str(path))
    for slide in presentation.slides:
        for shape in _iter_shapes(slide.shapes):
            if getattr(shape, "has_text_frame", False):
                for paragraph in shape.text_frame.paragraphs:
                    value = "".join(run.text for run in paragraph.runs) or paragraph.text
                    if value.strip():
                        parts.append(value)
            if getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    for cell in row.cells:
                        if cell.text.strip():
                            parts.append(cell.text)
    return normalize_slide_text("\n".join(parts))


def _pptx_text_for_ref(ref: str | None) -> str | None:
    if not ref:
        return ""
    path: Path | None = None
    cleanup: Path | None = None
    try:
        if is_oss_ref(ref):
            try:
                cleanup = oss_storage.materialize(ref, suffix=".pptx")
            except Exception as exc:
                if _missing_object(exc):
                    logger.warning("OSS PPTX 文字源不存在: %s", ref)
                    return ""
                logger.warning("读取 OSS PPTX 文字源失败（可重试）: %s", ref, exc_info=True)
                return None
            path = cleanup
        else:
            path = settings.abs_path(ref)
        if path is None or not path.exists():
            return ""
        try:
            return extract_pptx_text(path)
        except Exception:
            logger.warning("解析 PPTX 文字失败（文件不可解析）: %s", ref, exc_info=True)
            return ""
    finally:
        if cleanup is not None:
            cleanup.unlink(missing_ok=True)


TEXT_EXTRACTOR_VERSION = 2


def ensure_text_fingerprints(
    db: sqlite3.Connection,
    rows: Iterable[sqlite3.Row],
    *,
    limit: int = 80,
    workers: int = 4,
) -> tuple[int, int]:
    """Fill missing per-version text caches for candidate resources."""
    pending = [
        row for row in rows
        if row["ppt_path"]
        and (
            row["text_value"] is None
            or int(row["text_version"] or -1) != int(row["version_no"])
            or int(row["text_extractor_version"] or 0) != TEXT_EXTRACTOR_VERSION
        )
    ]
    batch = pending[:limit]
    if not batch:
        return 0, len(pending)

    def compute(row: sqlite3.Row) -> tuple[int, int, str | None]:
        return int(row["resource_id"]), int(row["version_no"]), _pptx_text_for_ref(row["ppt_path"])

    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        results = list(executor.map(compute, batch))
    stored = 0
    for resource_id, version_no, value in results:
        if value is None:
            continue
        db.execute(
            """INSERT INTO resource_text_fingerprints (resource_id, version_no, text, extractor_version, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(resource_id) DO UPDATE SET
                 version_no = excluded.version_no, text = excluded.text,
                 extractor_version = excluded.extractor_version, updated_at = excluded.updated_at""",
            (resource_id, version_no, value, TEXT_EXTRACTOR_VERSION, now_iso()),
        )
        stored += 1
    return stored, max(0, len(pending) - stored)


def text_for_resources(db: sqlite3.Connection, resource_ids: Iterable[int]) -> dict[int, str]:
    ids = sorted(set(int(value) for value in resource_ids))
    if not ids:
        return {}
    result: dict[int, str] = {}
    # Stay well below SQLite's bound-variable limit for large libraries.
    for offset in range(0, len(ids), 500):
        chunk = ids[offset:offset + 500]
        placeholders = ",".join("?" for _ in chunk)
        result.update({
            int(row["resource_id"]): row["text"]
            for row in db.execute(
                f"SELECT f.resource_id, f.text FROM resource_text_fingerprints f "
                f"JOIN resources r ON r.id = f.resource_id AND f.version_no = r.current_version "
                f"WHERE f.resource_id IN ({placeholders}) AND f.extractor_version = ?",
                [*chunk, TEXT_EXTRACTOR_VERSION],
            )
        })
    return result
