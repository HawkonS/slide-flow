"""Deterministic protocol fault injection; no DB, network or Windows required."""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import zipfile

import httpx
from PIL import Image

from app.config import Settings
from app.services.resource_import import remote_fonts as fonts
from app.services.resource_import import remote_renderer as remote


class Stream(httpx.SyncByteStream):
    def __init__(self, generate):
        self.generate = generate

    def __iter__(self):
        yield from self.generate()


class RemoteProtocolTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="slideflow-remote-protocol-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config = Settings(root_dir=self.root, render_url="http://127.0.0.1:8765",
                               render_token="x" * 48, render_retries=1, render_batch_size=4)
        patcher = patch.object(remote, "settings", self.config)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.job = "a" * 32
        self.source = self.root / "page.pptx"
        self.source.write_bytes(b"source-pptx")
        with Image.new("RGB", (16, 9), "blue") as image:
            output = io.BytesIO()
            image.save(output, format="PNG")
        self.png = output.getvalue()
        self.page = {"index": 0, "size": len(self.png), "sha256": hashlib.sha256(self.png).hexdigest()}

    def client(self, handler):
        client = remote.RemoteRenderer(threading.Event(), lambda _: None)
        client.client.close()
        client.client = httpx.Client(base_url="http://renderer", transport=httpx.MockTransport(handler),
                                   headers={"Authorization": "Bearer " + self.config.render_token})
        self.addCleanup(client.close)
        return client

    def state(self, status="completed", pages=None):
        return {"id": self.job, "status": status, "pages": [dict(self.page)] if pages is None else pages}

    def successful_handler(self, calls):
        def handler(request):
            calls.append((request.method, request.url.path))
            if request.url.path == "/v1/fonts/check":
                return httpx.Response(200, json={"fonts": [], "installed": [], "missing": []})
            if request.method == "POST" and request.url.path == "/v1/jobs":
                return httpx.Response(202, json=self.state())
            if request.method == "GET" and request.url.path.endswith("/pages/0"):
                return httpx.Response(200, content=self.png, headers={"Content-Type": "image/png"})
            return httpx.Response(204)
        return handler

    def test_bearer_token_rejects_control_nonascii_and_unbounded_values(self):
        for token in ("x" * 32 + "\r\nHeader: injected", "密" * 40, "x" * 1025):
            with self.subTest(token_length=len(token)):
                self.config.render_token = token
                with self.assertRaises(RuntimeError):
                    remote.renderer_connection()

    def test_renderer_uses_bounded_task_scoped_keepalive_pool(self):
        """Requests in one batch may reuse a socket, but the pool is bounded.

        The renderer client is intentionally created per render batch and
        closed by previews.py in its finally block.  This assertion protects
        the production connection policy from regressing to an unbounded
        per-worker pool (or to one fresh connection for every poll/PNG).
        """
        with patch.object(remote.httpx, "Client", autospec=True) as factory:
            factory.return_value = Mock()
            renderer = remote.RemoteRenderer(threading.Event(), lambda _: None)
            kwargs = factory.call_args.kwargs
            limits = kwargs["limits"]
            self.assertEqual(limits.max_connections, remote.HTTP_MAX_CONNECTIONS)
            self.assertEqual(limits.max_keepalive_connections,
                             remote.HTTP_MAX_KEEPALIVE_CONNECTIONS)
            self.assertEqual(limits.keepalive_expiry,
                             remote.HTTP_KEEPALIVE_EXPIRY)
            self.assertFalse(kwargs["trust_env"])
            self.assertFalse(kwargs["follow_redirects"])
            renderer.close()
            renderer.close()  # explicit close is safe during cancellation races

    def test_credentials_cannot_be_forwarded_to_absolute_or_escaping_urls(self):
        transport = Mock()
        client = self.client(transport)
        for path in ("https://evil.example/v1/jobs", "//evil.example/v1/jobs", "/v1/../other", "/v1/jobs?token=secret"):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                client.request("GET", path)
        transport.assert_not_called()

    def test_remote_error_cannot_echo_credentials_or_raw_messages(self):
        response = httpx.Response(500, json={"error": {
            "code": self.config.render_token, "message": "Authorization: " + self.config.render_token,
        }})
        self.assertNotIn(self.config.render_token, remote._safe_error(response))
        self.assertNotIn("Authorization", remote._safe_error(response))

    def test_invalid_url_errors_do_not_echo_configured_secret_text(self):
        self.config.render_url = "https://renderer:" + self.config.render_token
        with self.assertRaises(RuntimeError) as raised:
            remote.renderer_connection()
        self.assertNotIn(self.config.render_token, str(raised.exception))

    def test_metadata_rejects_encoded_response_before_decompression(self):
        import gzip
        client = self.client(lambda _: httpx.Response(200, headers={"Content-Encoding": "gzip"},
            stream=Stream(lambda: iter([gzip.compress(b"x" * 1_000_000)]))))
        with self.assertRaisesRegex(RuntimeError, "压缩编码"):
            client.request("GET", "/v1/health")

    def test_font_response_must_be_object_and_reject_duplicate_json_keys(self):
        for payload in (b"[]", b"null", b'{"fonts":[],"fonts":[]}', b'{"fonts":NaN}'):
            with self.subTest(payload=payload):
                client = self.client(lambda _: httpx.Response(200, content=payload))
                with self.assertRaisesRegex(RuntimeError, "JSON"):
                    client.render([(0, self.source)], [], [], self.root, Mock())

    def test_page_only_render_does_not_send_font_manifest(self):
        seen = {}
        def handler(request):
            if request.method == "POST" and request.url.path == "/v1/jobs":
                with zipfile.ZipFile(io.BytesIO(request.content)) as archive:
                    seen.update(json.loads(archive.read("manifest.json")))
                return httpx.Response(202, json=self.state())
            if request.method == "GET" and request.url.path.endswith("/pages/0"):
                return httpx.Response(200, content=self.png, headers={"Content-Type": "image/png"})
            return httpx.Response(204)
        client = self.client(handler)
        client.render_pages([(0, self.source)], self.root, Mock())
        self.assertNotIn("fonts", seen)
        self.assertNotIn("required_fonts", seen)
        self.assertNotIn("font_hashes", seen)

    def test_font_statuses_are_unique_and_strict_booleans(self):
        inventory = [
            {"sha256": "a" * 64, "names": ["One"], "faces": []},
            {"sha256": "b" * 64, "names": ["Two"], "faces": []},
        ]
        for statuses in (
            [{"sha256": "a" * 64, "installed": True, "conflict": False}] * 2,
            [{"sha256": "a" * 64, "installed": "false", "conflict": False},
             {"sha256": "b" * 64, "installed": True, "conflict": False}],
        ):
            with self.subTest(statuses=statuses):
                client = self.client(lambda _: httpx.Response(200, json={"fonts": statuses}))
                with self.assertRaisesRegex(RuntimeError, "核验响应无效"):
                    client._font_inventory(inventory, ["One", "Two"])

    def test_duplicate_local_font_hashes_rejected_before_request(self):
        transport = Mock()
        client = self.client(transport)
        font = {"sha256": "a" * 64, "names": ["One"], "faces": []}
        with self.assertRaisesRegex(RuntimeError, "重复"):
            client._font_inventory([font, font], ["One"])
        transport.assert_not_called()

    def test_duplicate_font_names_are_rejected_before_request(self):
        transport = Mock()
        client = self.client(transport)
        font = {"sha256": "a" * 64, "names": ["Font", " font "], "faces": []}
        with self.assertRaisesRegex(RuntimeError, "字体清单"):
            client._font_inventory([font], ["Font"])
        with self.assertRaisesRegex(RuntimeError, "字体清单"):
            client._font_inventory([], ["Font", "font"])
        transport.assert_not_called()

    def test_slow_metadata_checks_deadline_before_rechunk_buffer_fills(self):
        elapsed = [0.0]
        def chunks():
            for _ in range(100):
                elapsed[0] += 1
                yield b"x"
        client = self.client(lambda _: httpx.Response(200, stream=Stream(chunks)))
        client.deadline = 3.0
        with patch.object(remote.time, "monotonic", side_effect=lambda: elapsed[0]):
            with self.assertRaisesRegex(RuntimeError, "总时间"):
                client.request("GET", "/v1/health")
        self.assertEqual(elapsed[0], 3)

    def test_cancel_checks_each_small_metadata_chunk(self):
        client = self.client(lambda _: httpx.Response(200, stream=Stream(chunks)))
        def chunks():
            client.cancel.set()
            yield b"x"
            self.fail("Cancellation must interrupt before a second chunk")
        with self.assertRaises(remote.RenderCancelled):
            client.request("GET", "/v1/health")

    def test_transport_timeout_cannot_outlive_deadline_or_cancel_poll_bound(self):
        timeouts = []
        def handler(request):
            timeouts.append(request.extensions["timeout"])
            return httpx.Response(200, json={})
        client = self.client(handler)
        with patch.object(remote.time, "monotonic", return_value=100):
            client.deadline = 100.5
            client.request("GET", "/v1/health")
        self.assertTrue(all(0 < value <= 0.5 for value in timeouts[0].values()))

    def test_accepted_upload_response_loss_recovers_by_key_without_resubmitting(self):
        calls, submitted_key, digest = [], [], []
        normal = self.successful_handler(calls)
        def handler(request):
            if request.method == "POST" and request.url.path == "/v1/jobs":
                calls.append((request.method, request.url.path))
                submitted_key.append(request.headers["Idempotency-Key"])
                digest.append(request.headers["X-Content-SHA256"])
                raise httpx.ReadError("response lost after acceptance", request=request)
            if request.method == "GET" and "/by-key/" in request.url.path:
                calls.append((request.method, request.url.path))
                self.assertEqual(request.url.path.rsplit("/", 1)[-1], submitted_key[0])
                self.assertEqual(request.headers["X-Content-SHA256"], digest[0])
                return httpx.Response(200, json=self.state())
            return normal(request)
        client = self.client(handler)
        publish = Mock()
        client.render([(0, self.source)], [], [], self.root, publish)
        self.assertEqual(len(submitted_key), 1)
        publish.assert_called_once()
        self.assertEqual(calls[-2:], [("DELETE", f"/v1/jobs/{self.job}/pages/0"), ("DELETE", f"/v1/jobs/{self.job}")])
        self.assertEqual(list(self.root.glob("batch-*.zip")), [])

    def test_response_loss_after_retries_uses_key_cleanup_not_unknown_job_id(self):
        calls, keys = [], []
        def handler(request):
            calls.append((request.method, request.url.path))
            if request.url.path == "/v1/fonts/check":
                return httpx.Response(200, json={"fonts": [], "installed": [], "missing": []})
            if request.method == "POST":
                keys.append(request.headers["Idempotency-Key"])
                raise httpx.ReadError("accepted response unavailable", request=request)
            if request.method == "GET":
                raise httpx.ReadError("lookup unavailable", request=request)
            return httpx.Response(204)
        client = self.client(handler)
        with patch.object(client, "pause"), self.assertRaises(remote.TransientRenderError):
            client.render([(0, self.source)], [], [], self.root, Mock())
        self.assertEqual(len(keys), 2)
        self.assertEqual(len(set(keys)), 1)
        self.assertEqual(calls[-1], ("DELETE", f"/v1/jobs/by-key/{keys[0]}"))
        self.assertFalse(list(self.root.glob("batch-*.zip")))

    def test_invalid_acceptance_body_still_releases_by_key(self):
        deletes = []
        def handler(request):
            if request.url.path == "/v1/fonts/check":
                return httpx.Response(200, json={"fonts": [], "installed": [], "missing": []})
            if request.method == "DELETE":
                deletes.append(request.url.path)
                return httpx.Response(204)
            return httpx.Response(202, content=b"not-json")
        client = self.client(handler)
        with self.assertRaisesRegex(RuntimeError, "JSON"):
            client.render([(0, self.source)], [], [], self.root, Mock())
        self.assertEqual(len(deletes), 1)
        self.assertIn("/by-key/", deletes[0])

    def test_cleanup_does_not_consume_untrusted_response_body(self):
        def chunks():
            self.fail("Cleanup must close without buffering the body")
            yield b""
        client = self.client(lambda _: httpx.Response(200, stream=Stream(chunks)))
        client.cancel.set()
        client.deadline = 0
        client._release(self.job, "b" * 32, "c" * 64)

    def test_poll_cannot_substitute_another_job(self):
        client = self.client(Mock())
        with self.assertRaisesRegex(RuntimeError, "其他任务"):
            client._job_state({**self.state(), "id": "b" * 32}, {0}, self.job, {})

    def test_complete_state_page_metadata_is_validated_before_any_download(self):
        calls = []
        normal = self.successful_handler(calls)
        def handler(request):
            if request.url.path == "/v1/jobs" and request.method == "POST":
                return httpx.Response(202, json=self.state(pages=[self.page, self.page]))
            return normal(request)
        client = self.client(handler)
        publish = Mock()
        with self.assertRaisesRegex(RuntimeError, "页列表"):
            client.render([(0, self.source)], [], [], self.root, publish)
        publish.assert_not_called()
        self.assertFalse(any(method == "GET" for method, _ in calls))

    def test_received_metadata_cannot_change_and_unknown_ack_is_rejected(self):
        client = self.client(Mock())
        for page in ({**self.page, "sha256": "0" * 64}, {**self.page, "acknowledged": True}):
            received = {0: (self.page["size"], self.page["sha256"])} if "acknowledged" not in page else {}
            with self.subTest(page=page), self.assertRaises(RuntimeError):
                client._job_state(self.state(pages=[page]), {0}, self.job, received)

    def test_download_transport_failure_retries_from_empty_partial_and_publishes_once(self):
        count = []
        def incomplete():
            yield self.png[:12]
            raise httpx.ReadError("interrupted")
        def handler(request):
            count.append(1)
            if len(count) == 1:
                return httpx.Response(200, stream=Stream(incomplete), headers={"content-type": "image/png"})
            return httpx.Response(200, content=self.png, headers={"content-type": "image/png"})
        client = self.client(handler)
        target = self.root / "page.png"
        with patch.object(client, "pause"):
            client.download(self.job, self.page, target)
        self.assertEqual(len(count), 2)
        self.assertEqual(target.read_bytes(), self.png)
        self.assertFalse(list(self.root.glob("*.part.png")))

    def test_download_retries_backpressure_but_not_auth_failure(self):
        for status, expected_calls in ((503, 2), (401, 1)):
            calls = []
            def handler(request):
                calls.append(1)
                return httpx.Response(status, headers={"retry-after": "7"})
            client = self.client(handler)
            with patch.object(client, "pause") as pause, self.assertRaises(RuntimeError):
                client.download(self.job, self.page, self.root / "retry.png")
            self.assertEqual(len(calls), expected_calls)
            if status == 503:
                pause.assert_called_once_with(7)

    def test_bad_checksum_keeps_previous_target_and_cleans_partial(self):
        client = self.client(lambda _: httpx.Response(200, content=self.png, headers={"content-type": "image/png"}))
        target = self.root / "page.png"
        target.write_bytes(b"previous")
        with self.assertRaisesRegex(RuntimeError, "校验"):
            client.download(self.job, {**self.page, "sha256": "0" * 64}, target)
        self.assertEqual(target.read_bytes(), b"previous")
        self.assertFalse(list(self.root.glob("*.part.png")))

    def test_page_ack_occurs_only_after_durable_validation_and_publication(self):
        calls = []
        client = self.client(self.successful_handler(calls))
        def publish(index, target):
            self.assertEqual(target.read_bytes(), self.png)
            self.assertNotIn(("DELETE", f"/v1/jobs/{self.job}/pages/0"), calls)
            raise RuntimeError("local publication failed")
        with self.assertRaisesRegex(RuntimeError, "local publication"):
            client.render([(0, self.source)], [], [], self.root, publish)
        self.assertNotIn(("DELETE", f"/v1/jobs/{self.job}/pages/0"), calls)
        self.assertEqual(calls[-1], ("DELETE", f"/v1/jobs/{self.job}"))

    def test_ack_response_loss_does_not_redownload_or_republish(self):
        calls, acks = [], []
        normal = self.successful_handler(calls)
        def handler(request):
            if request.method == "DELETE" and request.url.path.endswith("/pages/0"):
                acks.append(request.headers["If-Match"])
                raise httpx.ReadError("ack accepted but response lost", request=request)
            return normal(request)
        client = self.client(handler)
        publish = Mock()
        with patch.object(client, "pause"):
            client.render([(0, self.source)], [], [], self.root, publish)
        publish.assert_called_once()
        self.assertEqual(acks, ['"' + self.page["sha256"] + '"'] * 2)
        self.assertEqual(calls[-1], ("DELETE", f"/v1/jobs/{self.job}"))

    def test_batches_are_split_by_bytes_and_impossible_batch_fails_before_upload(self):
        source2 = self.root / "second.pptx"
        self.source.write_bytes(b"x" * 70)
        source2.write_bytes(b"x" * 70)
        font = self.root / "font.ttf"
        font.write_bytes(b"x" * 40)
        client = self.client(Mock())
        with patch.object(remote, "MAX_BUNDLE_BYTES", 160), patch.object(remote, "MAX_METADATA_BYTES", 20):
            batches = client._batches([(0, self.source), (1, source2)], [{"path": font}])
            self.assertEqual([len(batch) for batch, _ in batches], [1, 1])
            font.write_bytes(b"x" * 80)
            with self.assertRaisesRegex(RuntimeError, "单页 PPT 和字体"):
                client._batches([(0, self.source)], [{"path": font}])

    def test_font_snapshot_mutation_is_rejected_before_submit(self):
        font = self.root / "font.ttf"
        font.write_bytes(b"font-v2")
        inventory = [{"path": font, "sha256": hashlib.sha256(b"font-v1").hexdigest(), "names": ["Font"], "faces": ["Font Regular"]}]
        calls = []
        def handler(request):
            calls.append(request.url.path)
            return httpx.Response(200, json={"fonts": [{"sha256": inventory[0]["sha256"], "installed": False, "conflict": False}], "installed": [], "missing": ["Font"]})
        client = self.client(handler)
        with self.assertRaisesRegex(RuntimeError, "字体快照"):
            client.render([(0, self.source)], inventory, ["Font"], self.root, Mock())
        self.assertEqual(calls, ["/v1/fonts/check"])
        self.assertFalse(list(self.root.glob("batch-*.zip")))


class FontSnapshotTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="slideflow-font-snapshot-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.library = self.root / "library"
        self.library.mkdir()
        self.output = self.root / "snapshot"
        self.rows = []
        database = Mock()
        database.execute.return_value.fetchall.side_effect = lambda: self.rows
        for patcher in (
            patch.object(fonts, "get_db", return_value=database),
            patch.object(fonts, "settings", SimpleNamespace(fonts_dir=self.library, abs_path=lambda path: Path(path))),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def source(self, name, data):
        source = self.library / name
        source.write_bytes(data)
        self.rows.append({"aliases": '["Font"]', "file_path": str(source)})
        return source

    def test_snapshot_deduplicates_before_unique_byte_and_count_budgets(self):
        self.source("one.ttf", b"12345678")
        self.source("two.ttf", b"12345678")
        with patch.object(fonts, "MAX_FONT_TOTAL_BYTES", 8), patch.object(fonts, "_font_metadata", return_value=(["Font"], ["Font Regular"])):
            result = fonts.snapshot_fonts(["Font"], self.output)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["path"].read_bytes(), b"12345678")
        self.assertEqual(len(list(self.output.iterdir())), 1)

    def test_conflicting_full_faces_are_rejected_and_all_attempt_files_removed(self):
        self.source("one.ttf", b"first")
        self.source("two.ttf", b"second")
        with patch.object(fonts, "_font_metadata", return_value=(["Font"], ["Font Regular"])):
            with self.assertRaisesRegex(RuntimeError, "同名"):
                fonts.snapshot_fonts(["Font"], self.output)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_required_name_must_be_in_actual_font_not_just_database_alias(self):
        self.source("one.ttf", b"font")
        with patch.object(fonts, "_font_metadata", return_value=(["Other"], ["Other Regular"])):
            with self.assertRaisesRegex(RuntimeError, "真实名称"):
                fonts.snapshot_fonts(["Font"], self.output)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_invalid_font_is_rejected_locally_and_not_left_on_disk(self):
        self.source("one.ttf", b"not-font-data")
        with self.assertRaisesRegex(RuntimeError, "字体文件损坏"):
            fonts.snapshot_fonts(["Font"], self.output)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_oversized_collection_rejected_before_fonttools_constructs_faces(self):
        import struct
        self.source("huge.ttc", b"ttcf\x00\x01\x00\x00" + struct.pack(">I", 100000))
        with patch.object(fonts, "TTCollection") as parser:
            with self.assertRaisesRegex(RuntimeError, "字体文件损坏"):
                fonts.snapshot_fonts(["Font"], self.output)
        parser.assert_not_called()
        self.assertEqual(list(self.output.iterdir()), [])

    def test_growth_during_copy_is_bounded_and_partial_is_removed(self):
        source = self.source("one.ttf", b"1234")
        def grow():
            if source.stat().st_size == 4:
                with source.open("ab") as output:
                    output.write(b"x" * 32)
        with patch.object(fonts, "MAX_FONT_BYTES", 16):
            with self.assertRaises(RuntimeError):
                fonts.snapshot_fonts(["Font"], self.output, check=grow)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_symlink_outside_library_is_rejected_without_copy(self):
        external = self.root / "outside.ttf"
        external.write_bytes(b"font")
        link = self.library / "link.ttf"
        link.symlink_to(external)
        self.rows.append({"aliases": '["Font"]', "file_path": str(link)})
        with self.assertRaisesRegex(RuntimeError, "不可读取"):
            fonts.snapshot_fonts(["Font"], self.output)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_cancellation_cleans_all_snapshots_created_in_the_attempt(self):
        self.source("one.ttf", b"font")
        def check():
            if self.output.exists() and any(self.output.iterdir()):
                raise remote.RenderCancelled("cancelled")
        with self.assertRaises(remote.RenderCancelled):
            fonts.snapshot_fonts(["Font"], self.output, check=check)
        self.assertEqual(list(self.output.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
