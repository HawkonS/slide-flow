from __future__ import annotations

import hashlib
import io
import json
import errno
import sys
import tempfile
import unittest
import urllib.error
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wps_renderer.render_pull import RenderPull, _failure_code
from wps_renderer.font_sync import FontSync


TOKEN = "test-only-" + "x" * 40


class RenderPullTests(unittest.TestCase):
    def config(self, root):
        return {
            "url": "http://127.0.0.1:18088",
            "renderer_url": "http://127.0.0.1:8765",
            "token": TOKEN,
            "worker_id": "unit-worker",
            "work_dir": root,
        }

    def test_rejects_non_tls_remote_task_api(self):
        with tempfile.TemporaryDirectory() as temp:
            config = self.config(temp)
            config["url"] = "http://example.com:8088"
            with self.assertRaises(ValueError):
                RenderPull(config)

    def test_renderer_can_use_a_separate_local_token(self):
        with tempfile.TemporaryDirectory() as temp:
            config = self.config(temp)
            config["token"] = "main-token-" + "m" * 40
            config["renderer_token"] = "renderer-token-" + "r" * 40
            worker = RenderPull(config)
            self.assertEqual(worker.token, config["token"])
            self.assertEqual(worker.renderer_token, config["renderer_token"])

    def test_font_sync_also_rejects_remote_plain_http(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(ValueError):
                FontSync({"url": "http://example.com:8088", "token": TOKEN, "install_dir": temp})

    def test_bundle_contains_only_declared_single_page(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = RenderPull(self.config(temp))
            source = Path(temp) / "1.pptx"
            source.write_bytes(b"ppt")
            target = Path(temp) / "bundle.zip"
            page = {"index": 1, "sha256": hashlib.sha256(b"ppt").hexdigest()}
            worker._bundle(page, source, 288, target, ["Test Sans"], ["a" * 64])
            with zipfile.ZipFile(target) as archive:
                self.assertEqual(set(archive.namelist()), {"manifest.json", "pages/1.pptx"})
                manifest = json.loads(archive.read("manifest.json"))
                self.assertEqual(manifest["pages"][0]["index"], 1)
                self.assertEqual(manifest["required_fonts"], ["Test Sans"])
                self.assertEqual(manifest["font_hashes"], ["a" * 64])

    def test_process_reports_completed_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = RenderPull(self.config(temp))
            image = Path(temp) / "rendered.png"
            from PIL import Image
            Image.new("RGB", (16, 9)).save(image)
            calls = []
            def main(method, path, body=None, timeout=30):
                calls.append((method, path, body))
                if path.endswith("/urls"):
                    return {"page": {"index": 0, "download_url": "https://bucket.example/source", "upload_url": "https://bucket.example/output"}}
                return {"ok": True}
            worker._main = main
            worker._download = lambda url, target, expected_size, expected_sha: target.write_bytes(b"ppt")
            worker._submit_local = lambda page, source, dpi, stop, required, hashes: image
            worker._upload = lambda url, path, stop: None
            worker._renew_loop = lambda *args: None
            task = {
                "task_id": "a" * 32, "lease_token": "l" * 43, "dpi": 288, "lease_seconds": 600,
                "required_fonts": ["Test Sans"], "font_hashes": ["f" * 64],
                "pages": [{"index": 0, "size": 3, "sha256": hashlib.sha256(b"ppt").hexdigest(),
                           }],
            }
            worker.process(task)
            complete = [call for call in calls if call[1].endswith("/complete")]
            self.assertEqual(len(complete), 1)
            self.assertEqual(complete[0][2]["pages"][0]["sha256"], hashlib.sha256(image.read_bytes()).hexdigest())

    def test_transient_failures_use_retryable_server_codes(self):
        self.assertEqual(_failure_code(TimeoutError()), "network_error")
        self.assertEqual(_failure_code(OSError(errno.ENOSPC, "disk full")), "disk_pressure")
        self.assertEqual(_failure_code(RuntimeError("renderer_unavailable")), "renderer_unavailable")
        self.assertEqual(_failure_code(ValueError("invalid metadata")), "render_failed")
        self.assertEqual(_failure_code(urllib.error.HTTPError("x", 400, "bad", {}, None)), "render_failed")
        self.assertEqual(_failure_code(urllib.error.HTTPError("x", 503, "down", {}, None)), "network_error")
        self.assertEqual(_failure_code(urllib.error.HTTPError("x", 409, "stale", {}, None)), "lease_lost")

    def test_font_sync_bounds_metadata_response(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = FontSync({"url": "http://127.0.0.1:18088", "token": TOKEN, "install_dir": temp})
            class OversizedResponse:
                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return None

                def read(self, limit):
                    return b"x" * limit

            response = OversizedResponse()
            with patch("urllib.request.urlopen", return_value=response):
                with self.assertRaises(ValueError):
                    worker.request("GET", "/api/renderer/font-tasks/claim")

    def test_workers_reject_non_object_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            renderer = RenderPull(self.config(temp))
            class JsonListResponse:
                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return None

                def read(self, _limit):
                    return b"[]"

            with patch("urllib.request.urlopen", return_value=JsonListResponse()):
                with self.assertRaises(ValueError):
                    renderer._main("GET", "/api/renderer/render-tasks/status")

            fonts = FontSync({"url": "http://127.0.0.1:18088", "token": TOKEN, "install_dir": temp})
            fonts.request = lambda *args, **kwargs: b"[]"
            with self.assertRaises(ValueError):
                fonts.run_once()

    def test_font_sync_reports_result_with_lease_token(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = FontSync({"url": "http://127.0.0.1:18088", "token": TOKEN, "install_dir": temp})
            task = {
                "action": "install",
                "task_id": "a" * 32,
                "lease_token": "l" * 43,
                "lease_seconds": 600,
                "sha256": "b" * 64,
                "size": 12,
                "file_name": "font.ttf",
                "download_url": "/api/renderer/font-tasks/" + "a" * 32 + "/file",
            }
            calls = []

            def request(method, path, body=None, headers=None):
                calls.append((method, path, body, headers))
                if method == "GET":
                    return json.dumps({"task": task}).encode()
                return b'{"ok":true}'

            worker.request = request
            worker.install = lambda value: self.assertEqual(value, task)
            self.assertTrue(worker.run_once())
            self.assertEqual(calls[-1][2]["status"], "completed")
            self.assertEqual(calls[-1][3]["X-Render-Lease"], task["lease_token"])

    def test_font_sync_accepts_legacy_claim_without_lease_or_size(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = FontSync({"url": "http://127.0.0.1:18088", "token": TOKEN, "install_dir": temp})
            task = {"task_id": "a" * 32, "sha256": "b" * 64,
                    "file_name": "font.ttf",
                    "download_url": "/api/renderer/font-tasks/" + "a" * 32 + "/file"}
            calls = []

            def request(method, path, body=None, headers=None):
                calls.append((method, path, body, headers))
                if method == "GET":
                    return json.dumps({"task": task}).encode()
                return b'{"ok":true}'

            worker.request = request
            worker.install = lambda value: self.assertEqual(value, task)
            self.assertTrue(worker.run_once())
            self.assertIsNone(calls[-1][3])

    def test_font_install_uses_content_addressed_destination(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = FontSync({"url": "http://127.0.0.1:18088", "token": TOKEN, "install_dir": temp})
            task = {"file_name": "same-name.ttf", "sha256": "c" * 64, "size": 4}

            def download(_task, target):
                target.write_bytes(b"font")

            worker.download = download
            worker.register = lambda path: None
            worker.install(task)
            self.assertTrue((Path(temp) / (("c" * 64) + ".ttf")).is_file())
            self.assertFalse((Path(temp) / "same-name.ttf").exists())

    def test_font_sync_processes_delete_task_when_install_queue_is_empty(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = FontSync({"url": "http://127.0.0.1:18088", "token": TOKEN, "install_dir": temp})
            task = {"action": "delete", "task_id": "d" * 32, "lease_token": "l" * 43,
                    "lease_seconds": 600, "sha256": "e" * 64, "file_name": "font.ttf"}
            calls = []

            def request(method, path, body=None, headers=None):
                calls.append((method, path, body, headers))
                if method == "GET":
                    return json.dumps({"task": task}).encode()
                return b'{"ok":true}'

            worker.request = request
            worker.uninstall = lambda value: self.assertEqual(value, task)
            self.assertTrue(worker.run_once())
            self.assertIn("/font-tasks/", calls[-1][1])
            self.assertEqual(calls[-1][2]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
