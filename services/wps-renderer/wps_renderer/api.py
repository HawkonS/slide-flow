import asyncio
import hashlib
import hmac
import json
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .errors import RenderError
from .jobs import JobManager
from .transport import OwnedStreamingResponse, finish_thread
from .validation import HASH

IDEMPOTENCY = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


def create_app(settings, manager_factory=JobManager):
    @asynccontextmanager
    async def lifespan(app):
        app.state.manager = manager_factory(settings)
        try:
            yield
        finally:
            await finish_thread(app.state.manager.close)

    app = FastAPI(title="WPS Renderer", version="1.0.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def authenticate(request, call_next):
        actual = request.headers.get("authorization", "")
        expected = "Bearer " + settings.token
        if not hmac.compare_digest(actual.encode(), expected.encode()):
            return JSONResponse({"error": {"code": "unauthorized", "message": "Authentication required"}}, status_code=401)
        length = request.headers.get("content-length")
        if length:
            try:
                if int(length) < 0 or int(length) > settings.max_upload_bytes:
                    raise ValueError()
            except ValueError:
                return JSONResponse({"error": {"code": "body_too_large", "message": "Invalid or oversized request body"}}, status_code=413)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(RenderError)
    async def render_error(request, exc):
        headers = {"Retry-After": "5"} if exc.status in {429, 503, 507} else {}
        return JSONResponse({"error": exc.public()}, status_code=exc.status, headers=headers)

    def manager(request):
        return request.app.state.manager

    async def read_small_json(request, limit=64 * 1024):
        content = bytearray()
        async def consume():
            async for block in request.stream():
                content.extend(block)
                if len(content) > limit:
                    raise RenderError("body_too_large", "JSON body is too large", 413)
        try:
            await asyncio.wait_for(consume(), timeout=15)
            return json.loads(content)
        except asyncio.TimeoutError as exc:
            raise RenderError("upload_timeout", "Request upload timed out", 408) from exc
        except (ValueError, UnicodeDecodeError) as exc:
            raise RenderError("invalid_json", "Invalid JSON request") from exc

    @app.get("/v1/health")
    async def health(request: Request):
        service = manager(request)
        with service.lock:
            counts = service.activity_counts()
            draining = service.draining
        if not service.worker.is_alive():
            raise RenderError("worker_unavailable", "Conversion worker is not running; restart the renderer", 503)
        return {"version": 1, "status": "draining" if draining else "ok", **counts,
                "max_pages": settings.max_pages, "max_upload_bytes": settings.max_upload_bytes,
                "max_input_file_bytes": settings.max_input_file_bytes,
                "max_dpi": settings.max_dpi}

    @app.post("/v1/admin/drain")
    async def drain(request: Request):
        """Stop admitting new jobs while allowing accepted jobs to finish.

        The endpoint is intentionally idempotent so an upgrade script can retry
        a transient request without changing the service state. Authentication
        is provided by the application middleware; this route must never be
        exposed without the renderer bearer token.
        """
        return manager(request).begin_drain()

    @app.post("/v1/admin/resume")
    async def resume(request: Request):
        """Resume admission after maintenance or a failed upgrade attempt."""
        return manager(request).resume()

    @app.post("/v1/fonts/check")
    async def check_fonts(request: Request):
        data = await read_small_json(request)
        if not isinstance(data, dict):
            raise RenderError("invalid_fonts", "JSON object required")
        names, fonts = data.get("names", []), data.get("fonts", [])
        def valid_names(values):
            return isinstance(values, list) and len(values) <= 128 and all(isinstance(n, str) and 0 < len(n.strip()) <= 256 for n in values)
        if not valid_names(names) or not isinstance(fonts, list) or len(fonts) > 64:
            raise RenderError("invalid_fonts", "Invalid font manifest")
        seen_hashes = set()
        for entry in fonts:
            if (not isinstance(entry, dict) or not isinstance(entry.get("sha256"), str)
                    or not HASH.fullmatch(entry["sha256"]) or not valid_names(entry.get("names"))
                    or not valid_names(entry.get("faces", []))):
                raise RenderError("invalid_fonts", "Invalid font manifest")
            if entry["sha256"] in seen_hashes:
                raise RenderError("invalid_fonts", "Duplicate font SHA-256 entries are not accepted")
            seen_hashes.add(entry["sha256"])
        return await finish_thread(manager(request).fonts.check, names, fonts)

    @app.post("/v1/jobs")
    async def submit(request: Request):
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() not in {"application/zip", "application/octet-stream"}:
            raise RenderError("unsupported_media_type", "Send a raw application/zip bundle", 415)
        key = request.headers.get("idempotency-key", "")
        if not IDEMPOTENCY.fullmatch(key):
            raise RenderError("invalid_idempotency_key", "Idempotency-Key must be 16–128 URL-safe characters", 400)
        service = manager(request)
        def abandon_admission(result):
            admitted, created = result
            if created:
                service.upload_failed(admitted)
        job, is_new = await finish_thread(service.admit, key, on_cancel=abandon_admission)
        if not is_new:
            # The caller can query/reuse an accepted key without resending its body.
            # Digest header permits explicit detection of accidental key reuse.
            sha = request.headers.get("x-content-sha256")
            if sha and job.bundle_sha256 and sha != job.bundle_sha256:
                raise RenderError("idempotency_conflict", "Idempotency key was used with different bytes", 409)
            if job.state == "uploading":
                raise RenderError("upload_in_progress", "An upload with this key is already in progress", 409)
            if job.cancel.is_set() or job.deleted:
                raise RenderError("cancelled", "This idempotency key was cancelled", 409)
            return JSONResponse(job.public(), status_code=200)
        path = service.storage.directory(job.id) / "bundle.zip"
        sha, size = hashlib.sha256(), 0
        async def receive():
            nonlocal size
            with open(path, "xb") as output:
                async for block in request.stream():
                    if job.cancel.is_set():
                        raise RenderError("cancelled", "Upload cancelled", 409)
                    size += len(block)
                    if size > settings.max_upload_bytes:
                        raise RenderError("body_too_large", "Upload exceeds size limit", 413)
                    sha.update(block)
                    output.write(block)
        try:
            await asyncio.wait_for(receive(), timeout=settings.upload_timeout_seconds)
            expected_sha = request.headers.get("x-content-sha256")
            if expected_sha and (not HASH.fullmatch(expected_sha) or not hmac.compare_digest(expected_sha, sha.hexdigest())):
                raise RenderError("checksum_mismatch", "Upload checksum mismatch")
            # Shield validation so a disconnected caller cannot race cleanup with
            # the thread extracting files. Accepted jobs expire if nobody returns.
            await finish_thread(service.accept, job, sha.hexdigest())
        except asyncio.TimeoutError as exc:
            await finish_thread(service.upload_failed, job)
            raise RenderError("upload_timeout", "Upload timed out", 408) from exc
        except BaseException:
            if job.state == "uploading":
                await finish_thread(service.upload_failed, job)
            raise
        return JSONResponse(job.public(), status_code=202)

    @app.get("/v1/jobs/by-key/{key}")
    async def status_by_key(key: str, request: Request):
        if not IDEMPOTENCY.fullmatch(key):
            raise RenderError("invalid_idempotency_key", "Invalid idempotency key", 400)
        service = manager(request)
        with service.lock:
            job = service.get_by_key(key)
            expected = request.headers.get("x-content-sha256")
            if expected and (not HASH.fullmatch(expected) or (job.bundle_sha256 and expected != job.bundle_sha256)):
                raise RenderError("idempotency_conflict", "Idempotency key was used with different bytes", 409)
            return job.public()

    @app.delete("/v1/jobs/by-key/{key}", status_code=204)
    async def cancel_by_key(key: str, request: Request):
        if not IDEMPOTENCY.fullmatch(key):
            raise RenderError("invalid_idempotency_key", "Invalid idempotency key", 400)
        await finish_thread(manager(request).cancel_by_key, key)

    @app.get("/v1/jobs/{job_id}")
    async def status(job_id: str, request: Request):
        service = manager(request)
        with service.lock:
            return service.get(job_id).public()

    @app.delete("/v1/jobs/{job_id}")
    async def cancel(job_id: str, request: Request):
        return await finish_thread(manager(request).cancel, job_id)

    @app.get("/v1/jobs/{job_id}/pages/{index}")
    async def page(job_id: str, index: int, request: Request):
        chunks, info, release = manager(request).page_stream(job_id, index)
        return OwnedStreamingResponse(chunks, media_type="image/png", headers={"Content-Length": str(info["size"]),
                                  "ETag": '"' + info["sha256"] + '"', "X-Content-SHA256": info["sha256"]},
                                     release=release, timeout_seconds=settings.download_timeout_seconds)

    @app.delete("/v1/jobs/{job_id}/pages/{index}", status_code=204)
    async def acknowledge(job_id: str, index: int, request: Request):
        await finish_thread(manager(request).acknowledge, job_id, index, request.headers.get("if-match"))

    return app
