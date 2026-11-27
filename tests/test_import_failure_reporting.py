"""Import failures must name the real cause and leave the task settled.

A PPT structure failure used to be reported as "check the Windows conversion
node" and the failure handler itself crashed on the missing ``params`` column,
so the task stayed ``pending`` and the browser kept retrying.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from app.core.errors import (
    IMPORT_GENERIC_MESSAGE,
    RENDERER_GENERIC_MESSAGE,
    import_public_message,
)
from app.core.ppt_modules.errors import PptStructureError
from app.services.resource_import import sessions, streaming
from app.services.tasks import resource_import as task_module
from app.services.tasks.records import _serialize_task

STRUCTURE_MESSAGE = "第 2 页的幻灯片关系无效，不能安全拆分"


class PublicMessageTests(unittest.TestCase):
    def test_structure_failure_reports_the_page_problem(self):
        self.assertEqual(
            import_public_message(PptStructureError(STRUCTURE_MESSAGE), rendering=True),
            STRUCTURE_MESSAGE,
        )

    def test_vendor_failure_keeps_the_generic_renderer_copy(self):
        self.assertEqual(
            import_public_message(RuntimeError("oss2 500 internal detail"), rendering=True),
            RENDERER_GENERIC_MESSAGE,
        )
        self.assertEqual(
            import_public_message(RuntimeError("oss2 500 internal detail")),
            IMPORT_GENERIC_MESSAGE,
        )


class TaskFailureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-import-failure-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.db_path = self.root / "tasks.db"
        with self._connect() as db:
            db.executescript(
                """
                CREATE TABLE tasks (
                    id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
                    message TEXT DEFAULT '', progress INTEGER DEFAULT 0, total INTEGER DEFAULT 0,
                    params TEXT DEFAULT '{}', error_message TEXT, updated_at TEXT
                );
                """
            )
            db.execute(
                "INSERT INTO tasks (id, status, params) VALUES (7, 'pending', ?)",
                (json.dumps({"slide_count": 0}),),
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        return connection

    def test_structure_failure_marks_the_task_failed(self):
        session = {
            "session_id": "c" * 32,
            "source_path": str(self.root / "source.pptx"),
            "temp_dir": str(self.root),
        }
        Path(session["source_path"]).write_bytes(b"pptx placeholder")

        with (
            patch.object(task_module, "get_db", side_effect=self._connect),
            patch.object(task_module, "_session_for_task", return_value=dict(session)),
            patch.object(task_module, "_resource_import_file", side_effect=lambda _session, path: Path(path)),
            patch.object(task_module, "_resource_import_temp_dir", return_value=self.root),
            patch.object(task_module, "_write_resource_import_session"),
            patch.object(task_module, "_validate_import_ppt_package"),
            patch.object(task_module, "_normalize_import_ppt", side_effect=lambda source, _temp: source),
            patch.object(task_module, "slide_count", return_value=3),
            patch.object(
                task_module, "_split_import_pages",
                side_effect=PptStructureError(STRUCTURE_MESSAGE),
            ),
        ):
            task_module._execute_resource_import_task(7, session["session_id"])

        with self._connect() as db:
            row = db.execute("SELECT status, error_message, params FROM tasks WHERE id = 7").fetchone()
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["error_message"], STRUCTURE_MESSAGE)
        params = json.loads(row["params"])
        self.assertEqual(params["preview_error"], STRUCTURE_MESSAGE)
        self.assertEqual(params["preview_status"], "error")


class PreviewErrorPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-preview-error-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.session_dir = self.root / ("d" * 32)
        self.session_dir.mkdir()
        patcher = patch.object(sessions, "_resource_import_root", return_value=self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.session = {
            "session_id": "d" * 32,
            "owner_id": 1,
            "temp_dir": str(self.session_dir),
            "source_path": str(self.session_dir / "source.pptx"),
            "slide_count": 3,
            "preview_status": "pending",
            "expires_at": time.time() + 600,
        }
        sessions._write_resource_import_session(self.session)
        self.db_path = self.root / "tasks.db"
        with self._connect() as db:
            db.execute(
                "CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT, message TEXT,"
                " error_message TEXT, params TEXT, updated_at TEXT)"
            )
            db.execute(
                "INSERT INTO tasks (id, status, message, error_message, params, updated_at)"
                " VALUES (11, 'pending', '', NULL, ?, '')",
                (json.dumps({"task_id": 11, "workflow_state": "rendering"}),),
            )
        patcher = patch.object(streaming, "get_db", side_effect=self._connect)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.session["task_id"] = 11

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        return connection

    def _task(self):
        with self._connect() as db:
            return db.execute("SELECT status, error_message, params FROM tasks WHERE id = 11").fetchone()

    def test_terminal_failure_settles_the_task_as_failed(self):
        streaming._persist_render_error(self.session, STRUCTURE_MESSAGE, terminal=True)

        row = self._task()
        self.assertEqual(row["status"], "failed")
        params = json.loads(row["params"])
        self.assertEqual(params["workflow_state"], "failed")
        self.assertEqual(params["preview_error"], STRUCTURE_MESSAGE)
        current = sessions._load_resource_import_session_file(self.session["session_id"])
        self.assertEqual(current["preview_status"], "error")

    def test_transient_failure_keeps_the_task_waiting(self):
        streaming._persist_render_error(self.session, RENDERER_GENERIC_MESSAGE)

        row = self._task()
        self.assertEqual(row["status"], "pending")
        params = json.loads(row["params"])
        self.assertEqual(params["workflow_state"], "awaiting_render")


class StructureErrorMessageSerializationTests(unittest.TestCase):
    """The API must show the split diagnostics, never raw exception text."""

    def _serialized(self, params: dict, error: str) -> dict:
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        db.execute(
            "CREATE TABLE tasks (id INTEGER, task_type TEXT, status TEXT, owner_id INTEGER,"
            " progress INTEGER, upload_progress INTEGER, total INTEGER, params TEXT,"
            " result_data TEXT, error_message TEXT, message TEXT, created_at TEXT,"
            " updated_at TEXT, completed_at TEXT)"
        )
        db.execute(
            "INSERT INTO tasks VALUES (1, 'batch_split_import', 'failed', 1, 0, 0, 0, ?, NULL, ?, '', '', '', NULL)",
            (json.dumps(params), error),
        )
        row = db.execute("SELECT * FROM tasks WHERE id = 1").fetchone()
        try:
            return _serialize_task(row)
        finally:
            db.close()

    def test_structure_error_is_shown_verbatim(self):
        serialized = self._serialized({"error_kind": "ppt_structure"}, STRUCTURE_MESSAGE)
        self.assertEqual(serialized["error_message"], STRUCTURE_MESSAGE)

    def test_unmarked_error_keeps_the_generic_fallback(self):
        serialized = self._serialized({}, "Traceback: /srv/app/secret/path.py")
        self.assertEqual(serialized["error_message"], "任务处理失败，请重试或联系管理员")

    def test_stripped_links_are_exposed_to_the_import_dialog(self):
        links = [{"page": 2, "count": 1}]
        serialized = self._serialized({"stripped_links": links}, "")
        self.assertEqual(serialized["params"]["stripped_links"], links)


if __name__ == "__main__":
    unittest.main()
