from __future__ import annotations

import hashlib
import io
import json
import errno
import sys
import tempfile
import threading
import unittest
import urllib.error
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wps_renderer.render_pull import LeaseLost, RenderPull, _failure_code
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

    @staticmethod
    def local_submission(job_id="a" * 32):
        class Response:
            status = 202

            def read(self, _limit):
                return json.dumps({"id": job_id}).encode()

        class Connection:
            def putrequest(self, *_args):
                pass

            def putheader(self, *_args):
                pass

            def endheaders(self):
                pass

            def send(self, _block):
                pass

            def getresponse(self):
                return Response()

            def close(self):
                pass

        return Connection()

    class ImmediateEvent:
        def is_set(self):
            return False

        def wait(self, _timeout):
            return False

    def incremental_worker(self, root, *, count=11, batch_size=6, first_batch=4):
        worker = RenderPull(self.config(root))
        worker.retry_seconds = 0
        worker._renew_loop = lambda *args: None
        source = b"full-deck"
        task = {
            "task_id": "a" * 32, "lease_token": "l" * 43,
            "dpi": 288, "lease_seconds": 600, "batch_size": batch_size,
            "incremental_results": True, "first_batch_size": first_batch,
            "source": {"sha256": hashlib.sha256(source).hexdigest(),
                       "size": len(source), "slide_count": count},
            "pages": [{"index": index, "size": 3,
                       "sha256": hashlib.sha256(b"ppt").hexdigest()}
                      for index in range(count)],
        }
        events, requests, images, accepted = [], [], {}, set()
        from PIL import Image
        for index in range(count):
            image = Path(root) / f"image-{index}.png"
            Image.new("RGB", (16, 9), (index, 0, 0)).save(image)
            images[index] = image

        def main(method, path, body=None, timeout=30):
            requests.append((method, path, json.loads(json.dumps(body)), timeout))
            if path.endswith("/source-url"):
                return {"source": {**task["source"], "download_url": "https://bucket.example/deck"}}
            if path.endswith("/urls"):
                return {"page": {"index": body["page_index"],
                                 "download_url": "https://bucket.example/page",
                                 "upload_url": f"https://bucket.example/output-{body['page_index']}"}}
            if path.endswith("/progress"):
                indices = tuple(page["index"] for page in body["pages"])
                events.append(("progress", indices))
                accepted.update(indices)
                return {"ok": True, "preview_count": len(accepted), "total": count}
            if path.endswith("/complete"):
                events.append(("complete", tuple(page["index"] for page in body["pages"])))
            if path.endswith("/failed"):
                events.append(("failed", body["error_code"]))
            return {"ok": True}

        def submit(pages, source_meta, source_path, dpi, *_args):
            self.assertEqual(dpi, 288)
            self.assertEqual(source_path.read_bytes(), source)
            events.append(("render", tuple(page["index"] for page in pages)))
            return {page["index"]: images[page["index"]] for page in pages}

        worker._main = main
        worker._renderer = lambda *_args, **_kwargs: {
            "version": 2, "max_batch_pages": 50, "max_source_slides": 500,
            "max_input_file_bytes": 120 * 1024 * 1024,
            "max_upload_bytes": 128 * 1024 * 1024,
        }
        worker._download = lambda url, target, *_args: target.write_bytes(source)
        worker._submit_local_batch = submit
        worker._upload = lambda url, _path, _stop: events.append(("upload", int(url.rsplit("-", 1)[1])))
        return worker, task, events, requests, images

    def test_incremental_first_batch_is_published_before_remaining_conversion(self):
        with tempfile.TemporaryDirectory() as temp:
            worker, task, events, requests, _ = self.incremental_worker(temp)
            worker.process(task)
            phases = [event for event in events if event[0] != "upload"]
            self.assertEqual(phases, [
                ("render", (0, 1, 2, 3)), ("progress", (0, 1, 2, 3)),
                ("render", (4, 5, 6, 7, 8, 9)), ("progress", (4, 5, 6, 7, 8, 9)),
                ("render", (10,)), ("progress", (10,)),
                ("complete", tuple(range(11))),
            ])
            self.assertEqual([event[1] for event in events if event[0] == "upload"], list(range(11)))
            self.assertEqual(len([request for request in requests if request[1].endswith("/source-url")]), 1)
            self.assertTrue(all(request[2]["include_source"] is False
                                for request in requests if request[1].endswith("/urls")))
            completion = next(request[2] for request in requests if request[1].endswith("/complete"))
            receipts = [page for request in requests if request[1].endswith("/progress")
                        for page in request[2]["pages"]]
            self.assertEqual(completion["pages"], receipts)

    def test_first_batch_is_capped_by_negotiated_batch_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            worker, task, events, _, _ = self.incremental_worker(temp, count=5, batch_size=20)
            worker._renderer = lambda *_args, **_kwargs: {
                "version": 2, "max_batch_pages": 2, "max_source_slides": 500,
                "max_input_file_bytes": 120 * 1024 * 1024,
                "max_upload_bytes": 128 * 1024 * 1024,
            }
            worker.process(task)
            self.assertEqual([event[1] for event in events if event[0] == "render"], [(0, 1), (2, 3), (4,)])

    def test_unadvertised_incremental_results_preserves_original_batches(self):
        for capability in (None, False, 1, "true"):
            with self.subTest(capability=capability), tempfile.TemporaryDirectory() as temp:
                worker, task, events, requests, _ = self.incremental_worker(temp, count=6, batch_size=4, first_batch=1)
                if capability is None:
                    task.pop("incremental_results")
                else:
                    task["incremental_results"] = capability
                worker.process(task)
                self.assertEqual([event[1] for event in events if event[0] == "render"], [(0, 1, 2, 3), (4, 5)])
                self.assertFalse(any(request[1].endswith("/progress") for request in requests))
                self.assertEqual(events[-1], ("complete", tuple(range(6))))

    def test_fallback_publishes_successful_left_subbatch_before_rendering_right(self):
        with tempfile.TemporaryDirectory() as temp:
            worker, task, events, _, _ = self.incremental_worker(temp, count=4, batch_size=4)
            submit = worker._submit_local_batch

            def split(pages, *args):
                if len(pages) == 4:
                    events.append(("render", (0, 1, 2, 3)))
                    raise RuntimeError("render_timeout")
                return submit(pages, *args)

            worker._submit_local_batch = split
            worker.process(task)
            self.assertEqual([event for event in events if event[0] != "upload"], [
                ("render", (0, 1, 2, 3)), ("render", (0, 1)), ("progress", (0, 1)),
                ("render", (2, 3)), ("progress", (2, 3)), ("complete", (0, 1, 2, 3)),
            ])

    def test_publication_error_never_bisects_a_successfully_rendered_batch(self):
        for error in ("render_timeout", "temporary_oss_error"):
            with self.subTest(error=error), tempfile.TemporaryDirectory() as temp:
                worker, task, events, requests, _ = self.incremental_worker(temp, count=5)

                def fail_upload(*_args):
                    raise RuntimeError(error)

                worker._upload = fail_upload
                with self.assertLogs("wps_renderer.render_pull", level="ERROR"):
                    worker.process(task)
                self.assertEqual([event[1] for event in events if event[0] == "render"], [(0, 1, 2, 3)])
                self.assertFalse(any(request[1].endswith(("/progress", "/complete")) for request in requests))
                self.assertEqual(events[-1], ("failed", error))

    def test_repeated_success_callback_does_not_upload_or_report_twice(self):
        with tempfile.TemporaryDirectory() as temp:
            worker, task, events, requests, _ = self.incremental_worker(temp, count=4)
            render = worker._render_batch_with_fallback

            def repeat(*args):
                publish = args[-1]

                def twice(batch, images):
                    publish(batch, images)
                    publish(batch, images)

                return render(*args[:-1], twice)

            worker._render_batch_with_fallback = repeat
            worker.process(task)
            self.assertEqual(len([event for event in events if event[0] == "upload"]), 4)
            self.assertEqual(len([request for request in requests if request[1].endswith("/progress")]), 1)
            self.assertEqual(events[-1], ("complete", (0, 1, 2, 3)))

    def test_conflicting_repeat_callback_rejects_the_result(self):
        with tempfile.TemporaryDirectory() as temp:
            worker, task, events, requests, _ = self.incremental_worker(temp, count=4)
            render = worker._render_batch_with_fallback

            def repeat(*args):
                publish = args[-1]

                def conflicting(batch, images):
                    publish(batch, images)
                    images[0].write_bytes(b"different result")
                    publish(batch, images)

                return render(*args[:-1], conflicting)

            worker._render_batch_with_fallback = repeat
            with self.assertLogs("wps_renderer.render_pull", level="ERROR"):
                worker.process(task)
            self.assertEqual(len([event for event in events if event[0] == "render"]), 1)
            self.assertEqual(len([event for event in events if event[0] == "upload"]), 4)
            self.assertFalse(any(request[1].endswith("/complete") for request in requests))
            self.assertEqual(events[-1], ("failed", "render_failed"))

    def test_progress_lease_rejection_stops_without_failure_or_completion(self):
        for code in (404, 409):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as temp:
                worker, task, events, requests, _ = self.incremental_worker(temp, count=5)
                main = worker._main
                attempts = []

                def reject(method, path, body=None, timeout=30):
                    if path.endswith("/progress"):
                        attempts.append(body)
                        raise urllib.error.HTTPError(path, code, "lease rejected", {}, None)
                    return main(method, path, body, timeout)

                worker._main = reject
                worker.process(task)
                self.assertEqual(len(attempts), 1)
                self.assertEqual([event[1] for event in events if event[0] == "render"], [(0, 1, 2, 3)])
                self.assertFalse(any(request[1].endswith(("/failed", "/complete")) for request in requests))

    def test_progress_lost_response_retries_same_receipt_without_reupload(self):
        with tempfile.TemporaryDirectory() as temp:
            worker, task, events, requests, _ = self.incremental_worker(temp, count=4)
            main = worker._main
            first = True

            def lose_response(method, path, body=None, timeout=30):
                nonlocal first
                result = main(method, path, body, timeout)
                if path.endswith("/progress") and first:
                    first = False
                    raise TimeoutError("response lost after accepting receipt")
                return result

            worker._main = lose_response
            worker.process(task)
            receipts = [request[2] for request in requests if request[1].endswith("/progress")]
            self.assertEqual(len(receipts), 2)
            self.assertEqual(receipts[0], receipts[1])
            self.assertEqual(len([event for event in events if event[0] == "render"]), 1)
            self.assertEqual(len([event for event in events if event[0] == "upload"]), 4)
            self.assertEqual(events[-1], ("complete", (0, 1, 2, 3)))

    def test_progress_temporary_failure_has_a_finite_retry_budget(self):
        with tempfile.TemporaryDirectory() as temp:
            worker, task, events, requests, _ = self.incremental_worker(temp, count=5)
            main = worker._main
            attempts = []

            def unavailable(method, path, body=None, timeout=30):
                if path.endswith("/progress"):
                    attempts.append(json.loads(json.dumps(body)))
                    raise urllib.error.HTTPError(path, 503, "unavailable", {}, None)
                return main(method, path, body, timeout)

            worker._main = unavailable
            with self.assertLogs("wps_renderer.render_pull", level="ERROR"):
                worker.process(task)
            self.assertEqual(len(attempts), 3)
            self.assertTrue(all(attempt == attempts[0] for attempt in attempts))
            self.assertEqual(len([event for event in events if event[0] == "render"]), 1)
            self.assertEqual(len([event for event in events if event[0] == "upload"]), 4)
            self.assertFalse(any(request[1].endswith("/complete") for request in requests))
            self.assertEqual(events[-1], ("failed", "network_error"))

    def test_cancel_during_progress_backoff_stops_before_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = RenderPull(self.config(temp))
            stop = threading.Event()

            def cancel_wait(_seconds):
                stop.set()
                return True

            with patch.object(worker, "_main", side_effect=urllib.error.URLError("offline")) as request, \
                    patch.object(stop, "wait", side_effect=cancel_wait):
                with self.assertRaises(LeaseLost):
                    worker._report_progress("a" * 32, "l" * 43, [{"index": 0}], 1, stop)
            self.assertEqual(request.call_count, 1)

    def test_cancelled_conversion_does_not_upload_or_publish_returned_images(self):
        with tempfile.TemporaryDirectory() as temp:
            worker, task, events, requests, _ = self.incremental_worker(temp, count=5)
            submit = worker._submit_local_batch

            def cancel(pages, source_meta, source, dpi, stop, *args):
                result = submit(pages, source_meta, source, dpi, stop, *args)
                stop.set()
                return result

            worker._submit_local_batch = cancel
            worker.process(task)
            self.assertEqual(events, [("render", (0, 1, 2, 3))])
            self.assertFalse(any(request[1].endswith(("/progress", "/complete", "/failed")) for request in requests))

    def test_cancelling_local_job_removes_it_without_returning_partial_results(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = RenderPull(self.config(temp))
            archive = Path(temp) / "bundle.zip"
            archive.write_bytes(b"bundle")
            stop = threading.Event()
            calls = []
            worker._renderer = lambda method, path, **_kwargs: calls.append((method, path))
            with patch("wps_renderer.render_pull.http.client.HTTPConnection", return_value=self.local_submission()), \
                    patch.object(stop, "wait", return_value=True):
                with self.assertRaises(LeaseLost):
                    worker._submit_bundle(archive, [0], Path(temp) / "result", stop)
            self.assertEqual(calls, [("DELETE", "/v1/jobs/" + "a" * 32)])
            self.assertFalse(archive.exists())

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
            bindings = [{"name": "Test Sans", "sha256": "a" * 64}]
            worker._bundle(
                page, source, 288, target, ["Test Sans"], ["a" * 64], bindings,
            )
            with zipfile.ZipFile(target) as archive:
                self.assertEqual(set(archive.namelist()), {"manifest.json", "pages/1.pptx"})
                manifest = json.loads(archive.read("manifest.json"))
                self.assertEqual(manifest["pages"][0]["index"], 1)
                self.assertEqual(manifest["required_fonts"], ["Test Sans"])
                self.assertEqual(manifest["font_hashes"], ["a" * 64])
                self.assertEqual(manifest["font_bindings"], bindings)

    def test_batch_bundle_contains_one_multi_page_source_and_page_mapping(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = RenderPull(self.config(temp))
            source = Path(temp) / "deck.pptx"
            source.write_bytes(b"multi-page-ppt")
            target = Path(temp) / "batch.zip"
            source_meta = {
                "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "size": source.stat().st_size,
                "slide_count": 3,
            }
            pages = [{"index": index} for index in range(3)]
            worker._bundle_batch(pages, source_meta, source, 288, target, [], [], [])
            with zipfile.ZipFile(target) as archive:
                self.assertEqual(set(archive.namelist()), {"manifest.json", "source/deck.pptx"})
                manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["version"], 2)
            self.assertEqual(manifest["source"]["slide_count"], 3)
            self.assertEqual(manifest["pages"], [
                {"index": 0, "slide": 1},
                {"index": 1, "slide": 2},
                {"index": 2, "slide": 3},
            ])

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
            worker._submit_local = lambda page, source, dpi, stop, required, hashes, bindings: image
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

    def test_process_uses_supported_batch_source_once_and_chunks_by_setting(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = RenderPull(self.config(temp))
            from PIL import Image
            images = {}
            for index in range(3):
                image = Path(temp) / f"rendered-{index}.png"
                Image.new("RGB", (16, 9), (index, index, index)).save(image)
                images[index] = image
            source_bytes = b"full-deck"
            source_sha = hashlib.sha256(source_bytes).hexdigest()
            page_sha = hashlib.sha256(b"ppt").hexdigest()
            calls, batches, downloads, uploads = [], [], [], []

            worker._renderer = lambda method, path, body=None, timeout=30, headers=None: {
                "version": 2, "max_batch_pages": 50, "max_source_slides": 500,
                "max_input_file_bytes": 120 * 1024 * 1024,
                "max_upload_bytes": 128 * 1024 * 1024,
            }

            def main(method, path, body=None, timeout=30):
                calls.append((method, path, body))
                if path.endswith("/source-url"):
                    return {"source": {
                        "download_url": "https://bucket.example/deck", "sha256": source_sha,
                        "size": len(source_bytes), "slide_count": 3,
                    }}
                if path.endswith("/urls"):
                    return {"page": {
                        "index": body["page_index"],
                        "upload_url": f"https://bucket.example/output-{body['page_index']}",
                    }}
                return {"ok": True}

            def download(url, target, expected_size, expected_sha, max_bytes=120 * 1024 * 1024):
                downloads.append((url, expected_size, expected_sha, max_bytes))
                target.write_bytes(source_bytes)

            def submit(pages, source_meta, source, dpi, stop, required, hashes, bindings):
                batches.append([page["index"] for page in pages])
                self.assertEqual(source.read_bytes(), source_bytes)
                return {page["index"]: images[page["index"]] for page in pages}

            worker._main = main
            worker._download = download
            worker._submit_local_batch = submit
            worker._upload = lambda url, path, stop: uploads.append((url, path.name))
            worker._renew_loop = lambda *args: None
            task = {
                "task_id": "a" * 32, "lease_token": "l" * 43, "dpi": 288,
                "lease_seconds": 600, "batch_size": 2,
                "source": {"sha256": source_sha, "size": len(source_bytes), "slide_count": 3},
                "pages": [
                    {"index": index, "size": 3, "sha256": page_sha}
                    for index in range(3)
                ],
            }
            worker.process(task)
            self.assertEqual(batches, [[0, 1], [2]])
            self.assertEqual(len(downloads), 1)
            self.assertEqual(len(uploads), 3)
            complete = [call for call in calls if call[1].endswith("/complete")]
            self.assertEqual([page["index"] for page in complete[0][2]["pages"]], [0, 1, 2])

    def test_batch_timeout_is_bisected_until_single_pages_succeed(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = RenderPull(self.config(temp))
            source = Path(temp) / "deck.pptx"
            source.write_bytes(b"deck")
            images = {}
            from PIL import Image
            for index in range(4):
                image = Path(temp) / f"{index}.png"
                Image.new("RGB", (2, 2)).save(image)
                images[index] = image
            attempts = []

            def submit(pages, *_args):
                attempts.append([page["index"] for page in pages])
                if len(pages) > 1:
                    raise RuntimeError("render_timeout")
                return {pages[0]["index"]: images[pages[0]["index"]]}

            worker._submit_local_batch = submit
            pages = [{"index": index} for index in range(4)]
            result = worker._render_batch_with_fallback(
                pages, {"sha256": "a" * 64, "slide_count": 4}, source, 288,
                __import__("threading").Event(), [], [], [],
            )
            self.assertEqual(set(result), {0, 1, 2, 3})
            self.assertEqual(attempts[0], [0, 1, 2, 3])
            self.assertTrue(all([index] in attempts for index in range(4)))

    def test_claimed_task_rejects_invalid_font_alias_bindings(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = RenderPull(self.config(temp))
            base = {
                "task_id": "a" * 32,
                "lease_token": "l" * 43,
                "dpi": 288,
                "lease_seconds": 600,
                "required_fonts": ["Display A", "Display B"],
                "font_hashes": ["a" * 64, "b" * 64],
                "font_bindings": [
                    {"name": "Display A", "sha256": "a" * 64},
                    {"name": "Display B", "sha256": "b" * 64},
                ],
                "pages": [{
                    "index": 0,
                    "size": 3,
                    "sha256": hashlib.sha256(b"ppt").hexdigest(),
                }],
            }
            invalid = [
                [{"name": "Unknown", "sha256": "a" * 64}],
                [
                    {"name": "Display A", "sha256": "a" * 64},
                    {"name": "Display A", "sha256": "a" * 64},
                    {"name": "Display B", "sha256": "b" * 64},
                ],
                [{"name": "Display A", "sha256": "a" * 64}],
            ]
            for bindings in invalid:
                with self.subTest(bindings=bindings):
                    task = {**base, "font_bindings": bindings}
                    with self.assertRaisesRegex(ValueError, "invalid claimed task manifest"):
                        worker.process(task)

    def test_claimed_legacy_task_without_alias_bindings_is_accepted(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = RenderPull(self.config(temp))
            image = Path(temp) / "rendered.png"
            from PIL import Image
            Image.new("RGB", (16, 9)).save(image)
            worker._main = lambda method, path, body=None, timeout=30: (
                {"page": {
                    "index": 0,
                    "download_url": "https://bucket.example/source",
                    "upload_url": "https://bucket.example/output",
                }} if path.endswith("/urls") else {"ok": True}
            )
            worker._download = lambda url, target, expected_size, expected_sha: target.write_bytes(b"ppt")
            worker._submit_local = lambda page, source, dpi, stop, required, hashes, bindings: image
            worker._upload = lambda url, path, stop: None
            worker._renew_loop = lambda *args: None
            worker.process({
                "task_id": "a" * 32,
                "lease_token": "l" * 43,
                "dpi": 288,
                "lease_seconds": 600,
                "required_fonts": ["Legacy Sans"],
                "font_hashes": ["a" * 64],
                "pages": [{
                    "index": 0,
                    "size": 3,
                    "sha256": hashlib.sha256(b"ppt").hexdigest(),
                }],
            })

    def test_legacy_waiting_fonts_job_is_retried_and_cancelled(self):
        with tempfile.TemporaryDirectory() as temp:
            worker = RenderPull(self.config(temp))
            archive = Path(temp) / "bundle.zip"
            archive.write_bytes(b"bundle")
            calls = []

            def renderer(method, path, body=None, timeout=30, headers=None):
                calls.append((method, path))
                if method == "GET":
                    return {"status": "waiting_fonts"}
                return {}

            worker._renderer = renderer
            with patch(
                "wps_renderer.render_pull.http.client.HTTPConnection",
                return_value=self.local_submission(),
            ):
                with self.assertRaisesRegex(RuntimeError, "^worker_restarted$"):
                    worker._submit_bundle(
                        archive, [0], Path(temp) / "result", self.ImmediateEvent(),
                    )

            self.assertIn(("DELETE", "/v1/jobs/" + "a" * 32), calls)
            self.assertFalse(archive.exists())

    def test_local_renderer_job_has_a_total_deadline(self):
        with tempfile.TemporaryDirectory() as temp:
            config = self.config(temp)
            config["local_job_timeout_seconds"] = 60
            worker = RenderPull(config)
            archive = Path(temp) / "bundle.zip"
            archive.write_bytes(b"bundle")
            calls = []

            def renderer(method, path, body=None, timeout=30, headers=None):
                calls.append((method, path))
                return {"status": "running"} if method == "GET" else {}

            worker._renderer = renderer
            with patch(
                "wps_renderer.render_pull.http.client.HTTPConnection",
                return_value=self.local_submission(),
            ), patch("wps_renderer.render_pull.time.monotonic", side_effect=[0, 1, 61]):
                with self.assertRaisesRegex(RuntimeError, "^render_timeout$"):
                    worker._submit_bundle(
                        archive, [0], Path(temp) / "result", self.ImmediateEvent(),
                    )

            self.assertEqual(calls[0], ("GET", "/v1/jobs/" + "a" * 32))
            self.assertEqual(calls[-1], ("DELETE", "/v1/jobs/" + "a" * 32))
            self.assertFalse(archive.exists())

    def test_polling_exits_after_the_failure_recovery_deadline(self):
        with tempfile.TemporaryDirectory() as temp:
            config = self.config(temp)
            config["poll_failure_exit_seconds"] = 60
            worker = RenderPull(config)
            with patch.object(worker, "run_once", side_effect=TimeoutError()), patch(
                "wps_renderer.render_pull.time.monotonic", side_effect=[0, 61]
            ):
                with self.assertRaisesRegex(RuntimeError, "polling is unhealthy"):
                    worker.run_forever()

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
