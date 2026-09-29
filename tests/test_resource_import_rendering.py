"""Pull-render preview state regression tests."""
from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from PIL import Image
from fastapi import HTTPException

from app.routers.resource_import import resource_import_preview
from app.services.resource_import import font_tasks, previews, render_tasks, sessions, streaming
from app.services.resource_import.rendering import (
    RESOURCE_IMPORT_RENDERER_VERSION,
    _normalize_import_ppt,
)


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.session_dir = self.root / ("a" * 32)
        self.session_dir.mkdir()
        source = self.session_dir / "source.pptx"
        source.write_bytes(b"original curves and alpha must not change")
        self.session = dict(
            session_id="a" * 32, owner_id=1, temp_dir=str(self.session_dir),
            source_path=str(source), slide_count=2, fonts=[], missing_fonts=[],
            mode="ppt", preview_paths=[], preview_status="pending", expires_at=time.time() + 600,
        )
        patcher = patch.object(sessions, "_resource_import_root", return_value=self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        sessions._write_resource_import_session(self.session)

    def ready_snapshot(self):
        attempt = self.session.get("render_attempt", "b" * 32)
        directory = self.session_dir / f"previews_{attempt}"
        directory.mkdir(exist_ok=True)
        paths = []
        for index in range(2):
            path = directory / f"page_{index:04d}.png"
            Image.new("RGB", (16, 9)).save(path)
            paths.append(str(path))
        updated = dict(self.session, preview_status="ready", preview_paths=paths,
                       render_attempt=attempt, renderer_version=RESOURCE_IMPORT_RENDERER_VERSION)
        sessions._write_resource_import_session(updated)
        return updated

    def install_partial_receipt(self):
        self.session.update(render_attempt="b" * 32, render_task_id="c" * 32,
                            render_worker_attempt=1, preview_status="rendering",
                            renderer_version=RESOURCE_IMPORT_RENDERER_VERSION)
        directory = self.session_dir / f"previews_{self.session['render_attempt']}"
        directory.mkdir()
        self.partial_path = directory / "page_0000.png"
        Image.new("RGB", (16, 9)).save(self.partial_path)
        digest = hashlib.sha256(self.partial_path.read_bytes()).hexdigest()
        receipt = {
            "worker_attempt": 1,
            "pages": [{"index": 0, "size": self.partial_path.stat().st_size, "sha256": digest}],
            "partial_preview_paths": {"0": str(self.partial_path)},
            "partial_preview_hashes": {"0": digest},
        }
        self.session.update(partial_preview_paths={"0": str(self.partial_path)},
                            partial_preview_hashes={"0": digest})
        sessions._write_resource_import_session(self.session)
        self.db_path = self.root / "render.sqlite3"
        self.render_db = self.connect_render_db()
        self.addCleanup(self.render_db.close)
        self.render_db.execute("""
            CREATE TABLE renderer_ppt_tasks (
                task_id TEXT PRIMARY KEY, session_id TEXT, render_attempt TEXT,
                parent_task_id INTEGER, status TEXT, attempts INTEGER,
                source_manifest TEXT, result_manifest TEXT, error_code TEXT
            )
        """)
        self.render_db.execute("INSERT INTO renderer_ppt_tasks VALUES (?,?,?,?,?,?,?,?,?)", (
            self.session["render_task_id"], self.session["session_id"], self.session["render_attempt"],
            None, "running", 1, json.dumps({"pages": [{"index": 0}, {"index": 1}]}),
            json.dumps(receipt), None,
        ))
        self.render_db.commit()
        patcher = patch.object(render_tasks, "get_db", side_effect=self.connect_render_db)
        patcher.start()
        self.addCleanup(patcher.stop)

    def connect_render_db(self):
        db = sqlite3.connect(self.db_path)
        db.row_factory = sqlite3.Row
        return db

    def test_no_normalization_roundtrip(self):
        source = Path(self.session["source_path"])
        self.assertEqual(_normalize_import_ppt(source, self.session_dir), source)
        alias = source.with_suffix(".potx")
        alias.write_bytes(source.read_bytes())
        self.assertEqual(_normalize_import_ppt(alias, self.session_dir).read_bytes(), source.read_bytes())
        with self.assertRaisesRegex(RuntimeError, "PPTX"):
            _normalize_import_ppt(source.with_suffix(".ppt"), self.session_dir)

    def test_wait_wrapper_observes_completed_pull_task(self):
        events = []
        attempts = {"count": 0}

        def state(_session):
            attempts["count"] += 1
            if attempts["count"] == 1:
                return {"status": "running"}
            attempt = "b" * 32
            directory = self.session_dir / f"previews_{attempt}"
            directory.mkdir(exist_ok=True)
            paths = []
            for index in range(2):
                target = directory / f"page_{index:04d}.png"
                Image.new("RGB", (16, 9)).save(target)
                paths.append(str(target))
            updated = dict(self.session, preview_status="ready", preview_paths=paths,
                           render_attempt=attempt, renderer_version=RESOURCE_IMPORT_RENDERER_VERSION)
            sessions._write_resource_import_session(updated)
            return {"status": "completed", "preview_count": 2}

        with patch.object(previews, "ensure_render_task"), patch.object(previews, "render_task_state", side_effect=state), patch.object(previews.time, "sleep"):
            result = previews._render_and_publish_ppt_previews(self.session, events.append)
        self.assertEqual(len(result), 2)
        self.assertEqual([item["index"] for item in events if item["type"] == "page"], [0, 1])

    def test_stream_disconnect_does_not_cancel_durable_task(self):
        async def scenario():
            response = streaming.preview_stream(self.session["session_id"], {"id": 1})
            events = response.body_iterator
            self.assertEqual(json.loads(await anext(events))["type"], "started")
            await events.aclose()

        with patch.object(streaming, "ensure_render_task") as ensure:
            asyncio.run(scenario())
        ensure.assert_called_once()

    def test_stream_returns_completed_pages(self):
        attempt = "c" * 32
        paths = []
        directory = self.session_dir / f"previews_{attempt}"
        directory.mkdir()
        for index in range(2):
            path = directory / f"page_{index:04d}.png"
            Image.new("RGB", (16, 9)).save(path)
            paths.append(str(path))
        updated = dict(self.session, preview_status="ready", preview_paths=paths,
                       render_attempt=attempt, renderer_version=RESOURCE_IMPORT_RENDERER_VERSION)
        sessions._write_resource_import_session(updated)

        async def scenario():
            response = streaming.preview_stream(self.session["session_id"], {"id": 1})
            events = []
            async for raw in response.body_iterator:
                events.append(json.loads(raw))
            return events

        events = asyncio.run(scenario())
        self.assertEqual([item["type"] for item in events], ["started", "page", "page", "completed"])

    def test_stream_timeout_does_not_cancel_durable_task(self):
        async def scenario():
            response = streaming.preview_stream(self.session["session_id"], {"id": 1})
            events = response.body_iterator
            started = json.loads(await anext(events))
            timed_out = json.loads(await anext(events))
            await events.aclose()
            return started, timed_out

        with (
            patch.object(streaming, "ensure_render_task"),
            patch.object(streaming, "render_task_state", return_value={"status": "running"}),
            patch.object(streaming.settings, "render_total_timeout", 10),
            patch.object(streaming, "time") as stream_time,
            patch.object(streaming, "_persist_render_error") as persist_error,
        ):
            stream_time.monotonic.side_effect = [0, 0, 11]
            started, timed_out = asyncio.run(scenario())

        self.assertEqual(started["type"], "started")
        self.assertEqual(timed_out["type"], "error")
        self.assertIs(timed_out["recoverable"], True)
        persist_error.assert_not_called()
        current = sessions._load_resource_import_session_file(self.session["session_id"])
        self.assertEqual(current["preview_status"], "pending")

    def test_get_image_never_starts_conversion(self):
        self.session.update(renderer_version="old", preview_paths=[self.session["source_path"]], preview_status="ready")
        sessions._write_resource_import_session(self.session)
        with self.assertRaises(HTTPException) as caught:
            resource_import_preview(self.session["session_id"], 0, user={"id": 1})
        self.assertEqual(caught.exception.status_code, 409)

    def test_stream_emits_partial_before_next_poll_and_deduplicates_at_completion(self):
        polls = 0

        def state(current):
            nonlocal polls
            polls += 1
            if polls < 3:
                return {"status": "running", "preview_count": 1, "ready_indexes": [0],
                        "attempts": 1, "render_attempt": "b" * 32}
            current.update(self.ready_snapshot())
            return {"status": "completed", "preview_count": 2, "ready_indexes": [0, 1],
                    "attempts": 1, "render_attempt": "b" * 32}

        async def scenario():
            response = streaming.preview_stream(self.session["session_id"], {"id": 1})
            iterator = response.body_iterator
            self.assertEqual(json.loads(await anext(iterator))["type"], "started")
            first = json.loads(await anext(iterator))
            self.assertEqual(first["index"], 0)
            self.assertEqual(polls, 1)
            remaining = [json.loads(raw) async for raw in iterator]
            return [first, *remaining]

        with (patch.object(streaming, "ensure_render_task"),
              patch.object(streaming, "render_task_state", side_effect=state),
              patch.object(streaming.asyncio, "sleep", new_callable=AsyncMock)):
            events = asyncio.run(scenario())
        pages = [event for event in events if event["type"] == "page"]
        self.assertEqual([event["index"] for event in pages], [0, 1])
        self.assertTrue(all("worker_attempt=1" in event["preview_url"] for event in pages))
        self.assertEqual(events[-1]["type"], "completed")

    def test_stream_reconnect_replays_current_partial_once(self):
        self.install_partial_receipt()

        async def scenario():
            page_events = []
            for _ in range(2):
                response = streaming.preview_stream(self.session["session_id"], {"id": 1})
                iterator = response.body_iterator
                self.assertEqual(json.loads(await anext(iterator))["type"], "started")
                page_events.append(json.loads(await anext(iterator)))
                await iterator.aclose()
            return page_events

        with patch.object(streaming, "ensure_render_task"):
            events = asyncio.run(scenario())
        self.assertEqual([event["index"] for event in events], [0, 0])
        self.assertEqual(events[0]["preview_url"], events[1]["preview_url"])
        self.assertIn("worker_attempt=1", events[0]["preview_url"])

    def test_stream_reclaim_emits_only_new_worker_urls_after_reset(self):
        states = iter([
            {"status": "running", "preview_count": 1, "ready_indexes": [0], "attempts": 1},
            {"status": "running", "preview_count": 0, "ready_indexes": [], "attempts": 2},
            {"status": "running", "preview_count": 1, "ready_indexes": [0], "attempts": 2},
            {"status": "error", "message": "end test"},
        ])

        async def scenario():
            response = streaming.preview_stream(self.session["session_id"], {"id": 1})
            return [json.loads(raw) async for raw in response.body_iterator]

        with (patch.object(streaming, "ensure_render_task"),
              patch.object(streaming, "render_task_state", side_effect=lambda _: next(states)),
              patch.object(streaming.asyncio, "sleep", new_callable=AsyncMock)):
            events = asyncio.run(scenario())
        pages = [event for event in events if event["type"] == "page"]
        self.assertEqual([event["index"] for event in pages], [0, 0])
        self.assertIn("worker_attempt=1", pages[0]["preview_url"])
        self.assertIn("worker_attempt=2", pages[1]["preview_url"])
        self.assertNotIn("completed", [event["type"] for event in events])

    def test_stream_does_not_trust_ready_snapshot_for_cancelled_task(self):
        self.install_partial_receipt()
        self.session = self.ready_snapshot()
        self.render_db.execute("UPDATE renderer_ppt_tasks SET status='cancelled'")
        self.render_db.commit()

        async def scenario():
            response = streaming.preview_stream(self.session["session_id"], {"id": 1})
            return [json.loads(raw) async for raw in response.body_iterator]

        events = asyncio.run(scenario())
        self.assertEqual([event["type"] for event in events], ["started", "error"])

    def test_wait_wrapper_emits_partial_before_complete_without_duplicate(self):
        polls = 0
        events = []

        def state(_session):
            nonlocal polls
            polls += 1
            if polls == 1:
                return {"status": "running", "preview_count": 1, "ready_indexes": [0],
                        "attempts": 1, "render_attempt": "b" * 32}
            self.assertEqual([event["index"] for event in events if event["type"] == "page"], [0])
            self.ready_snapshot()
            return {"status": "completed", "preview_count": 2, "ready_indexes": [0, 1],
                    "attempts": 1, "render_attempt": "b" * 32}

        with (patch.object(previews, "ensure_render_task"),
              patch.object(previews, "render_task_state", side_effect=state),
              patch.object(previews.time, "sleep")):
            result = previews._render_and_publish_ppt_previews(self.session, events.append)
        self.assertEqual(len(result), 2)
        self.assertEqual([event["index"] for event in events if event["type"] == "page"], [0, 1])

    def test_wait_wrapper_validates_ready_task_before_returning(self):
        self.session["render_task_id"] = "c" * 32
        self.session = self.ready_snapshot()
        with patch.object(previews, "render_task_state", return_value={"status": "error", "message": "stale task"}) as state:
            with self.assertRaisesRegex(RuntimeError, "stale task"):
                previews._render_and_publish_ppt_previews(self.session)
        state.assert_called_once()

    def test_preview_route_serves_verified_partial_and_rejects_unreceived_page(self):
        self.install_partial_receipt()
        response = resource_import_preview(self.session["session_id"], 0, user={"id": 1}, worker_attempt=1)
        self.assertEqual(Path(response.path), self.partial_path)
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        with self.assertRaises(HTTPException) as caught:
            resource_import_preview(self.session["session_id"], 1, user={"id": 1}, worker_attempt=1)
        self.assertEqual(caught.exception.status_code, 404)

    def test_preview_route_rejects_old_worker_and_cancelled_task(self):
        self.install_partial_receipt()
        with self.assertRaises(HTTPException) as caught:
            resource_import_preview(self.session["session_id"], 0, user={"id": 1}, worker_attempt=2)
        self.assertEqual(caught.exception.status_code, 409)
        self.render_db.execute("UPDATE renderer_ppt_tasks SET status='cancelled'")
        self.render_db.commit()
        with self.assertRaises(HTTPException) as caught:
            resource_import_preview(self.session["session_id"], 0, user={"id": 1}, worker_attempt=1)
        self.assertEqual(caught.exception.status_code, 409)

    def test_preview_route_never_uses_partial_json_without_current_receipt(self):
        self.install_partial_receipt()
        self.render_db.execute("UPDATE renderer_ppt_tasks SET result_manifest=NULL")
        self.render_db.commit()
        with self.assertRaises(HTTPException) as caught:
            resource_import_preview(self.session["session_id"], 0, user={"id": 1}, worker_attempt=1)
        self.assertEqual(caught.exception.status_code, 404)

    def test_preview_route_rejects_corrupted_normalized_image(self):
        self.install_partial_receipt()
        self.partial_path.write_bytes(b"changed after publication")
        with self.assertRaises(HTTPException) as caught:
            resource_import_preview(self.session["session_id"], 0, user={"id": 1}, worker_attempt=1)
        self.assertEqual(caught.exception.status_code, 409)

    def test_state_reclaim_clears_stale_partial_snapshot(self):
        self.install_partial_receipt()
        self.render_db.execute("UPDATE renderer_ppt_tasks SET attempts=2, result_manifest=NULL")
        self.render_db.commit()
        state = render_tasks.render_task_state(self.session)
        self.assertEqual(state["ready_indexes"], [])
        self.assertEqual(state["preview_count"], 0)
        self.assertEqual(state["attempts"], 2)
        current = sessions._load_resource_import_session_file(self.session["session_id"])
        self.assertEqual(current["partial_preview_paths"], {})
        self.assertEqual(current["render_worker_attempt"], 2)

    def test_task_creation_keeps_single_sources_local_until_requested(self):
        self.db_path = self.root / "queue.sqlite3"
        db = self.connect_render_db()
        db.executescript("""
            CREATE TABLE renderer_ppt_tasks (
                task_id TEXT PRIMARY KEY, session_id TEXT, render_attempt TEXT,
                parent_task_id INTEGER, status TEXT, lease_token_hash TEXT,
                lease_until REAL, worker_id TEXT, attempts INTEGER DEFAULT 0,
                source_manifest TEXT, result_manifest TEXT, error_code TEXT,
                created_at TEXT, updated_at TEXT
            );
        """)
        db.close()

        def split(_source, directory, **kwargs):
            directory.mkdir(parents=True)
            paths = [directory / f"single_{index}.pptx" for index in range(2)]
            for index, path in enumerate(paths):
                path.write_bytes(f"immutable single {index}".encode())
            return paths

        config = SimpleNamespace(storage_backend="oss", render_wps_batch_size=20, render_dpi=288)
        with (patch.object(render_tasks, "settings", config),
              patch.object(render_tasks, "get_db", side_effect=self.connect_render_db),
              patch.object(render_tasks, "split_pptx_to_single_pages", side_effect=split),
              patch.object(render_tasks, "_render_font_inventory", return_value=([], [], [])),
              patch.object(font_tasks, "ensure_all_font_tasks"),
              patch.object(render_tasks, "_cleanup_manifest_objects"),
              patch.object(render_tasks.oss_storage, "ensure_configured"),
              patch.object(render_tasks.oss_storage, "key", side_effect=lambda category, suffix="": category + suffix),
              patch.object(render_tasks, "oss_ref", side_effect=lambda key: "oss://bucket/" + key),
              patch.object(render_tasks.oss_storage, "upload_file", side_effect=lambda path, key, **kwargs: "oss://bucket/" + key) as upload):
            for batch_size in (20, 1):
                with self.subTest(batch_size=batch_size):
                    config.render_wps_batch_size = batch_size
                    upload.reset_mock()
                    self.session.update(preview_hashes=["stale"], partial_preview_hashes={"0": "stale"})
                    row = render_tasks.create_render_task(self.session)
                    manifest = json.loads(row["source_manifest"])
                    self.assertEqual(row["status"], "queued")
                    self.assertEqual(upload.call_count, 1 if batch_size > 1 else 0)
                    if batch_size > 1:
                        self.assertEqual(upload.call_args.args[0], Path(self.session["source_path"]))
                        self.assertIn("source", manifest)
                    self.assertTrue(all(page["source_uploaded"] is False for page in manifest["pages"]))
                    for index, raw_path in enumerate(self.session["split_paths"]):
                        path = Path(raw_path)
                        self.assertTrue(path.is_file())
                        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), manifest["pages"][index]["sha256"])
                    self.assertEqual(self.session["preview_hashes"], [])
                    self.assertEqual(self.session["partial_preview_hashes"], {})


if __name__ == "__main__":
    unittest.main()
