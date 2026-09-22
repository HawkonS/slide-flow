import hashlib
import io
import json
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from PIL import Image

from wps_renderer.api import create_app
from wps_renderer.config import Settings
from wps_renderer.errors import RenderError
from wps_renderer.jobs import JobManager
from wps_renderer.validation import unpack_bundle, validate_pptx

TOKEN = "test-only-" + "x" * 40


def pptx(extra=None):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        archive.writestr("ppt/presentation.xml", '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256"/></p:sldIdLst></p:presentation>')
        if "ppt/slides/slide1.xml" not in (extra or {}):
            archive.writestr("ppt/slides/slide1.xml", '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>')
        for name, content in (extra or {}).items():
            archive.writestr(name, content)
    return stream.getvalue()


def bundle(pages=1, mutate=None):
    stream = io.BytesIO()
    data = pptx()
    manifest = {"version": 1, "dpi": 150, "pages": [{"index": i, "file": f"pages/{i}.pptx", "sha256": hashlib.sha256(data).hexdigest()} for i in range(pages)], "fonts": [], "required_fonts": []}
    if mutate:
        mutate(manifest)
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        for i in range(pages):
            archive.writestr(f"pages/{i}.pptx", data)
    return stream.getvalue()


class FakeFonts:
    @contextmanager
    def activate(self, directory, manifest):
        yield

    def check(self, names, fonts):
        return {"installed": [], "missing": names, "fonts": [{"sha256": f["sha256"], "installed": False, "conflict": False} for f in fonts]}


def converter(exe, source, output, dpi, timeout, cancel, check, memory_limit_bytes):
    output.mkdir(parents=True)
    check()
    nested = output / source.stem
    nested.mkdir()
    Image.new("RGB", (320, 180), "white").save(nested / "page_1.png")


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = Settings(wpscli="fake", data_dir=self.temp.name + "/data", token=TOKEN,
                                 min_free_bytes=1, min_free_ratio=0, retention_seconds=1)

    def tearDown(self):
        self.temp.cleanup()

    def client(self, convert=converter):
        return TestClient(create_app(self.settings, lambda settings: JobManager(settings, convert, FakeFonts())))

    def headers(self, key="test-idempotency-0001"):
        return {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/zip", "Idempotency-Key": key}

    def wait(self, client, job_id, states={"completed", "failed", "cancelled"}):
        for _ in range(100):
            data = client.get(f"/v1/jobs/{job_id}", headers=self.headers()).json()
            if data["status"] in states:
                return data
            time.sleep(0.01)
        self.fail("Job did not finish")

    def test_auth_rejected_before_upload_and_no_public_health(self):
        with self.client() as client:
            self.assertEqual(client.post("/v1/jobs", content=b"garbage").status_code, 401)
            self.assertEqual(client.get("/v1/health").status_code, 401)
            self.assertEqual(client.post("/v1/admin/drain").status_code, 401)
            self.assertEqual(client.post("/v1/admin/resume").status_code, 401)
            self.assertEqual(client.app.state.manager.jobs, {})

    def test_drain_rejects_new_jobs_and_resume_reopens_admission(self):
        started, release = threading.Event(), threading.Event()

        def blocking(exe, source, output, dpi, timeout, cancel, check, memory_limit_bytes):
            started.set()
            while not release.wait(0.01):
                if cancel.is_set():
                    raise RenderError("cancelled", "Render cancelled", 409)
            return converter(exe, source, output, dpi, timeout, cancel, check, memory_limit_bytes)

        with self.client(blocking) as client:
            first_key = "drain-existing-key-0001"
            first = client.post("/v1/jobs", content=bundle(), headers=self.headers(first_key))
            self.assertEqual(first.status_code, 202, first.text)
            first_id = first.json()["id"]
            self.assertTrue(started.wait(1), "The first job must be running before drain")

            drained = client.post("/v1/admin/drain", headers={"Authorization": "Bearer " + TOKEN})
            self.assertEqual(drained.status_code, 200, drained.text)
            self.assertEqual(drained.json()["status"], "draining")
            self.assertGreaterEqual(drained.json()["running"], 1)
            self.assertEqual(client.get("/v1/health", headers=self.headers()).json()["status"], "draining")

            # A retry for an already accepted key remains idempotent while the
            # service drains, but a new key is rejected before its body is read.
            repeated = client.post("/v1/jobs", content=bundle(), headers=self.headers(first_key))
            self.assertEqual(repeated.status_code, 200, repeated.text)
            self.assertEqual(repeated.json()["id"], first_id)
            rejected = client.post("/v1/jobs", content=bundle(), headers=self.headers("drain-new-key-00001"))
            self.assertEqual(rejected.status_code, 503, rejected.text)
            self.assertEqual(rejected.json()["error"]["code"], "renderer_draining")

            # Calling drain again is safe for retrying an upgrade request.
            repeated_drain = client.post("/v1/admin/drain", headers={"Authorization": "Bearer " + TOKEN})
            self.assertEqual(repeated_drain.status_code, 200)
            self.assertEqual(repeated_drain.json()["status"], "draining")

            release.set()
            self.assertEqual(self.wait(client, first_id)["status"], "completed")
            resumed = client.post("/v1/admin/resume", headers={"Authorization": "Bearer " + TOKEN})
            self.assertEqual(resumed.status_code, 200, resumed.text)
            self.assertEqual(resumed.json(), {"status": "ok"})
            accepted = client.post("/v1/jobs", content=bundle(), headers=self.headers("resume-new-key-0001"))
            self.assertEqual(accepted.status_code, 202, accepted.text)
            self.assertEqual(self.wait(client, accepted.json()["id"])["status"], "completed")

    def test_progress_download_ack_and_idempotency(self):
        with self.client() as client:
            result = client.post("/v1/jobs", content=bundle(2), headers=self.headers())
            self.assertEqual(result.status_code, 202, result.text)
            job = result.json()["id"]
            final = self.wait(client, job)
            self.assertEqual(final["status"], "completed", final)
            self.assertEqual(len(final["pages"]), 2)
            repeat = client.post("/v1/jobs", content=bundle(2), headers=self.headers())
            self.assertEqual(repeat.json()["id"], job)
            conflict = client.post("/v1/jobs", content=bundle(1), headers={**self.headers(), "X-Content-SHA256": "0" * 64})
            self.assertEqual(conflict.status_code, 409)
            response = client.get(f"/v1/jobs/{job}/pages/0", headers=self.headers())
            sha = hashlib.sha256(response.content).hexdigest()
            self.assertEqual(sha, final["pages"][0]["sha256"])
            self.assertEqual(client.delete(f"/v1/jobs/{job}/pages/0", headers={**self.headers(), "If-Match": '"' + sha + '"'}).status_code, 204)
            self.assertEqual(client.get(f"/v1/jobs/{job}/pages/0", headers=self.headers()).status_code, 404)
            self.assertFalse((Path(self.settings.data_dir) / job / "output/0.png").exists())
            client.delete(f"/v1/jobs/{job}", headers=self.headers())
            self.assertEqual(sorted(p.name for p in (Path(self.settings.data_dir) / job).iterdir()), ["job.json"])

    def test_bad_bundle_removes_upload_and_frees_key(self):
        with self.client() as client:
            failed = client.post("/v1/jobs", content=b"invalid", headers=self.headers())
            self.assertEqual(failed.status_code, 422)
            self.assertEqual(client.app.state.manager.jobs, {})
            retry = client.post("/v1/jobs", content=bundle(), headers=self.headers())
            self.assertEqual(retry.status_code, 202, retry.text)

    def test_ack_during_next_page_disk_check_does_not_fail_batch(self):
        acknowledged = threading.Event()
        original_is_file = Path.is_file

        def converting(exe, source, output, dpi, timeout, cancel, check, memory_limit_bytes):
            if source.stem != "1":
                return converter(exe, source, output, dpi, timeout, cancel, check, memory_limit_bytes)

            previous_page = output.parent / "0.png"
            job_id = output.parent.parent.name

            def is_file_then_ack(path):
                exists = original_is_file(path)
                if path == previous_page and exists and not acknowledged.is_set():
                    # Force the exact race: is_file() has seen the first PNG,
                    # then a normal ACK removes it before the following stat().
                    client.app.state.manager.acknowledge(job_id, 0)
                    acknowledged.set()
                return exists

            def check_with_ack():
                with patch.object(Path, "is_file", is_file_then_ack):
                    check()

            return converter(exe, source, output, dpi, timeout, cancel, check_with_ack, memory_limit_bytes)

        with self.client(converting) as client:
            response = client.post("/v1/jobs", content=bundle(2), headers=self.headers())
            self.assertEqual(response.status_code, 202, response.text)
            job_id = response.json()["id"]
            final = self.wait(client, job_id)
            self.assertTrue(acknowledged.is_set(), "The test must exercise the deletion race")
            self.assertEqual(final["status"], "completed", final)
            self.assertIsNone(final["error"])
            self.assertEqual(len(final["pages"]), 2)
            self.assertTrue(final["pages"][0]["acknowledged"])
            self.assertFalse((Path(self.settings.data_dir) / job_id / "output/0.png").exists())
            image = client.get(f"/v1/jobs/{job_id}/pages/1", headers=self.headers())
            self.assertEqual(image.status_code, 200)
            self.assertEqual(hashlib.sha256(image.content).hexdigest(), final["pages"][1]["sha256"])

    def test_checksum_and_unmanifested_entries(self):
        with self.client() as client:
            response = client.post("/v1/jobs", content=bundle(mutate=lambda m: m["pages"][0].update(sha256="0" * 64)), headers=self.headers())
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.json()["error"]["code"], "checksum_mismatch")
            response = client.post("/v1/jobs", content=bundle(mutate=lambda m: m["pages"][0].update(file="../evil.pptx")), headers=self.headers())
            self.assertEqual(response.status_code, 422)

    def test_cancel_waits_for_owned_worker(self):
        started, released = threading.Event(), threading.Event()
        def blocking(exe, source, output, dpi, timeout, cancel, check, memory_limit_bytes):
            started.set()
            cancel.wait(2)
            released.set()
            raise RenderError("cancelled", "Cancelled")
        with self.client(blocking) as client:
            job = client.post("/v1/jobs", content=bundle(), headers=self.headers()).json()["id"]
            self.assertTrue(started.wait(1))
            client.delete(f"/v1/jobs/{job}", headers=self.headers())
            self.assertEqual(self.wait(client, job)["status"], "cancelled")
            self.assertTrue(released.is_set())
            self.assertFalse((Path(self.settings.data_dir) / job / "input").exists())

    def test_font_check_schema(self):
        with self.client() as client:
            headers = {"Authorization": "Bearer " + TOKEN}
            response = client.post("/v1/fonts/check", json={"names": ["Example"], "fonts": [{"sha256": "a" * 64, "names": ["Example"], "faces": ["Example Bold"]}]}, headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["missing"], ["Example"])
            self.assertEqual(client.post("/v1/fonts/check", json={"fonts": [{"sha256": "bad", "names": []}]}, headers=headers).status_code, 422)

    def test_pptx_external_assets_and_xml_entities_rejected(self):
        for extra in ({"ppt/_rels/presentation.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship TargetMode="External" Type="image" Target="https://example.com/a.png"/></Relationships>'},
                      {"ppt/slides/slide1.xml": '<!DOCTYPE x [<!ENTITY y "bomb">]><x>&y;</x>'},
                      {"ppt/vbaProject.bin": b"macro"}):
            path = Path(self.temp.name) / "unsafe.pptx"
            path.write_bytes(pptx(extra))
            with self.assertRaises(RenderError):
                validate_pptx(path, 1024 * 1024)

    def test_single_instance_guard(self):
        first = JobManager(self.settings, converter, FakeFonts())
        try:
            with self.assertRaises(RuntimeError):
                JobManager(self.settings, converter, FakeFonts())
        finally:
            first.close()

    def test_dpi_page_and_disk_limits(self):
        with self.client() as client:
            result = client.post("/v1/jobs", content=bundle(mutate=lambda m: m.update(dpi=601)), headers=self.headers())
            self.assertEqual(result.status_code, 422)
            result = client.post("/v1/jobs", content=bundle(5), headers=self.headers())
            self.assertEqual(result.status_code, 422)
            client.app.state.manager.settings = Settings(**{**self.settings.__dict__, "min_free_bytes": 1 << 62})
            result = client.post("/v1/jobs", content=bundle(), headers=self.headers())
            self.assertEqual(result.status_code, 507)


if __name__ == "__main__":
    unittest.main()
