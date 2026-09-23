"""Pull-render preview state and legacy transport regression tests."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from PIL import Image
from fastapi import HTTPException

from app.config import Settings
from app.routers.resource_import import resource_import_preview
from app.services.resource_import import previews, remote_renderer, sessions, streaming
from app.services.resource_import.rendering import _normalize_import_ppt


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.session_dir = self.root / ("a" * 32)
        self.session_dir.mkdir()
        source = self.session_dir / "source.pptx"
        source.write_bytes(b"original curves and alpha must not change")
        self.session = dict(
            session_id="a" * 32, owner_id=1, temp_dir=str(self.session_dir),
            source_path=str(source), slide_count=2, fonts=[], missing_fonts=[],
            mode="ppt", preview_paths=[], preview_status="pending", expires_at=time.time() + 600,
        )
        patcher = patch.object(sessions, "_resource_import_root", return_value=self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        sessions._write_resource_import_session(self.session)

    def test_no_normalization_roundtrip(self):
        source = Path(self.session["source_path"])
        self.assertEqual(_normalize_import_ppt(source, self.session_dir), source)
        alias = source.with_suffix(".potx")
        alias.write_bytes(source.read_bytes())
        self.assertEqual(_normalize_import_ppt(alias, self.session_dir).read_bytes(), source.read_bytes())
        with self.assertRaisesRegex(RuntimeError, "PPTX"):
            _normalize_import_ppt(source.with_suffix(".ppt"), self.session_dir)

    def test_wait_wrapper_observes_completed_pull_task(self):
        events = []
        attempts = {"count": 0}

        def state(_session):
            attempts["count"] += 1
            if attempts["count"] == 1:
                return {"status": "running"}
            attempt = "b" * 32
            directory = self.session_dir / f"previews_{attempt}"
            directory.mkdir(exist_ok=True)
            paths = []
            for index in range(2):
                target = directory / f"page_{index:04d}.png"
                Image.new("RGB", (16, 9)).save(target)
                paths.append(str(target))
            updated = dict(self.session, preview_status="ready", preview_paths=paths,
                           render_attempt=attempt, renderer_version="wps-pull-v3-4k")
            sessions._write_resource_import_session(updated)
            return {"status": "completed", "preview_count": 2}

        with patch.object(previews, "ensure_render_task"), patch.object(previews, "render_task_state", side_effect=state), patch.object(previews.time, "sleep"):
            result = previews._render_and_publish_ppt_previews(self.session, events.append)
        self.assertEqual(len(result), 2)
        self.assertEqual([item["index"] for item in events if item["type"] == "page"], [0, 1])

    def test_stream_disconnect_does_not_cancel_durable_task(self):
        async def scenario():
            response = streaming.preview_stream(self.session["session_id"], {"id": 1})
            events = response.body_iterator
            self.assertEqual(json.loads(await anext(events))["type"], "started")
            await events.aclose()

        with patch.object(streaming, "ensure_render_task") as ensure:
            asyncio.run(scenario())
        ensure.assert_called_once()

    def test_stream_returns_completed_pages(self):
        attempt = "c" * 32
        paths = []
        directory = self.session_dir / f"previews_{attempt}"
        directory.mkdir()
        for index in range(2):
            path = directory / f"page_{index:04d}.png"
            Image.new("RGB", (16, 9)).save(path)
            paths.append(str(path))
        updated = dict(self.session, preview_status="ready", preview_paths=paths,
                       render_attempt=attempt, renderer_version="wps-pull-v3-4k")
        sessions._write_resource_import_session(updated)

        async def scenario():
            response = streaming.preview_stream(self.session["session_id"], {"id": 1})
            events = []
            async for raw in response.body_iterator:
                events.append(json.loads(raw))
            return events

        events = asyncio.run(scenario())
        self.assertEqual([item["type"] for item in events], ["started", "page", "page", "completed"])

    def test_get_image_never_starts_conversion(self):
        self.session.update(renderer_version="old", preview_paths=[self.session["source_path"]], preview_status="ready")
        sessions._write_resource_import_session(self.session)
        with self.assertRaises(HTTPException) as caught:
            resource_import_preview(self.session["session_id"], 0, user={"id": 1})
        self.assertEqual(caught.exception.status_code, 409)


class ClientTests(unittest.TestCase):
    def setUp(self):
        config = Settings(root_dir=Path("/tmp"), render_url="http://127.0.0.1:8765", render_token="x" * 48)
        patcher = patch.object(remote_renderer, "settings", config)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.settings = config

    def test_transport_is_private_or_tls(self):
        for url in ("http://example.com:8765", "https://user:pass@example.com", "https://example.com/path", "https://example.com?token=x"):
            self.settings.render_url = url
            with self.assertRaises(RuntimeError):
                remote_renderer.renderer_connection()

    def test_large_split_pptx_is_checked_against_input_limit_not_png_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "page_56.pptx"
            with path.open("wb") as output:
                output.truncate(66 * 1024 * 1024)
            renderer = object.__new__(remote_renderer.RemoteRenderer)
            renderer.check = lambda: None
            renderer.batch_size = 1
            self.assertEqual(len(renderer._batches([(55, path)], [])), 1)

    def test_input_error_identifies_page_and_size(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "page_57.pptx"
            with path.open("wb") as output:
                output.truncate(remote_renderer.MAX_INPUT_FILE_BYTES + 1)
            renderer = object.__new__(remote_renderer.RemoteRenderer)
            renderer.check = lambda: None
            renderer.batch_size = 1
            with self.assertRaisesRegex(RuntimeError, "第 57 页 PPTX"):
                renderer._batches([(56, path)], [])

    def test_private_ip_https_does_not_require_a_domain(self):
        self.settings.render_url = "https://10.0.2.15:8766"
        url, verify = remote_renderer.renderer_connection()
        self.assertEqual(url, self.settings.render_url)
        self.assertIsNotNone(verify)

    def test_download_verified_before_publication(self):
        buffer = io.BytesIO()
        Image.new("RGB", (16, 9)).save(buffer, format="PNG")
        data = buffer.getvalue()
        renderer = remote_renderer.RemoteRenderer(threading.Event(), lambda message: None)
        renderer.client.close()
        renderer.client = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(200, content=data, headers={"content-type": "image/png"})), base_url="http://test")
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "page.png"
            renderer.download("a" * 32, {"index": 0, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}, target)
            self.assertEqual(target.read_bytes(), data)
        renderer.close()

    def test_cancel_and_total_deadline(self):
        cancel = threading.Event()
        renderer = remote_renderer.RemoteRenderer(cancel, lambda message: None)
        cancel.set()
        with self.assertRaises(remote_renderer.RenderCancelled):
            renderer.check()
        cancel.clear()
        renderer.deadline = 0
        with self.assertRaisesRegex(RuntimeError, "总时间"):
            renderer.check()
        renderer.close()


if __name__ == "__main__":
    unittest.main()
