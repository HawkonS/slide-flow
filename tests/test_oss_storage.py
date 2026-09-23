from __future__ import annotations

import asyncio
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import oss2
from PIL import Image
from fastapi import UploadFile

from app.config import settings
from app.core.oss import OSSStorage, StorageConfigurationError, oss_key, oss_ref, public_asset_origin
from app.middleware.http import SecurityHeadersMiddleware
from app.services import files
from app.core import storage as upload_storage


class _SignedBucket:
    def __init__(self):
        self.calls = []

    def sign_url(self, method, key, expires, **kwargs):
        self.calls.append((method, key, expires, kwargs))
        return "https://cdn.example.test/signed"


class _EndpointBucket:
    def __init__(self, *, error=None):
        self.error = error
        self.calls = []

    def put_object(self, key, source, **kwargs):
        content = source.read() if hasattr(source, "read") else source
        self.calls.append(("put_object", key, content))
        if self.error:
            raise self.error

    def put_object_from_file(self, key, source, **kwargs):
        self.calls.append(("put_object_from_file", key, source))
        if self.error:
            raise self.error

    def get_object_to_file(self, key, destination):
        self.calls.append(("get_object_to_file", key, destination))
        Path(destination).write_bytes(b"downloaded")
        if self.error:
            raise self.error

    def delete_object(self, key):
        self.calls.append(("delete_object", key))
        if self.error:
            raise self.error


class OSSStorageTests(unittest.TestCase):
    def test_unconfigured_oss_fails_with_actionable_configuration_error(self):
        storage = OSSStorage()
        with (
            patch.object(settings, "storage_backend", "oss"),
            patch.object(settings, "oss_endpoint", ""),
            patch.object(settings, "oss_bucket", ""),
        ):
            with self.assertRaisesRegex(StorageConfigurationError, "oss.endpoint.*oss.bucket"):
                storage.ensure_configured()

    def test_reference_round_trip_and_bucket_validation(self):
        with patch.object(settings, "oss_bucket", "slides"):
            ref = oss_ref("resources/png/example.png")
            self.assertEqual(ref, "oss://slides/resources/png/example.png")
            self.assertEqual(oss_key(ref), "resources/png/example.png")
            with self.assertRaises(ValueError):
                oss_key("oss://another/resources/png/example.png")

    def test_configuration_rejects_internal_endpoint_for_browser_urls(self):
        storage = OSSStorage()
        internal = "https://oss-cn-beijing-internal.aliyuncs.com"
        with (
            patch.object(settings, "storage_backend", "oss"),
            patch.object(settings, "oss_endpoint", "https://oss-cn-beijing.aliyuncs.com"),
            patch.object(settings, "oss_internal_endpoint", internal),
            patch.object(settings, "oss_public_endpoint", internal),
            patch.object(settings, "oss_bucket", "slides"),
        ):
            self.assertIn("public_endpoint", storage.configuration_error())

    def test_configuration_rejects_missing_external_fallback_when_internal_is_set(self):
        storage = OSSStorage()
        internal = "https://oss-cn-beijing-internal.aliyuncs.com"
        with (
            patch.object(settings, "storage_backend", "oss"),
            patch.object(settings, "oss_endpoint", internal),
            patch.object(settings, "oss_internal_endpoint", internal),
            patch.object(settings, "oss_public_endpoint", ""),
            patch.object(settings, "oss_bucket", "slides"),
        ):
            self.assertIn("外网回退地址", storage.configuration_error())

    def test_configuration_rejects_bucket_hosted_internal_endpoint_for_browser_urls(self):
        storage = OSSStorage()
        with (
            patch.object(settings, "storage_backend", "oss"),
            patch.object(settings, "oss_endpoint", "https://oss-cn-beijing.aliyuncs.com"),
            patch.object(settings, "oss_internal_endpoint", "https://oss-cn-beijing-internal.aliyuncs.com"),
            patch.object(settings, "oss_public_endpoint", "https://slides.oss-cn-beijing-internal.aliyuncs.com"),
            patch.object(settings, "oss_bucket", "slides"),
        ):
            self.assertIn("public_endpoint", storage.configuration_error())

    def test_signed_thumbnail_url_contains_oss_process(self):
        bucket = _SignedBucket()
        storage = OSSStorage()
        storage._public_bucket = bucket
        with (
            patch.object(storage, "_public", return_value=bucket),
            patch.object(settings, "oss_bucket", "slides"),
            patch.object(settings, "oss_url_expire_seconds", 900),
        ):
            result = storage.signed_url(
                "oss://slides/resources/png/example.png",
                process="image/resize,m_lfit,w_640,h_360/quality,q_74/format,jpg",
            )
        self.assertEqual(result, "https://cdn.example.test/signed")
        _, key, expires, kwargs = bucket.calls[0]
        self.assertEqual(key, "resources/png/example.png")
        self.assertEqual(expires, 900)
        self.assertEqual(
            kwargs["params"]["x-oss-process"],
            "image/resize,m_lfit,w_640,h_360/quality,q_74/format,jpg",
        )

    def test_key_uses_configured_bucket_directory(self):
        storage = OSSStorage()
        with patch.object(settings, "oss_prefix", "prod/slide-flow"):
            key = storage.key("resources/png", ".png")
        self.assertRegex(key, r"^prod/slide-flow/resources/png/[0-9a-f]{32}\.png$")

    def test_key_rejects_dot_segments_in_bucket_directory(self):
        storage = OSSStorage()
        with patch.object(settings, "oss_prefix", "prod/../private"):
            with self.assertRaises(ValueError):
                storage.key("resources/png", ".png")

    def test_public_origin_uses_bucket_host_or_custom_domain(self):
        with (
            patch.object(settings, "oss_bucket", "slides"),
            patch.object(settings, "oss_endpoint", "https://oss-cn-hangzhou.aliyuncs.com"),
            patch.object(settings, "oss_public_endpoint", ""),
        ):
            self.assertEqual(public_asset_origin(), "https://slides.oss-cn-hangzhou.aliyuncs.com")
        with patch.object(settings, "oss_public_endpoint", "https://cdn.example.com"):
            self.assertEqual(public_asset_origin(), "https://cdn.example.com")

    def test_security_policy_allows_direct_oss_images_and_downloads(self):
        with (
            patch.object(settings, "storage_backend", "oss"),
            patch.object(settings, "oss_bucket", "slides"),
            patch.object(settings, "oss_endpoint", "https://oss-cn-hangzhou.aliyuncs.com"),
            patch.object(settings, "oss_public_endpoint", ""),
        ):
            middleware = SecurityHeadersMiddleware(lambda *_args: None)
        policy = middleware._content_security_policy.decode("ascii")
        origin = "https://slides.oss-cn-hangzhou.aliyuncs.com"
        self.assertIn(f"img-src 'self' data: blob: {origin}", policy)
        self.assertIn(f"connect-src 'self' ws: wss: {origin}", policy)

    def test_hd_image_is_one_png_with_4k_edge_limit(self):
        with tempfile.TemporaryDirectory() as temp_name:
            source = Path(temp_name) / "preview.jpg"
            Image.new("RGB", (5000, 2500), (10, 20, 30)).save(source, "JPEG")
            with (
                patch.object(files.settings, "image_hd_max_resolution", 3840),
                patch.object(files.settings, "image_hd_dpi", 288),
            ):
                result = files._compress_hd_image(source)
            self.assertEqual(result.suffix, ".png")
            self.assertFalse(source.exists())
            with Image.open(result) as image:
                self.assertEqual(image.size, (3840, 1920))

    def test_materialization_scope_removes_downloaded_oss_file(self):
        with tempfile.TemporaryDirectory() as temp_name:
            target = Path(temp_name) / "asset.pptx"

            def materialize(_ref):
                target.write_bytes(b"pptx")
                return target

            with (
                patch.object(files.oss_storage, "materialize", side_effect=materialize),
                files.materialization_scope(),
            ):
                self.assertEqual(
                    files._resource_file_abs("oss://slides/resources/ppt/asset.pptx"),
                    target,
                )
                self.assertTrue(target.exists())
            self.assertFalse(target.exists())

    def test_upload_can_stage_through_oss_before_local_processing(self):
        class FakeStorage:
            def __init__(self):
                self.uploaded = {}
                self.deleted = []

            def key(self, category, suffix=""):
                return f"slide-flow/{category}/temporary{suffix}"

            def upload_fileobj(self, source, key, *, content_type=None):
                self.uploaded[key] = source.read()
                return f"oss://slides/{key}"

            def download_file(self, ref, destination):
                key = ref.removeprefix("oss://slides/")
                destination.write_bytes(self.uploaded[key])
                return destination

            def delete(self, ref):
                self.deleted.append(ref)

        with tempfile.TemporaryDirectory() as temp_name:
            fake = FakeStorage()
            upload = UploadFile(filename="source.pptx", file=io.BytesIO(b"ppt-bytes"))
            with (
                patch.object(upload_storage, "oss_storage", fake),
                patch.object(upload_storage.settings, "storage_backend", "oss"),
            ):
                target, size = asyncio.run(
                    upload_storage.stage_upload_via_oss(upload, Path(temp_name), "source_")
                )
            self.assertEqual(size, 9)
            self.assertEqual(target.read_bytes(), b"ppt-bytes")
            self.assertEqual(len(fake.uploaded), 1)
            self.assertEqual(fake.deleted, ["oss://slides/slide-flow/_incoming/temporary.pptx"])

    def test_network_upload_failure_retries_external_endpoint_and_rewinds_stream(self):
        internal = _EndpointBucket(error=oss2.exceptions.RequestError(ConnectionError("offline")))
        external = _EndpointBucket()
        storage = OSSStorage()
        storage._bucket = internal
        storage._fallback_bucket = external
        source = io.BytesIO(b"upload-bytes")
        with (
            patch.object(storage, "_require_bucket", return_value=internal),
            patch.object(settings, "oss_endpoint", "https://oss-cn-beijing.aliyuncs.com"),
            patch.object(settings, "oss_internal_endpoint", "https://oss-cn-beijing-internal.aliyuncs.com"),
            patch.object(settings, "oss_bucket", "slides"),
        ):
            self.assertEqual(
                storage.upload_fileobj(source, "resources/ppt/example.pptx"),
                "oss://slides/resources/ppt/example.pptx",
            )
        self.assertEqual(external.calls[0][2], b"upload-bytes")

    def test_permission_error_does_not_retry_external_endpoint(self):
        internal = _EndpointBucket(error=oss2.exceptions.AccessDenied(403, {}, "", {}))
        external = _EndpointBucket()
        storage = OSSStorage()
        storage._fallback_bucket = external
        with (
            patch.object(storage, "_require_bucket", return_value=internal),
            patch.object(settings, "oss_endpoint", "https://oss-cn-beijing.aliyuncs.com"),
            patch.object(settings, "oss_internal_endpoint", "https://oss-cn-beijing-internal.aliyuncs.com"),
            patch.object(settings, "oss_bucket", "slides"),
            self.assertRaises(oss2.exceptions.AccessDenied),
        ):
            storage.upload_bytes(b"data", "resources/ppt/example.pptx")
        self.assertEqual(external.calls, [])

    def test_network_download_failure_cleans_partial_file_before_external_retry(self):
        internal = _EndpointBucket(error=oss2.exceptions.RequestError(ConnectionError("offline")))
        external = _EndpointBucket()
        storage = OSSStorage()
        storage._fallback_bucket = external
        with tempfile.TemporaryDirectory() as temp_name:
            destination = Path(temp_name) / "asset.pptx"
            destination.write_bytes(b"stale")
            with (
                patch.object(storage, "_require_bucket", return_value=internal),
                patch.object(settings, "oss_endpoint", "https://oss-cn-beijing.aliyuncs.com"),
                patch.object(settings, "oss_internal_endpoint", "https://oss-cn-beijing-internal.aliyuncs.com"),
                patch.object(settings, "oss_bucket", "slides"),
            ):
                storage.download_file("oss://slides/resources/ppt/example.pptx", destination)
            self.assertEqual(destination.read_bytes(), b"downloaded")
            self.assertEqual(external.calls[0][0], "get_object_to_file")

    def test_save_upload_keeps_local_mode_without_oss_round_trip(self):
        with tempfile.TemporaryDirectory() as temp_name:
            upload = UploadFile(filename="font.ttf", file=io.BytesIO(b"font-bytes"))
            with patch.object(upload_storage.settings, "storage_backend", "oss"):
                target = asyncio.run(upload_storage.save_upload(upload, Path(temp_name), "font_"))
            self.assertEqual(target.read_bytes(), b"font-bytes")
            self.assertTrue(target.name.startswith("font_"))


if __name__ == "__main__":
    unittest.main()
