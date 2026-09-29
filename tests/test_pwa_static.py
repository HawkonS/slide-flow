"""PWA/static routing tests without a database or application lifespan."""

from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.web import static


class PwaStaticTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.dist = self.root / "dist"
        (self.dist / "assets").mkdir(parents=True)
        (self.dist / "pwa").mkdir()
        (self.dist / "index.html").write_text("<!doctype html><title>Shell</title>")
        (self.dist / "sw.js").write_text("self.addEventListener('install', () => {});")
        (self.dist / "manifest.webmanifest").write_text('{"start_url":"/manage/offline-cache"}')
        (self.dist / "assets/main-12345678.js").write_text("export const value = 1;")
        (self.dist / "pwa/icon.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
        self.settings_patch = patch.object(static, "settings", SimpleNamespace(static_dir=self.root))
        self.index_patch = patch.object(static, "SPA_INDEX", self.dist / "index.html")
        self.settings_patch.start()
        self.index_patch.start()
        self.addCleanup(self.settings_patch.stop)
        self.addCleanup(self.index_patch.stop)
        app = FastAPI()
        app.include_router(static.router)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_worker_has_root_scope_javascript_mime_and_revalidation(self):
        response = self.client.get("/sw.js")
        self.assertEqual(response.status_code, 200)
        self.assertIn("javascript", response.headers["content-type"])
        self.assertEqual(response.headers["service-worker-allowed"], "/")
        self.assertIn("must-revalidate", response.headers["cache-control"])
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        head = self.client.head("/sw.js")
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head.content, b"")

    def test_manifest_and_icons_are_served_as_files(self):
        response = self.client.get("/manifest.webmanifest")
        self.assertEqual(response.status_code, 200)
        self.assertIn("application/manifest+json", response.headers["content-type"])
        self.assertEqual(response.headers["cache-control"], "no-cache")
        self.assertEqual(self.client.head("/manifest.webmanifest").status_code, 200)
        icon = self.client.get("/pwa/icon.svg")
        self.assertEqual(icon.status_code, 200)
        self.assertIn("image/svg+xml", icon.headers["content-type"])

    def test_hashed_assets_keep_immutable_caching_on_both_paths(self):
        for path in ("/assets/main-12345678.js", "/dist/assets/main-12345678.js"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertIn("immutable", response.headers["cache-control"])
                self.assertIn("javascript", response.headers["content-type"])

    def test_missing_assets_and_reserved_paths_never_return_html(self):
        for path in ("/assets/missing.js", "/dist/assets/missing.css", "/pwa/missing.png",
                     "/api", "/api/missing", "/ws/missing", "/storage/missing",
                     "/static", "/favicon.ico", "/missing.json", "/assets/%00.js"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 404)
                self.assertNotIn("<title>Shell", response.text)
        (self.dist / "sw.js").unlink()
        (self.dist / "manifest.webmanifest").unlink()
        self.assertEqual(self.client.get("/sw.js").status_code, 404)
        self.assertEqual(self.client.get("/manifest.webmanifest").status_code, 404)

    def test_spa_deep_links_keep_public_shell_without_cacheable_identity(self):
        for path in ("/", "/index.html", "/shows/42/present?offline=true", "/manage/offline-cache"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertIn("<title>Shell", response.text)
                self.assertEqual(response.headers["cache-control"], "no-cache")
                self.assertNotIn("set-cookie", response.headers)

    def test_dist_boundary_rejects_traversal_and_symlinks(self):
        secret = self.root / "private.txt"
        secret.write_text("must not be exposed")
        (self.dist / "assets/escape.txt").symlink_to(secret)
        for path in ("../private.txt", "assets/../../private.txt", "assets/escape.txt", "assets/\x00.js", "..\\private.txt"):
            with self.subTest(path=path):
                with self.assertRaises(HTTPException) as caught:
                    static._dist_file(path)
                self.assertEqual(caught.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
