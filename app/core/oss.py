"""Alibaba Cloud OSS asset storage.

PPT and preview PNGs are persisted as OSS objects.  Local files are only used
as short-lived working files while an upload is being validated or while an
export is being assembled.
"""

from __future__ import annotations

from app.config import settings
from pathlib import Path
from typing import BinaryIO
import logging
import mimetypes
import os
import re
import tempfile
import threading
import time
import uuid
from urllib.parse import urlparse

try:  # Keep the application importable for local unit tests without OSS.
    import oss2
except ImportError:  # pragma: no cover - exercised only in minimal dev envs
    oss2 = None  # type: ignore[assignment]


OSS_REF_PREFIX = "oss://"
logger = logging.getLogger(__name__)


class StorageConfigurationError(RuntimeError):
    """Raised when the configured OSS backend cannot be used.

    This is deliberately distinct from transient OSS/network failures.  HTTP
    callers can turn it into a clear 503 response instead of exposing a bare
    500, while background jobs can still record the task as failed.
    """


class StorageUnavailableError(RuntimeError):
    """Raised when the configured OSS service cannot be reached temporarily.

    The original SDK exception is kept as ``__cause__`` for logs, while the
    exception itself contains only a safe, user-facing message.
    """


STORAGE_UNAVAILABLE_MESSAGE = "对象存储暂时不可用，请稍后重试；如持续失败，请联系管理员检查 OSS 网络"
INTERNAL_ENDPOINT_COOLDOWN_SECONDS = 60
# OSS service endpoints may have one bucket label (3-63 characters).
_INTERNAL_OSS_HOST_RE = re.compile(
    r"(?:[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.)?"
    r"oss-[a-z0-9]+(?:-[a-z0-9]+)*-internal\.aliyuncs\.com"
)


def is_oss_ref(value: str | None) -> bool:
    return bool(value and value.startswith(OSS_REF_PREFIX))


def oss_key(value: str) -> str:
    if not is_oss_ref(value):
        return value
    body = value[len(OSS_REF_PREFIX):]
    bucket, separator, key = body.partition("/")
    if not bucket or not separator or not key:
        raise ValueError(f"非法 OSS 对象引用: {value!r}")
    configured_bucket = settings.oss_bucket.strip()
    if configured_bucket and bucket != configured_bucket:
        raise ValueError("OSS 对象引用的 Bucket 与当前配置不一致")
    return key


def oss_ref(key: str) -> str:
    return f"{OSS_REF_PREFIX}{settings.oss_bucket}/{key.lstrip('/')}"


def _content_type(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _is_cname(endpoint: str) -> bool:
    host = urlparse(endpoint).hostname or endpoint.split("/", 1)[0]
    return not (host == "oss.aliyuncs.com" or host.endswith(".aliyuncs.com"))


def _is_internal_endpoint(endpoint: str) -> bool:
    if not endpoint:
        return False
    host = (urlparse(endpoint if "://" in endpoint else f"https://{endpoint}").hostname or "").lower()
    # A DNS root dot does not change the host; match the whole OSS hostname.
    return _INTERNAL_OSS_HOST_RE.fullmatch(host.removesuffix(".")) is not None


def public_asset_origin() -> str | None:
    """Return the exact browser origin used by generated OSS URLs for CSP."""
    endpoint = (settings.oss_public_endpoint or settings.oss_endpoint).strip()
    if not endpoint:
        return None
    parsed = urlparse(endpoint if "://" in endpoint else f"https://{endpoint}")
    if not parsed.hostname:
        return None
    port = f":{parsed.port}" if parsed.port else ""
    if not _is_cname(endpoint) and not settings.oss_bucket:
        return None
    host = parsed.hostname if _is_cname(endpoint) else f"{settings.oss_bucket}.{parsed.hostname}"
    return f"{parsed.scheme or 'https'}://{host}{port}"


class OSSStorage:
    """Small synchronous OSS facade used from FastAPI worker threads."""

    def __init__(self) -> None:
        self._bucket = None
        self._fallback_bucket = None
        self._public_bucket = None
        self._health_lock = threading.Lock()
        self._health_cache: dict[str, object] | None = None
        self._health_checked_monotonic = 0.0
        self._endpoint_lock = threading.Lock()
        self._internal_cooldown_endpoint: tuple[str, str] | None = None
        self._internal_cooldown_until = 0.0

    @property
    def enabled(self) -> bool:
        return settings.storage_backend.lower() == "oss"

    def configuration_error(self) -> str | None:
        """Return a user-actionable configuration error, if any.

        OSS remains mandatory whenever ``storage.backend=oss``.  This helper
        only validates configuration; it never silently switches to local
        storage and never performs a network request.
        """
        if not self.enabled:
            if settings.storage_backend.strip().lower() != "local":
                return "storage.backend 只能配置为 local 或 oss"
            return None
        if oss2 is None:
            return "OSS 存储未安装，请先安装 oss2 依赖"
        if not settings.oss_endpoint or not settings.oss_bucket:
            return "OSS 未配置完整，请填写 oss.endpoint 和 oss.bucket"
        public_endpoint = self._normalise_endpoint(settings.oss_public_endpoint)
        internal_endpoint = self._normalise_endpoint(settings.oss_internal_endpoint)
        external_endpoint = self._normalise_endpoint(settings.oss_endpoint)
        if _is_internal_endpoint(external_endpoint):
            return "oss.endpoint 必须是外网回退地址，不能填写 OSS 内网 Endpoint"
        if public_endpoint and _is_internal_endpoint(public_endpoint):
            return "oss.public_endpoint 不能使用 OSS 内网 Endpoint，请填写浏览器可访问的外网地址"
        if internal_endpoint and internal_endpoint == external_endpoint:
            return "oss.endpoint 必须是外网回退地址，不能与 oss.internal_endpoint 相同"
        if bool(settings.oss_access_key_id) != bool(settings.oss_access_key_secret):
            return "OSS AccessKey ID 和 Secret 必须同时配置"
        if not settings.oss_access_key_id and not os.getenv("ALIBABA_CLOUD_RAM_ROLE_NAME", "").strip():
            return (
                "OSS 未配置凭证，请设置 ALIBABA_CLOUD_ACCESS_KEY_ID/"
                "ALIBABA_CLOUD_ACCESS_KEY_SECRET，或设置 ALIBABA_CLOUD_RAM_ROLE_NAME"
            )
        return None

    def ensure_configured(self) -> None:
        """Fail fast for OSS uploads without changing the selected backend."""
        error = self.configuration_error()
        if error:
            raise StorageConfigurationError(error)

    def health_status(self) -> dict[str, object]:
        """Return a short-lived authenticated connectivity snapshot."""
        # Storage backend changes can be applied in-process by tests or config
        # reloads. Never serve an OSS result while local storage is selected.
        if not self.enabled:
            return self._probe_health()
        now = time.monotonic()
        with self._health_lock:
            if self._health_cache is not None and now - self._health_checked_monotonic < 10:
                return dict(self._health_cache)
            result = self._probe_health()
            self._health_cache = result
            self._health_checked_monotonic = now
            return dict(result)

    def _probe_health(self) -> dict[str, object]:
        if not self.enabled:
            if settings.storage_backend.strip().lower() == "local":
                return {
                    "status": "disabled",
                    "endpoint_type": None,
                    "message": "当前使用本地存储",
                    "checked_at": time.time(),
                }
            return {
                "status": "misconfigured",
                "endpoint_type": None,
                "message": self.configuration_error() or "storage.backend 配置无效",
                "checked_at": time.time(),
            }
        try:
            self.ensure_configured()
            # ``get_bucket_info`` is a metadata-only request and does not read
            # user content. It validates credentials, endpoint and bucket ACL.
            primary = self._require_bucket()
            endpoint_type: str | None = None

            def check_bucket(bucket):
                nonlocal endpoint_type
                bucket.get_bucket_info()
                endpoint_type = "internal" if bucket is primary and self._normalise_endpoint(settings.oss_internal_endpoint) else "external"

            self._with_endpoint_fallback("health check", check_bucket)
            return {
                "status": "connected",
                "endpoint_type": endpoint_type,
                "message": f"OSS 连接正常（{'内网' if endpoint_type == 'internal' else '外网'}）",
                "checked_at": time.time(),
            }
        except StorageConfigurationError as exc:
            return {"status": "misconfigured", "endpoint_type": None, "message": str(exc), "checked_at": time.time()}
        except Exception:
            logger.warning("OSS health check failed", exc_info=False)
            return {
                "status": "disconnected",
                "endpoint_type": None,
                "message": STORAGE_UNAVAILABLE_MESSAGE,
                "checked_at": time.time(),
            }

    def reset_health_cache(self) -> None:
        """Discard the cached snapshot after configuration changes or in tests."""
        with self._health_lock:
            self._health_cache = None
            self._health_checked_monotonic = 0.0

    def _require_bucket(self):
        if not self.enabled:
            raise StorageConfigurationError("当前未启用 OSS 存储，请检查 storage.backend")
        self.ensure_configured()
        if self._bucket is None:
            self._bucket = self._build_bucket(self._primary_endpoint())
        return self._bucket

    @staticmethod
    def _normalise_endpoint(endpoint: str) -> str:
        return endpoint.strip().rstrip("/")

    def _primary_endpoint(self) -> str:
        return self._normalise_endpoint(settings.oss_internal_endpoint or settings.oss_endpoint)

    def _fallback_endpoint(self) -> str | None:
        """Return the public service endpoint only when an internal endpoint is configured."""
        primary = self._primary_endpoint()
        external = self._normalise_endpoint(settings.oss_endpoint)
        if not external or external == primary:
            return None
        return external

    def _build_bucket(self, endpoint: str):
        auth = self._auth()
        return oss2.Bucket(
            auth,
            endpoint,
            settings.oss_bucket,
            is_cname=_is_cname(endpoint),
            connect_timeout=max(1, int(settings.oss_connect_timeout_seconds)),
        )

    def _fallback_bucket_or_none(self):
        endpoint = self._fallback_endpoint()
        if endpoint is None:
            return None
        if self._fallback_bucket is None:
            self._fallback_bucket = self._build_bucket(endpoint)
        return self._fallback_bucket

    def _internal_endpoint_is_cooling_down(self) -> bool:
        fallback = self._fallback_endpoint()
        if fallback is None:
            return False
        endpoints = (self._primary_endpoint(), fallback)
        now = time.monotonic()
        with self._endpoint_lock:
            if self._internal_cooldown_endpoint != endpoints:
                self._internal_cooldown_endpoint = None
                self._internal_cooldown_until = 0.0
            if now >= self._internal_cooldown_until:
                self._internal_cooldown_endpoint = None
                self._internal_cooldown_until = 0.0
                return False
            return self._internal_cooldown_endpoint == endpoints

    def _mark_internal_endpoint_unavailable(self) -> None:
        fallback = self._fallback_endpoint()
        if fallback is None:
            return
        with self._endpoint_lock:
            self._internal_cooldown_endpoint = (self._primary_endpoint(), fallback)
            self._internal_cooldown_until = time.monotonic() + INTERNAL_ENDPOINT_COOLDOWN_SECONDS

    @staticmethod
    def _is_retryable_endpoint_error(exc: Exception) -> bool:
        """Only retry connectivity and transient server failures on the other endpoint."""
        if oss2 is None:
            return False
        exceptions = oss2.exceptions
        if isinstance(exc, exceptions.RequestError):
            return True
        if isinstance(exc, exceptions.ServerError):
            status = getattr(exc, "status", 0) or 0
            return status >= 500
        return False

    def _with_endpoint_fallback(self, operation: str, action):
        primary = self._require_bucket()
        fallback = self._fallback_bucket_or_none()
        if fallback is not None and self._internal_endpoint_is_cooling_down():
            return action(fallback)
        try:
            return action(primary)
        except Exception as exc:
            if not self._is_retryable_endpoint_error(exc):
                raise
            if fallback is None:
                raise StorageUnavailableError(STORAGE_UNAVAILABLE_MESSAGE) from exc
            self._mark_internal_endpoint_unavailable()
            logger.warning(
                "OSS internal endpoint failed; retrying %s through external endpoint",
                operation,
                exc_info=False,
            )
            try:
                return action(fallback)
            except Exception as fallback_exc:
                if self._is_retryable_endpoint_error(fallback_exc):
                    raise StorageUnavailableError(STORAGE_UNAVAILABLE_MESSAGE) from fallback_exc
                raise

    @staticmethod
    def _auth():
        """Build static-key or ECS RAM-role credentials without logging secrets."""
        if settings.oss_access_key_id or settings.oss_access_key_secret:
            if not settings.oss_access_key_id or not settings.oss_access_key_secret:
                raise StorageConfigurationError("OSS AccessKey ID 和 Secret 必须同时配置")
            return oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
        role_name = os.getenv("ALIBABA_CLOUD_RAM_ROLE_NAME", "").strip()
        if role_name:
            try:
                from oss2.credentials import EcsRamRoleCredentialsProvider

                metadata_base = os.getenv(
                    "ALIBABA_CLOUD_ECS_METADATA_URL",
                    "http://100.100.100.200/latest/meta-data/ram/security-credentials",
                ).rstrip("/")
                provider = EcsRamRoleCredentialsProvider(f"{metadata_base}/{role_name}")
                return oss2.ProviderAuth(provider)
            except Exception as exc:
                raise StorageConfigurationError("无法初始化 ECS RAM Role OSS 凭证") from exc
        raise StorageConfigurationError(
            "OSS 未配置凭证，请设置 ALIBABA_CLOUD_ACCESS_KEY_ID/"
            "ALIBABA_CLOUD_ACCESS_KEY_SECRET，或设置 ALIBABA_CLOUD_RAM_ROLE_NAME"
        )

    def _public(self):
        bucket = self._require_bucket()
        endpoint = settings.oss_public_endpoint or settings.oss_endpoint
        internal = settings.oss_internal_endpoint or settings.oss_endpoint
        if self._normalise_endpoint(endpoint) == self._normalise_endpoint(internal):
            return bucket
        if self._public_bucket is None:
            self._public_bucket = self._build_bucket(self._normalise_endpoint(endpoint))
        return self._public_bucket

    @staticmethod
    def _normalise_prefix(value: str) -> str:
        """Normalise a configured Bucket directory without allowing dot segments."""
        value = (value or "").replace("\\", "/")
        parts = [part.strip() for part in value.strip("/").split("/") if part.strip()]
        if any(part in {".", ".."} for part in parts):
            raise ValueError("OSS Bucket 内目录不能包含 . 或 .. 路径段")
        return "/".join(parts)

    def key(self, category: str, suffix: str = "") -> str:
        # `oss.prefix` is the configurable directory inside the Bucket.  Keep
        # the category below it so PPT/PNG objects remain easy to manage.
        prefix = self._normalise_prefix(settings.oss_prefix)
        category = self._normalise_prefix(category)
        parts = [part for part in (prefix, category, uuid.uuid4().hex) if part]
        return "/".join(parts) + suffix

    def upload_file(self, source: Path, key: str, *, content_type: str | None = None) -> str:
        headers = {"Content-Type": content_type or _content_type(source)}
        self._with_endpoint_fallback(
            "file upload",
            lambda bucket: bucket.put_object_from_file(key, str(source), headers=headers),
        )
        return oss_ref(key)

    def upload_fileobj(self, source: BinaryIO, key: str, *, content_type: str | None = None) -> str:
        """Upload an already-open file object without making a durable local copy."""
        headers = {"Content-Type": content_type or "application/octet-stream"}
        try:
            initial_position = source.tell()
        except (AttributeError, OSError):
            initial_position = None

        def upload(bucket):
            if initial_position is not None:
                source.seek(initial_position)
            return bucket.put_object(key, source, headers=headers)

        self._with_endpoint_fallback("stream upload", upload)
        return oss_ref(key)

    def upload_bytes(self, content: bytes, key: str, *, content_type: str = "application/octet-stream") -> str:
        self._with_endpoint_fallback(
            "byte upload",
            lambda bucket: bucket.put_object(key, content, headers={"Content-Type": content_type}),
        )
        return oss_ref(key)

    def download_file(self, ref: str, destination: Path) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        key = oss_key(ref)

        def download(bucket):
            destination.unlink(missing_ok=True)
            return bucket.get_object_to_file(key, str(destination))

        self._with_endpoint_fallback("file download", download)
        return destination

    def delete(self, ref: str | None) -> None:
        if not ref or not is_oss_ref(ref):
            return
        key = oss_key(ref)
        self._with_endpoint_fallback("object deletion", lambda bucket: bucket.delete_object(key))

    def signed_url(self, ref: str, *, process: str | None = None, filename: str | None = None, download: bool = False) -> str:
        bucket = self._public()
        params = {"x-oss-process": process} if process else {}
        if filename:
            disposition = "attachment" if download else "inline"
            params["response-content-disposition"] = f'{disposition}; filename="{filename}"'
        return bucket.sign_url(
            "GET",
            oss_key(ref),
            max(60, int(settings.oss_url_expire_seconds)),
            params=params,
            slash_safe=True,
        )

    def signed_put_url(
        self, ref: str, *, expires_seconds: int | None = None,
        content_type: str = "application/octet-stream",
    ) -> str:
        """Return a short-lived public PUT URL for a preselected object key.

        The Windows worker receives only this capability URL. It never gets
        the OSS AccessKey and cannot choose a different bucket/object key.
        """
        bucket = self._public()
        return bucket.sign_url(
            "PUT",
            oss_key(ref),
            max(60, int(expires_seconds or settings.oss_url_expire_seconds)),
            headers={"Content-Type": content_type},
            slash_safe=True,
        )

    def materialize(self, ref: str, suffix: str = "") -> Path:
        """Download an OSS object to a disposable temp file for server-side work."""
        suffix = suffix or Path(oss_key(ref)).suffix
        fd, name = tempfile.mkstemp(prefix="slide-flow-oss-", suffix=suffix)
        os.close(fd)
        target = Path(name)
        try:
            self.download_file(ref, target)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return target


storage = OSSStorage()


def asset_url(ref: str | None, *, process: str | None = None, filename: str | None = None) -> str | None:
    if not ref:
        return None
    if is_oss_ref(ref):
        return storage.signed_url(ref, process=process, filename=filename)
    return None
