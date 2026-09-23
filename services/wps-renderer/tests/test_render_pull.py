from __future__ import annotations

import hashlib
import io
import json
import errno
import sys
import tempfile
import unittest
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
            worker._bundle(page, source, 288, target)
            with zipfile.ZipFile(target) as archive:
                self.assertEqual(set(archive.namelist()), {"manifest.json", "pages/1.pptx"})
                manifest = json.loads(archive.read("manifest.json"))
                self.assertEqual(manifest["pages"][0]["index"], 1)

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
            worker._submit_local = lambda page, source, dpi, stop: image
            worker._upload = lambda url, path, stop: None
            worker._renew_loop = lambda *args: None
            task = {
                "task_id": "a" * 32, "lease_token": "l" * 43, "dpi": 288, "lease_seconds": 600,
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


if __name__ == "__main__":
    unittest.main()
