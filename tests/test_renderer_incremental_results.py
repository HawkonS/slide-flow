"""Public behavior of incremental render publication and lazy split uploads."""
from __future__ import annotations

import copy
import hashlib
import io
import json
import sqlite3
import tempfile
import time
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from PIL import Image

from app.core import oss
from app.services.resource_import import render_tasks, sessions


class RendererIncrementalResultTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.db_path = self.base / 'tasks.sqlite'
        self.db = self.connect()
        self.addCleanup(self.db.close)
        self.db.executescript('''
            CREATE TABLE fonts (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, aliases TEXT);
            CREATE TABLE renderer_font_tasks (
                task_id TEXT PRIMARY KEY, font_id INTEGER, sha256 TEXT, status TEXT,
                lease_until REAL, attempts INTEGER, error_code TEXT, created_at TEXT, updated_at TEXT
            );
            CREATE TABLE renderer_font_delete_tasks (
                task_id TEXT PRIMARY KEY, sha256 TEXT, file_name TEXT, status TEXT,
                lease_token_hash TEXT, lease_until REAL, attempts INTEGER,
                error_code TEXT, created_at TEXT, updated_at TEXT
            );
            CREATE TABLE tasks (
                id INTEGER PRIMARY KEY, status TEXT, params TEXT, progress INTEGER,
                total INTEGER, message TEXT, error_message TEXT, updated_at TEXT
            );
            CREATE TABLE renderer_ppt_tasks (
                task_id TEXT PRIMARY KEY, session_id TEXT, render_attempt TEXT,
                parent_task_id INTEGER, status TEXT, lease_token_hash TEXT,
                lease_until REAL, worker_id TEXT, attempts INTEGER,
                source_manifest TEXT, result_manifest TEXT, error_code TEXT,
                created_at TEXT, updated_at TEXT
            );
        ''')
        self.task_id, self.session_id, self.attempt = 'a' * 32, 'b' * 32, 'c' * 32
        self.root = self.base / self.session_id
        self.root.mkdir()
        self.preview_dir = self.root / ('previews_' + self.attempt)
        self.preview_dir.mkdir()
        self.sources = []
        self.images = {}
        for index in range(3):
            source = self.root / ('split_' + str(index) + '.pptx')
            source.write_bytes(('immutable split ' + str(index)).encode())
            self.sources.append(source)
            buffer = io.BytesIO()
            Image.new('RGB', (32, 24), (index * 60, 70, 120)).save(buffer, format='PNG')
            self.images[index] = buffer.getvalue()
        self.source_manifest = {
            'version': 1, 'dpi': 288, 'batch_size': 20,
            'source': {'source_ref': 'oss://bucket/deck.pptx', 'sha256': 'd' * 64, 'size': 100, 'slide_count': 3},
            'required_fonts': [], 'font_hashes': [], 'font_bindings': [],
            'pages': [{'index': index, 'source_ref': 'oss://bucket/inputs/' + str(index) + '.pptx',
                       'source_uploaded': False, 'sha256': self.digest(source.read_bytes()), 'size': source.stat().st_size}
                      for index, source in enumerate(self.sources)],
            'outputs': [{'index': index, 'output_ref': 'oss://bucket/original/' + str(index) + '.png'} for index in range(3)],
        }
        self.snapshot = {
            'session_id': self.session_id, 'temp_dir': str(self.root), 'task_id': 7, 'slide_count': 3,
            'render_attempt': self.attempt, 'render_task_id': self.task_id,
            'preview_status': 'rendering', 'preview_paths': [], 'partial_preview_paths': {},
            'split_paths': [str(path) for path in self.sources],
            'split_hashes': [self.digest(path.read_bytes()) for path in self.sources],
        }
        self.db.execute('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)',
                        (7, 'pending', json.dumps(self.parent_params()), 0, 3, '', None, 'now'))
        self.db.execute('INSERT INTO renderer_ppt_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                        (self.task_id, self.session_id, self.attempt, 7, 'queued', None, None, None, 0,
                         json.dumps(self.source_manifest), None, None, 'now', 'now'))
        self.db.commit()
        self.downloads, self.uploads, self.output_indices = [], [], {}
        self.fail_snapshot_write = False
        self.on_download = None
        self.mock(oss, 'settings', SimpleNamespace(oss_bucket='bucket'))
        self.mock(render_tasks, 'settings', SimpleNamespace(secret_key='incremental-tests', render_dpi=288, render_wps_batch_size=20))
        self.mock(render_tasks, 'get_db', side_effect=self.connect)
        self.mock(sessions, '_resource_import_root', return_value=self.base)
        self.mock(render_tasks, '_load_resource_import_session_file', side_effect=lambda _sid: copy.deepcopy(self.snapshot))
        self.mock(render_tasks, '_write_resource_import_session', side_effect=self.write_snapshot)
        self.mock(render_tasks, '_resource_import_operation', side_effect=lambda *args, **kwargs: nullcontext())
        self.mock(render_tasks, '_compress_hd_image', side_effect=lambda path: path)
        self.mock(render_tasks, '_cleanup_manifest_objects', return_value=None)
        self.mock(render_tasks, 'oss_ref', side_effect=lambda key: 'oss://bucket/' + key)
        self.mock(render_tasks.oss_storage, 'key', side_effect=lambda category, suffix='': 'prefix/' + category + suffix)
        self.mock(render_tasks.oss_storage, 'download_file', side_effect=self.download)
        self.upload_mock = self.mock(render_tasks.oss_storage, 'upload_file', side_effect=self.upload)
        self.signed_mock = self.mock(render_tasks.oss_storage, 'signed_url', side_effect=lambda ref, **kwargs: 'https://objects.test/download/' + ref)
        self.put_mock = self.mock(render_tasks.oss_storage, 'signed_put_url', side_effect=lambda ref, **kwargs: 'https://objects.test/upload/' + ref)
        self.row, self.token = self.claim('worker-one')

    def mock(self, target, name, *args, **kwargs):
        replacement = patch.object(target, name, *args, **kwargs)
        result = replacement.start()
        self.addCleanup(replacement.stop)
        return result

    def connect(self):
        db = sqlite3.connect(self.db_path, check_same_thread=False)
        db.row_factory = sqlite3.Row
        return db

    @staticmethod
    def digest(value):
        return hashlib.sha256(value).hexdigest()

    def parent_params(self):
        return {'workflow_state': 'rendering', 'render_task_id': self.task_id, 'render_attempt': self.attempt}

    def parent(self):
        return self.db.execute('SELECT * FROM tasks WHERE id=7').fetchone()

    def task(self):
        return self.db.execute('SELECT * FROM renderer_ppt_tasks WHERE task_id=?', (self.task_id,)).fetchone()

    def change_parent(self, *, status='pending', **params):
        self.db.execute('UPDATE tasks SET status=?, params=? WHERE id=7',
                        (status, json.dumps({**self.parent_params(), **params})))
        self.db.commit()

    def claim(self, worker):
        row, token = render_tasks.claim_render_task(self.db, worker)
        for item in json.loads(row['source_manifest'])['outputs']:
            self.output_indices[item['output_ref']] = item['index']
        return row, token

    def metadata(self, source_index, **changes):
        data = self.images[source_index]
        return {'index': source_index, 'size': len(data), 'sha256': self.digest(data), **changes}

    def publish(self, *indices):
        return render_tasks.publish_render_task_progress(self.db, self.task_id, self.token,
                                                        [self.metadata(index) for index in indices])

    def state(self):
        return render_tasks.render_task_state(copy.deepcopy(self.snapshot))

    def write_snapshot(self, value):
        if self.fail_snapshot_write:
            raise OSError('session volume temporarily unavailable')
        self.snapshot = copy.deepcopy(value)

    def download(self, ref, target):
        self.assertFalse(self.db.in_transaction, 'OSS downloads must not hold a SQLite transaction')
        self.downloads.append(ref)
        target.write_bytes(self.images[self.output_indices[ref]])
        if self.on_download:
            self.on_download()

    def upload(self, source, key, **kwargs):
        self.assertFalse(self.db.in_transaction, 'OSS uploads must not hold a SQLite transaction')
        self.uploads.append((Path(source), key, kwargs))
        return 'oss://bucket/' + key

    def test_claim_advertises_incremental_protocol_and_first_batch(self):
        payload = render_tasks.claim_payload(self.row, self.token)
        self.assertIs(payload['incremental_results'], True)
        self.assertEqual(payload['first_batch_size'], 4)
        self.assertEqual(payload['batch_size'], 20)

    def test_progress_publishes_partial_without_finishing_parent_or_lease(self):
        result = self.publish(1)
        self.assertIs(result['ok'], True)
        self.assertEqual((result['preview_count'], result['total']), (1, 3))
        self.assertEqual(self.task()['status'], 'running')
        self.assertIn(self.snapshot['preview_status'], {'partial', 'rendering'})
        self.assertFalse(self.snapshot['preview_paths'])
        self.assertEqual(json.loads(self.parent()['params'])['workflow_state'], 'rendering')
        self.assertEqual(self.state()['preview_count'], 1)
        self.assertGreater(render_tasks.renew_render_task(self.db, self.task_id, self.token), time.time())

    def test_progress_with_every_page_still_requires_complete(self):
        self.assertEqual(self.publish(0, 1, 2)['preview_count'], 3)
        self.assertNotEqual(self.snapshot['preview_status'], 'ready')
        self.assertEqual(self.task()['status'], 'running')
        self.assertEqual(json.loads(self.parent()['params'])['workflow_state'], 'rendering')

    def test_repeated_identical_metadata_is_idempotent_without_redownload(self):
        self.publish(0)
        original = list(self.downloads)
        result = self.publish(0)
        self.assertEqual(result['preview_count'], 1)
        self.assertEqual(self.downloads, original)
        self.assertEqual(self.state()['preview_count'], 1)

    def test_conflicting_received_metadata_cannot_replace_a_published_page(self):
        self.publish(0)
        original = list(self.downloads)
        for changes in ({'sha256': '0' * 64}, {'size': len(self.images[0]) + 1}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                render_tasks.publish_render_task_progress(self.db, self.task_id, self.token, [self.metadata(0, **changes)])
        self.assertEqual(self.downloads, original)
        self.assertEqual(self.state()['preview_count'], 1)

    def test_invalid_indices_sizes_and_hashes_fail_before_downloading(self):
        for changes in ({'index': -1}, {'index': 3}, {'index': True}, {'index': '0'},
                        {'size': 0}, {'size': True}, {'size': render_tasks.MAX_OUTPUT_IMAGE_BYTES + 1},
                        {'sha256': 'A' * 64}, {'sha256': 'bad'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                render_tasks.publish_render_task_progress(self.db, self.task_id, self.token, [self.metadata(0, **changes)])
        self.assertFalse(self.downloads)

    def test_corrupt_download_is_rejected_without_publishing_a_preview(self):
        metadata = self.metadata(0)
        self.images[0] = b'corrupt'
        with self.assertRaises(ValueError):
            render_tasks.publish_render_task_progress(self.db, self.task_id, self.token, [metadata])
        self.assertFalse(self.snapshot['partial_preview_paths'])
        self.assertEqual(self.state()['preview_count'], 0)

    def test_non_image_with_matching_checksum_is_rejected(self):
        self.images[0] = b'not a PNG despite its valid checksum'
        with self.assertRaises((ValueError, HTTPException)):
            self.publish(0)
        self.assertFalse(self.snapshot['partial_preview_paths'])
        self.assertEqual(self.state()['preview_count'], 0)

    def test_cumulative_output_limit_includes_previously_received_pages(self):
        self.publish(0)
        original = list(self.downloads)
        with patch.object(render_tasks, 'MAX_TOTAL_OUTPUT_BYTES', len(self.images[0]) + len(self.images[1]) - 1):
            with self.assertRaises(ValueError):
                self.publish(1)
        self.assertEqual(self.downloads, original)
        self.assertEqual(self.state()['preview_count'], 1)

    def test_reclaim_drops_old_receipts_and_rejects_old_worker(self):
        self.publish(0, 1)
        old_token = self.token
        self.db.execute('UPDATE renderer_ppt_tasks SET lease_until=? WHERE task_id=?', (time.time() - 1, self.task_id))
        self.db.commit()
        self.row, self.token = self.claim('worker-two')
        self.assertEqual(self.row['attempts'], 2)
        original = list(self.downloads)
        with self.assertRaises(PermissionError):
            render_tasks.publish_render_task_progress(self.db, self.task_id, old_token, [self.metadata(2)])
        self.assertEqual(self.downloads, original)
        self.assertEqual(self.state()['preview_count'], 0)
        self.assertEqual(self.publish(0)['preview_count'], 1)
        self.assertEqual(len(self.downloads), len(original) + 1)

    def test_expired_lease_cannot_publish_or_request_lazy_source(self):
        self.db.execute('UPDATE renderer_ppt_tasks SET lease_until=? WHERE task_id=?', (time.time() - 1, self.task_id))
        self.db.commit()
        with self.assertRaises(PermissionError):
            self.publish(0)
        with self.assertRaises(PermissionError):
            render_tasks.refresh_render_task_urls(self.db, self.task_id, self.token, 0, include_source=True)
        self.assertFalse(self.downloads)
        self.upload_mock.assert_not_called()

    def test_reclaim_resets_parent_progress_before_any_status_poll(self):
        self.publish(0, 1)
        self.assertEqual(self.parent()['progress'], 2)
        self.db.execute('UPDATE renderer_ppt_tasks SET lease_until=? WHERE task_id=?', (time.time() - 1, self.task_id))
        self.db.commit()
        row, _token = self.claim('worker-two')
        parent = self.parent()
        params = json.loads(parent['params'])
        self.assertEqual(parent['progress'], 0)
        self.assertEqual(params['render_completed'], 0)
        self.assertEqual(params['render_worker_attempt'], row['attempts'])
        self.assertEqual(row['attempts'], 2)

    def test_claim_does_not_overwrite_parent_owned_by_another_render_task(self):
        self.publish(0)
        self.change_parent(render_task_id='d' * 32, render_attempt='e' * 32,
                           render_completed=2, render_worker_attempt=9, operator_note='preserve')
        self.db.execute('UPDATE tasks SET progress=2 WHERE id=7')
        self.db.execute('UPDATE renderer_ppt_tasks SET lease_until=? WHERE task_id=?', (time.time() - 1, self.task_id))
        self.db.commit()
        before = dict(self.parent())
        render_tasks.claim_render_task(self.db, 'worker-two')
        self.assertEqual(dict(self.parent()), before)

    def test_cancelled_or_replaced_parent_cannot_accept_progress(self):
        for changes in ({'status': 'cancelled'}, {'render_task_id': 'd' * 32}, {'render_attempt': 'e' * 32}):
            with self.subTest(changes=changes):
                self.change_parent(**changes)
                with self.assertRaises(PermissionError):
                    self.publish(0)
        self.assertFalse(self.downloads)
        self.assertFalse(self.snapshot['partial_preview_paths'])

    def test_replaced_session_cannot_accept_progress(self):
        original = copy.deepcopy(self.snapshot)
        for key in ('render_attempt', 'render_task_id'):
            with self.subTest(key=key):
                self.snapshot = {**original, key: 'f' * 32}
                with self.assertRaises(PermissionError):
                    self.publish(0)
        self.assertFalse(self.downloads)

    def test_parent_change_during_download_is_rechecked_before_publication(self):
        self.on_download = lambda: self.change_parent(render_attempt='f' * 32)
        with self.assertRaises(PermissionError):
            self.publish(0)
        self.assertFalse(self.snapshot['partial_preview_paths'])
        self.assertNotEqual(self.task()['status'], 'completed')

    def test_status_recovers_durable_partial_receipt_after_snapshot_write_failure(self):
        self.fail_snapshot_write = True
        try:
            self.publish(0)
        except OSError:
            pass
        self.assertFalse(self.snapshot['partial_preview_paths'])
        self.fail_snapshot_write = False
        state = self.state()
        self.assertEqual(state['preview_count'], 1)
        self.assertNotEqual(state['status'], 'completed')
        self.assertIn(self.snapshot['preview_status'], {'partial', 'rendering'})
        self.assertEqual(len(self.downloads), 1)
        self.assertEqual(self.publish(0)['preview_count'], 1)
        self.assertEqual(len(self.downloads), 1)

    def test_complete_reuses_partial_pages_and_publishes_ready_only_when_complete(self):
        self.publish(0, 2)
        render_tasks.complete_render_task(self.db, self.task_id, self.token, [self.metadata(index) for index in range(3)])
        self.assertEqual(len(self.downloads), 3)
        self.assertEqual(self.task()['status'], 'completed')
        self.assertEqual(self.snapshot['preview_status'], 'ready')
        self.assertEqual(len(self.snapshot['preview_paths']), 3)
        self.assertEqual(json.loads(self.parent()['params'])['workflow_state'], 'awaiting_confirmation')
        for index, path in enumerate(self.snapshot['preview_paths']):
            self.assertEqual(Path(path).read_bytes(), self.images[index])

    def test_output_only_url_never_uploads_or_signs_an_unuploaded_source(self):
        result = render_tasks.refresh_render_task_urls(self.db, self.task_id, self.token, 0, include_source=False)
        self.assertEqual(result['index'], 0)
        self.assertTrue(result['upload_url'])
        self.upload_mock.assert_not_called()
        self.signed_mock.assert_not_called()

    def test_lazy_source_upload_is_bound_to_preallocated_ref_and_reused(self):
        source_ref = self.source_manifest['pages'][0]['source_ref']
        first = render_tasks.refresh_render_task_urls(self.db, self.task_id, self.token, 0, include_source=True)
        second = render_tasks.refresh_render_task_urls(self.db, self.task_id, self.token, 0)
        self.assertEqual(first['download_url'], second['download_url'])
        self.assertEqual(len(self.uploads), 1)
        self.assertEqual(self.uploads[0][0], self.sources[0])
        self.assertEqual('oss://bucket/' + self.uploads[0][1], source_ref)
        self.assertEqual(self.signed_mock.call_args.args[0], source_ref)

    def test_lazy_source_rejects_changed_session_split_path_hash_and_content(self):
        original = copy.deepcopy(self.snapshot)
        invalid = [
            {**original, 'render_attempt': 'f' * 32},
            {**original, 'render_task_id': 'f' * 32},
            {**original, 'split_paths': [str(self.root / 'missing.pptx'), *original['split_paths'][1:]]},
            {**original, 'split_hashes': ['0' * 64, *original['split_hashes'][1:]]},
        ]
        for value in invalid:
            with self.subTest(value=value):
                self.snapshot = value
                with self.assertRaises((PermissionError, ValueError, HTTPException)):
                    render_tasks.refresh_render_task_urls(self.db, self.task_id, self.token, 0, include_source=True)
        self.snapshot = original
        self.sources[0].write_bytes(b'modified split contents')
        with self.assertRaises((PermissionError, ValueError, HTTPException)):
            render_tasks.refresh_render_task_urls(self.db, self.task_id, self.token, 0, include_source=True)
        self.upload_mock.assert_not_called()
        self.signed_mock.assert_not_called()

    def test_lazy_source_failure_does_not_mark_the_source_uploaded(self):
        with patch.object(render_tasks.oss_storage, 'upload_file', side_effect=OSError('object store unavailable')):
            with self.assertRaises(OSError):
                render_tasks.refresh_render_task_urls(self.db, self.task_id, self.token, 0, include_source=True)
        self.signed_mock.assert_not_called()
        result = render_tasks.refresh_render_task_urls(self.db, self.task_id, self.token, 0, include_source=True)
        self.assertTrue(result['download_url'])
        self.assertEqual(len(self.uploads), 1)


if __name__ == '__main__':
    unittest.main()
