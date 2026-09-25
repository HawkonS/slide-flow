"""Pull-render preview state regression tests."""
from __future__ import annotations

import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from fastapi import HTTPException

from app.routers.resource_import import resource_import_preview
from app.services.resource_import import previews, sessions, streaming
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

    def test_get_image_never_starts_conversion(self):
        self.session.update(renderer_version="old", preview_paths=[self.session["source_path"]], preview_status="ready")
        sessions._write_resource_import_session(self.session)
        with self.assertRaises(HTTPException) as caught:
            resource_import_preview(self.session["session_id"], 0, user={"id": 1})
        self.assertEqual(caught.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
