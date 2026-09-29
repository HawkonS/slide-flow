from __future__ import annotations

import hashlib
import sqlite3
import tempfile
import unittest
from datetime import datetime
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.parse import urlparse

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.config import settings
from app.core.permissions import SESSION_COOKIE, _auth_db_dep
from app.core.security import create_session_token, read_session_expiry
from app.routers import auth, presentation
from app.routers.dependencies import db_read_dep


class OfflinePresentationTests(unittest.TestCase):
    """Exercise real cookie authentication without touching the application DB."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-offline-tests-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.assets = self.root / "assets"
        self.assets.mkdir()
        for name, value in (("root_dir", self.root), ("assets_dir", self.assets),
                            ("oss_bucket", "tests"),
                            ("secret_key", "offline-test-signing-key")):
            patcher = patch.object(settings, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        presentation._offline_snapshots.clear()
        presentation._offline_images.clear()
        self.addCleanup(presentation._offline_snapshots.clear)
        self.addCleanup(presentation._offline_images.clear)
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript(
            """
            CREATE TABLE users (
                id INTEGER PRIMARY KEY, name TEXT, username TEXT, role TEXT,
                password_hash TEXT DEFAULT 'test-password-hash-never-export',
                session_version INTEGER DEFAULT 1, must_change_pwd INTEGER DEFAULT 0,
                feishu_id TEXT DEFAULT '', avatar_url TEXT DEFAULT '',
                created_at TEXT DEFAULT '', updated_at TEXT DEFAULT ''
            );
            INSERT INTO users(id, name, username, role) VALUES
                (1, 'Owner', 'owner', 'user'), (2, 'Viewer', 'viewer', 'user'),
                (3, 'Other', 'other', 'user');
            CREATE TABLE shows (
                id INTEGER PRIMARY KEY, name TEXT, owner_id INTEGER,
                visibility_scope TEXT, version_no INTEGER, series_id TEXT,
                updated_at TEXT, subject TEXT, tags TEXT, status TEXT
            );
            INSERT INTO shows VALUES
                (10, 'A fixed show', 1, 'public', 4, 'series-a',
                 '2026-09-28T00:00:00Z', 'Product', 'one,two', 'active');
            CREATE TABLE resources (
                id INTEGER PRIMARY KEY, name TEXT, owner_id INTEGER,
                visibility_scope TEXT, current_version INTEGER
            );
            INSERT INTO resources VALUES
                (20, 'First', 1, 'public', 2), (21, 'Hidden', 1, 'public', 1);
            CREATE TABLE resource_versions (
                id INTEGER PRIMARY KEY, resource_id INTEGER, version_no INTEGER,
                png_path TEXT, common_remark_html TEXT DEFAULT ''
            );
            CREATE TABLE show_resources (
                show_id INTEGER, resource_id INTEGER, version_no INTEGER,
                sort_order INTEGER, is_hidden INTEGER
            );
            INSERT INTO show_resources VALUES (10, 20, 1, 0, 0), (10, 21, 1, 1, 1);
            CREATE TABLE personal_remarks (
                resource_id INTEGER, version_id INTEGER, user_id INTEGER, content_html TEXT
            );
            CREATE TABLE show_remarks (
                show_id INTEGER, resource_id INTEGER, user_id INTEGER, content_html TEXT
            );
            INSERT INTO personal_remarks VALUES (20, 100, 2, '<p>Viewer personal</p>'),
                (20, 100, 3, '<p>Other personal</p>'), (20, 101, 2, '<p>Wrong version</p>');
            INSERT INTO show_remarks VALUES (10, 20, 2, '<p>Viewer show</p>'),
                (10, 20, 3, '<p>Other show</p>');
            """
        )
        self.first_path = self.assets / "first-v1.png"
        self.second_path = self.assets / "first-v2.png"
        self.hidden_path = self.assets / "hidden.png"
        for path, color in ((self.first_path, 'red'), (self.second_path, 'blue'),
                            (self.hidden_path, 'green')):
            Image.new('RGB', (32, 18), color).save(path)
        self.first_bytes = self.first_path.read_bytes()
        self.db.executemany(
            "INSERT INTO resource_versions VALUES (?, ?, ?, ?, ?)",
            [(100, 20, 1, str(self.first_path), '<p onclick="bad()">Common</p><script>bad()</script>'),
             (101, 20, 2, str(self.second_path), ''), (102, 21, 1, str(self.hidden_path), '')],
        )
        self.db.commit()
        self.app = FastAPI()
        self.app.include_router(presentation.router)
        self.app.include_router(auth.router, prefix="/api")

        def override_db():
            yield self.db

        self.app.dependency_overrides[db_read_dep] = override_db
        self.app.dependency_overrides[_auth_db_dep] = override_db
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.authenticate()
        self.manifest_url = "/api/shows/10/offline-manifest"

    def authenticate(self, user_id=2, *, ttl=3600, session_version=1):
        token = create_session_token(user_id, settings.secret_key, ttl_seconds=ttl,
                                     session_version=session_version)
        self.client.cookies.set(SESSION_COOKIE, token)
        return token

    def manifest(self):
        response = self.client.get(self.manifest_url)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('no-store', response.headers['cache-control'])
        return response.json()

    def assert_status_no_store(self, response, status):
        self.assertEqual(response.status_code, status, response.text)
        self.assertIn('no-store', response.headers['cache-control'])

    def test_manifest_has_scoped_identity_notes_hashes_and_pinned_binary_assets(self):
        data = self.manifest()
        self.assertEqual((data['format_version'], data['user_id'], data['session_version']), (3, 2, 1))
        self.assertEqual(data['tags'], ['one', 'two'])
        self.assertEqual(data['owner_name'], 'Owner')
        self.assertTrue(data['package_id'])
        self.assertNotIn('auth_hash', data)
        self.assertNotIn('password_hash', str(data))
        first, hidden = data['resources']
        self.assertEqual((first['slide_index'], hidden['slide_index']), (0, 1))
        self.assertFalse(first['hidden'])
        self.assertTrue(hidden['hidden'])
        self.assertEqual(first['version_no'], 1)
        self.assertIn('Viewer personal', first['personal_remark_html'])
        self.assertIn('Viewer show', first['show_remark_html'])
        self.assertNotIn('Other personal', str(data))
        self.assertNotIn('Wrong version', str(data))
        self.assertNotIn('<script', first['common_remark_html'])
        self.assertNotIn('onclick', first['common_remark_html'])
        for kind, expected_mime in [('image', 'image/png'), ('thumb', 'image/jpeg')]:
            url = first[f'{kind}_url']
            self.assertEqual(urlparse(url).netloc, '')
            response = self.client.get(url)
            self.assert_status_no_store(response, 200)
            self.assertEqual(response.headers['content-type'], expected_mime)
            self.assertEqual(hashlib.sha256(response.content).hexdigest(), first[f'{kind}_sha256'])
            self.assertEqual(len(response.content), first['size_bytes' if kind == 'image' else 'thumb_size_bytes'])
            self.assertNotIn('location', response.headers)
            with Image.open(BytesIO(response.content)) as image:
                image.verify()
        self.assertEqual(self.client.get(first['image_url']).content, self.first_bytes)

    def test_switching_accounts_never_reuses_personal_notes(self):
        first = self.manifest()
        self.authenticate(3)
        second = self.manifest()
        self.assertNotEqual(first['package_id'], second['package_id'])
        self.assertEqual(second['user_id'], 3)
        self.assertIn('Other personal', second['resources'][0]['personal_remark_html'])
        self.assertNotIn('Viewer personal', str(second))
        self.assertNotIn('Viewer show', str(second))

    def test_expiry_is_capped_by_current_session_and_twenty_four_hours(self):
        token = self.authenticate(ttl=120)
        data = self.manifest()
        self.assertEqual(datetime.fromisoformat(data['expires_at'].replace('Z', '+00:00')).timestamp(),
                         read_session_expiry(token, settings.secret_key))
        self.authenticate(ttl=48 * 3600)
        data = self.manifest()
        issued = datetime.fromisoformat(data['issued_at'].replace('Z', '+00:00'))
        expires = datetime.fromisoformat(data['expires_at'].replace('Z', '+00:00'))
        self.assertEqual((expires - issued).total_seconds(), 24 * 3600)

    def test_legacy_package_is_gone_and_never_exports_password_hash(self):
        for mode in ('none', 'required'):
            response = self.client.get(f'/api/shows/10/offline-package?auth_mode={mode}')
            self.assert_status_no_store(response, 410)
            self.assertNotIn('test-password-hash-never-export', response.text)

    def test_missing_expired_and_tampered_sessions_are_not_cacheable(self):
        image_url = self.manifest()['resources'][0]['image_url']
        self.client.cookies.clear()
        for url in (self.manifest_url, image_url):
            self.assert_status_no_store(self.client.get(url), 401)
        self.authenticate(ttl=-1)
        self.assert_status_no_store(self.client.get(self.manifest_url), 401)
        token = self.authenticate()
        self.client.cookies.set(SESSION_COOKIE, token + 'tampered')
        self.assert_status_no_store(self.client.get(image_url), 401)
        self.assertIsNone(read_session_expiry(token + 'tampered', settings.secret_key))

    def test_session_revocation_also_blocks_already_validated_assets(self):
        image_url = self.manifest()['resources'][0]['image_url']
        self.db.execute('UPDATE users SET session_version = 2 WHERE id = 2')
        self.db.commit()
        for url in (self.manifest_url, image_url):
            self.assert_status_no_store(self.client.get(url), 401)
        self.authenticate(session_version=2)
        self.assertEqual(self.manifest()['session_version'], 2)

    def test_non_ascii_session_cookie_is_rejected_without_server_error(self):
        self.client.cookies.clear()
        response = self.client.get(
            self.manifest_url,
            headers=[(b'cookie', SESSION_COOKIE.encode('ascii') + b'=\xff.invalid')],
        )
        self.assert_status_no_store(response, 401)
        self.assertIsNone(read_session_expiry('\u00ff.invalid', settings.secret_key))

    def test_all_permissions_are_preflighted_including_hidden_resources(self):
        self.db.execute("UPDATE resources SET visibility_scope = 'private' WHERE id = 21")
        self.db.commit()
        with patch.object(presentation, '_offline_asset_snapshot') as images:
            self.assert_status_no_store(self.client.get(self.manifest_url), 403)
            images.assert_not_called()

    def test_live_show_and_resource_revocations_override_verified_image_cache(self):
        resources = self.manifest()['resources']
        urls = [self.manifest_url, resources[0]['image_url'], resources[0]['thumb_url']]
        for table in ('shows', 'resources'):
            self.db.execute(f"UPDATE {table} SET visibility_scope = 'private'")
            self.db.commit()
            for url in urls:
                self.assert_status_no_store(self.client.get(url), 403)
            self.db.execute(f"UPDATE {table} SET visibility_scope = 'public'")
            self.db.commit()

    def test_missing_version_fails_whole_manifest_instead_of_omitting_a_slide(self):
        self.db.execute('DELETE FROM resource_versions WHERE id = 102')
        self.db.commit()
        with patch.object(presentation, '_offline_asset_snapshot') as images:
            self.assert_status_no_store(self.client.get(self.manifest_url), 409)
            images.assert_not_called()

    def test_changed_show_version_and_unrelated_asset_do_not_fall_back_to_latest(self):
        url = self.manifest()['resources'][0]['image_url']
        self.db.execute('UPDATE show_resources SET version_no = 2 WHERE resource_id = 20')
        self.db.commit()
        self.assert_status_no_store(self.client.get(url), 409)
        self.assert_status_no_store(self.client.get('/api/shows/10/offline-assets/999/image?version_no=1'), 403)
        self.assertEqual(self.manifest()['resources'][0]['version_no'], 2)

    def test_missing_corrupt_and_replaced_files_invalidate_verified_snapshots(self):
        url = self.manifest()['resources'][0]['image_url']
        Image.new('RGB', (32, 18), 'black').save(self.first_path)
        self.assert_status_no_store(self.client.get(url), 409)
        self.first_path.write_bytes(b'broken PNG')
        self.assert_status_no_store(self.client.get(self.manifest_url), 409)
        self.first_path.unlink()
        self.assert_status_no_store(self.client.get(self.manifest_url), 409)

    def test_oss_assets_are_verified_once_proxied_and_temporary_files_cleaned(self):
        self.db.execute("UPDATE resource_versions SET png_path = 'oss://tests/first.png' WHERE id = 100")
        self.db.commit()
        temporary_png = self.root / 'materialized.png'
        head = SimpleNamespace(etag='immutable-object-v1', content_length=len(self.first_bytes),
                               last_modified=123, server_crc=456, headers={})
        bucket = Mock()
        bucket.head_object.return_value = head

        def materialize(_):
            temporary_png.write_bytes(self.first_bytes)
            return temporary_png

        with patch.object(presentation.oss_storage, '_with_endpoint_fallback',
                          side_effect=lambda operation, action: action(bucket)), \
             patch('app.services.files.oss_storage.materialize', side_effect=materialize) as download:
            first = self.manifest()
            self.assertFalse(temporary_png.exists())
            resource = first['resources'][0]
            for kind in ('image', 'thumb'):
                response = self.client.get(resource[f'{kind}_url'])
                self.assert_status_no_store(response, 200)
                self.assertNotIn('location', response.headers)
            confirmed = self.manifest()
            self.assertEqual(confirmed['resources'], first['resources'])
            self.assertEqual(download.call_count, 1)
            self.assertFalse(temporary_png.exists())
            self.assertGreater(bucket.head_object.call_count, 1)

    def test_small_image_cache_budget_does_not_evict_snapshot_integrity(self):
        with patch.object(presentation, '_OFFLINE_IMAGE_CACHE_BYTES', 1):
            first = self.manifest()
            self.assertEqual(len(presentation._offline_images), 0)
            response = self.client.get(first['resources'][0]['image_url'])
            self.assert_status_no_store(response, 200)
            self.assertEqual(response.content, self.first_bytes)
            self.assertEqual(len(presentation._offline_images), 0)
            self.assertEqual(self.manifest()['resources'], first['resources'])

    def test_validation_errors_and_current_identity_have_no_store_headers(self):
        self.assert_status_no_store(self.client.get('/api/shows/10/offline-assets/20/image?version_no=0'), 422)
        response = self.client.get('/api/me')
        self.assert_status_no_store(response, 200)
        self.assertEqual(response.json()['user']['session_version'], 1)
        self.assertNotIn('password_hash', response.json()['user'])

    def add_series_show(self, show_id, version, *, visibility="public", resources=((20, 1), (21, 1))):
        self.db.execute(
            "INSERT INTO shows SELECT ?, ?, owner_id, ?, ?, series_id, updated_at, subject, tags, status "
            "FROM shows WHERE id = 10",
            (show_id, "Successor " + str(show_id), visibility, version),
        )
        self.db.executemany(
            "INSERT INTO show_resources VALUES (?, ?, ?, ?, 0)",
            [(show_id, resource_id, pinned, index) for index, (resource_id, pinned) in enumerate(resources)],
        )
        self.db.commit()

    def test_version_check_selects_latest_visible_successor_without_revoking_old_show(self):
        self.add_series_show(11, 5)
        self.add_series_show(12, 6, visibility="private")
        with patch.object(presentation, '_offline_asset_snapshot') as images:
            response = self.client.get('/api/shows/10/offline-version')
            self.assert_status_no_store(response, 200)
            images.assert_not_called()
        data = response.json()
        self.assertEqual((data['queried_show_id'], data['show_id'], data['version_no']), (10, 11, 5))
        self.assertNotIn('Successor 12', response.text)
        self.assertEqual(data['resource_versions'], {'20': 1, '21': 1})
        self.db.execute("UPDATE shows SET visibility_scope = 'private' WHERE id = 11")
        self.db.commit()
        response = self.client.get('/api/shows/10/offline-version')
        self.assert_status_no_store(response, 200)
        self.assertEqual(response.json()['show_id'], 10)
        self.assertEqual(self.manifest()['show_id'], 10)

    def test_version_check_ignores_successors_with_forbidden_or_missing_fixed_resources(self):
        self.db.execute("INSERT INTO resources VALUES (22, 'Private successor slide', 1, 'private', 1)")
        self.db.execute("INSERT INTO resource_versions VALUES (103, 22, 1, ?, '')", (str(self.hidden_path),))
        self.add_series_show(11, 5, resources=((22, 1),))
        response = self.client.get('/api/shows/10/offline-version')
        self.assert_status_no_store(response, 200)
        self.assertEqual(response.json()['show_id'], 10)
        self.assertNotIn('22', response.json()['resource_versions'])
        self.assertNotIn('22', response.json()['resource_updates'])
        self.db.execute("UPDATE resources SET visibility_scope = 'public' WHERE id = 22")
        self.db.execute('DELETE FROM resource_versions WHERE id = 103')
        self.db.commit()
        response = self.client.get('/api/shows/10/offline-version')
        self.assert_status_no_store(response, 200)
        self.assertEqual(response.json()['show_id'], 10)
        self.db.execute("INSERT INTO resource_versions VALUES (103, 22, 1, ?, '')", (str(self.hidden_path),))
        self.db.commit()
        response = self.client.get('/api/shows/10/offline-version')
        self.assert_status_no_store(response, 200)
        self.assertEqual(response.json()['show_id'], 11)

    def test_version_check_revalidates_queried_resources_before_selecting_a_successor(self):
        self.add_series_show(11, 5, resources=((20, 1),))
        self.db.execute("UPDATE resources SET visibility_scope = 'private' WHERE id = 21")
        self.db.commit()
        # The hidden original slide is still part of the already-downloaded package.
        self.assert_status_no_store(self.client.get('/api/shows/10/offline-version'), 403)
        self.db.execute("UPDATE resources SET visibility_scope = 'public' WHERE id = 21")
        self.db.execute('DELETE FROM resource_versions WHERE id = 102')
        self.db.commit()
        self.assert_status_no_store(self.client.get('/api/shows/10/offline-version'), 409)
        self.db.execute("INSERT INTO resource_versions VALUES (102, 21, 1, '', '')")
        self.db.commit()
        self.assert_status_no_store(self.client.get('/api/shows/10/offline-version'), 409)
        self.db.execute('DELETE FROM resources WHERE id = 21')
        self.db.commit()
        self.assert_status_no_store(self.client.get('/api/shows/10/offline-version'), 409)

    def test_version_check_reports_resource_upgrades_without_changing_fixed_versions(self):
        self.db.execute("INSERT INTO resource_versions VALUES (103, 20, 3, ?, '')", (str(self.second_path),))
        self.db.commit()
        response = self.client.get('/api/shows/10/offline-version')
        self.assert_status_no_store(response, 200)
        data = response.json()
        self.assertEqual(data['resource_versions'], {'20': 1, '21': 1})
        # A higher row alone is not the resource's published current version.
        self.assertEqual(data['resource_updates'], {'20': 2})
        self.assertEqual(self.db.execute('SELECT version_no FROM show_resources WHERE resource_id = 20').fetchone()[0], 1)
        self.assertEqual(self.manifest()['resources'][0]['version_no'], 1)
        self.db.execute('UPDATE resources SET current_version = 4 WHERE id = 20')
        self.db.commit()
        self.assertEqual(self.client.get('/api/shows/10/offline-version').json()['resource_updates'], {})
        self.db.execute("INSERT INTO resource_versions VALUES (104, 20, 4, '', '')")
        self.db.commit()
        self.assertEqual(self.client.get('/api/shows/10/offline-version').json()['resource_updates'], {})
        self.db.execute('UPDATE resource_versions SET png_path = ? WHERE id = 104', (str(self.second_path),))
        self.db.commit()
        data = self.client.get('/api/shows/10/offline-version').json()
        self.assertEqual(data['resource_updates'], {'20': 4})
        self.assertEqual(data['resource_versions']['20'], 1)

    def test_version_check_current_show_and_session_denials_are_not_cacheable(self):
        self.add_series_show(11, 5)
        self.db.execute("UPDATE shows SET visibility_scope = 'private' WHERE id = 10")
        self.db.commit()
        self.assert_status_no_store(self.client.get('/api/shows/10/offline-version'), 403)
        self.assert_status_no_store(self.client.get('/api/shows/999/offline-version'), 404)
        self.client.cookies.clear()
        self.assert_status_no_store(self.client.get('/api/shows/10/offline-version'), 401)


if __name__ == '__main__':
    unittest.main()
