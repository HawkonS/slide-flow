import json
import logging
import math
import os
import queue
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field

from PIL import Image

from .errors import RenderError
from .fonts import FontManager
from .process import convert
from .storage import JOB_ID, Storage
from .validation import digest, unpack_bundle

LOG = logging.getLogger(__name__)
TERMINAL = {"completed", "failed", "cancelled"}


def _natural_path_key(path):
    return tuple(
        (1, int(part)) if part.isdigit() else (0, part)
        for part in re.split(r"(\d+)", path.as_posix().casefold())
    )


@dataclass
class Job:
    id: str
    key: str
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    state: str = "uploading"
    bundle_sha256: str = ""
    pages: list = field(default_factory=list)
    error: dict = None
    manifest: dict = None
    cancel: threading.Event = field(default_factory=threading.Event)
    readers: int = 0
    deleted: bool = False
    fonts_ready: bool = True

    def public(self):
        return {"id": self.id, "status": self.state, "created_at": self.created_at,
                "updated_at": self.updated_at, "pages": [dict(p) for p in self.pages],
                "error": self.error}


class JobManager:
    def __init__(self, settings, converter=convert, font_manager=None):
        self.settings = settings
        self.storage = Storage(settings.data_dir)
        self.fonts = font_manager or FontManager()
        self.converter = converter
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.jobs = {}
        self.keys = {}
        self.uploads = set()
        self.accepting = set()
        self.queue = queue.Queue(maxsize=settings.max_queue)
        self.stop = threading.Event()
        self._closed = False
        # Draining is a maintenance state, distinct from stopping the worker.
        # It rejects new submissions while allowing the current queue to finish
        # before an operator upgrades or restarts the service.
        self.draining = False
        try:
            self._recover()
        except BaseException:
            self.storage.close()
            raise
        self.worker = threading.Thread(target=self._work, name="wps-single-worker", daemon=True)
        self.cleaner = threading.Thread(target=self._clean_loop, name="wps-cleaner", daemon=True)
        self.worker.start()
        self.cleaner.start()

    def _recover(self):
        for directory in self.storage.root.iterdir():
            if not JOB_ID.fullmatch(directory.name):
                continue
            target = self.storage.directory(directory.name)
            data = {}
            try:
                metadata = target / "job.json"
                if metadata.stat().st_size > 65536:
                    raise ValueError("Oversized job metadata")
                data = json.loads(metadata.read_text(encoding="utf-8"))
                if (not isinstance(data, dict) or not isinstance(data.get("key"), str)
                        or not 16 <= len(data["key"]) <= 128
                        or not isinstance(data.get("updated_at"), (int, float))
                        or not math.isfinite(data["updated_at"])):
                    raise ValueError("Invalid job metadata")
            except (OSError, ValueError):
                data = {}
            if hasattr(self.fonts, "recover"):
                self.fonts.recover(target / "input" / "fonts")
            try:
                self.storage.remove(directory.name)
            except OSError:
                # Quarantine a transiently locked orphan rather than preventing
                # the whole service from restarting. Disk accounting includes it.
                LOG.warning("Recovery cleanup deferred job=%s", directory.name)
                data.setdefault("key", "recovered_" + directory.name)
                data["updated_at"] = time.time()
            if data and time.time() - data["updated_at"] < self.settings.retention_seconds:
                cancelled = data.get("status") == "cancelled" or data.get("deleted", False)
                job = Job(id=directory.name, key=data["key"], created_at=data.get("created_at", time.time()),
                          updated_at=data["updated_at"], bundle_sha256=data.get("bundle_sha256", ""),
                          state="cancelled" if cancelled else "failed", deleted=bool(cancelled),
                          error={"code": "cancelled" if cancelled else "worker_restarted",
                                 "message": "Submission cancelled" if cancelled else "Renderer restarted; resubmit using a new idempotency key"})
                if cancelled:
                    job.cancel.set()
                self.jobs[job.id], self.keys[job.key] = job, job.id
                self._persist(job)

    def _persist(self, job):
        directory = self.storage.directory(job.id)
        directory.mkdir(exist_ok=True)
        data = {**job.public(), "key": job.key, "bundle_sha256": job.bundle_sha256, "deleted": job.deleted,
                "fonts_ready": job.fonts_ready}
        temporary = directory / "job.json.tmp"
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(data, stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(directory / "job.json")

    def _capacity(self, extra=0):
        free = shutil.disk_usage(self.storage.root)
        used = self.storage.size()
        reserved = sum((self.settings.max_upload_bytes + self.settings.max_expanded_bytes + self.settings.max_output_bytes)
                       if job.state == "uploading" else self.settings.max_output_bytes
                       for job in self.jobs.values() if job.state not in TERMINAL)
        if (used + reserved + extra > self.settings.max_total_bytes
                or free.free - reserved - extra < max(self.settings.min_free_bytes, free.total * self.settings.min_free_ratio)):
            raise RenderError("disk_pressure", "Renderer storage reserve is exhausted; retry later", 507)

    def admit(self, key):
        with self.lock:
            # Preserve idempotency lookups during maintenance. A retry for an
            # already accepted key must be able to retrieve its existing job;
            # drain only rejects genuinely new submissions.
            self.cleanup()
            existing = self.keys.get(key)
            if existing:
                return self.jobs[existing], False
            if self.stop.is_set() or not self.worker.is_alive():
                raise RenderError("worker_unavailable", "Renderer is stopping or unavailable", 503)
            if self.draining:
                raise RenderError("renderer_draining", "Renderer is draining for maintenance; retry shortly", 503)
            if len(self.jobs) >= self.settings.max_records:
                raise RenderError("queue_full", "Renderer job history is full; retry after retention expires", 429)
            active = sum(job.state not in TERMINAL for job in self.jobs.values())
            if active >= self.settings.max_queue + 1:
                raise RenderError("queue_full", "Renderer queue is full", 429)
            self._capacity(self.settings.max_upload_bytes + self.settings.max_expanded_bytes + self.settings.max_output_bytes)
            job = Job(id=uuid.uuid4().hex, key=key)
            self.jobs[job.id], self.keys[key] = job, job.id
            self.uploads.add(job.id)
            try:
                self._persist(job)
            except OSError as exc:
                self.jobs.pop(job.id, None)
                self.keys.pop(key, None)
                self.uploads.discard(job.id)
                self.storage.remove(job.id)
                raise RenderError("disk_pressure", "Cannot reserve renderer storage", 507) from exc
            return job, True

    def begin_drain(self):
        with self.lock:
            self.draining = True
            counts = self.activity_counts()
            return {
                "status": "draining",
                **counts,
            }

    def activity_counts(self):
        """Return all states that can still own files or queue capacity."""
        return {
            "uploading": sum(j.state == "uploading" for j in self.jobs.values()),
            "accepting": len(self.accepting),
            "queued": sum(j.state == "queued" for j in self.jobs.values()),
            "running": sum(j.state == "running" for j in self.jobs.values()),
            "readers": sum(j.readers for j in self.jobs.values()),
        }

    def resume(self):
        with self.lock:
            if self.stop.is_set() or not self.worker.is_alive():
                raise RenderError("worker_unavailable", "Conversion worker is not running", 503)
            self.draining = False
            return {"status": "ok"}

    def accept(self, job, sha):
        with self.changed:
            if self.stop.is_set() or job.cancel.is_set():
                raise RenderError("cancelled", "Upload was cancelled", 409)
            self.accepting.add(job.id)
        try:
            self._accept(job, sha)
        finally:
            with self.changed:
                self.accepting.discard(job.id)
                if job.state != "uploading":
                    self.uploads.discard(job.id)
                self.changed.notify_all()

    def _accept(self, job, sha):
        directory = self.storage.directory(job.id)
        manifest = unpack_bundle(directory / "bundle.zip", directory / "input", self.settings)
        with self.lock:
            if job.cancel.is_set():
                raise RenderError("cancelled", "Upload was cancelled", 409)
            job.manifest, job.bundle_sha256 = manifest, sha
            # Font sync is owned by a separate process. Its completion can race
            # this process's short-lived installed-font cache, so admission must
            # never park a job in an unconsumed intermediate state. The worker
            # performs the authoritative, forced inventory scan in
            # ``FontManager.activate`` immediately before WPS starts.
            job.fonts_ready = True
            job.state = "queued"
            job.updated_at = time.time()
            try:
                (directory / "bundle.zip").unlink(missing_ok=True)
                self._persist(job)
                self.queue.put_nowait(job.id)
            except queue.Full as exc:
                job.state, job.manifest = "uploading", None
                raise RenderError("queue_full", "Renderer queue is full", 429) from exc
            except Exception:
                job.state, job.manifest = "uploading", None
                raise

    def upload_failed(self, job):
        with self.changed:
            if job.id in self.accepting:
                raise RuntimeError("Cannot clean an upload while validation still owns its files")
            try:
                if job.cancel.is_set() or job.deleted:
                    job.state, job.updated_at, job.deleted = "cancelled", time.time(), True
                    self._drop_payload(job)
                    self._persist(job)
                else:
                    self.storage.remove(job.id)
            except OSError:
                job.state, job.updated_at = "failed", time.time()
                job.error = {"code": "cleanup_pending", "message": "Temporary files will be retried by retention cleanup"}
                self._persist(job)
                LOG.exception("Upload cleanup deferred for job %s", job.id)
            else:
                if job.state != "cancelled":
                    self.keys.pop(job.key, None)
                    self.jobs.pop(job.id, None)
            finally:
                self.uploads.discard(job.id)
                self.changed.notify_all()

    def get_by_key(self, key):
        with self.lock:
            job_id = self.keys.get(key)
            if job_id is None:
                raise RenderError("not_found", "No job exists for this idempotency key", 404)
            return self.get(job_id)

    def cancel_by_key(self, key):
        """Persist a cancellation even if its delayed POST has not arrived yet."""
        with self.lock:
            if key in self.keys:
                return self.cancel(self.keys[key])
            self.cleanup()
            if len(self.jobs) >= self.settings.max_records:
                raise RenderError("queue_full", "Cannot retain another cancellation key yet", 429)
            job = Job(id=uuid.uuid4().hex, key=key, state="cancelled", deleted=True,
                      error={"code": "cancelled", "message": "This submission key was cancelled"})
            job.cancel.set()
            try:
                self._persist(job)
            except OSError as exc:
                raise RenderError("disk_pressure", "Unable to persist cancellation", 507) from exc
            self.jobs[job.id], self.keys[key] = job, job.id
            return job.public()

    def get(self, job_id):
        with self.lock:
            self.storage.directory(job_id)
            job = self.jobs.get(job_id)
            if not job:
                raise RenderError("not_found", "Job does not exist or has expired", 404)
            return job

    def cancel(self, job_id):
        with self.lock:
            job = self.get(job_id)
            job.cancel.set()
            job.deleted = True
            if job.state in TERMINAL:
                job.state, job.updated_at = "cancelled", time.time()
                self._drop_payload(job)
            elif job.state == "queued":
                job.state, job.updated_at = "cancelled", time.time()
                self._drop_payload(job)
            self._persist(job)
            return job.public()

    def acknowledge(self, job_id, index, sha=None):
        with self.lock:
            job = self.get(job_id)
            page = next((p for p in job.pages if p["index"] == index), None)
            if not page:
                raise RenderError("not_found", "Page has not been rendered", 404)
            if sha and sha.strip('"') != page["sha256"]:
                raise RenderError("checksum_mismatch", "Acknowledged checksum does not match", 409)
            page["acknowledged"] = True
            if not job.readers:
                (self.storage.directory(job.id) / "output" / f"{index}.png").unlink(missing_ok=True)
            job.updated_at = time.time()
            self._persist(job)

    def page_stream(self, job_id, index):
        with self.lock:
            job = self.get(job_id)
            page = next((p for p in job.pages if p["index"] == index and not p.get("acknowledged")), None)
            if not page or job.deleted:
                raise RenderError("not_found", "Page is not available or was acknowledged", 404)
            try:
                stream = open(self.storage.directory(job.id) / "output" / f"{index}.png", "rb")
            except FileNotFoundError as exc:
                raise RenderError("not_found", "Page was removed after a failed or expired job", 404) from exc
            job.readers += 1
        released = False
        def release():
            nonlocal released
            with self.lock:
                if not released:
                    released = True
                    stream.close()
                    job.readers -= 1
                    self.changed.notify_all()
                    if job.deleted and job.state in TERMINAL:
                        self._drop_payload(job)
                    elif not job.readers:
                        for item in job.pages:
                            if item.get("acknowledged"):
                                (self.storage.directory(job.id) / "output" / f"{item['index']}.png").unlink(missing_ok=True)
        def chunks():
            try:
                for block in iter(lambda: stream.read(256 * 1024), b""):
                    yield block
            finally:
                release()
        return chunks(), dict(page), release

    def _drop_payload(self, job):
        if job.readers:
            return
        directory = self.storage.directory(job.id)
        if directory.exists():
            for path in directory.iterdir():
                if path.name not in {"job.json", "job.json.tmp"}:
                    try:
                        if path.is_dir():
                            shutil.rmtree(path)
                        else:
                            path.unlink(missing_ok=True)
                    except OSError:
                        # A recently unloaded font or AV scanner can briefly
                        # retain an NTFS handle. TTL cleanup retries; the worker
                        # must stay alive to serve subsequent jobs.
                        LOG.warning("Deferred payload cleanup job=%s", job.id)

    def _work(self):
        while not self.stop.is_set():
            try:
                job_id = self.queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                with self.lock:
                    job = self.jobs.get(job_id)
                    if job is None:
                        continue
                    if job.cancel.is_set() or job.state != "queued":
                        continue
                    job.state, job.updated_at = "running", time.time()
                    self._persist(job)
                self._render(job)
                with self.lock:
                    job.state = "cancelled" if job.cancel.is_set() else "completed"
            except RenderError as exc:
                with self.lock:
                    job.state = "cancelled" if job.cancel.is_set() else "failed"
                    job.error = exc.public()
                    if exc.code in {"process_cleanup_failed", "font_cleanup_failed"}:
                        # Do not start a new render in a possibly contaminated
                        # process/font lane. Keep the lock until service restart.
                        self.stop.set()
            except Exception:
                LOG.exception("Renderer job %s failed", job_id)
                with self.lock:
                    job.state, job.error = "failed", {"code": "internal_error", "message": "Renderer failed; check server logs"}
            finally:
                try:
                    with self.lock:
                        if job_id in self.jobs:
                            job = self.jobs[job_id]
                            job.updated_at = time.time()
                            if job.state in {"failed", "cancelled"} or job.deleted:
                                self._drop_payload(job)
                            elif job.state == "completed":
                                source = self.storage.directory(job.id) / "input"
                                if source.exists():
                                    shutil.rmtree(source)
                            self._persist(job)
                except OSError:
                    # Locked font files or transient antivirus locks must not kill
                    # the only worker. TTL cleanup retries without touching live jobs.
                    LOG.exception("Deferred payload cleanup for job %s", job_id)
                self.queue.task_done()

    def _render(self, job):
        directory = self.storage.directory(job.id)
        output = directory / "output"
        output.mkdir()
        with self.fonts.activate(directory / "input", job.manifest):
            if job.manifest.get("version") == 2:
                self._render_source_batch(job, directory, output)
            else:
                self._render_single_pages(job, directory, output)

    def _render_single_pages(self, job, directory, output):
        for item in job.manifest["pages"]:
            if job.cancel.is_set():
                raise RenderError("cancelled", "Render cancelled", 409)
            stage = output / f"stage-{item['index']}"
            self.converter(self.settings.wpscli, directory / "input" / item["file"], stage,
                           job.manifest["dpi"], self.settings.render_timeout_seconds, job.cancel,
                           lambda: self._check_output(job, output), self.settings.process_memory_limit_bytes)
            self._check_output(job, output)
            files = [path for path in stage.rglob("*") if path.is_file() and path.suffix.lower() == ".png"]
            if len(files) != 1 or files[0].is_symlink():
                raise RenderError("invalid_output", "WPSCLI must produce exactly one PNG per submitted slide")
            path = files[0]
            info = self._inspect_png(item["index"], path)
            with self.lock:
                path.replace(output / f"{item['index']}.png")
                shutil.rmtree(stage)
                job.pages.append(info)
                job.updated_at = time.time()
                self._persist(job)

    def _render_source_batch(self, job, directory, output):
        pages = job.manifest["pages"]
        source = job.manifest["source"]
        if job.cancel.is_set():
            raise RenderError("cancelled", "Render cancelled", 409)
        stage = output / "stage-batch"
        slide_range = ",".join(str(item["slide"]) for item in pages)
        timeout = min(
            self.settings.max_batch_timeout_seconds,
            max(self.settings.render_timeout_seconds, self.settings.render_timeout_seconds * len(pages)),
        )
        self.converter(
            self.settings.wpscli, directory / "input" / source["file"], stage,
            job.manifest["dpi"], timeout, job.cancel,
            lambda: self._check_output(job, output), self.settings.process_memory_limit_bytes,
            slide_range,
        )
        self._check_output(job, output)
        files = sorted(
            (path for path in stage.rglob("*") if path.is_file() and path.suffix.lower() == ".png"),
            key=_natural_path_key,
        )
        if len(files) != len(pages) or any(path.is_symlink() for path in files):
            raise RenderError("invalid_output", "WPSCLI output count does not match the requested slide range")
        inspected = [self._inspect_png(item["index"], path) for item, path in zip(pages, files)]
        with self.lock:
            for item, path, info in zip(pages, files, inspected):
                path.replace(output / f"{item['index']}.png")
                job.pages.append(info)
            shutil.rmtree(stage)
            job.updated_at = time.time()
            self._persist(job)

    def _inspect_png(self, index, path):
        if path.stat().st_size > self.settings.max_output_bytes:
            raise RenderError("output_too_large", "Rendered PNG exceeds configured output limit")
        with Image.open(path) as image:
            width, height = image.size
            if image.format != "PNG" or width <= 0 or height <= 0 or width * height > self.settings.max_pixels:
                raise RenderError("invalid_output", "Invalid PNG format or dimensions")
            image.verify()
        with Image.open(path) as image:
            image.load()
        return {"index": index, "sha256": digest(path), "size": path.stat().st_size,
                "width": width, "height": height, "acknowledged": False}

    def _check_output(self, job, output):
        size = 0
        for path in output.rglob("*"):
            try:
                if path.is_file():
                    size += path.stat().st_size
            except FileNotFoundError:
                # ACK can delete an earlier page while the next page is being
                # rendered. Its disappearance releases space, not a render error.
                continue
        if size > self.settings.max_output_bytes:
            raise RenderError("output_too_large", "WPS output exceeded the job disk limit")
        free = shutil.disk_usage(self.storage.root)
        if free.free < max(self.settings.min_free_bytes, free.total * self.settings.min_free_ratio):
            raise RenderError("disk_pressure", "Renderer free disk is below its safety reserve", 507)

    def cleanup(self):
        with self.lock:
            for job_id, job in list(self.jobs.items()):
                if job.state in TERMINAL and not job.readers and time.time() - job.updated_at > self.settings.retention_seconds:
                    try:
                        if hasattr(self.fonts, "recover"):
                            self.fonts.recover(self.storage.directory(job_id) / "input" / "fonts")
                        self.storage.remove(job_id)
                    except OSError:
                        LOG.exception("Deferred retention cleanup for job %s", job_id)
                    else:
                        self.jobs.pop(job_id)
                        self.keys.pop(job.key, None)

    def _clean_loop(self):
        while not self.stop.wait(15):
            try:
                self.cleanup()
            except Exception:
                LOG.exception("Renderer cleanup failed")

    def close(self, timeout=None):
        with self.lock:
            if self._closed:
                return
        self.stop.set()
        with self.lock:
            for job in self.jobs.values():
                job.cancel.set()
        deadline = time.monotonic() + (self.settings.max_batch_timeout_seconds + 20 if timeout is None else timeout)
        self.worker.join(timeout=max(0, deadline - time.monotonic()))
        self.cleaner.join(timeout=max(0, deadline - time.monotonic()))
        with self.changed:
            while self.accepting or self.uploads or any(job.readers for job in self.jobs.values()):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.changed.wait(timeout=remaining)
            if (self.worker.is_alive() or self.cleaner.is_alive() or self.accepting or self.uploads
                    or any(job.readers for job in self.jobs.values())):
                # Do not let another process acquire the data/font lane while an
                # old worker, validator or HTTP reader can still touch it.
                raise RuntimeError("Renderer shutdown timed out; single-instance lock is retained until process exit")
            for job in self.jobs.values():
                if job.state not in TERMINAL:
                    job.state, job.updated_at = "cancelled", time.time()
                    self._drop_payload(job)
                    self._persist(job)
        self.storage.close()
        self._closed = True
