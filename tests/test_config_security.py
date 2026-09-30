"""Configuration secret validation and upgrade behavior."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.config import (
    DEFAULT_PROPERTIES,
    _migrate_known_default_secret,
    _render_properties,
    _validate_properties,
    read_properties,
    _write_text_atomic,
)


class ConfigSecurityTests(unittest.TestCase):
    def values(self, secret: str) -> dict[str, str]:
        values = dict(DEFAULT_PROPERTIES)
        values["security.secret_key"] = secret
        return values

    def test_secret_length_boundary_and_known_default_are_enforced(self):
        _validate_properties(self.values("x" * 32))
        with self.assertRaisesRegex(ValueError, "至少 32 个字符"):
            _validate_properties(self.values("x" * 31))
        with self.assertRaisesRegex(ValueError, "至少 32 个字符"):
            _validate_properties(self.values(DEFAULT_PROPERTIES["security.secret_key"]))

    def test_environment_secret_is_validated_as_the_effective_value(self):
        with patch.dict(os.environ, {"SLIDE_FLOW_SECRET": "e" * 32}):
            _validate_properties(self.values("x" * 31))
        with patch.dict(os.environ, {"SLIDE_FLOW_SECRET": "e" * 31}):
            with self.assertRaisesRegex(ValueError, "至少 32 个字符"):
                _validate_properties(self.values("x" * 32))

    def test_known_default_is_rotated_once_and_existing_settings_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "slide_flow.properties"
            values = self.values(DEFAULT_PROPERTIES["security.secret_key"])
            values["site.name"] = "Existing Site"
            _write_text_atomic(path, _render_properties(values))

            _migrate_known_default_secret(values, path)
            saved = read_properties(path)

            self.assertGreaterEqual(len(saved["security.secret_key"]), 32)
            self.assertNotEqual(saved["security.secret_key"], DEFAULT_PROPERTIES["security.secret_key"])
            self.assertEqual(saved["site.name"], "Existing Site")
            self.assertTrue(path.with_suffix(".properties.bak").exists())
            self.assertEqual(values["security.secret_key"], saved["security.secret_key"])

            migrated = saved["security.secret_key"]
            _migrate_known_default_secret(saved, path)
            self.assertEqual(read_properties(path)["security.secret_key"], migrated)


if __name__ == "__main__":
    unittest.main()
