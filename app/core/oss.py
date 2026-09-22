"""Alibaba Cloud OSS asset storage.

PPT and preview PNGs are persisted as OSS objects.  Local files are only used
as short-lived working files while an upload is being validated or while an
export is being assembled.
"""

from __future__ import annotations

from app.config import settings
from pathlib import Path
from typing import BinaryIO
import mimetypes
import os
import tempfile
import uuid
from urllib.parse import urlparse

try:  # Keep the application importable for local unit tests without OSS.
    import oss2
except ImportError:  # pragma: no cover - exercised only in minimal dev envs
    oss2 = None  # type: ignore[assignment]


OSS_REF_PREFIX = "oss://"


class StorageConfigurationError(RuntimeError):
    """Raised when the configured OSS backend cannot be used.

    This is deliberately distinct from transient OSS/network failures.  HTTP
    callers can turn it into a clear 503 response instead of exposing a bare
    500, while background jobs can still record the task as failed.
    """


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
        self._public_bucket = None

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

    def _require_bucket(self):
        if not self.enabled:
            raise StorageConfigurationError("当前未启用 OSS 存储，请检查 storage.backend")
        self.ensure_configured()
        if self._bucket is None:
            auth = self._auth()
            endpoint = settings.oss_internal_endpoint or settings.oss_endpoint
            self._bucket = oss2.Bucket(auth, endpoint, settings.oss_bucket, is_cname=_is_cname(endpoint))
        return self._bucket

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
        if endpoint == internal:
            return bucket
        if self._public_bucket is None:
            auth = self._auth()
            self._public_bucket = oss2.Bucket(auth, endpoint, settings.oss_bucket, is_cname=_is_cname(endpoint))
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
        bucket = self._require_bucket()
        headers = {"Content-Type": content_type or _content_type(source)}
        bucket.put_object_from_file(key, str(source), headers=headers)
        return oss_ref(key)

    def upload_fileobj(self, source: BinaryIO, key: str, *, content_type: str | None = None) -> str:
        """Upload an already-open file object without making a durable local copy."""
        bucket = self._require_bucket()
        headers = {"Content-Type": content_type or "application/octet-stream"}
        bucket.put_object(key, source, headers=headers)
        return oss_ref(key)

    def upload_bytes(self, content: bytes, key: str, *, content_type: str = "application/octet-stream") -> str:
        bucket = self._require_bucket()
        bucket.put_object(key, content, headers={"Content-Type": content_type})
        return oss_ref(key)

    def download_file(self, ref: str, destination: Path) -> Path:
        bucket = self._require_bucket()
        destination.parent.mkdir(parents=True, exist_ok=True)
        bucket.get_object_to_file(oss_key(ref), str(destination))
        return destination

    def delete(self, ref: str | None) -> None:
        if not ref or not is_oss_ref(ref):
            return
        self._require_bucket().delete_object(oss_key(ref))

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
