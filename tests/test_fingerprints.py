"""Unit tests for perceptual page fingerprints used by import deduplication."""

import io
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from unittest.mock import patch

from app.services import fingerprints
from app.services.fingerprints import (
    HASH_VERSION,
    compute_dhash_bytes,
    extract_pptx_text,
    dhash_hex,
    ensure_fingerprints,
    hamming_distance,
    match_fingerprints,
    parse_dhash,
)


def make_slide(shift: int = 0, *, size=(320, 180)) -> Image.Image:
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((20 + shift, 20, 120 + shift, 160), fill="#1f2a44")
    draw.ellipse((160 - shift, 40, 260 - shift, 140), fill="#2f9e8f")
    draw.line((10, 170 - shift, 300, 170 - shift), fill="#e0b341", width=6)
    return image


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def jpeg_bytes(image: Image.Image, quality: int = 55) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality)
    return buffer.getvalue()


class FingerprintTests(unittest.TestCase):
    def test_identical_images_have_zero_distance(self):
        data = png_bytes(make_slide())
        self.assertEqual(compute_dhash_bytes(data), compute_dhash_bytes(data))

    def test_recompressed_image_stays_within_duplicate_threshold(self):
        image = make_slide()
        original = compute_dhash_bytes(png_bytes(image))
        recompressed = compute_dhash_bytes(jpeg_bytes(image))
        self.assertLessEqual(hamming_distance(original, recompressed), 6)

    def test_different_layout_exceeds_duplicate_threshold(self):
        left = Image.new("RGB", (320, 180), "white")
        draw_left = ImageDraw.Draw(left)
        draw_left.rectangle((0, 0, 150, 180), fill="#111111")

        right = Image.new("RGB", (320, 180), "white")
        draw_right = ImageDraw.Draw(right)
        draw_right.rectangle((170, 0, 320, 180), fill="#111111")

        self.assertGreater(
            hamming_distance(compute_dhash_bytes(png_bytes(left)), compute_dhash_bytes(png_bytes(right))),
            6,
        )

    def test_normalised_pipeline_matches_full_and_small_images(self):
        full = make_slide(size=(1280, 720))
        small = full.resize((96, 54), Image.Resampling.LANCZOS)
        self.assertLessEqual(
            hamming_distance(compute_dhash_bytes(png_bytes(full)), compute_dhash_bytes(png_bytes(small))),
            1,
        )

    def test_hex_roundtrip(self):
        value = compute_dhash_bytes(png_bytes(make_slide()))
        self.assertEqual(parse_dhash(dhash_hex(value)), value)
        self.assertEqual(len(dhash_hex(value)), 16)

    def test_match_fingerprints_sorts_by_distance_and_limits(self):
        page = 0b1010
        candidates = [(1, 1, page), (2, 1, page ^ 0b11), (3, 1, page ^ 0b111), (4, 1, page ^ 0b11111111)]
        matches = match_fingerprints([page], candidates, max_distance=6, per_page=2)
        self.assertEqual([(resource_id, distance) for resource_id, _, distance in matches[0]], [(1, 0), (2, 2)])


class PptxTextTests(unittest.TestCase):
    def test_extracts_visible_slide_text(self):
        from pptx import Presentation
        from pptx.util import Inches

        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "text.pptx"
            presentation = Presentation()
            slide = presentation.slides.add_slide(presentation.slide_layouts[6])
            box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1))
            box.text_frame.text = "主要涉及场景"
            presentation.save(path)
            self.assertEqual(extract_pptx_text(path), "主要涉及场景")


class PptxTextDependencyTests(unittest.TestCase):
    def test_missing_pptx_parser_keeps_the_text_fingerprint_pending(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "page.pptx"
            path.write_bytes(b"not-a-real-pptx")
            with patch.object(fingerprints, "extract_pptx_text", side_effect=ModuleNotFoundError("No module named 'pptx'")):
                self.assertIsNone(fingerprints._pptx_text_for_ref(str(path)))


class EnsureFingerprintsTests(unittest.TestCase):
    def test_missing_fingerprint_is_computed_and_stored(self):
        import sqlite3

        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.execute(
            "CREATE TABLE resource_fingerprints (resource_id INTEGER PRIMARY KEY, version_no INTEGER NOT NULL, dhash TEXT NOT NULL, hash_version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)"
        )
        with tempfile.TemporaryDirectory() as temp:
            image_path = Path(temp) / "page.png"
            make_slide().save(image_path)
            rows = [{
                "resource_id": 7,
                "version_no": 2,
                "png_path": str(image_path),
                "fp_version": None,
                "fp_dhash": None,
                "fp_hash_version": None,
            }]
            processed, remaining = ensure_fingerprints(connection, rows, limit=10, workers=2)
        self.assertEqual((processed, remaining), (1, 0))
        stored = connection.execute("SELECT resource_id, version_no, dhash FROM resource_fingerprints").fetchone()
        self.assertEqual(stored[0], 7)
        self.assertEqual(stored[1], 2)
        self.assertEqual(len(stored[2]), 16)
        # A second pass is a no-op once the fingerprint matches the version.
        rows[0]["fp_version"] = 2
        rows[0]["fp_dhash"] = stored[2]
        rows[0]["fp_hash_version"] = 2
        self.assertEqual(ensure_fingerprints(connection, rows, limit=10, workers=2), (0, 0))

    def test_transient_read_failure_is_not_cached_and_is_retried(self):
        import sqlite3

        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.execute(
            "CREATE TABLE resource_fingerprints (resource_id INTEGER PRIMARY KEY, version_no INTEGER NOT NULL, dhash TEXT NOT NULL, hash_version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)"
        )
        rows = [{
            "resource_id": 7,
            "version_no": 2,
            "png_path": "oss://bucket/page.png",
            "fp_version": None,
            "fp_dhash": None,
            "fp_hash_version": None,
        }]
        with patch.object(fingerprints, "fingerprint_ref", return_value=None):
            processed, remaining = ensure_fingerprints(connection, rows, limit=10, workers=2)
        self.assertEqual((processed, remaining), (0, 1))
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM resource_fingerprints").fetchone()[0], 0)

        value = dhash_hex(0b1010)
        with patch.object(fingerprints, "fingerprint_ref", return_value=value):
            processed, remaining = ensure_fingerprints(connection, rows, limit=10, workers=2)
        self.assertEqual((processed, remaining), (1, 0))
        stored = connection.execute("SELECT dhash, hash_version FROM resource_fingerprints").fetchone()
        self.assertEqual(stored[0], value)
        self.assertEqual(stored[1], HASH_VERSION)

    def test_old_hash_version_is_recomputed(self):
        import sqlite3

        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.execute(
            "CREATE TABLE resource_fingerprints (resource_id INTEGER PRIMARY KEY, version_no INTEGER NOT NULL, dhash TEXT NOT NULL, hash_version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)"
        )
        connection.execute(
            "INSERT INTO resource_fingerprints VALUES (7, 2, ?, 1, 'old')",
            (dhash_hex(0b1),),
        )
        rows = [{
            "resource_id": 7,
            "version_no": 2,
            "png_path": "oss://bucket/page.png",
            "fp_version": 2,
            "fp_dhash": dhash_hex(0b1),
            "fp_hash_version": 1,
        }]
        with patch.object(fingerprints, "fingerprint_ref", return_value=dhash_hex(0b10)):
            self.assertEqual(ensure_fingerprints(connection, rows, limit=10, workers=2), (1, 0))
        self.assertEqual(connection.execute("SELECT dhash, hash_version FROM resource_fingerprints").fetchone(), (dhash_hex(0b10), HASH_VERSION))


if __name__ == "__main__":
    unittest.main()
