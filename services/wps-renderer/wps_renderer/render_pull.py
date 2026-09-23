"""Windows worker that pulls durable PPT-to-PNG tasks from SlideFlow."""
from __future__ import annotations

import argparse
import errno
import hashlib
import http.client
import json
import os
import re
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path

from PIL import Image

SHA256 = re.compile(r"^[0-9a-f]{64}$")
TASK_ID = re.compile(r"^[0-9a-f]{32}$")
MAX_PAGE_BYTES = 120 * 1024 * 1024
MAX_IMAGE_BYTES = 64 * 1024 * 1024
MAX_METADATA_BYTES = 256 * 1024


class LeaseLost(RuntimeError):
    pass


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _failure_code(exc: Exception) -> str:
    """Map local failures to the server's bounded retry vocabulary."""
    if isinstance(exc, RuntimeError) and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", str(exc)):
        return str(exc)
    if isinstance(exc, urllib.error.HTTPError) and exc.code in {404, 409}:
        return "lease_lost"
    if isinstance(exc, (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError)):
        return "network_error"
    if isinstance(exc, OSError):
        if exc.errno in {errno.ENOSPC, errno.EDQUOT}:
            return "disk_pressure"
        return "internal_error"
    if isinstance(exc, (ValueError, KeyError, TypeError, json.JSONDecodeError, zipfile.BadZipFile)):
        return "render_failed"
    return "internal_error"


class RenderPull:
    def __init__(self, config: dict):
        self.base_url = str(config["url"]).rstrip("/")
        self.renderer_url = str(config.get("renderer_url", "http://127.0.0.1:8765")).rstrip("/")
        token = str(config.get("token", ""))
        if not token and config.get("token_file"):
            token = Path(config["token_file"]).read_text(encoding="utf-8").strip()
        self.token = token
        self.worker_id = str(config.get("worker_id") or f"{socket.gethostname()}-{os.getpid()}")
        self.wait_seconds = max(0, min(25, int(config.get("wait_seconds", 25))))
        self.retry_seconds = max(1, min(60, int(config.get("retry_seconds", 5))))
        self.renew_seconds = max(10, min(120, int(config.get("renew_seconds", 30))))
        self.work_dir = Path(config.get("work_dir") or tempfile.gettempdir()) / "slideflow-render-pull"
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self._validate_origin(self.base_url, "main task URL", allow_https_any=True)
        self._validate_origin(self.renderer_url, "local renderer URL", loopback_only=True)
        if len(self.token) < 32 or any(ord(char) < 33 or ord(char) > 126 for char in self.token):
            raise ValueError("render pull token is invalid")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", self.worker_id):
            raise ValueError("worker_id is invalid")

    @staticmethod
    def _validate_origin(value: str, label: str, *, allow_https_any=False, loopback_only=False):
        parsed = urllib.parse.urlsplit(value)
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
            raise ValueError(f"{label} must contain only scheme, host and port")
        host = (parsed.hostname or "").lower()
        loopback = host in {"127.0.0.1", "localhost", "::1"}
        if parsed.scheme not in {"http", "https"} or not host:
            raise ValueError(f"{label} is invalid")
        if parsed.scheme == "http" and not loopback:
            raise ValueError(f"{label} must use HTTPS unless connected through a loopback tunnel")
        if loopback_only and not loopback:
            raise ValueError(f"{label} must use the local renderer loopback listener")
        if not allow_https_any and not loopback:
            raise ValueError(f"{label} must be loopback")

    def _request(self, base: str, method: str, path: str, body=None, timeout=30, headers=None):
        data = None
        request_headers = {"Authorization": "Bearer " + self.token, "Accept": "application/json"}
        request_headers.update(headers or {})
        if body is not None:
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(base + path, data=data, method=method, headers=request_headers)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            content = response.read(MAX_METADATA_BYTES + 1)
            if len(content) > MAX_METADATA_BYTES:
                raise ValueError("metadata response is too large")
            return json.loads(content or b"{}")

    def _main(self, method, path, body=None, timeout=30):
        return self._request(self.base_url, method, path, body, timeout)

    def _renderer(self, method, path, body=None, timeout=30, headers=None):
        return self._request(self.renderer_url, method, path, body, timeout, headers)

    def claim(self):
        query = urllib.parse.urlencode({"worker_id": self.worker_id, "wait_seconds": self.wait_seconds})
        return self._main("GET", "/api/renderer/render-tasks/claim?" + query,
                          timeout=self.wait_seconds + 10).get("task")

    @staticmethod
    def _download(url: str, target: Path, expected_size: int, expected_sha: str):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise ValueError("source URL must be a signed HTTPS object URL")
        if not 0 < expected_size <= MAX_PAGE_BYTES or not SHA256.fullmatch(expected_sha):
            raise ValueError("invalid source metadata")
        digest, written = hashlib.sha256(), 0
        with urllib.request.urlopen(url, timeout=180) as response, target.open("xb") as output:
            for block in iter(lambda: response.read(1024 * 1024), b""):
                written += len(block)
                if written > expected_size or written > MAX_PAGE_BYTES:
                    raise ValueError("source PPTX exceeds declared size")
                output.write(block)
                digest.update(block)
        if written != expected_size or digest.hexdigest() != expected_sha:
            raise ValueError("source PPTX checksum mismatch")

    @staticmethod
    def _bundle(page: dict, source: Path, dpi: int, target: Path):
        manifest = {
            "version": 1, "dpi": dpi,
            "pages": [{"index": page["index"], "file": f"pages/{page['index']}.pptx", "sha256": page["sha256"]}],
            "fonts": [], "required_fonts": [],
        }
        with zipfile.ZipFile(target, "x", compression=zipfile.ZIP_STORED) as archive:
            archive.write(source, f"pages/{page['index']}.pptx")
            archive.writestr("manifest.json", json.dumps(manifest, separators=(",", ":")))

    def _submit_local(self, page: dict, source: Path, dpi: int, stop: threading.Event) -> Path:
        bundle = source.with_suffix(".zip")
        self._bundle(page, source, dpi, bundle)
        key = uuid.uuid4().hex
        bundle_sha = _sha256_file(bundle)
        headers = {
            "Authorization": "Bearer " + self.token,
            "Accept": "application/json",
            "Content-Type": "application/zip",
            "Idempotency-Key": key,
            "X-Content-SHA256": bundle_sha,
            "Content-Length": str(bundle.stat().st_size),
        }
        job_id = None
        try:
            parsed = urllib.parse.urlsplit(self.renderer_url)
            connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=180)
            try:
                connection.putrequest("POST", "/v1/jobs")
                for name, value in headers.items():
                    connection.putheader(name, value)
                connection.endheaders()
                with bundle.open("rb") as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        if stop.is_set():
                            raise LeaseLost("render lease was lost")
                        connection.send(block)
                response = connection.getresponse()
                content = response.read(MAX_METADATA_BYTES + 1)
                if len(content) > MAX_METADATA_BYTES:
                    raise ValueError("local renderer response is too large")
                state = json.loads(content or b"{}")
                if response.status >= 400:
                    error = state.get("error") if isinstance(state, dict) else None
                    code = error.get("code") if isinstance(error, dict) else "renderer_unavailable"
                    raise RuntimeError(str(code or "renderer_unavailable"))
            finally:
                connection.close()
            job_id = state.get("id")
            if not isinstance(job_id, str) or not TASK_ID.fullmatch(job_id):
                raise ValueError("local renderer returned an invalid job id")
            while not stop.wait(0.5):
                state = self._renderer("GET", f"/v1/jobs/{job_id}")
                if state.get("status") == "completed":
                    pages = state.get("pages")
                    if not isinstance(pages, list) or len(pages) != 1 or pages[0].get("index") != page["index"]:
                        raise ValueError("local renderer returned invalid pages")
                    meta = pages[0]
                    result = source.with_suffix(".png")
                    self._download_local_page(job_id, meta, result)
                    return result
                if state.get("status") in {"failed", "cancelled"}:
                    error = state.get("error") or {}
                    code = error.get("code") if isinstance(error, dict) else "render_failed"
                    raise RuntimeError(str(code or "render_failed"))
            raise LeaseLost("render lease was lost")
        finally:
            bundle.unlink(missing_ok=True)
            if job_id:
                try:
                    self._renderer("DELETE", f"/v1/jobs/{job_id}", timeout=5)
                except Exception:
                    pass

    def _download_local_page(self, job_id: str, meta: dict, target: Path):
        size, digest = meta.get("size"), meta.get("sha256")
        if type(size) is not int or not 0 < size <= MAX_IMAGE_BYTES or not isinstance(digest, str) or not SHA256.fullmatch(digest):
            raise ValueError("local renderer page metadata is invalid")
        request = urllib.request.Request(
            self.renderer_url + f"/v1/jobs/{job_id}/pages/{meta['index']}",
            headers={"Authorization": "Bearer " + self.token, "Accept": "image/png"},
        )
        sha, written = hashlib.sha256(), 0
        with urllib.request.urlopen(request, timeout=180) as response, target.open("xb") as output:
            for block in iter(lambda: response.read(1024 * 1024), b""):
                written += len(block)
                if written > size:
                    raise ValueError("local renderer PNG exceeds declared size")
                output.write(block)
                sha.update(block)
        if written != size or sha.hexdigest() != digest:
            raise ValueError("local renderer PNG checksum mismatch")
        with Image.open(target) as image:
            if image.format != "PNG" or image.width <= 0 or image.height <= 0 or image.width * image.height > 50_000_000:
                raise ValueError("local renderer output is not a bounded PNG")
            image.verify()
        with Image.open(target) as image:
            image.load()

    @staticmethod
    def _upload(url: str, path: Path, stop: threading.Event):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise ValueError("output URL must be a signed HTTPS object URL")
        connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=180)
        target = urllib.parse.urlunsplit(("", "", parsed.path, parsed.query, ""))
        try:
            connection.putrequest("PUT", target)
            connection.putheader("Content-Type", "image/png")
            connection.putheader("Content-Length", str(path.stat().st_size))
            connection.endheaders()
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    if stop.is_set():
                        raise LeaseLost("render lease was lost")
                    connection.send(block)
            response = connection.getresponse()
            response.read(64 * 1024)
            if response.status // 100 != 2:
                raise RuntimeError("temporary_oss_error" if response.status >= 500 else "oss_upload_rejected")
        except (TimeoutError, socket.timeout, ConnectionError, OSError) as exc:
            raise RuntimeError("temporary_oss_error") from exc
        finally:
            connection.close()

    def _renew_loop(
        self, task_id: str, lease_token: str, lease_seconds: int,
        stopped: threading.Event, lost: threading.Event,
    ):
        last_success = time.monotonic()
        safety_window = max(5, min(60, lease_seconds // 6))
        while not stopped.wait(self.renew_seconds):
            try:
                self._main("POST", f"/api/renderer/render-tasks/{task_id}/renew", {"lease_token": lease_token})
                last_success = time.monotonic()
            except urllib.error.HTTPError as exc:
                if exc.code in {404, 409}:
                    lost.set()
                    return
            except Exception:
                pass
            if time.monotonic() - last_success >= lease_seconds - safety_window:
                lost.set()
                return

    def process(self, task: dict):
        task_id, lease_token = task.get("task_id"), task.get("lease_token")
        if not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id) or not isinstance(lease_token, str):
            raise ValueError("invalid claimed task")
        pages, dpi = task.get("pages"), task.get("dpi")
        lease_seconds = task.get("lease_seconds")
        if (not isinstance(pages, list) or not 1 <= len(pages) <= 500 or type(dpi) is not int
                or not 72 <= dpi <= 300 or type(lease_seconds) is not int or not 60 <= lease_seconds <= 3600):
            raise ValueError("invalid claimed task manifest")
        stopped, lost = threading.Event(), threading.Event()
        renewer = threading.Thread(
            target=self._renew_loop,
            args=(task_id, lease_token, lease_seconds, stopped, lost),
            daemon=True,
        )
        renewer.start()
        directory = Path(tempfile.mkdtemp(prefix=f"{task_id}-", dir=self.work_dir))
        results = []
        try:
            for page in pages:
                if lost.is_set():
                    raise LeaseLost("render lease was lost")
                index = page.get("index")
                if type(index) is not int or index < 0:
                    raise ValueError("invalid page index")
                signed = self._main(
                    "POST", f"/api/renderer/render-tasks/{task_id}/urls",
                    {"lease_token": lease_token, "page_index": index},
                ).get("page")
                if not isinstance(signed, dict) or signed.get("index") != index:
                    raise ValueError("could not obtain signed page URLs")
                source = directory / f"{index}.pptx"
                self._download(signed["download_url"], source, page["size"], page["sha256"])
                if lost.is_set():
                    raise LeaseLost("render lease was lost")
                image = self._submit_local(page, source, dpi, lost)
                signed = self._main(
                    "POST", f"/api/renderer/render-tasks/{task_id}/urls",
                    {"lease_token": lease_token, "page_index": index},
                ).get("page")
                if not isinstance(signed, dict) or signed.get("index") != index:
                    raise ValueError("could not refresh the signed output URL")
                self._upload(signed["upload_url"], image, lost)
                results.append({"index": index, "size": image.stat().st_size, "sha256": _sha256_file(image)})
            if lost.is_set():
                raise LeaseLost("render lease was lost")
            self._main("POST", f"/api/renderer/render-tasks/{task_id}/complete", {"lease_token": lease_token, "pages": results}, timeout=300)
        except LeaseLost:
            return
        except Exception as exc:
            code = _failure_code(exc)
            if code == "lease_lost":
                return
            try:
                self._main("POST", f"/api/renderer/render-tasks/{task_id}/failed", {"lease_token": lease_token, "error_code": code})
            except Exception:
                pass
        finally:
            stopped.set()
            renewer.join(timeout=5)
            import shutil
            shutil.rmtree(directory, ignore_errors=True)

    def run_once(self):
        task = self.claim()
        if not task:
            return False
        self.process(task)
        return True

    def run_forever(self):
        while True:
            try:
                self.run_once()
            except (urllib.error.URLError, TimeoutError, ValueError, OSError, json.JSONDecodeError):
                time.sleep(self.retry_seconds)


def main():
    parser = argparse.ArgumentParser(description="Pull and render SlideFlow PPT tasks")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    RenderPull(config).run_forever()


if __name__ == "__main__":
    main()
