import asyncio
import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from app import db as database
from app.core import download_tasks
from app.services.downloads import cache, cleanup


class DownloadCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_expiration_removes_only_task_outputs_and_expired_cache(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            outputs, cache_dir = root / 'tasks', root / 'cache'
            outputs.mkdir()
            cache_dir.mkdir()
            original = root / 'original.pptx'
            original.write_bytes(b'never delete source assets')
            for task_id in (1, 2, 3):
                (outputs / f'task_{task_id}.zip').write_bytes(b'export')
            fresh, expired = cache_dir / 'fresh.zip', cache_dir / 'expired.zip'
            fresh.write_bytes(b'fresh')
            expired.write_bytes(b'expired')
            old = datetime.now() - timedelta(days=2)
            os.utime(expired, (old.timestamp(), old.timestamp()))
            now = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
            db = sqlite3.connect(root / 'tasks.sqlite', check_same_thread=False)
            db.row_factory = sqlite3.Row
            try:
                db.executescript('''
                    CREATE TABLE tasks (id INTEGER PRIMARY KEY, task_type TEXT, status TEXT,
                        result_data TEXT, completed_at TEXT, updated_at TEXT);
                    CREATE TABLE task_events (id INTEGER PRIMARY KEY, created_at TEXT);
                ''')
                db.executemany('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)', [
                    (1, 'download', 'completed', json.dumps({'file_path': str(original)}), old.isoformat(), now),
                    (2, 'download', 'completed', '[]', old.isoformat(), now),
                    (3, 'download', 'completed', '{}', now, now),
                ])
                db.executemany('INSERT INTO task_events VALUES (?, ?)', [(1, old.isoformat()), (2, now)])
                db.commit()
                with patch.object(database, 'get_write_db', return_value=db), \
                     patch.object(database, 'release_db'), \
                     patch.object(download_tasks, '_DOWNLOAD_TASKS_DIR', outputs), \
                     patch.object(cache, '_DOWNLOAD_CACHE_DIR', cache_dir), \
                     patch.object(cleanup.asyncio, 'sleep', side_effect=[None, asyncio.CancelledError()]):
                    await cleanup._download_cleanup_loop()
                self.assertEqual(original.read_bytes(), b'never delete source assets')
                self.assertEqual(list(outputs.iterdir()), [outputs / 'task_3.zip'])
                self.assertEqual(list(cache_dir.iterdir()), [fresh])
                self.assertEqual([row[0] for row in db.execute('SELECT id FROM task_events')], [2])
                for task_id in (1, 2):
                    result = db.execute('SELECT result_data FROM tasks WHERE id = ?', (task_id,)).fetchone()[0]
                    self.assertEqual(json.loads(result), {'expired': True})
            finally:
                db.close()
