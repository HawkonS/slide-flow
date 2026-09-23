"""Remote renderer integrity, source preservation and transport regressions."""
import hashlib
import asyncio
import json
import io
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from PIL import Image
from fastapi import HTTPException
from starlette.middleware.gzip import GZipMiddleware
from app.config import Settings
from app.services.resource_import import previews, sessions, remote_renderer
from app.services.resource_import import streaming, jobs
from app.services.resource_import.rendering import _normalize_import_ppt
from app.routers.resource_import import resource_import_preview


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.session_dir = self.root / ("a" * 32)
        self.session_dir.mkdir()
        source = self.session_dir / "source.pptx"
        source.write_bytes(b"original curves and alpha must not change")
        self.session = dict(session_id="a" * 32, owner_id=1, temp_dir=str(self.session_dir),
                            source_path=str(source), slide_count=2, fonts=[], missing_fonts=[],
                            mode="ppt", preview_paths=[], preview_status="pending", expires_at=time.time()+600)
        patcher = patch.object(sessions, "_resource_import_root", return_value=self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        sessions._write_resource_import_session(self.session)

    @staticmethod
    def split(source, dest, **kwargs):
        dest.mkdir()
        paths = [dest / f"{i}.pptx" for i in range(2)]
        for path in paths:
            path.write_bytes(source.read_bytes())
        return paths

    def test_no_normalization_roundtrip(self):
        source = Path(self.session["source_path"])
        self.assertEqual(_normalize_import_ppt(source, self.session_dir), source)
        alias = source.with_suffix(".potx")
        alias.write_bytes(source.read_bytes())
        self.assertEqual(_normalize_import_ppt(alias, self.session_dir).read_bytes(), source.read_bytes())
        with self.assertRaisesRegex(RuntimeError, "PPTX"):
            _normalize_import_ppt(source.with_suffix(".ppt"), self.session_dir)

    def fake_remote(self, *, fail=False):
        test = self
        class Remote:
            def __init__(self, *_): pass
            def check(self): pass
            def close(self): pass
            def render(self, pages, fonts, required, directory, publish):
                for index, source in pages:
                    test.assertEqual(source.read_bytes(), b"original curves and alpha must not change")
                    target = directory / f"page_{index}.png"
                    Image.new("RGB", (16, 9)).save(target)
                    publish(index, target)
                    stored = sessions._load_resource_import_session_file(test.session["session_id"])
                    test.assertEqual(stored["preview_status"], "rendering")
                    test.assertFalse(stored["preview_paths"])
                    response = resource_import_preview(test.session["session_id"], index, user={"id":1}, attempt=stored["render_attempt"])
                    test.assertEqual(Path(response.path), target)
                    if fail: raise RuntimeError("injected network failure")
        return Remote

    def test_progressive_readable_but_atomic_ready_and_exact_singles(self):
        events = []
        with patch.object(previews, "RemoteRenderer", self.fake_remote()), patch.object(previews, "split_pptx_to_single_pages", self.split), patch.object(previews, "wait_for_font_sync"):
            result = previews._render_and_publish_ppt_previews(self.session, events.append)
        self.assertEqual(len(result), 2)
        self.assertEqual(self.session["preview_status"], "ready")
        self.assertEqual(len(self.session["split_paths"]), 2)
        self.assertEqual([e["index"] for e in events if e["type"]=="page"], [0,1])
        with self.assertRaises(HTTPException) as caught:
            resource_import_preview(self.session["session_id"], 0, user={"id":1}, attempt="old")
        self.assertEqual(caught.exception.status_code, 409)

    def test_partial_failure_removes_generation_and_preserves_source(self):
        with patch.object(previews, "RemoteRenderer", self.fake_remote(fail=True)), patch.object(previews, "split_pptx_to_single_pages", self.split), patch.object(previews, "wait_for_font_sync"):
            with self.assertRaisesRegex(RuntimeError, "network failure"):
                previews._render_and_publish_ppt_previews(self.session)
        self.assertEqual(self.session["preview_status"], "error")
        self.assertEqual(self.session["partial_preview_paths"], {})
        self.assertEqual(list(self.session_dir.glob("previews_*")), [])
        self.assertTrue(Path(self.session["source_path"]).exists())

    def test_get_image_never_starts_conversion(self):
        self.session.update(renderer_version="old", preview_paths=[self.session["source_path"]], preview_status="ready")
        sessions._write_resource_import_session(self.session)
        with self.assertRaises(HTTPException) as caught:
            resource_import_preview(self.session["session_id"], 0, user={"id":1})
        self.assertEqual(caught.exception.status_code, 409)

    def test_disconnect_waits_for_cancellation_before_releasing_session_lease(self):
        released = threading.Event()
        def render(session, emit, cancel):
            emit({"type":"progress", "message":"running"})
            cancel.wait(3)
            released.set()
            raise remote_renderer.RenderCancelled("cancelled")
        async def scenario():
            response = streaming.preview_stream(self.session["session_id"], {"id":1})
            events = response.body_iterator
            self.assertEqual(json.loads(await anext(events))["type"], "started")
            self.assertEqual(json.loads(await anext(events))["type"], "progress")
            with self.assertRaises(HTTPException) as caught:
                with sessions._resource_import_operation(self.session): pass
            self.assertEqual(caught.exception.status_code,409)
            await events.aclose()
            self.assertTrue(released.is_set())
            with sessions._resource_import_operation(self.session): pass
        with patch.object(streaming,"_render_and_publish_ppt_previews",render), patch.object(jobs,"_resource_import_root",return_value=self.root):
            asyncio.run(scenario())

    def test_gzip_does_not_buffer_progress_before_conversion_finishes(self):
        released = threading.Event()
        def render(session, emit, cancel):
            emit({"type":"progress", "message":"running"})
            if not released.wait(2):
                raise RuntimeError("progress was buffered by compression")
            return []
        async def scenario():
            response = streaming.preview_stream(self.session["session_id"], {"id":1})
            bodies = []
            async def app(scope, receive, send):
                await response(scope, receive, send)
            async def receive():
                await asyncio.Future()
            async def send(message):
                if message["type"] == "http.response.start":
                    self.assertEqual(dict(message["headers"])[b"content-encoding"], b"identity")
                elif message["type"] == "http.response.body":
                    bodies.append(message.get("body", b""))
                    if b'"type": "progress"' in bodies[-1]:
                        released.set()
            await GZipMiddleware(app, minimum_size=1)({"type":"http","asgi":{"spec_version":"2.4"},"headers":[(b"accept-encoding",b"gzip")]}, receive, send)
            self.assertTrue(released.is_set())
            self.assertIn(b'"type": "completed"', b"".join(bodies))
        with patch.object(streaming,"_render_and_publish_ppt_previews",render), patch.object(jobs,"_resource_import_root",return_value=self.root):
            asyncio.run(scenario())


class ClientTests(unittest.TestCase):
    def setUp(self):
        config = Settings(root_dir=Path("/tmp"), render_url="http://127.0.0.1:8765", render_token="x"*48)
        patcher = patch.object(remote_renderer, "settings", config)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.settings = config

    def test_transport_is_private_or_tls(self):
        for url in ("http://example.com:8765", "https://user:pass@example.com", "https://example.com/path", "https://example.com?token=x"):
            self.settings.render_url = url
            with self.assertRaises(RuntimeError): remote_renderer.renderer_connection()

    def test_large_split_pptx_is_checked_against_input_limit_not_png_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "page_56.pptx"
            with path.open("wb") as output:
                output.truncate(66 * 1024 * 1024)
            renderer = object.__new__(remote_renderer.RemoteRenderer)
            renderer.check = lambda: None
            renderer.batch_size = 1
            batches = renderer._batches([(55, path)], [])
            self.assertEqual(len(batches), 1)

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
        renderer.client = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(200, content=data, headers={"content-type":"image/png"})), base_url="http://test")
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "page.png"
            renderer.download("a"*32, {"index":0,"size":len(data),"sha256":hashlib.sha256(data).hexdigest()},target)
            self.assertEqual(target.read_bytes(), data)
            target.unlink()
            with self.assertRaisesRegex(RuntimeError,"校验"):
                renderer.download("a"*32, {"index":0,"size":len(data),"sha256":"0"*64},target)
            self.assertEqual(list(Path(temp).iterdir()), [])
        renderer.close()

    def test_cancel_and_total_deadline(self):
        cancel = threading.Event()
        renderer = remote_renderer.RemoteRenderer(cancel, lambda message: None)
        cancel.set()
        with self.assertRaises(remote_renderer.RenderCancelled): renderer.check()
        cancel.clear()
        renderer.deadline = 0
        with self.assertRaisesRegex(RuntimeError, "总时间"): renderer.check()
        renderer.close()

    def test_unauthorized_is_not_retried(self):
        calls = []
        renderer = remote_renderer.RemoteRenderer(threading.Event(), lambda message: None)
        renderer.client.close()
        def fail(req):
            calls.append(req)
            return httpx.Response(401,json={"error":{"code":"unauthorized"}})
        renderer.client = httpx.Client(transport=httpx.MockTransport(fail),base_url="http://test")
        with self.assertRaisesRegex(RuntimeError,"鉴权"):
            renderer.request("GET", "/v1/health")
        self.assertEqual(len(calls),1)
        renderer.close()

    def test_metadata_size_is_bounded(self):
        renderer = remote_renderer.RemoteRenderer(threading.Event(), lambda message:None)
        renderer.client.close()
        renderer.client = httpx.Client(transport=httpx.MockTransport(lambda req:httpx.Response(200,content=b"x"*300000)),base_url="http://test")
        with self.assertRaisesRegex(RuntimeError,"响应过大"):
            renderer.request("GET","/v1/health")
        renderer.close()

    def test_retry_respects_remote_backpressure_and_keeps_idempotency_key(self):
        renderer = remote_renderer.RemoteRenderer(threading.Event(), lambda message: None)
        self.addCleanup(renderer.close)
        renderer.client.close()
        seen = []
        def respond(request):
            seen.append(request.headers.get("idempotency-key"))
            if len(seen) == 1:
                return httpx.Response(429, headers={"Retry-After": "5"}, json={"error":{"code":"queue_full"}})
            return httpx.Response(200, json={"ok": True})
        renderer.client = httpx.Client(transport=httpx.MockTransport(respond), base_url="http://test")
        with patch.object(renderer, "pause") as pause:
            response = renderer.request("POST", "/v1/jobs", headers={"Idempotency-Key":"stable-key"})
        self.assertEqual(response.status_code, 200)
        pause.assert_called_once_with(5)
        self.assertEqual(seen, ["stable-key", "stable-key"])


if __name__ == "__main__": unittest.main()
