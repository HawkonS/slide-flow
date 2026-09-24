from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException, Response
from fastapi.testclient import TestClient

from app.core.permissions import require_system_admin
from app.routers import system


class SystemLogTests(unittest.TestCase):
    def test_tail_returns_only_newest_lines(self):
        with TemporaryDirectory() as temp_dir:
            log_file = Path(temp_dir) / "server.log"
            log_file.write_text("\n".join(f"line-{index}" for index in range(200)) + "\n", encoding="utf-8")

            lines, truncated, stat = system._read_log_tail(log_file, 50)
            expected_size = log_file.stat().st_size

        self.assertEqual(lines, [f"line-{index}" for index in range(150, 200)])
        self.assertTrue(truncated)
        self.assertEqual(stat.st_size, expected_size)

    def test_tail_preserves_utf8_and_partial_final_line(self):
        with TemporaryDirectory() as temp_dir:
            log_file = Path(temp_dir) / "server.log"
            log_file.write_text("启动完成\n任务执行中", encoding="utf-8")

            lines, truncated, _ = system._read_log_tail(log_file, 50)

        self.assertEqual(lines, ["启动完成", "任务执行中"])
        self.assertFalse(truncated)

    def test_log_path_rejects_traversal(self):
        with TemporaryDirectory() as temp_dir, patch.object(system.settings, "log_dir", Path(temp_dir)):
            with self.assertRaises(HTTPException) as raised:
                system._resolve_log_file("../slide_flow.properties")

        self.assertEqual(raised.exception.status_code, 400)

    def test_log_path_rejects_non_log_files_and_symlinks(self):
        with TemporaryDirectory() as temp_dir:
            log_dir = Path(temp_dir)
            secret = log_dir / "secret.txt"
            secret.write_text("do not expose", encoding="utf-8")
            symlink = log_dir / "linked.log"
            symlink.symlink_to(secret)
            with patch.object(system.settings, "log_dir", log_dir):
                with self.assertRaises(HTTPException) as non_log:
                    system._resolve_log_file("secret.txt")
                with self.assertRaises(HTTPException) as linked_log:
                    system._resolve_log_file("linked.log")

        self.assertEqual(non_log.exception.status_code, 400)
        self.assertEqual(linked_log.exception.status_code, 400)

    def test_log_filename_supports_rotation_but_rejects_ambiguous_names(self):
        self.assertTrue(system._is_log_filename("server.log"))
        self.assertTrue(system._is_log_filename("server.log.1"))
        self.assertTrue(system._is_log_filename("server.log.20260924-001500"))
        self.assertTrue(system._is_log_filename("server.log-20260924"))
        self.assertFalse(system._is_log_filename("server.log.old"))
        self.assertFalse(system._is_log_filename("../server.log"))
        self.assertFalse(system._is_log_filename("server.log/1"))

    def test_tail_truncates_a_pathological_single_line(self):
        with TemporaryDirectory() as temp_dir:
            log_file = Path(temp_dir) / "server.log"
            log_file.write_text("x" * (system.LOG_TAIL_MAX_LINE_CHARS * 2), encoding="utf-8")

            lines, truncated, _ = system._read_log_tail(log_file, 50)

        self.assertEqual(len(lines), 1)
        self.assertIn("单行过长，已截断", lines[0])
        self.assertLessEqual(len(lines[0]), system.LOG_TAIL_MAX_LINE_CHARS + 32)
        self.assertTrue(truncated)

    def test_tail_sanitizes_terminal_and_directional_controls(self):
        with TemporaryDirectory() as temp_dir:
            log_file = Path(temp_dir) / "server.log"
            log_file.write_text(
                "\x1b[31mERROR\x1b[0m\tbad\x00value\u202etest",
                encoding="utf-8",
            )

            lines, truncated, _ = system._read_log_tail(log_file, 50)

        self.assertEqual(lines, ["ERROR\tbad�value�test"])
        self.assertFalse(truncated)

    def test_log_list_includes_rotated_logs_and_excludes_other_files(self):
        with TemporaryDirectory() as temp_dir:
            log_dir = Path(temp_dir)
            (log_dir / "server.log").write_text("active", encoding="utf-8")
            (log_dir / "server.log.1").write_text("rotated", encoding="utf-8")
            (log_dir / "secret.txt").write_text("hidden", encoding="utf-8")
            response = Response()
            with patch.object(system.settings, "log_dir", log_dir):
                logs = system.api_admin_system_logs(response=response, _={})

        self.assertEqual({log.filename for log in logs}, {"server.log", "server.log.1"})
        self.assertEqual(response.headers["cache-control"], "private, no-store")

    def test_tail_endpoint_returns_bounded_metadata(self):
        with TemporaryDirectory() as temp_dir:
            log_file = Path(temp_dir) / "server.log"
            log_file.write_text("first\nsecond\n", encoding="utf-8")
            app = FastAPI()
            app.include_router(system.router, prefix="/api")
            app.dependency_overrides[require_system_admin] = lambda: {}
            with patch.object(system.settings, "log_dir", Path(temp_dir)), TestClient(app) as client:
                response = client.get("/api/admin/system/logs/server.log/tail?lines=50")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["filename"], "server.log")
        self.assertEqual(payload["lines"], ["first", "second"])
        self.assertEqual(payload["line_count"], 2)
        self.assertRegex(payload["version"], r"^[0-9a-f]{24}$")
        self.assertEqual(response.headers["cache-control"], "private, no-store")

    def test_tail_endpoint_validates_line_limit_before_file_lookup(self):
        app = FastAPI()
        app.include_router(system.router, prefix="/api")
        app.dependency_overrides[require_system_admin] = lambda: {}
        with TestClient(app) as client:
            response = client.get("/api/admin/system/logs/server.log/tail?lines=5001")

        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
