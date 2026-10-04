"""Task sockets must follow the same live session boundary as HTTP requests."""

import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import db as database
from app.config import settings
from app.core.permissions import SESSION_COOKIE
from app.core.security import create_session_token
from app.core.task_events import append_task_event
from app.routers.task_events import router


class TaskEventSessionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.db_path = Path(temporary.name) / 'sessions.sqlite'
        self.db = self.connect()
        self.addCleanup(self.db.close)
        self.db.executescript('''
            CREATE TABLE users (id INTEGER PRIMARY KEY, session_version INTEGER, must_change_pwd INTEGER);
            INSERT INTO users VALUES (1, 1, 0), (2, 1, 0);
            CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id INTEGER, task_id INTEGER, event_type TEXT, payload TEXT);
        ''')
        for target, name, value in (
            (settings, 'secret_key', 'task-event-test-key'),
            (settings, 'allowed_host', ''),
            (database, 'get_read_db', self.connect),
            (database, 'release_db', lambda db, **kwargs: db.close()),
        ):
            patcher = patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.client.cookies.set(SESSION_COOKIE, create_session_token(1, settings.secret_key))

    def connect(self):
        db = sqlite3.connect(self.db_path, check_same_thread=False)
        db.row_factory = sqlite3.Row
        return db

    def test_untrusted_browser_cannot_open_cookie_authenticated_socket(self):
        for origin in ('https://untrusted.example', 'null'):
            with self.subTest(origin=origin), self.assertRaises(WebSocketDisconnect) as denied:
                with self.client.websocket_connect('/ws/tasks', headers={'Origin': origin}):
                    pass
            self.assertEqual(denied.exception.code, 1008)

    def test_same_origin_socket_replays_only_current_users_events(self):
        first = append_task_event(self.db, 1, {'type': 'download_completed', 'task_id': 11})
        append_task_event(self.db, 2, {'type': 'download_completed', 'task_id': 22})
        last = append_task_event(self.db, 1, {'type': 'download_progress', 'task_id': 33})
        self.db.commit()
        with self.client.websocket_connect('/ws/tasks?after=0', headers={'Origin': 'http://testserver'}) as socket:
            self.assertEqual(socket.receive_json(), {'type': 'event_cursor', 'event_id': 0})
            self.assertEqual(socket.receive_json()['event_id'], first)
            self.assertEqual(socket.receive_json()['event_id'], last)

    def test_explicit_frontend_origin_is_allowed(self):
        with patch.object(settings, 'allowed_host', 'https://ui.example'):
            with self.client.websocket_connect('/ws/tasks', headers={'Origin': 'https://ui.example'}) as socket:
                self.assertEqual(socket.receive_json()['type'], 'event_cursor')

    def test_expired_cookie_is_rejected_before_handshake(self):
        self.client.cookies.set(SESSION_COOKIE, create_session_token(1, settings.secret_key, ttl_seconds=-10))
        with self.assertRaises(WebSocketDisconnect) as denied:
            with self.client.websocket_connect('/ws/tasks'):
                pass
        self.assertEqual(denied.exception.code, 1008)

    def test_password_reset_change_requirement_and_account_deletion_close_live_socket(self):
        for change in (
            'UPDATE users SET session_version = 2 WHERE id = 1',
            'UPDATE users SET must_change_pwd = 1 WHERE id = 1',
            'DELETE FROM users WHERE id = 1',
        ):
            with self.subTest(change=change):
                self.db.execute('INSERT OR REPLACE INTO users VALUES (1, 1, 0)')
                self.db.commit()
                with self.client.websocket_connect('/ws/tasks') as socket:
                    self.assertEqual(socket.receive_json()['type'], 'event_cursor')
                    self.db.execute(change)
                    self.db.commit()
                    socket.send_text('pong')
                    with self.assertRaises(WebSocketDisconnect) as closed:
                        socket.receive_json()
                    self.assertEqual(closed.exception.code, 1008)

    def test_token_expiry_closes_already_established_socket(self):
        now = time.time()
        self.client.cookies.set(SESSION_COOKIE, create_session_token(1, settings.secret_key, ttl_seconds=60))
        with self.client.websocket_connect('/ws/tasks') as socket:
            self.assertEqual(socket.receive_json()['type'], 'event_cursor')
            with patch('app.core.security.time.time', return_value=now + 120):
                socket.send_text('pong')
                with self.assertRaises(WebSocketDisconnect) as closed:
                    socket.receive_json()
                self.assertEqual(closed.exception.code, 1008)
