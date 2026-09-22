import asyncio
import io
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import test_service
from test_service import FakeFonts, bundle, converter
from wps_renderer.config import Settings
from wps_renderer.errors import RenderError
from wps_renderer.jobs import JobManager
from wps_renderer.transport import OwnedStreamingResponse, finish_thread


class LifecycleTests(unittest.TestCase):
    setUp = test_service.ServiceTests.setUp
    tearDown = test_service.ServiceTests.tearDown
    client = test_service.ServiceTests.client
    headers = test_service.ServiceTests.headers
    wait = test_service.ServiceTests.wait
    def test_lookup_by_key_and_cancel_before_late_submission(self):
        key = "cancel-before-upload-0001"
        with self.client() as client:
            self.assertEqual(client.get(f"/v1/jobs/by-key/{key}", headers=self.headers()).status_code, 404)
            self.assertEqual(client.delete(f"/v1/jobs/by-key/{key}", headers=self.headers()).status_code, 204)
            status = client.get(f"/v1/jobs/by-key/{key}", headers=self.headers())
            self.assertEqual(status.status_code, 200)
            self.assertEqual(status.json()["status"], "cancelled")
            late = client.post("/v1/jobs", content=bundle(), headers=self.headers(key))
            self.assertEqual(late.status_code, 409)
            self.assertEqual(late.json()["error"]["code"], "cancelled")
            self.assertEqual(client.app.state.manager.uploads, set())

    def test_cancel_tombstone_survives_restart(self):
        key = "cancel-survives-restart-0001"
        manager = JobManager(self.settings, converter, FakeFonts())
        manager.cancel_by_key(key)
        manager.close()
        restored = JobManager(self.settings, converter, FakeFonts())
        try:
            job = restored.get_by_key(key)
            self.assertEqual(job.state, "cancelled")
            self.assertTrue(job.cancel.is_set())
            self.assertTrue(job.deleted)
        finally:
            restored.close()

    def test_cancelled_upload_cleanup_preserves_key(self):
        manager = JobManager(self.settings, converter, FakeFonts())
        try:
            job, _ = manager.admit("cancel-upload-cleanup-0001")
            (manager.storage.directory(job.id) / "bundle.zip").write_bytes(b"partial")
            manager.cancel_by_key(job.key)
            manager.upload_failed(job)
            self.assertEqual(manager.get_by_key(job.key).state, "cancelled")
            self.assertEqual(sorted(p.name for p in manager.storage.directory(job.id).iterdir()), ["job.json"])
            self.assertFalse(manager.uploads)
        finally:
            manager.close()

    def test_download_lease_released_when_asgi_send_fails_before_headers(self):
        self._assert_download_release("headers")

    def test_download_lease_released_when_asgi_send_fails_after_first_chunk(self):
        self._assert_download_release("body")

    def test_download_lease_released_on_timeout(self):
        self._assert_download_release("timeout")

    def test_download_lease_released_on_task_cancellation(self):
        self._assert_download_release("cancel")

    def _assert_download_release(self, mode):
        with self.client() as client:
            job_id = client.post("/v1/jobs", content=bundle(), headers=self.headers()).json()["id"]
            self.wait(client, job_id)
            manager = client.app.state.manager
            job = manager.get(job_id)
            chunks, _, release = manager.page_stream(job_id, 0)
            self.assertEqual(job.readers, 1)
            response = OwnedStreamingResponse(chunks, release=release, timeout_seconds=0.05 if mode == "timeout" else 5)

            async def exercise():
                started = asyncio.Event()
                async def send(message):
                    started.set()
                    if mode in {"timeout", "cancel"}:
                        await asyncio.Event().wait()
                    if mode == "headers" or message["type"] == "http.response.body":
                        raise OSError("Disconnected transport")
                async def receive():
                    await asyncio.Event().wait()
                scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"}, "method": "GET"}
                task = asyncio.create_task(response(scope, receive, send))
                if mode == "cancel":
                    await started.wait()
                    task.cancel()
                try:
                    await task
                except (Exception, asyncio.CancelledError):
                    pass
                else:
                    self.fail("Test transport must fail or cancel")

            asyncio.run(exercise())
            self.assertEqual(job.readers, 0)
            release()  # Multiple cleanup paths must not underflow the lease.
            self.assertEqual(job.readers, 0)
            manager.acknowledge(job_id, 0)
            self.assertFalse((manager.storage.directory(job_id) / "output/0.png").exists())

    def test_shutdown_retains_singleton_while_worker_still_alive(self):
        started, release = threading.Event(), threading.Event()
        def noncooperative(*args):
            started.set()
            release.wait(5)
            raise RenderError("cancelled", "Stopped")
        manager = JobManager(self.settings, noncooperative, FakeFonts())
        try:
            job, _ = manager.admit("blocked-worker-close-0001")
            (manager.storage.directory(job.id) / "bundle.zip").write_bytes(bundle())
            manager.accept(job, "a" * 64)
            self.assertTrue(started.wait(1))
            with self.assertRaisesRegex(RuntimeError, "lock is retained"):
                manager.close(timeout=0.02)
            with self.assertRaises(RuntimeError):
                JobManager(self.settings, converter, FakeFonts())
            release.set()
            manager.close(timeout=2)
            replacement = JobManager(self.settings, converter, FakeFonts())
            replacement.close()
        finally:
            release.set()
            manager.close(timeout=2)

    def test_shutdown_retains_singleton_while_validation_still_alive(self):
        started, release = threading.Event(), threading.Event()
        manager = JobManager(self.settings, converter, FakeFonts())
        job, _ = manager.admit("blocked-validator-close-0001")
        errors = []
        def blocked(*args):
            started.set()
            release.wait(5)
            return {"pages": [], "dpi": 150}
        def accepting():
            try:
                manager.accept(job, "a" * 64)
            except RenderError as exc:
                errors.append(exc.code)
            finally:
                manager.upload_failed(job)
        try:
            with patch("wps_renderer.jobs.unpack_bundle", blocked):
                thread = threading.Thread(target=accepting)
                thread.start()
                self.assertTrue(started.wait(1))
                with self.assertRaisesRegex(RuntimeError, "lock is retained"):
                    manager.close(timeout=0.02)
                with self.assertRaises(RuntimeError):
                    JobManager(self.settings, converter, FakeFonts())
                release.set()
                thread.join(timeout=2)
            self.assertEqual(errors, ["cancelled"])
            manager.close(timeout=2)
        finally:
            release.set()
            manager.close(timeout=2)

    def test_duplicate_font_hashes_are_rejected(self):
        with self.client() as client:
            descriptor = {"sha256": "a" * 64, "names": ["Test"]}
            response = client.post("/v1/fonts/check", json={"fonts": [descriptor, descriptor]}, headers=self.headers())
            self.assertEqual(response.status_code, 422)

    def test_render_process_cleanup_error_stops_future_queue_work(self):
        runs = []
        def contaminated(*args):
            runs.append(1)
            raise RenderError("process_cleanup_failed", "owned process did not stop")
        with self.client(contaminated) as client:
            first = client.post("/v1/jobs", content=bundle(), headers=self.headers("cleanup-error-first-0001"))
            self.assertEqual(first.status_code, 202)
            self.wait(client, first.json()["id"])
            self.assertEqual(client.get("/v1/health", headers=self.headers()).status_code, 503)
            second = client.post("/v1/jobs", content=bundle(), headers=self.headers("cleanup-error-second-0001"))
            self.assertIn(second.status_code, (202, 503))
            time.sleep(0.05)
            self.assertEqual(len(runs), 1)


class ThreadCancellationTests(unittest.TestCase):
    def test_repeated_cancellation_waits_for_thread_and_runs_release(self):
        started, release, finished = threading.Event(), threading.Event(), threading.Event()
        cleanup = []
        def blocked():
            started.set()
            release.wait(5)
            finished.set()
            return "owned-result"
        async def exercise():
            task = asyncio.create_task(finish_thread(blocked, on_cancel=lambda value: cleanup.append((value, finished.is_set()))))
            while not started.is_set():
                await asyncio.sleep(0.001)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0.01)
            self.assertFalse(task.done(), "Cleanup must wait for the actual thread")
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        try:
            asyncio.run(exercise())
            self.assertEqual(cleanup, [("owned-result", True)])
        finally:
            release.set()
