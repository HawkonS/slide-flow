"""Windows worker that pulls durable PPT-to-PNG tasks from SlideFlow."""
from __future__ import annotations

import argparse
import errno
import hashlib
import http.client
import json
import logging
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
from concurrent.futures import ThreadPoolExecutor
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Callable

from PIL import Image

SHA256 = re.compile(r"^[0-9a-f]{64}$")
TASK_ID = re.compile(r"^[0-9a-f]{32}$")
MAX_PAGE_BYTES = 120 * 1024 * 1024
MAX_SOURCE_BYTES = 1024 * 1024 * 1024
MAX_IMAGE_BYTES = 64 * 1024 * 1024
MAX_METADATA_BYTES = 256 * 1024
LOG = logging.getLogger(__name__)


def _configure_logging(config_path: Path) -> Path:
    log_dir = config_path.resolve().parent / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{config_path.stem}.log"
    handler = RotatingFileHandler(
        log_path, maxBytes=1024 * 1024, backupCount=3, encoding="utf-8",
    )
    logging.basicConfig(
        level=logging.INFO,
        handlers=[handler],
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        force=True,
    )
    return log_path


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
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code in {404, 409}:
            return "lease_lost"
        if exc.code in {408, 425, 429} or exc.code >= 500:
            return "network_error"
        return "render_failed"
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
        renderer_token = str(config.get("renderer_token", ""))
        if not renderer_token and config.get("renderer_token_file"):
            renderer_token = Path(config["renderer_token_file"]).read_text(encoding="utf-8").strip()
        self.renderer_token = renderer_token or self.token
        self.worker_id = str(config.get("worker_id") or f"{socket.gethostname()}-{os.getpid()}")
        self.wait_seconds = max(0, min(25, int(config.get("wait_seconds", 25))))
        self.retry_seconds = max(1, min(60, int(config.get("retry_seconds", 5))))
        self.renew_seconds = max(10, min(120, int(config.get("renew_seconds", 30))))
        self.local_job_timeout_seconds = max(
            60, min(7200, int(config.get("local_job_timeout_seconds", 2100)))
        )
        self.poll_failure_exit_seconds = max(
            60, min(3600, int(config.get("poll_failure_exit_seconds", 300)))
        )
        # Publishing a rendered batch is network bound (signed URL requests
        # and OSS PUTs). Keep the default small enough for older Windows
        # machines while avoiding one round trip per page in the critical path.
        self.publish_concurrency = max(
            1, min(8, int(config.get("publish_concurrency", 4)))
        )
        self.work_dir = Path(config.get("work_dir") or tempfile.gettempdir()) / "slideflow-render-pull"
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self._validate_origin(self.base_url, "main task URL", allow_https_any=True)
        self._validate_origin(self.renderer_url, "local renderer URL", loopback_only=True)
        for name, value in (("render pull token", self.token), ("renderer token", self.renderer_token)):
            if len(value) < 32 or any(ord(char) < 33 or ord(char) > 126 for char in value):
                raise ValueError(f"{name} is invalid")
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

    def _request(self, base: str, method: str, path: str, body=None, timeout=30, headers=None, token=None):
        data = None
        request_headers = {"Authorization": "Bearer " + (token or self.token), "Accept": "application/json"}
        request_headers.update(headers or {})
        if body is not None:
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(base + path, data=data, method=method, headers=request_headers)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            content = response.read(MAX_METADATA_BYTES + 1)
            if len(content) > MAX_METADATA_BYTES:
                raise ValueError("metadata response is too large")
            payload = json.loads(content or b"{}")
            if not isinstance(payload, dict):
                raise ValueError("metadata response must be a JSON object")
            return payload

    def _main(self, method, path, body=None, timeout=30):
        return self._request(self.base_url, method, path, body, timeout)

    def _renderer(self, method, path, body=None, timeout=30, headers=None):
        return self._request(self.renderer_url, method, path, body, timeout, headers, self.renderer_token)

    def claim(self):
        query = urllib.parse.urlencode({"worker_id": self.worker_id, "wait_seconds": self.wait_seconds})
        return self._main("GET", "/api/renderer/render-tasks/claim?" + query,
                          timeout=self.wait_seconds + 10).get("task")

    @staticmethod
    def _download(
        url: str, target: Path, expected_size: int, expected_sha: str,
        max_bytes: int = MAX_PAGE_BYTES,
    ):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise ValueError("source URL must be a signed HTTPS object URL")
        if not 0 < expected_size <= max_bytes or not SHA256.fullmatch(expected_sha):
            raise ValueError("invalid source metadata")
        digest, written = hashlib.sha256(), 0
        with urllib.request.urlopen(url, timeout=180) as response, target.open("xb") as output:
            for block in iter(lambda: response.read(1024 * 1024), b""):
                written += len(block)
                if written > expected_size or written > max_bytes:
                    raise ValueError("source PPTX exceeds declared size")
                output.write(block)
                digest.update(block)
        if written != expected_size or digest.hexdigest() != expected_sha:
            raise ValueError("source PPTX checksum mismatch")

    @staticmethod
    def _bundle(
        page: dict, source: Path, dpi: int, target: Path,
        required_fonts: list[str], font_hashes: list[str],
        font_bindings: list[dict[str, str]],
    ):
        manifest = {
            "version": 1, "dpi": dpi,
            "pages": [{"index": page["index"], "file": f"pages/{page['index']}.pptx", "sha256": page["sha256"]}],
            "fonts": [], "required_fonts": required_fonts, "font_hashes": font_hashes,
            "font_bindings": font_bindings,
        }
        with zipfile.ZipFile(target, "x", compression=zipfile.ZIP_STORED) as archive:
            archive.write(source, f"pages/{page['index']}.pptx")
            archive.writestr("manifest.json", json.dumps(manifest, separators=(",", ":")))

    @staticmethod
    def _bundle_batch(
        pages: list[dict], source_meta: dict, source: Path, dpi: int, target: Path,
        required_fonts: list[str], font_hashes: list[str],
        font_bindings: list[dict[str, str]],
    ):
        manifest = {
            "version": 2,
            "dpi": dpi,
            "source": {
                "file": "source/deck.pptx",
                "sha256": source_meta["sha256"],
                "slide_count": source_meta["slide_count"],
            },
            "pages": [
                {"index": page["index"], "slide": page["index"] + 1}
                for page in pages
            ],
            "fonts": [],
            "required_fonts": required_fonts,
            "font_hashes": font_hashes,
            "font_bindings": font_bindings,
        }
        with zipfile.ZipFile(target, "x", compression=zipfile.ZIP_STORED) as archive:
            archive.write(source, "source/deck.pptx")
            archive.writestr("manifest.json", json.dumps(manifest, separators=(",", ":")))

    def _submit_bundle(
        self, bundle: Path, expected_indexes: list[int], result_dir: Path,
        stop: threading.Event,
    ) -> dict[int, Path]:
        key = uuid.uuid4().hex
        bundle_sha = _sha256_file(bundle)
        headers = {
            "Authorization": "Bearer " + self.renderer_token,
            "Accept": "application/json",
            "Content-Type": "application/zip",
            "Idempotency-Key": key,
            "X-Content-SHA256": bundle_sha,
            "Content-Length": str(bundle.stat().st_size),
        }
        job_id = None
        try:
            parsed = urllib.parse.urlsplit(self.renderer_url)
            connection_type = (
                http.client.HTTPSConnection if parsed.scheme == "https"
                else http.client.HTTPConnection
            )
            connection = connection_type(parsed.hostname, parsed.port, timeout=180)
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
            deadline = time.monotonic() + self.local_job_timeout_seconds
            while not stop.wait(0.5):
                if time.monotonic() >= deadline:
                    raise RuntimeError("render_timeout")
                state = self._renderer("GET", f"/v1/jobs/{job_id}")
                status = state.get("status")
                if status == "completed":
                    pages = state.get("pages")
                    if not isinstance(pages, list) or len(pages) != len(expected_indexes):
                        raise ValueError("local renderer returned invalid pages")
                    by_index = {
                        item.get("index"): item for item in pages
                        if isinstance(item, dict) and type(item.get("index")) is int
                    }
                    if set(by_index) != set(expected_indexes):
                        raise ValueError("local renderer returned invalid page indexes")
                    result_dir.mkdir(parents=True, exist_ok=False)
                    results = {}
                    for index in expected_indexes:
                        result = result_dir / f"{index}.png"
                        self._download_local_page(job_id, by_index[index], result)
                        results[index] = result
                    return results
                if status in {"failed", "cancelled"}:
                    error = state.get("error") or {}
                    code = error.get("code") if isinstance(error, dict) else "render_failed"
                    message = error.get("message") if isinstance(error, dict) else None
                    if isinstance(message, str) and message:
                        LOG.error("local renderer job %s failed: %s: %s", job_id, code, message)
                    raise RuntimeError(str(code or "render_failed"))
                if status == "waiting_fonts":
                    # Older renderer versions could leave this undocumented
                    # state pending forever. Treat it as a legacy worker restart
                    # so the durable main task is retried against the current
                    # renderer. A real missing font is reported authoritatively
                    # by FontManager.activate after that retry starts.
                    raise RuntimeError("worker_restarted")
                if status not in {"queued", "running"}:
                    raise RuntimeError("renderer_unavailable")
            raise LeaseLost("render lease was lost")
        finally:
            bundle.unlink(missing_ok=True)
            if job_id:
                try:
                    self._renderer("DELETE", f"/v1/jobs/{job_id}", timeout=5)
                except Exception:
                    pass

    def _submit_local(
        self, page: dict, source: Path, dpi: int, stop: threading.Event,
        required_fonts: list[str], font_hashes: list[str],
        font_bindings: list[dict[str, str]],
    ) -> Path:
        bundle = source.with_suffix(".zip")
        self._bundle(
            page, source, dpi, bundle, required_fonts, font_hashes, font_bindings,
        )
        results = self._submit_bundle(bundle, [page["index"]], source.parent / f"result-{page['index']}", stop)
        return results[page["index"]]

    def _submit_local_batch(
        self, pages: list[dict], source_meta: dict, source: Path, dpi: int,
        stop: threading.Event, required_fonts: list[str], font_hashes: list[str],
        font_bindings: list[dict[str, str]],
    ) -> dict[int, Path]:
        token = uuid.uuid4().hex
        bundle = source.parent / f"batch-{token}.zip"
        self._bundle_batch(
            pages, source_meta, source, dpi, bundle,
            required_fonts, font_hashes, font_bindings,
        )
        return self._submit_bundle(
            bundle, [page["index"] for page in pages], source.parent / f"result-{token}", stop,
        )

    def _download_local_page(self, job_id: str, meta: dict, target: Path):
        size, digest = meta.get("size"), meta.get("sha256")
        if type(size) is not int or not 0 < size <= MAX_IMAGE_BYTES or not isinstance(digest, str) or not SHA256.fullmatch(digest):
            raise ValueError("local renderer page metadata is invalid")
        request = urllib.request.Request(
            self.renderer_url + f"/v1/jobs/{job_id}/pages/{meta['index']}",
            headers={"Authorization": "Bearer " + self.renderer_token, "Accept": "image/png"},
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

    def _batch_capabilities(self, source: dict, requested: int) -> tuple[int, int]:
        if requested <= 1 or not isinstance(source, dict):
            return 1, MAX_PAGE_BYTES
        try:
            health = self._renderer("GET", "/v1/health", timeout=10)
        except Exception:
            return 1, MAX_PAGE_BYTES
        version = health.get("version")
        max_batch = health.get("max_batch_pages")
        max_input = health.get("max_input_file_bytes")
        max_upload = health.get("max_upload_bytes")
        max_slides = health.get("max_source_slides")
        if (type(version) is not int or version < 2 or type(max_batch) is not int
                or type(max_input) is not int or type(max_upload) is not int
                or type(max_slides) is not int):
            return 1, MAX_PAGE_BYTES
        size, slide_count = source.get("size"), source.get("slide_count")
        upload_limit = min(MAX_SOURCE_BYTES, max_input, max(0, max_upload - 1024 * 1024))
        if (type(size) is not int or not 0 < size <= upload_limit
                or type(slide_count) is not int or not 1 <= slide_count <= max_slides):
            return 1, MAX_PAGE_BYTES
        return max(1, min(requested, max_batch)), upload_limit

    def _render_batch_with_fallback(
        self, pages: list[dict], source_meta: dict, source: Path, dpi: int,
        stop: threading.Event, required_fonts: list[str], font_hashes: list[str],
        font_bindings: list[dict[str, str]],
        on_batch: Callable[[list[dict], dict[int, Path]], None] | None = None,
    ) -> dict[int, Path]:
        if stop.is_set():
            raise LeaseLost("render lease was lost")
        try:
            images = self._submit_local_batch(
                pages, source_meta, source, dpi, stop,
                required_fonts, font_hashes, font_bindings,
            )
        except RuntimeError as exc:
            splittable = {
                "render_timeout", "conversion_failed", "output_too_large",
                "invalid_output", "internal_error",
            }
            if len(pages) <= 1 or str(exc) not in splittable:
                raise
            middle = len(pages) // 2
            left = self._render_batch_with_fallback(
                pages[:middle], source_meta, source, dpi, stop,
                required_fonts, font_hashes, font_bindings, on_batch,
            )
            right = self._render_batch_with_fallback(
                pages[middle:], source_meta, source, dpi, stop,
                required_fonts, font_hashes, font_bindings, on_batch,
            )
            return {**left, **right}
        if stop.is_set():
            raise LeaseLost("render lease was lost")
        # Only local conversion errors may bisect a batch. An upload or result
        # acknowledgement failure must never repeat an already successful WPS
        # conversion, including when a successful left subtree was published.
        if on_batch is not None:
            on_batch(pages, images)
        return images

    def _output_url(self, task_id: str, lease_token: str, index: int) -> str:
        signed = self._main(
            "POST", f"/api/renderer/render-tasks/{task_id}/urls",
            {"lease_token": lease_token, "page_index": index, "include_source": False},
        ).get("page")
        if not isinstance(signed, dict) or signed.get("index") != index:
            raise ValueError("could not obtain signed page URLs")
        url = signed.get("upload_url")
        if not isinstance(url, str):
            raise ValueError("could not obtain signed output URL")
        return url

    def _report_progress(
        self, task_id: str, lease_token: str, pages: list[dict],
        total: int, stop: threading.Event,
    ) -> None:
        # Retry the exact receipt after a lost response. The server owns
        # idempotency; conversion and OSS upload are outside this retry loop.
        for attempt in range(3):
            if stop.is_set():
                raise LeaseLost("render lease was lost")
            try:
                result = self._main(
                    "POST", f"/api/renderer/render-tasks/{task_id}/progress",
                    {"lease_token": lease_token, "pages": pages}, timeout=300,
                )
                count = result.get("preview_count")
                if (result.get("ok") is not True or type(count) is not int
                        or type(result.get("total")) is not int
                        or result["total"] != total or not len(pages) <= count <= total):
                    raise ValueError("invalid incremental result acknowledgement")
                if stop.is_set():
                    raise LeaseLost("render lease was lost")
                return
            except urllib.error.HTTPError as exc:
                if exc.code in {404, 409}:
                    stop.set()
                    raise LeaseLost("render result lease was rejected") from exc
                if _failure_code(exc) != "network_error" or attempt == 2:
                    raise
            except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError):
                if attempt == 2:
                    raise
            if stop.wait(min(5, self.retry_seconds) * (attempt + 1)):
                raise LeaseLost("render lease was lost")

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
                    LOG.warning("render task %s lease was rejected with HTTP %s", task_id, exc.code)
                    lost.set()
                    return
                LOG.warning("render task %s lease renewal failed with HTTP %s", task_id, exc.code)
            except Exception as exc:
                LOG.warning("render task %s lease renewal failed: %s", task_id, type(exc).__name__)
            if time.monotonic() - last_success >= lease_seconds - safety_window:
                LOG.error("render task %s lease could not be renewed before its safety deadline", task_id)
                lost.set()
                return

    def process(self, task: dict):
        task_id, lease_token = task.get("task_id"), task.get("lease_token")
        if not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id) or not isinstance(lease_token, str):
            raise ValueError("invalid claimed task")
        pages, dpi = task.get("pages"), task.get("dpi")
        lease_seconds = task.get("lease_seconds")
        required_fonts = task.get("required_fonts", [])
        font_hashes = task.get("font_hashes", [])
        font_bindings = task.get("font_bindings", [])
        requested_batch = task.get("batch_size", 1)
        incremental = task.get("incremental_results") is True
        first_batch = task.get("first_batch_size", 4) if incremental else requested_batch
        if (not isinstance(pages, list) or not 1 <= len(pages) <= 500 or type(dpi) is not int
                or not 72 <= dpi <= 300 or type(lease_seconds) is not int or not 60 <= lease_seconds <= 3600
                or type(requested_batch) is not int or not 1 <= requested_batch <= 50
                or type(first_batch) is not int or not 1 <= first_batch <= 50
                or not isinstance(required_fonts, list) or len(required_fonts) > 128
                or any(not isinstance(name, str) or not name.strip() or len(name) > 256 for name in required_fonts)
                or len(set(required_fonts)) != len(required_fonts)
                or not isinstance(font_hashes, list) or len(font_hashes) > 64
                or any(not isinstance(digest, str) or not SHA256.fullmatch(digest) for digest in font_hashes)
                or len(set(font_hashes)) != len(font_hashes)
                or not isinstance(font_bindings, list) or len(font_bindings) > 512
                or any(
                    not isinstance(binding, dict)
                    or not isinstance(binding.get("name"), str)
                    or binding.get("name") not in required_fonts
                    or not isinstance(binding.get("sha256"), str)
                    or binding.get("sha256") not in font_hashes
                    for binding in font_bindings
                )
                or len({(binding["name"], binding["sha256"]) for binding in font_bindings})
                != len(font_bindings)
                or (font_bindings and {binding["name"] for binding in font_bindings} != set(required_fonts))):
            raise ValueError("invalid claimed task manifest")
        indexes = set()
        for page in pages:
            if (not isinstance(page, dict) or type(page.get("index")) is not int
                    or not 0 <= page["index"] <= 100000 or page["index"] in indexes
                    or type(page.get("size")) is not int or not 0 < page["size"] <= MAX_PAGE_BYTES
                    or not isinstance(page.get("sha256"), str) or not SHA256.fullmatch(page["sha256"])):
                raise ValueError("invalid claimed page manifest")
            indexes.add(page["index"])
        source_meta = task.get("source")
        source_valid = (
            isinstance(source_meta, dict)
            and isinstance(source_meta.get("sha256"), str)
            and SHA256.fullmatch(source_meta["sha256"]) is not None
            and type(source_meta.get("size")) is int and source_meta["size"] > 0
            and type(source_meta.get("slide_count")) is int
            and source_meta["slide_count"] == len(pages)
            and indexes == set(range(len(pages)))
        )
        if not source_valid:
            source_meta = None
        batch_size, source_limit = self._batch_capabilities(source_meta, requested_batch)
        stopped, lost = threading.Event(), threading.Event()
        renewer = threading.Thread(
            target=self._renew_loop,
            args=(task_id, lease_token, lease_seconds, stopped, lost),
            daemon=True,
        )
        renewer.start()
        directory = Path(tempfile.mkdtemp(prefix=f"{task_id}-", dir=self.work_dir))
        results: dict[int, dict] = {}

        def publish_batch(batch: list[dict], images: dict[int, Path]) -> None:
            batch_indexes = [page["index"] for page in batch]
            if (len(set(batch_indexes)) != len(batch_indexes)
                    or not set(batch_indexes).issubset(indexes)
                    or set(images) != set(batch_indexes)):
                raise ValueError("invalid rendered batch indexes")
            pending = []
            for index in batch_indexes:
                if lost.is_set():
                    raise LeaseLost("render lease was lost")
                image = images[index]
                meta = {"index": index, "size": image.stat().st_size,
                        "sha256": _sha256_file(image)}
                previous = results.get(index)
                if previous is not None:
                    if previous != meta:
                        raise ValueError("conflicting rendered page result")
                    continue
                pending.append(meta)
            if not pending:
                return

            def signed_output(meta: dict) -> tuple[int, str]:
                if lost.is_set():
                    raise LeaseLost("render lease was lost")
                index = meta["index"]
                return index, self._output_url(task_id, lease_token, index)

            # URL signing and object uploads are independent for pages in one
            # batch. Run them concurrently so the first incremental receipt is
            # gated by the slowest page instead of the sum of all pages.
            workers = min(self.publish_concurrency, len(pending))
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="render-url") as pool:
                output_urls = dict(pool.map(signed_output, pending))

            def upload(meta: dict) -> None:
                if lost.is_set():
                    raise LeaseLost("render lease was lost")
                index = meta["index"]
                self._upload(output_urls[index], images[index], lost)

            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="render-upload") as pool:
                list(pool.map(upload, pending))
            if pending and incremental:
                self._report_progress(task_id, lease_token, pending, len(pages), lost)
            for meta in pending:
                results[meta["index"]] = meta

        LOG.info("render task %s started with %s page(s)", task_id, len(pages))
        try:
            if batch_size > 1 and source_meta is not None:
                signed_source = self._main(
                    "POST", f"/api/renderer/render-tasks/{task_id}/source-url",
                    {"lease_token": lease_token},
                ).get("source")
                if (not isinstance(signed_source, dict)
                        or signed_source.get("sha256") != source_meta["sha256"]
                        or signed_source.get("size") != source_meta["size"]
                        or signed_source.get("slide_count") != source_meta["slide_count"]):
                    raise ValueError("could not obtain the signed render source")
                source = directory / "source.pptx"
                self._download(
                    signed_source["download_url"], source, source_meta["size"],
                    source_meta["sha256"], source_limit,
                )
                offset = 0
                while offset < len(pages):
                    if lost.is_set():
                        raise LeaseLost("render lease was lost")
                    chunk_size = min(first_batch, batch_size) if offset == 0 else batch_size
                    chunk = pages[offset:offset + chunk_size]
                    images = self._render_batch_with_fallback(
                        chunk, source_meta, source, dpi, lost,
                        required_fonts, font_hashes, font_bindings,
                        publish_batch if incremental else None,
                    )
                    if not incremental:
                        publish_batch(chunk, images)
                    offset += len(chunk)
            else:
                for page in pages:
                    if lost.is_set():
                        raise LeaseLost("render lease was lost")
                    index = page["index"]
                    signed = self._main(
                        "POST", f"/api/renderer/render-tasks/{task_id}/urls",
                        {"lease_token": lease_token, "page_index": index},
                    ).get("page")
                    if not isinstance(signed, dict) or signed.get("index") != index:
                        raise ValueError("could not obtain signed page URLs")
                    source = directory / f"{index}.pptx"
                    self._download(signed["download_url"], source, page["size"], page["sha256"])
                    image = self._submit_local(
                        page, source, dpi, lost,
                        required_fonts, font_hashes, font_bindings,
                    )
                    publish_batch([page], {index: image})
            if lost.is_set():
                raise LeaseLost("render lease was lost")
            if set(results) != indexes:
                raise ValueError("incomplete rendered page results")
            self._main("POST", f"/api/renderer/render-tasks/{task_id}/complete", {"lease_token": lease_token, "pages": [results[page["index"]] for page in pages]}, timeout=300)
            LOG.info("render task %s completed with %s page(s)", task_id, len(results))
        except LeaseLost:
            LOG.warning("render task %s stopped after its lease was lost", task_id)
            return
        except Exception as exc:
            code = _failure_code(exc)
            LOG.exception("render task %s failed with code %s", task_id, code)
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
        last_success = time.monotonic()
        while True:
            try:
                self.run_once()
                last_success = time.monotonic()
            except (urllib.error.URLError, TimeoutError, ValueError, OSError, json.JSONDecodeError) as exc:
                unhealthy_seconds = time.monotonic() - last_success
                LOG.warning(
                    "render task polling failed for %.0f second(s): %s",
                    unhealthy_seconds,
                    type(exc).__name__,
                )
                if unhealthy_seconds >= self.poll_failure_exit_seconds:
                    LOG.error(
                        "render task polling stayed unhealthy for %.0f second(s); exiting for scheduler recovery",
                        unhealthy_seconds,
                    )
                    raise RuntimeError("render pull polling is unhealthy") from exc
                time.sleep(self.retry_seconds)


def main():
    parser = argparse.ArgumentParser(description="Pull and render SlideFlow PPT tasks")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config_path = Path(args.config).resolve()
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    log_path = _configure_logging(config_path)
    worker = RenderPull(config)
    LOG.info(
        "render pull worker %s starting; main=%s renderer=%s log=%s",
        worker.worker_id,
        worker.base_url,
        worker.renderer_url,
        log_path,
    )
    worker.run_forever()


if __name__ == "__main__":
    main()
