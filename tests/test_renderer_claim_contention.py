from __future__ import annotations

import sqlite3
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.db import is_sqlite_busy_error
from app.routers import renderer_font_tasks, renderer_render_tasks


class SqliteBusyDetectionTests(unittest.TestCase):
    def test_detects_busy_and_locked_errors_only(self):
        self.assertTrue(is_sqlite_busy_error(sqlite3.OperationalError("database is locked")))
        self.assertTrue(is_sqlite_busy_error(sqlite3.OperationalError("database table is locked")))
        self.assertFalse(is_sqlite_busy_error(sqlite3.OperationalError("no such table: tasks")))
        self.assertFalse(is_sqlite_busy_error(RuntimeError("database is locked")))


class RendererClaimContentionTests(unittest.IsolatedAsyncioTestCase):
    async def test_render_claim_treats_write_lock_as_transient_empty_queue(self):
        heartbeat_db = MagicMock()
        claim_db = MagicMock()
        with (
            patch.object(renderer_render_tasks, "get_db", side_effect=[heartbeat_db, claim_db]),
            patch.object(renderer_render_tasks, "touch_renderer_worker"),
            patch.object(
                renderer_render_tasks,
                "claim_render_task",
                side_effect=sqlite3.OperationalError("database is locked"),
            ),
        ):
            result = await renderer_render_tasks.claim(
                worker_id="dev-render-pull", wait_seconds=0, _=None,
            )

        self.assertEqual(result, {"task": None})
        claim_db.rollback.assert_called_once_with()
        heartbeat_db.close.assert_called_once_with()
        claim_db.close.assert_called_once_with()

    async def test_render_claim_does_not_hide_other_database_errors(self):
        heartbeat_db = MagicMock()
        claim_db = MagicMock()
        with (
            patch.object(renderer_render_tasks, "get_db", side_effect=[heartbeat_db, claim_db]),
            patch.object(renderer_render_tasks, "touch_renderer_worker"),
            patch.object(
                renderer_render_tasks,
                "claim_render_task",
                side_effect=sqlite3.OperationalError("no such table: renderer_ppt_tasks"),
            ),
        ):
            with self.assertRaisesRegex(sqlite3.OperationalError, "no such table"):
                await renderer_render_tasks.claim(
                    worker_id="dev-render-pull", wait_seconds=0, _=None,
                )


class FontClaimContentionTests(unittest.TestCase):
    def test_font_claim_treats_write_lock_as_transient_empty_queue(self):
        db = MagicMock()
        request = SimpleNamespace(query_params={})
        with (
            patch.object(renderer_font_tasks, "get_db", return_value=db),
            patch.object(renderer_font_tasks, "ensure_all_font_tasks"),
            patch.object(
                renderer_font_tasks,
                "claim_font_task",
                side_effect=sqlite3.OperationalError("database is locked"),
            ),
        ):
            result = renderer_font_tasks.claim(request=request, _=None)

        self.assertEqual(result, {"task": None})
        db.rollback.assert_called_once_with()
        db.close.assert_called_once_with()

    def test_font_claim_does_not_hide_other_database_errors(self):
        db = MagicMock()
        request = SimpleNamespace(query_params={})
        with (
            patch.object(renderer_font_tasks, "get_db", return_value=db),
            patch.object(renderer_font_tasks, "ensure_all_font_tasks"),
            patch.object(
                renderer_font_tasks,
                "claim_font_task",
                side_effect=sqlite3.OperationalError("no such table: renderer_font_tasks"),
            ),
        ):
            with self.assertRaisesRegex(sqlite3.OperationalError, "no such table"):
                renderer_font_tasks.claim(request=request, _=None)


if __name__ == "__main__":
    unittest.main()
