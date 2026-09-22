"""Bounded, authenticated WPS job client. No local rendering fallback."""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import ssl
import shutil
import threading
import time
import uuid
import zipfile
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from app.config import settings
from app.services.resource_import.remote_fonts import sha256_file
from app.services.resource_import.validation import _validate_import_image

JOB_ID = re.compile(r"^[0-9a-f]{32}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
# Input PPTX/font files and rendered PNGs have different limits.  The old
# code reused the output limit for inputs, which rejected otherwise valid
# split slides (large embedded images are common in PPTX files).
MAX_INPUT_FILE_BYTES = 120 * 1024 * 1024
MAX_OUTPUT_IMAGE_BYTES = 64 * 1024 * 1024
MAX_BUNDLE_BYTES = 128 * 1024 * 1024
MAX_METADATA_BYTES = 256 * 1024
DISK_RESERVE_BYTES = 256 * 1024 * 1024
# One renderer instance owns one HTTP client for the lifetime of a render
# batch.  The client is intentionally *not* a process-global singleton: this
# gives every import an explicit lifetime and prevents a cancelled request in
# one session from keeping another session's files/credentials alive.  Within
# that lifetime httpx reuses a bounded keep-alive pool, so polling, downloads,
# ACKs and cleanup do not perform a fresh TCP/TLS handshake for every request.
# The limits also protect a low-resource Windows relay from connection bursts
# when several Ubuntu workers render concurrently.
HTTP_MAX_CONNECTIONS = 2
HTTP_MAX_KEEPALIVE_CONNECTIONS = 1
HTTP_KEEPALIVE_EXPIRY = 20.0
# Sync transport cancellation is cooperative; cap each socket wait as well as
# checking every chunk, so an idle remote cannot hide cancellation for 300 s.
MAX_IO_WAIT = 5.0
RETRY_STATUSES = {408, 429, 502, 503, 504, 507}
JOB_STATUSES = {"uploading", "queued", "running", "completed", "failed", "cancelled"}


class RenderCancelled(RuntimeError):
    pass


class TransientRenderError(RuntimeError):
    """A bounded retry was exhausted; remote TTL remains a cleanup backstop."""


def renderer_connection():
    try:
        url = settings.render_url.rstrip("/")
        if any(ord(char) < 33 for char in url):
            raise ValueError("Invalid URL whitespace")
        parsed = urlsplit(url)
        parsed.port  # Validate malformed/out-of-range ports before HTTPX does.
    except (AttributeError, ValueError):
        raise RuntimeError("请配置有效的 render.url（仅协议、主机和端口）") from None
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise RuntimeError("请配置有效的 render.url（仅协议、主机和端口）")
    try:
        loopback = ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        loopback = parsed.hostname == "localhost"
    if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
        raise RuntimeError("渲染服务必须使用 HTTPS（内网 IP 也必须配置 IP-SAN 证书）；HTTP 仅用于本机 SSH 隧道")
    if not isinstance(settings.render_token, str) or not re.fullmatch(r"[!-~]{32,1024}", settings.render_token):
        raise RuntimeError("请配置至少 32 位随机 render.token / SLIDE_FLOW_RENDER_TOKEN")
    for value, lower, upper, name in (
        (settings.render_batch_size, 1, 4, "batch_size"),
        (settings.render_dpi, 72, 300, "dpi"),
        (settings.render_retries, 0, 5, "retries"),
        (settings.render_connect_timeout, 1, 60, "connect_timeout"),
        (settings.render_read_timeout, 1, 300, "read_timeout"),
        (settings.render_total_timeout, 10, 7200, "total_timeout"),
    ):
        if type(value) is not int or not lower <= value <= upper:
            raise RuntimeError(f"render.{name} 应在 {lower}–{upper} 范围内")
    try:
        verify = ssl.create_default_context(cafile=settings.render_ca_file or None)
    except (OSError, ssl.SSLError) as exc:
        raise RuntimeError("渲染服务 CA 配置无效") from exc
    return url, verify


def _json_object(response):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result
    try:
        result = json.loads(response.content, object_pairs_hook=pairs,
                            parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid JSON number")))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise RuntimeError("渲染服务返回无效 JSON 响应") from exc
    if not isinstance(result, dict):
        raise RuntimeError("渲染服务返回的 JSON 必须是对象")
    return result


def _page_metadata(page):
    if not isinstance(page, dict):
        raise RuntimeError("渲染服务返回无效图片信息")
    index, size, sha = page.get("index"), page.get("size"), page.get("sha256")
    if (type(index) is not int or not 0 <= index <= 100000 or type(size) is not int
            or not 0 < size <= MAX_OUTPUT_IMAGE_BYTES or not isinstance(sha, str) or not SHA256.fullmatch(sha)):
        raise RuntimeError("渲染服务返回无效图片信息")
    if "acknowledged" in page and type(page["acknowledged"]) is not bool:
        raise RuntimeError("渲染服务返回无效图片确认状态")
    return index, size, sha


def _font_names(names):
    return isinstance(names, list) and len(names) <= 128 and all(
        isinstance(name, str) and 0 < len(name.strip()) <= 256
        and not any(ord(char) < 32 for char in name) for name in names
    )


def _unique_font_names(names):
    if not _font_names(names):
        return False
    normalized = [" ".join(name.lstrip("@").split()).casefold() for name in names]
    return len(normalized) == len(set(normalized))


def _safe_error(response):
    try:
        payload = _json_object(response)
        error = payload.get("error", {})
        code = error.get("code", "remote_error")
    except (RuntimeError, ValueError, AttributeError):
        code = "remote_error"
    messages = {
        "font_conflict": "Windows 与标准字体库存在同名字体版本冲突，请统一字体文件后重试",
        "fonts_missing": "Windows 缺少所需字体，且字体同步未成功",
        "font_install_failed": "Windows 临时字体注册失败",
        "unauthorized": "渲染服务鉴权失败，请检查服务密钥",
        "queue_full": "Windows 渲染队列已满，请稍后重试",
        "disk_pressure": "Windows 可用磁盘不足，清理完成后可重试",
        "worker_restarted": "Windows 渲染服务已重启，请重新渲染",
        "wps_sign_in_required": "Windows WPS 尚未登录，请在渲染服务器登录后重试",
        "wps_license_required": "Windows WPS 账号没有此转换权限",
        "render_timeout": "Windows WPS 转图超时，可重试或减少每批页数",
        "wps_quota_exceeded": "WPS 转换配额或频率受限，请检查 Windows 账号，不会自动重复扣费重试",
        "unsafe_pptx": "PPT 含外部链接、宏、ActiveX 或嵌入 Office/OLE 对象，请在 Office/WPS 中移除活动内容后重试",
        "invalid_pptx": "拆分后的 PPTX 结构不完整或不安全，请检查源文件",
        "file_too_large": "单页 PPT 超过 120 MiB 或字体超过 64 MiB 输入上限，请精简对应文件后重试",
        "invalid_font": "标准字体文件无法被 Windows 服务解析，请重新上传有效字体",
    }
    # Even a syntactically valid unknown code is untrusted and could echo a
    # credential or host path. Only disclose the known public message catalog.
    return messages.get(code if isinstance(code, str) else "", f"Windows 转图失败（HTTP {response.status_code}）")


class RemoteRenderer:
    def __init__(self, cancel: threading.Event, on_progress):
        url, verify = renderer_connection()
        self.cancel = cancel
        self.progress = on_progress
        self.deadline = time.monotonic() + settings.render_total_timeout
        self.retries = settings.render_retries
        self.batch_size = settings.render_batch_size
        self.dpi = settings.render_dpi
        self.read_timeout = settings.render_read_timeout
        self.connect_timeout = settings.render_connect_timeout
        # This is a bounded, task-scoped persistent connection pool rather
        # than one new socket per request.  The Windows service keeps its
        # listener alive across jobs; when an idle socket expires or the
        # service restarts, httpx drops the broken pooled connection and the
        # request retry path below opens a fresh one.  Keepalive expiry is
        # shorter than the relay's server-side idle timeout to avoid reusing a
        # socket the server has already closed.
        self.client = httpx.Client(
            base_url=url,
            verify=verify,
            trust_env=False,
            follow_redirects=False,
            headers={"Authorization": "Bearer " + settings.render_token,
                     "Accept-Encoding": "identity"},
            limits=httpx.Limits(
                max_connections=HTTP_MAX_CONNECTIONS,
                max_keepalive_connections=HTTP_MAX_KEEPALIVE_CONNECTIONS,
                keepalive_expiry=HTTP_KEEPALIVE_EXPIRY,
            ),
            timeout=httpx.Timeout(
                settings.render_read_timeout,
                connect=settings.render_connect_timeout,
            ),
        )

    def check(self):
        if self.cancel.is_set():
            raise RenderCancelled("渲染已取消，字体替换结果已保留")
        if time.monotonic() >= self.deadline:
            raise RuntimeError("渲染总时间超过限制，请减少页数或稍后重试")

    def pause(self, seconds):
        self.cancel.wait(min(seconds, max(0, self.deadline - time.monotonic())))
        self.check()

    def timeout(self):
        self.check()
        remaining = self.deadline - time.monotonic()
        return httpx.Timeout(min(self.read_timeout, remaining, MAX_IO_WAIT),
                             connect=min(self.connect_timeout, remaining, MAX_IO_WAIT))

    @staticmethod
    def _path(path):
        # Never send the shared bearer credential to an absolute URL, redirect,
        # user-controlled authority, or path escaping the versioned API.
        if not isinstance(path, str) or not re.fullmatch(r"/v1/[A-Za-z0-9_/-]+", path):
            raise RuntimeError("渲染服务请求路径无效")

    @staticmethod
    def _retry_delay(response, attempt):
        delay = min(2 ** (attempt + 1), 8)
        hint = response.headers.get("retry-after", "")
        try:
            requested = int(hint) if hint.isdigit() else parsedate_to_datetime(hint).timestamp() - time.time()
            return max(delay, requested)
        except (ValueError, TypeError, OverflowError):
            return delay

    def request(self, method, path, *, bundle=None, **kwargs):
        self._path(path)
        for attempt in range(self.retries + 1):
            self.check()
            retry_delay = min(2 ** (attempt + 1), 8)
            try:
                if bundle is not None:
                    with bundle.open("rb") as content:
                        def chunks():
                            for block in iter(lambda: content.read(256 * 1024), b""):
                                self.check()
                                yield block
                        response = self._small_response(method, path, content=chunks(), **kwargs)
                else:
                    response = self._small_response(method, path, **kwargs)
                if response.status_code < 400:
                    if response.is_redirect:
                        raise RuntimeError("渲染服务不允许重定向")
                    return response
                retryable = response.status_code in RETRY_STATUSES
                if response.status_code == 409:
                    try:
                        payload = _json_object(response)
                        error = payload.get("error")
                        retryable = isinstance(error, dict) and error.get("code") == "upload_in_progress"
                    except (RuntimeError, ValueError, AttributeError):
                        pass
                message = _safe_error(response)
                if retryable and attempt == self.retries:
                    raise TransientRenderError(message)
                if not retryable:
                    raise RuntimeError(message)
                retry_delay = self._retry_delay(response, attempt)
            except httpx.TransportError as exc:
                # Acceptance may have succeeded although its response was lost.
                # Recover by key without uploading the archive again. This also
                # makes the accepted ID available for cancellation/cleanup.
                headers = kwargs.get("headers", {})
                key = headers.get("Idempotency-Key") or headers.get("idempotency-key")
                if bundle is not None and path == "/v1/jobs" and isinstance(key, str) and JOB_ID.fullmatch(key):
                    try:
                        content_sha = headers.get("X-Content-SHA256") or headers.get("x-content-sha256")
                        if not isinstance(content_sha, str) or not SHA256.fullmatch(content_sha):
                            raise RuntimeError("上传校验信息无效")
                        recovered = self._small_response("GET", f"/v1/jobs/by-key/{key}",
                            headers={"X-Content-SHA256": content_sha})
                        if recovered.status_code == 200:
                            return recovered
                        if recovered.status_code in {401, 403, 409}:
                            raise RuntimeError(_safe_error(recovered))
                    except httpx.TransportError:
                        pass
                if attempt == self.retries:
                    raise TransientRenderError("无法连接 Windows 渲染服务或传输中断，请检查地址/隧道后重试") from exc
            self.progress("渲染服务暂时繁忙或网络中断，正在安全重试")
            self.pause(retry_delay)
        raise RuntimeError("渲染服务不可用")

    def _small_response(self, method, path, **kwargs):
        """Bound metadata bodies too, not just uploaded/downloaded artifacts."""
        with self.client.stream(method, path, timeout=self.timeout(), **kwargs) as response:
            if response.headers.get("content-encoding", "identity").lower() != "identity":
                raise RuntimeError("渲染服务元数据不允许传输压缩编码")
            length = response.headers.get("content-length")
            if length is not None and (not length.isdigit() or int(length) > MAX_METADATA_BYTES):
                raise RuntimeError("渲染服务元数据响应过大或长度无效")
            body = bytearray()
            # No re-chunking: buffering 8 KiB can hide deadline/cancel checks
            # indefinitely when a peer trickles a byte before each read timeout.
            for chunk in response.iter_bytes():
                self.check()
                body.extend(chunk)
                if len(body) > MAX_METADATA_BYTES:
                    raise RuntimeError("渲染服务元数据响应过大")
            self.check()
            headers = {k:v for k,v in response.headers.items() if k.lower() not in {"content-encoding", "content-length", "transfer-encoding"}}
            return httpx.Response(response.status_code, headers=headers, content=bytes(body))

    def download(self, job_id, page, target):
        if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
            raise RuntimeError("渲染服务返回无效任务 ID")
        index, size, sha = _page_metadata(page)
        partial = target.with_name(target.stem + ".part.png")
        if target.is_symlink() or partial.is_symlink():
            raise RuntimeError("高清图目标路径无效")
        if shutil.disk_usage(target.parent).free < size + DISK_RESERVE_BYTES:
            raise RuntimeError("主服务器临时空间不足，未开始下载高清图")
        try:
            for attempt in range(self.retries + 1):
                self.check()
                delay = min(2 ** (attempt + 1), 8)
                try:
                    with self.client.stream("GET", f"/v1/jobs/{job_id}/pages/{index}", timeout=self.timeout()) as response:
                        if response.status_code in RETRY_STATUSES:
                            delay = self._retry_delay(response, attempt)
                            raise TransientRenderError("Windows 高清图暂不可读，请稍后重试")
                        if response.status_code != 200 or response.headers.get("content-type", "").split(";")[0].strip().lower() != "image/png":
                            raise RuntimeError("无法读取 Windows 生成的 PNG")
                        length = response.headers.get("content-length")
                        if length is not None and (not length.isdigit() or int(length) != size):
                            raise RuntimeError("远端图片体积不符，已停止下载")
                        if response.headers.get("content-encoding", "identity").lower() != "identity":
                            raise RuntimeError("远端图片不允许传输压缩编码")
                        header_sha = response.headers.get("x-content-sha256")
                        if header_sha is not None and header_sha != sha:
                            raise RuntimeError("远端图片校验信息不一致")
                        digest, written = hashlib.sha256(), 0
                        with partial.open("wb") as output:
                            for block in response.iter_bytes():
                                self.check()
                                written += len(block)
                                if written > size:
                                    raise RuntimeError("远端图片体积不符，已停止下载")
                                output.write(block)
                                digest.update(block)
                            output.flush()
                            os.fsync(output.fileno())
                    if written != size or digest.hexdigest() != sha:
                        raise RuntimeError("远端图片校验失败，请重试")
                    _validate_import_image(partial)
                    self.check()
                    partial.replace(target)
                    return
                except (httpx.TransportError, TransientRenderError) as exc:
                    partial.unlink(missing_ok=True)
                    if attempt == self.retries:
                        raise TransientRenderError("图片传输中断或服务暂忙，请重试") from exc
                    self.pause(delay)
        finally:
            partial.unlink(missing_ok=True)

    def _font_inventory(self, fonts, required_fonts):
        if not _unique_font_names(required_fonts) or not isinstance(fonts, list) or len(fonts) > 64:
            raise RuntimeError("字体清单无效")
        hashes, faces = set(), {}
        for font in fonts:
            if (not isinstance(font, dict) or not isinstance(font.get("sha256"), str)
                    or not SHA256.fullmatch(font["sha256"]) or font["sha256"] in hashes
                    or not _unique_font_names(font.get("names")) or not font["names"]
                    or not _unique_font_names(font.get("faces", []))):
                raise RuntimeError("字体清单含无效或重复字体")
            hashes.add(font["sha256"])
            for face in font.get("faces", []):
                normalized = " ".join(face.lstrip("@").split()).casefold()
                if normalized in faces and faces[normalized] != font["sha256"]:
                    raise RuntimeError("字体清单含同名但版本不同的字体")
                faces[normalized] = font["sha256"]
        payload = {
            "names": required_fonts,
            "fonts": [{"sha256": f["sha256"], "names": f["names"], "faces": f.get("faces", [])} for f in fonts],
        }
        if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > 64 * 1024:
            raise RuntimeError("字体核验清单超过 64 KB，请减少字体种类")
        check = _json_object(self.request("POST", "/v1/fonts/check", json=payload))
        statuses = check.get("fonts")
        if not isinstance(statuses, list) or len(statuses) != len(fonts):
            raise RuntimeError("Windows 字体核验响应不完整")
        installed, seen = set(), set()
        for item in statuses:
            if (not isinstance(item, dict) or not isinstance(item.get("sha256"), str)
                    or item["sha256"] not in hashes or item["sha256"] in seen
                    or type(item.get("conflict")) is not bool or type(item.get("installed")) is not bool):
                raise RuntimeError("Windows 字体核验响应无效")
            seen.add(item["sha256"])
            if item.get("conflict"):
                raise RuntimeError("Windows 与标准字体库存在同名字体版本冲突，请统一字体文件后重试")
            if item.get("installed") is True:
                installed.add(item["sha256"])
        declared_installed, declared_missing = check.get("installed", []), check.get("missing", [])
        if (not _unique_font_names(declared_installed) or not _unique_font_names(declared_missing)
                or set(" ".join(name.lstrip("@").split()).casefold() for name in declared_installed)
                & set(" ".join(name.lstrip("@").split()).casefold() for name in declared_missing)):
            raise RuntimeError("Windows 字体核验响应无效")
        required_set = {" ".join(name.lstrip("@").split()).casefold() for name in required_fonts}
        reported_set = {
            " ".join(name.lstrip("@").split()).casefold()
            for name in [*declared_installed, *declared_missing]
        }
        if required_set and reported_set != required_set:
            raise RuntimeError("Windows 字体核验响应缺少字体状态")
        missing_fonts = [f for f in fonts if f["sha256"] not in installed]
        self.progress(f"字体核验完成，需同步 {len(missing_fonts)} 个字体文件")
        return missing_fonts

    def _batches(self, pages, fonts):
        """Preflight all inputs and split by bytes as well as page count."""
        sizes = {}
        for index, raw_path in pages:
            path = Path(raw_path)
            self.check()
            if path.is_symlink() or not path.is_file():
                raise RuntimeError("渲染输入文件无效")
            size = path.stat().st_size
            if not 0 < size <= MAX_INPUT_FILE_BYTES:
                size_text = f"{size / (1024 * 1024):.1f} MiB" if size else "0 bytes"
                raise RuntimeError(
                    f"渲染输入文件为空或超过 {MAX_INPUT_FILE_BYTES // (1024 * 1024)} MiB："
                    f"第 {index + 1} 页 PPTX（{size_text}）"
                )
            sizes[path] = size
        for font in fonts:
            path = Path(font["path"])
            self.check()
            if path.is_symlink() or not path.is_file():
                raise RuntimeError("渲染输入文件无效")
            size = path.stat().st_size
            if not 0 < size <= MAX_INPUT_FILE_BYTES:
                size_text = f"{size / (1024 * 1024):.1f} MiB" if size else "0 bytes"
                names = font.get("names") or [path.name]
                raise RuntimeError(
                    f"渲染输入文件为空或超过 {MAX_INPUT_FILE_BYTES // (1024 * 1024)} MiB："
                    f"字体 {names[0]}（{size_text}）"
                )
            sizes[path] = size
        # Reserve ample space for manifest and ZIP entry headers. The bundle
        # writer checks the exact archive size too, before any POST is made.
        base = sum(sizes[Path(font["path"])] for font in fonts) + MAX_METADATA_BYTES
        result, batch, total, seen = [], [], base, set()
        for index, path in pages:
            if type(index) is not int or not 0 <= index <= 100000 or index in seen:
                raise RuntimeError("待渲染页码重复或无效")
            seen.add(index)
            size = sizes[Path(path)]
            if base + size > MAX_BUNDLE_BYTES:
                raise RuntimeError("单页 PPT 和字体已超过渲染服务 128 MB 上限，请精简单页或减少字体种类")
            if batch and (len(batch) == self.batch_size or total + size > MAX_BUNDLE_BYTES):
                result.append((batch, total))
                batch, total = [], base
            batch.append((index, Path(path)))
            total += size
        if batch:
            result.append((batch, total))
        return result

    def _archive_input(self, archive, path, name, expected_sha=None):
        digest, size = hashlib.sha256(), 0
        with path.open("rb") as source, archive.open(name, "w") as output:
            for chunk in iter(lambda: source.read(256 * 1024), b""):
                self.check()
                size += len(chunk)
                if size > MAX_INPUT_FILE_BYTES or archive.fp.tell() + len(chunk) > MAX_BUNDLE_BYTES - MAX_METADATA_BYTES:
                    raise RuntimeError("渲染输入在打包期间增长或超过文件上限")
                output.write(chunk)
                digest.update(chunk)
        sha = digest.hexdigest()
        if not size or (expected_sha is not None and sha != expected_sha):
            raise RuntimeError("字体快照在打包期间发生变化，请重新渲染")
        return sha

    def _job_state(self, state, expected, job_id=None, received=None):
        if not isinstance(state, dict) or not isinstance(state.get("id"), str) or not JOB_ID.fullmatch(state["id"]):
            raise RuntimeError("渲染服务返回无效任务 ID")
        if job_id is not None and state["id"] != job_id:
            raise RuntimeError("渲染服务返回了其他任务的结果")
        if not isinstance(state.get("status"), str) or state["status"] not in JOB_STATUSES:
            raise RuntimeError("Windows 渲染任务状态无效")
        pages = state.get("pages")
        if not isinstance(pages, list) or len(pages) > len(expected):
            raise RuntimeError("渲染服务返回无效页列表")
        seen = set()
        for page in pages:
            index, size, sha = _page_metadata(page)
            if index not in expected or index in seen:
                raise RuntimeError("渲染服务返回了重复或错误的页码")
            seen.add(index)
            if received is not None and index in received and received[index] != (size, sha):
                raise RuntimeError("渲染服务已接收页的校验信息发生变化")
            if page.get("acknowledged") and (received is None or index not in received):
                raise RuntimeError("渲染服务图片已被确认但主服务器未接收")
        return state

    def _release(self, job_id, key, digest):
        # A separate tiny cleanup budget is intentional even after cancellation
        # or the render deadline. Never buffer a potentially unbounded body.
        path = f"/v1/jobs/{job_id}" if job_id else f"/v1/jobs/by-key/{key}"
        try:
            with self.client.stream("DELETE", path, timeout=2,
                                    headers={"X-Content-SHA256": digest}):
                pass
        except (httpx.HTTPError, RuntimeError):
            pass  # Authenticated server retention is the crash/disconnect backstop.

    def render(self, pages, fonts, required_fonts, directory, on_page):
        return self._render_impl(pages, directory, on_page, fonts, required_fonts, include_fonts=True)

    def render_pages(self, pages, directory, on_page):
        """Submit pages only; fonts are synchronized by the pull worker first."""
        return self._render_impl(pages, directory, on_page, [], [], include_fonts=False)

    def _render_impl(self, pages, directory, on_page, fonts, required_fonts, *, include_fonts):
        self.check()
        if not isinstance(pages, list) or not pages or len(pages) > 500:
            raise RuntimeError("待渲染页面清单无效")
        missing_fonts = self._font_inventory(fonts, required_fonts) if include_fonts else []
        batches = self._batches(pages, missing_fonts)
        completed = 0
        for batch, estimated_bytes in batches:
            self.check()
            manifest = {"version": 1, "dpi": self.dpi, "required_fonts": required_fonts if include_fonts else [],
                        "pages": [], "fonts": [], "font_hashes": [f["sha256"] for f in fonts] if include_fonts else []}
            if not include_fonts:
                manifest.pop("required_fonts")
                manifest.pop("fonts")
                manifest.pop("font_hashes")
            bundle = directory / f"batch-{completed}.zip"
            job_id, key, bundle_sha, submitted = None, uuid.uuid4().hex, "", False
            try:
                if shutil.disk_usage(directory).free < estimated_bytes + DISK_RESERVE_BYTES:
                    raise RuntimeError("主服务器临时空间不足，未开始生成上传包")
                with zipfile.ZipFile(bundle, "w", compression=zipfile.ZIP_STORED) as archive:
                    for index, path in batch:
                        name = f"pages/{index}.pptx"
                        sha = self._archive_input(archive, path, name)
                        manifest["pages"].append({"index": index, "file": name, "sha256": sha})
                    for font in missing_fonts:
                        name = f"fonts/{font['sha256']}{font['path'].suffix}"
                        manifest["fonts"].append({"file": name, "sha256": font["sha256"]})
                        self._archive_input(archive, font["path"], name, font["sha256"])
                    archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
                if bundle.stat().st_size > MAX_BUNDLE_BYTES:
                    raise RuntimeError("本批 PPT 和字体超过渲染服务 128 MB 上限，请减少 render.batch_size")
                bundle_sha = sha256_file(bundle, check=self.check)
                headers = {"Content-Type": "application/zip", "Idempotency-Key": key,
                           "X-Content-SHA256": bundle_sha, "Content-Length": str(bundle.stat().st_size)}
                submitted = True
                state = _json_object(self.request("POST", "/v1/jobs", bundle=bundle, headers=headers))
                job_id = state.get("id")
                if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
                    job_id = None
                    raise RuntimeError("渲染服务返回无效任务 ID")
                expected, received, previous = {i for i, _ in batch}, {}, None
                while True:
                    self.check()
                    self._job_state(state, expected, job_id, received)
                    status = state.get("status")
                    if status != previous:
                        self.progress("正在排队等待 Windows 渲染" if status in {"uploading", "queued"} else f"Windows 正在转换第 {completed + 1}–{completed + len(batch)} 页")
                        previous = status
                    for page in state["pages"]:
                        index = page["index"]
                        if index in received:
                            continue
                        target = directory / f"page_{index:04d}.png"
                        self.download(job_id, page, target)
                        on_page(index, target)
                        received[index] = (page["size"], page["sha256"])
                        try:
                            self.request("DELETE", f"/v1/jobs/{job_id}/pages/{index}", headers={"If-Match": '"' + page["sha256"] + '"'})
                        except TransientRenderError:
                            self.check()
                            self.progress("图片已校验接收，Windows 临时副本将在连接恢复或到期后回收")
                    if status == "completed":
                        if set(received) != expected:
                            raise RuntimeError("Windows 渲染结果缺页")
                        break
                    if status in {"failed", "cancelled"}:
                        synthetic = httpx.Response(400, json={"error": state.get("error") or {"code": "cancelled"}})
                        raise RuntimeError(_safe_error(synthetic))
                    if status not in {"uploading", "queued", "running"}:
                        raise RuntimeError("Windows 渲染任务状态无效")
                    self.pause(0.6)
                    state = _json_object(self.request("GET", f"/v1/jobs/{job_id}"))
                completed += len(batch)
            finally:
                try:
                    bundle.unlink(missing_ok=True)
                finally:
                    if submitted:
                        self._release(job_id, key, bundle_sha)

    def close(self):
        self.client.close()
