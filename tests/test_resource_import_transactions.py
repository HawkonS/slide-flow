"""Import-session transaction/lease tests using only temporary files and SQLite."""

import asyncio
import contextvars
import json
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException, Response
from PIL import Image

from app.config import settings
from app.db import now_iso
from app.routers.resource_import import commit_resource_import
from app.routers.resource_import import resource_import_result
from app.routers.resource_import import resource_import_status
from app.services import files as import_files
from app.services.resource_import import commit as import_commit
from app.services.resource_import import jobs as import_jobs
from app.services.resource_import import render_tasks
from app.services.resource_import import sessions as import_sessions
from app.services.resource_import.remote_fonts import sha256_file
from app.services.resource_import.rendering import RESOURCE_IMPORT_RENDERER_VERSION
from app.services.resources import _insert_version
import logging


class ResourceImportTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="slideflow-import-transactions-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.imports = self.root / "imports"
        self.resources = self.root / "resources"
        self.thumbs = self.root / "thumbs"
        for directory in (self.imports, self.resources, self.thumbs):
            directory.mkdir()
        settings = SimpleNamespace(
            assets_dir=self.root,
            resources_dir=self.resources,
            thumbs_dir=self.thumbs,
            max_concurrent_splits=2,
            image_hd_max_resolution=2560,
            image_hd_format="png",
            image_hd_dpi=300,
            image_hd_quality=90,
            image_thumb_width=64,
            image_thumb_height=36,
            image_thumb_quality=74,
            storage_backend="local",
            abs_path=lambda path: Path(path) if path else None,
            store_path=lambda path: str(path),
        )
        for patcher in (
            patch.object(import_sessions, "settings", settings),
            patch.object(import_sessions, "_resource_import_root", return_value=self.imports),
            patch.object(import_sessions, "_resource_import_sessions", {}),
            patch.object(import_commit, "settings", settings),
            patch.object(import_files, "settings", settings),
            patch.object(import_jobs, "settings", settings),
            patch.object(import_commit, "split_pptx_to_single_pages", side_effect=self.split_source),
            patch.object(import_commit, "_insert_version", side_effect=self.insert_version_fixture),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.addCleanup(self.db.close)
        # Sweeper recovery consults commit receipts. Never let that lookup
        # escape this in-memory DB into the user's configured database.
        database_patch = patch.object(import_sessions, "get_db", return_value=self.db)
        database_patch.start()
        self.addCleanup(database_patch.stop)
        self.db.executescript("""
            CREATE TABLE users (id INTEGER PRIMARY KEY);
            INSERT INTO users (id) VALUES (1), (2);
            CREATE TABLE resources (
                id INTEGER PRIMARY KEY AUTOINCREMENT, detail_token TEXT,
                name TEXT, owner_id INTEGER,
                subject TEXT, tags TEXT, status TEXT, visibility_scope TEXT,
                management_scope TEXT, secrecy_level TEXT, current_version INTEGER,
                updated_by INTEGER, created_at TEXT, updated_at TEXT
            );
            CREATE TABLE resource_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, resource_id INTEGER REFERENCES resources(id),
                version_no INTEGER, ppt_path TEXT, png_path TEXT, font_names TEXT,
                missing_fonts TEXT, common_remark_html TEXT, change_note TEXT,
                created_by INTEGER, created_at TEXT
            );
            CREATE TABLE resource_visibility (resource_id INTEGER REFERENCES resources(id), user_id INTEGER REFERENCES users(id));
            CREATE TABLE resource_management (resource_id INTEGER REFERENCES resources(id), user_id INTEGER REFERENCES users(id));
            CREATE TABLE user_tag_definitions (name TEXT PRIMARY KEY);
            INSERT INTO user_tag_definitions (name) VALUES ('company-leader');
            CREATE TABLE user_tags (user_id INTEGER REFERENCES users(id), tag_name TEXT, PRIMARY KEY (user_id, tag_name));
            CREATE TABLE resource_visibility_tags (resource_id INTEGER REFERENCES resources(id), tag_name TEXT);
            CREATE TABLE resource_management_tags (resource_id INTEGER REFERENCES resources(id), tag_name TEXT);
            CREATE TABLE resource_import_commits (
                session_id TEXT PRIMARY KEY, owner_id INTEGER REFERENCES users(id),
                result_json TEXT NOT NULL, created_at TEXT NOT NULL
            );
        """)
        self.db.commit()
        self.user = {"id": 1}
        self.payload = {"name_prefix": "事务测试", "subject": "测试主体", "visibility_scope": "private", "management_scope": "private"}

    @staticmethod
    def split_source(source, output_dir):
        output_dir.mkdir(parents=True, exist_ok=True)
        count = int(source.read_text(encoding="utf-8"))
        outputs = []
        for index in range(count):
            path = output_dir / f"page_{index + 1}.pptx"
            path.write_bytes(b"isolated split PPT fixture")
            outputs.append(path)
        return outputs

    def insert_version_fixture(
        self, db, *, resource_id, version_no, ppt_path, png_path,
        common_remark_html, change_note, created_by, ppt_ref=None, png_ref=None,
    ):
        """Insert a minimal version row without parsing the fake PPT bytes."""
        ts = now_iso()
        db.execute(
            """INSERT INTO resource_versions (
                resource_id, version_no, ppt_path, png_path, font_names,
                missing_fonts, common_remark_html, change_note, created_by,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                resource_id,
                version_no,
                ppt_ref or str(ppt_path),
                png_ref or (str(png_path) if png_path else None),
                "[]",
                "[]",
                common_remark_html,
                change_note,
                created_by,
                ts,
            ),
        )
        return db.execute(
            "SELECT * FROM resource_versions WHERE resource_id = ? AND version_no = ?",
            (resource_id, version_no),
        ).fetchone()

    def session(self, sid="a" * 32, *, owner=1, slides=2, expired=False):
        directory = self.imports / sid
        directory.mkdir()
        source = directory / "source.pptx"
        source.write_text(str(slides), encoding="utf-8")
        previews = []
        for index in range(slides):
            path = directory / f"preview_{index}.png"
            Image.new("RGB", (160, 90), (index, 100, 200)).save(path)
            previews.append(str(path))
        session = {
            "session_id": sid, "owner_id": owner, "mode": "ppt", "temp_dir": str(directory),
            "source_path": str(source), "image_paths": [], "preview_paths": previews,
            "slide_count": slides, "fonts": [], "missing_fonts": [], "preview_status": "ready",
            "expires_at": time.time() + (-60 if expired else 1800),
        }
        singles = self.split_source(source, directory / "rendered-sources")
        session.update(renderer_version=RESOURCE_IMPORT_RENDERER_VERSION,
                       preview_hashes=[sha256_file(Path(p)) for p in previews],
                       split_paths=[str(p) for p in singles],
                       split_hashes=[sha256_file(p) for p in singles],
                       rendered_source_sha256=sha256_file(source))
        import_sessions._write_resource_import_session(session)
        return session

    async def commit(self, sid, *, user=None, payload=None):
        current_user = user or self.user
        lease = import_sessions._resource_import_locked_session(sid, user=current_user, db=self.db)
        session = await anext(lease)
        try:
            return await commit_resource_import(
                sid, payload=payload or self.payload, user=current_user,
                db=self.db, session=session,
            )
        finally:
            await lease.aclose()

    def count(self, table):
        return self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]

    def test_other_owner_cannot_read_or_lock_session(self):
        session = self.session()
        with self.assertRaises(HTTPException) as caught:
            import_sessions._resource_import_session(session["session_id"], {"id": 2})
        self.assertEqual(caught.exception.status_code, 404)
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(self.commit(session["session_id"], user={"id": 2}))
        self.assertEqual(caught.exception.status_code, 404)
        self.assertTrue(Path(session["temp_dir"]).is_dir())
        self.assertEqual(self.count("resources"), 0)

    def test_commit_requires_explicit_visibility_and_management_scopes(self):
        for missing in ("visibility_scope", "management_scope"):
            session = self.session(sid=("b" if missing == "visibility_scope" else "c") * 32)
            payload = dict(self.payload)
            payload.pop(missing)
            with self.assertRaisesRegex(HTTPException, "请选择") as caught:
                asyncio.run(self.commit(session["session_id"], payload=payload))
            self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(self.count("resources"), 0)

    def test_duplicate_commit_replays_receipt_without_creating_resources(self):
        session = self.session()
        first = asyncio.run(self.commit(session["session_id"]))
        self.assertEqual(first["created"], 2)
        self.assertFalse(Path(session["temp_dir"]).exists())
        before = sorted(str(path) for path in self.root.rglob("*"))
        second = asyncio.run(self.commit(session["session_id"], payload={"name_prefix": "must not create more"}))
        self.assertEqual(second, first)
        self.assertEqual(self.count("resources"), 2)
        self.assertEqual(self.count("resource_versions"), 2)
        self.assertEqual(self.count("resource_import_commits"), 1)
        self.assertEqual(sorted(str(path) for path in self.root.rglob("*")), before)
        response = Response()
        result = resource_import_result(session["session_id"], response, user=self.user, db=self.db)
        self.assertEqual(result, {"status": "completed", **first})
        self.assertIn("no-store", response.headers["Cache-Control"])
        with self.assertRaises(HTTPException) as caught:
            resource_import_result(session["session_id"], Response(), user={"id": 2}, db=self.db)
        self.assertEqual(caught.exception.status_code, 404)

    def test_status_reports_ready_processing_and_completed_snapshots(self):
        session = self.session()
        response = Response()
        ready = resource_import_status(session["session_id"], response, user=self.user, db=self.db)
        self.assertEqual(ready, {"status": "ready", "progress": 0, "total": 2, "message": ""})
        self.assertIn("no-store", response.headers["Cache-Control"])

        session.update(commit_status="processing", commit_progress=1, commit_total=2, commit_message="已保存第 1/2 个单页素材…")
        import_sessions._write_resource_import_session(session)
        processing = resource_import_status(session["session_id"], Response(), user=self.user, db=self.db)
        self.assertEqual(processing, {"status": "processing", "progress": 1, "total": 2, "message": "已保存第 1/2 个单页素材…"})

        self.db.execute(
            "INSERT INTO resource_import_commits VALUES (?, ?, ?, ?)",
            (session["session_id"], 1, json.dumps({"created": 2, "resource_ids": [10, 11]}), now_iso()),
        )
        self.db.commit()
        completed = resource_import_status(session["session_id"], Response(), user=self.user, db=self.db)
        self.assertEqual(completed, {"status": "completed", "created": 2, "progress": 2, "total": 2, "message": "导入完成"})

    def test_commit_publishes_each_page_progress_snapshot(self):
        session = self.session()
        snapshots = []
        write_snapshot = import_commit._write_resource_import_session

        def capture_snapshot(state):
            snapshots.append(dict(state))
            write_snapshot(state)

        with patch.object(import_commit, "_write_resource_import_session", side_effect=capture_snapshot):
            result = asyncio.run(self.commit(session["session_id"]))
        self.assertEqual(result["created"], 2)
        self.assertEqual([item["commit_progress"] for item in snapshots], [0, 1, 2])
        self.assertTrue(all(item["commit_status"] == "processing" for item in snapshots))
        self.assertEqual([item["commit_total"] for item in snapshots], [2, 2, 2])

    def test_commit_applies_dynamic_tag_grants_to_every_created_resource(self):
        session = self.session()
        payload = {
            **self.payload,
            "visibility_scope": "partial",
            "management_scope": "partial",
            "visible_user_tags": ["company-leader"],
            "manage_user_tags": ["company-leader"],
        }
        result = asyncio.run(self.commit(session["session_id"], payload=payload))
        self.assertEqual(result["created"], 2)
        self.assertEqual(
            self.db.execute(
                "SELECT COUNT(*) FROM resource_visibility_tags WHERE tag_name = 'company-leader'"
            ).fetchone()[0],
            2,
        )
        self.assertEqual(
            self.db.execute(
                "SELECT COUNT(*) FROM resource_management_tags WHERE tag_name = 'company-leader'"
            ).fetchone()[0],
            2,
        )

    def test_concurrent_session_lease_fails_fast_with_conflict(self):
        session = self.session()
        with import_sessions._resource_import_operation(session):
            with self.assertRaises(HTTPException) as caught:
                with import_sessions._resource_import_operation(session):
                    self.fail("two leases acquired for one session")
            self.assertEqual(caught.exception.status_code, 409)
            with self.assertRaises(HTTPException) as still_locked:
                with import_sessions._resource_import_operation(session):
                    self.fail("failed competitor released the original lease")
            self.assertEqual(still_locked.exception.status_code, 409)
        with import_sessions._resource_import_operation(session):
            pass  # A conflict must not accidentally release the first lease.

    def test_expiry_sweep_skips_active_lease_then_cleans_when_released(self):
        session = self.session(expired=True)
        directory = Path(session["temp_dir"])
        with import_sessions._resource_import_operation(session):
            import_sessions._cleanup_expired_resource_imports()
            self.assertTrue(directory.is_dir())
        import_sessions._cleanup_expired_resource_imports()
        self.assertFalse(directory.exists())

    def test_expiry_cancels_durable_windows_render_before_deleting_session(self):
        session = self.session(expired=True)
        session["render_task_id"] = "d" * 32
        import_sessions._write_resource_import_session(session)
        with patch.object(render_tasks, "cancel_render_tasks") as cancel:
            import_sessions._cleanup_expired_resource_imports()
        cancel.assert_called_once_with(self.db, session["session_id"])
        self.assertFalse(Path(session["temp_dir"]).exists())

    def test_stale_in_memory_session_cannot_revive_deleted_metadata(self):
        session = self.session()
        sid = session["session_id"]
        import_sessions._resource_import_sessions[sid] = session
        (Path(session["temp_dir"]) / "session.json").unlink()
        with self.assertRaises(HTTPException) as caught:
            import_sessions._resource_import_session(sid, self.user)
        self.assertEqual(caught.exception.status_code, 404)
        self.assertFalse((Path(session["temp_dir"]) / "session.json").exists())

    def test_page_failure_rolls_back_database_files_and_session(self):
        session = self.session()
        actual_persist = import_commit.persist_asset
        calls = 0

        def fail_second_page_png(path, category):
            nonlocal calls
            calls += 1
            if calls == 4:
                raise OSError("injected second-page PNG upload failure")
            return actual_persist(path, category)

        with patch.object(import_commit, "persist_asset", side_effect=fail_second_page_png), self.assertLogs(import_commit.logger, level="ERROR"):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(self.commit(session["session_id"]))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(calls, 4)
        for table in (
            "resources", "resource_versions", "resource_visibility", "resource_management",
            "resource_visibility_tags", "resource_management_tags", "resource_import_commits",
        ):
            self.assertEqual(self.count(table), 0, table)
        self.assertEqual(list(self.resources.iterdir()), [])
        self.assertEqual(list(self.thumbs.iterdir()), [])
        self.assertFalse(Path(session["temp_dir"]).exists())

    def test_validation_failure_keeps_session_recoverable_and_creates_nothing(self):
        session = self.session()
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(self.commit(session["session_id"], payload={**self.payload, "visible_user_ids": [999]}))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertTrue(Path(session["temp_dir"]).is_dir())
        self.assertEqual(self.count("resources"), 0)
        self.assertEqual(list(self.resources.iterdir()), [])
        self.assertEqual(list(self.thumbs.iterdir()), [])
        self.assertEqual(asyncio.run(self.commit(session["session_id"]))["created"], 2)

    def test_post_commit_cleanup_failure_never_deletes_committed_artefacts(self):
        session = self.session()
        with patch.object(import_commit, "_cleanup_resource_import_session", side_effect=OSError("injected cleanup failure")), self.assertLogs(import_commit.logger, level="ERROR"):
            result = asyncio.run(self.commit(session["session_id"]))
        self.assertEqual(result["created"], 2)
        self.assertEqual(self.count("resources"), 2)
        self.assertEqual(self.count("resource_versions"), 2)
        self.assertEqual(self.count("resource_import_commits"), 1)
        self.assertEqual(len(list(self.resources.iterdir())), 4)
        self.assertEqual(len(list(self.thumbs.iterdir())), 0)
        for row in self.db.execute("SELECT ppt_path, png_path FROM resource_versions"):
            self.assertTrue(Path(row["ppt_path"]).is_file())
            self.assertTrue(Path(row["png_path"]).is_file())
        self.assertEqual(asyncio.run(self.commit(session["session_id"])), result)

    def test_expiry_reclaims_journaled_uncommitted_outputs(self):
        session = self.session(expired=True)
        resource = self.resources / ("b" * 32)
        resource.mkdir()
        (resource / "v1.pptx").write_bytes(b"orphan")
        thumb = self.thumbs / "preview_v123_456.jpg"
        thumb.write_bytes(b"orphan")
        session["created_dirs"] = [str(resource)]
        session["created_thumbs"] = [str(thumb)]
        import_sessions._write_resource_import_session(session)
        import_sessions._cleanup_expired_resource_imports()
        self.assertFalse(resource.exists())
        self.assertFalse(thumb.exists())
        self.assertFalse(Path(session["temp_dir"]).exists())

    def test_expiry_preserves_outputs_when_commit_receipt_exists(self):
        session = self.session(expired=True)
        resource = self.resources / ("b" * 32)
        resource.mkdir()
        thumb = self.thumbs / "preview_v123_456.jpg"
        thumb.write_bytes(b"committed thumbnail")
        session["created_dirs"] = [str(resource)]
        session["created_thumbs"] = [str(thumb)]
        import_sessions._write_resource_import_session(session)
        self.db.execute(
            "INSERT INTO resource_import_commits VALUES (?, ?, ?, ?)",
            (session["session_id"], 1, json.dumps({"created": 1, "resource_ids": [123]}), now_iso()),
        )
        self.db.commit()
        import_sessions._cleanup_expired_resource_imports()
        self.assertTrue(resource.is_dir())
        self.assertTrue(thumb.is_file())
        self.assertFalse(Path(session["temp_dir"]).exists())

    def test_repeated_cancellation_keeps_slot_and_session_locked_until_thread_finishes(self):
        session = self.session()
        started = threading.Event()
        release_worker = threading.Event()
        finished = threading.Event()
        context_marker = contextvars.ContextVar("import_test_context", default="missing")
        observed_context = []

        def work():
            observed_context.append(context_marker.get())
            started.set()
            release_worker.wait(5)
            finished.set()
            return "completed"

        async def run_locked_job():
            with import_sessions._resource_import_operation(session):
                return await import_jobs._run_resource_import_job(work)

        async def exercise():
            context_marker.set("request context")
            request = asyncio.create_task(run_locked_job())
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 2))
                for _ in range(2):
                    request.cancel()
                    await asyncio.sleep(0.01)
                    self.assertFalse(request.done(), "request must retain leases while worker is running")
                    self.assertFalse(finished.is_set())
                with self.assertRaises(HTTPException) as conflict:
                    with import_sessions._resource_import_operation(session):
                        self.fail("session lease released before worker completion")
                self.assertEqual(conflict.exception.status_code, 409)
                with self.assertRaises(HTTPException) as capacity:
                    await import_jobs._run_resource_import_job(lambda: "competing worker")
                self.assertEqual(capacity.exception.status_code, 429)
                release_worker.set()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(request, 2)
                self.assertTrue(finished.is_set())
                with import_sessions._resource_import_operation(session):
                    pass
                self.assertEqual(await import_jobs._run_resource_import_job(lambda: "slot released"), "slot released")
            finally:
                release_worker.set()
                try:
                    await request
                except asyncio.CancelledError:
                    pass

        with patch.object(import_jobs.settings, "max_concurrent_splits", 1):
            asyncio.run(exercise())
        self.assertEqual(observed_context, ["request context"])

    def test_expiry_reclaims_crashed_thumbnail_temporary_file_without_final_jpeg(self):
        session = self.session(expired=True)
        resource = self.resources / ("b" * 32)
        resource.mkdir()
        thumb = self.thumbs / "preview_v123_456_64x36_q74.jpg"
        hidden_temp = self.thumbs / f".{thumb.name}.{'c' * 32}.tmp"
        hidden_temp.write_bytes(b"incomplete encoded thumbnail from crashed worker")
        session["created_dirs"] = [str(resource)]
        session["created_thumbs"] = [str(thumb)]
        import_sessions._write_resource_import_session(session)
        import_sessions._cleanup_expired_resource_imports()
        self.assertFalse(hidden_temp.exists())
        self.assertFalse(resource.exists())
        self.assertFalse(Path(session["temp_dir"]).exists())

    def test_thumbnail_temp_recovery_does_not_remove_neighbors_or_symlinks(self):
        thumb = self.thumbs / "preview_v123_456_64x36_q74.jpg"
        valid = self.thumbs / f".{thumb.name}.{'a' * 32}.tmp"
        valid.write_bytes(b"orphan temp")
        neighbors = [
            self.thumbs / f".preview_v124_456_64x36_q74.jpg.{'a' * 32}.tmp",
            self.thumbs / f".{thumb.name}.{'a' * 31}.tmp",
            self.thumbs / f".{thumb.name}.{'a' * 33}.tmp",
            self.thumbs / f".{thumb.name}.{'g' * 32}.tmp",
            self.thumbs / f".{thumb.name}.{'a' * 32}.tmp.bak",
            self.thumbs / "unrelated.jpg",
        ]
        for path in neighbors:
            path.write_bytes(b"must be retained")
        directory = self.thumbs / f".{thumb.name}.{'d' * 32}.tmp"
        directory.mkdir()
        external = self.root / "do-not-delete.jpg"
        external.write_bytes(b"outside target")
        symlink = self.thumbs / f".{thumb.name}.{'e' * 32}.tmp"
        symlink.symlink_to(external)
        # A tampered journal entry must not make an external path eligible.
        external_temp = self.root / f".{thumb.name}.{'f' * 32}.tmp"
        external_temp.write_bytes(b"outside temp")
        import_sessions._rollback_resource_import_files({"created_thumbs": [str(thumb), str(self.root / thumb.name)]})
        self.assertFalse(valid.exists())
        for path in neighbors:
            self.assertEqual(path.read_bytes(), b"must be retained", path.name)
        self.assertTrue(directory.is_dir())
        self.assertTrue(symlink.is_symlink())
        self.assertEqual(external.read_bytes(), b"outside target")
        self.assertEqual(external_temp.read_bytes(), b"outside temp")


if __name__ == "__main__":
    unittest.main()
