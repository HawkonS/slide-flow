from __future__ import annotations

import json
import sqlite3
import tempfile
import time
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.services.resource_import import render_tasks


class RendererPptTaskTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            CREATE TABLE fonts (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, aliases TEXT);
            INSERT INTO fonts VALUES (1, '/tmp/font.ttf', 'font.ttf', '["Test Sans"]');
            CREATE TABLE renderer_font_tasks (
                task_id TEXT PRIMARY KEY, font_id INTEGER, sha256 TEXT,
                status TEXT, lease_until REAL, attempts INTEGER, error_code TEXT,
                created_at TEXT, updated_at TEXT
            );
            INSERT INTO renderer_font_tasks VALUES
                ('font', 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                 'completed', NULL, 1, NULL, 'now', 'now');
            CREATE TABLE renderer_font_delete_tasks (
                task_id TEXT PRIMARY KEY, sha256 TEXT, file_name TEXT, status TEXT,
                lease_token_hash TEXT, lease_until REAL, attempts INTEGER,
                error_code TEXT, created_at TEXT, updated_at TEXT
            );
            CREATE TABLE tasks (
                id INTEGER PRIMARY KEY, status TEXT, params TEXT, progress INTEGER,
                total INTEGER, message TEXT, error_message TEXT, updated_at TEXT
            );
            INSERT INTO tasks VALUES (7, 'pending', '{"workflow_state":"rendering"}', 0, 1, '', NULL, '');
            CREATE TABLE renderer_ppt_tasks (
                task_id TEXT PRIMARY KEY, session_id TEXT, render_attempt TEXT,
                parent_task_id INTEGER, status TEXT, lease_token_hash TEXT,
                lease_until REAL, worker_id TEXT, attempts INTEGER,
                source_manifest TEXT, result_manifest TEXT, error_code TEXT,
                created_at TEXT, updated_at TEXT
            );
        """)
        self.db.commit()
        self.settings = SimpleNamespace(secret_key="unit-test-secret", render_dpi=288)
        self.settings_patch = patch.object(render_tasks, "settings", self.settings)
        self.settings_patch.start()
        self.addCleanup(self.settings_patch.stop)
        self.cleanup_patch = patch.object(render_tasks, "_cleanup_manifest_objects", lambda manifest: None)
        self.cleanup_patch.start()
        self.addCleanup(self.cleanup_patch.stop)

    def insert_task(self, *, status="queued", attempts=0, lease_until=None):
        manifest = {
            "version": 1, "dpi": 288,
            "required_fonts": ["Test Sans"], "font_hashes": ["a" * 64],
            "pages": [{"index": 0, "source_ref": "oss://bucket/source.pptx", "sha256": "a" * 64, "size": 10}],
            "outputs": [{"index": 0, "output_ref": "oss://bucket/output.png"}],
        }
        self.db.execute(
            "INSERT INTO renderer_ppt_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("a" * 32, "b" * 32, "c" * 32, 7, status, None, lease_until, None, attempts,
             json.dumps(manifest), None, None, "now", "now"),
        )
        self.db.commit()

    def test_only_one_worker_claims_one_task(self):
        self.insert_task()
        first = render_tasks.claim_render_task(self.db, "worker-one")
        self.assertIsNotNone(first)
        second = render_tasks.claim_render_task(self.db, "worker-two")
        self.assertIsNone(second)
        self.assertEqual(first[0]["attempts"], 1)

    def test_renew_rejects_old_token(self):
        self.insert_task()
        row, token = render_tasks.claim_render_task(self.db, "worker-one")
        renewed = render_tasks.renew_render_task(self.db, row["task_id"], token)
        self.assertGreater(renewed, time.time())
        with self.assertRaises(PermissionError):
            render_tasks.renew_render_task(self.db, row["task_id"], "x" * 43)

    def test_expired_lease_is_reclaimed_with_new_token(self):
        self.insert_task(status="running", attempts=1, lease_until=time.time() - 1)
        claimed = render_tasks.claim_render_task(self.db, "worker-two")
        self.assertIsNotNone(claimed)
        self.assertEqual(claimed[0]["attempts"], 2)
        self.assertEqual(claimed[0]["worker_id"], "worker-two")

    def test_old_worker_failure_cannot_clear_reclaimed_lease(self):
        self.insert_task()
        first, old_token = render_tasks.claim_render_task(self.db, "worker-one")
        self.db.execute(
            "UPDATE renderer_ppt_tasks SET lease_until=? WHERE task_id=?",
            (time.time() - 1, first["task_id"]),
        )
        self.db.commit()
        second, _new_token = render_tasks.claim_render_task(self.db, "worker-two")
        with self.assertRaises(PermissionError):
            render_tasks.fail_render_task(self.db, first["task_id"], old_token, "network_error")
        current = self.db.execute(
            "SELECT status, worker_id, attempts FROM renderer_ppt_tasks WHERE task_id=?",
            (first["task_id"],),
        ).fetchone()
        self.assertEqual((current["status"], current["worker_id"], current["attempts"]),
                         ("running", "worker-two", 2))
        self.assertEqual(second["worker_id"], "worker-two")

    def test_each_claim_gets_distinct_output_objects(self):
        self.insert_task()
        with patch.object(render_tasks.oss_storage, "key", side_effect=lambda category, suffix="": f"prefix/{category}{suffix}"), patch.object(render_tasks, "oss_ref", side_effect=lambda key: f"oss://bucket/{key}"):
            first, _ = render_tasks.claim_render_task(self.db, "worker-one")
            first_output = json.loads(first["source_manifest"])["outputs"][0]["output_ref"]
            self.db.execute(
                "UPDATE renderer_ppt_tasks SET lease_until=? WHERE task_id=?",
                (time.time() - 1, first["task_id"]),
            )
            self.db.commit()
            second, _ = render_tasks.claim_render_task(self.db, "worker-two")
            second_output = json.loads(second["source_manifest"])["outputs"][0]["output_ref"]
        self.assertNotEqual(first_output, second_output)
        self.assertIn("output-1", first_output)
        self.assertIn("output-2", second_output)

    def test_claim_payload_carries_font_activation_inventory(self):
        self.insert_task()
        row, token = render_tasks.claim_render_task(self.db, "worker-one")
        payload = render_tasks.claim_payload(row, token)
        self.assertEqual(payload["required_fonts"], ["Test Sans"])
        self.assertEqual(payload["font_hashes"], ["a" * 64])

    def test_render_font_inventory_resolves_aliases_to_synced_hashes(self):
        required, hashes = render_tasks._render_font_inventory(self.db, ["Test Sans"])
        self.assertEqual(required, ["Test Sans"])
        self.assertEqual(hashes, ["a" * 64])

    def test_retryable_failure_requeues_then_hard_failure_stops(self):
        self.insert_task()
        row, token = render_tasks.claim_render_task(self.db, "worker-one")
        self.assertEqual(render_tasks.fail_render_task(self.db, row["task_id"], token, "network_error"), "queued")
        self.db.execute("UPDATE renderer_ppt_tasks SET status='running', attempts=5, lease_until=? WHERE task_id=?",
                        (time.time() + 60, row["task_id"]))
        token2 = "z" * 43
        self.db.execute("UPDATE renderer_ppt_tasks SET lease_token_hash=? WHERE task_id=?",
                        (render_tasks._token_hash(token2), row["task_id"]))
        self.db.commit()
        with patch.object(render_tasks, "_load_resource_import_session_file", return_value=None):
            self.assertEqual(render_tasks.fail_render_task(self.db, row["task_id"], token2, "network_error"), "failed")

    def test_fonts_not_ready_blocks_render_claim(self):
        self.insert_task()
        self.db.execute("UPDATE renderer_font_tasks SET status='queued'")
        self.db.commit()
        self.assertIsNone(render_tasks.claim_render_task(self.db, "worker-one"))

    def test_queued_font_deletion_blocks_render_until_cleanup(self):
        self.insert_task()
        self.db.execute(
            "INSERT INTO renderer_font_delete_tasks VALUES "
            "('delete', 'old-sha', 'old.ttf', 'queued', NULL, NULL, 0, NULL, 'now', 'now')"
        )
        self.db.commit()
        self.assertIsNone(render_tasks.claim_render_task(self.db, "worker-one"))

    def test_running_or_failed_font_deletion_blocks_render_claim(self):
        for status in ("running", "failed"):
            with self.subTest(status=status):
                self.db.execute("DELETE FROM renderer_ppt_tasks")
                self.db.execute("DELETE FROM renderer_font_delete_tasks")
                self.db.commit()
                self.insert_task()
                self.db.execute(
                    "INSERT INTO renderer_font_delete_tasks VALUES "
                    "('delete', 'old-sha', 'old.ttf', ?, NULL, NULL, 1, NULL, 'now', 'now')",
                    (status,),
                )
                self.db.commit()
                self.assertIsNone(render_tasks.claim_render_task(self.db, "worker-one"))

    def test_partial_publish_failure_removes_already_moved_pages(self):
        manifest = {
            "version": 1, "dpi": 288,
            "pages": [
                {"index": 0, "source_ref": "oss://bucket/0.pptx", "sha256": "a" * 64, "size": 10},
                {"index": 1, "source_ref": "oss://bucket/1.pptx", "sha256": "b" * 64, "size": 10},
            ],
            "outputs": [
                {"index": 0, "output_ref": "oss://bucket/0.png"},
                {"index": 1, "output_ref": "oss://bucket/1.png"},
            ],
        }
        task_id, session_id, attempt = "a" * 32, "b" * 32, "c" * 32
        self.db.execute(
            "INSERT INTO renderer_ppt_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (task_id, session_id, attempt, 7, "queued", None, None, None, 0,
             json.dumps(manifest), None, None, "now", "now"),
        )
        self.db.commit()
        row, token = render_tasks.claim_render_task(self.db, "worker-one")
        current_manifest = json.loads(row["source_manifest"])
        payloads = {0: b"first-png", 1: b"second-png"}
        outputs = {item["output_ref"]: payloads[item["index"]] for item in current_manifest["outputs"]}
        pages = [
            {"index": index, "size": len(data), "sha256": render_tasks.hashlib.sha256(data).hexdigest()}
            for index, data in payloads.items()
        ]
        session = {
            "session_id": session_id, "temp_dir": "unused", "render_attempt": attempt,
            "render_task_id": task_id, "preview_status": "rendering",
        }
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            directory = root / f"previews_{attempt}"
            directory.mkdir()

            def download(ref, target):
                target.write_bytes(outputs[ref])

            original_replace = Path.replace
            calls = 0

            def replace(path, target):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("simulated publish failure")
                return original_replace(path, target)

            with patch.object(render_tasks, "_load_resource_import_session_file", return_value=session), \
                    patch.object(render_tasks, "_resource_import_temp_dir", return_value=root), \
                    patch.object(render_tasks.oss_storage, "download_file", side_effect=download), \
                    patch.object(render_tasks, "_validate_import_image", return_value=None), \
                    patch.object(render_tasks, "_compress_hd_image", side_effect=lambda path: path), \
                    patch.object(render_tasks, "_resource_import_operation", side_effect=lambda *args, **kwargs: nullcontext()), \
                    patch.object(render_tasks, "_write_resource_import_session", return_value=None), \
                    patch.object(Path, "replace", replace):
                with self.assertRaises(OSError):
                    render_tasks.complete_render_task(self.db, task_id, token, pages)

            self.assertFalse((directory / "page_0000.png").exists())
            self.assertFalse((directory / "page_0001.png").exists())
            current = self.db.execute(
                "SELECT status, worker_id FROM renderer_ppt_tasks WHERE task_id=?", (task_id,)
            ).fetchone()
            self.assertEqual((current["status"], current["worker_id"]), ("running", "worker-one"))

    def test_completed_database_receipt_recovers_session_after_write_failure(self):
        self.insert_task()
        row, token = render_tasks.claim_render_task(self.db, "worker-one")
        manifest = json.loads(row["source_manifest"])
        output_ref = manifest["outputs"][0]["output_ref"]
        payload = b"validated-png-fixture"
        page = {
            "index": 0, "size": len(payload),
            "sha256": render_tasks.hashlib.sha256(payload).hexdigest(),
        }
        stale_session = {
            "session_id": row["session_id"], "temp_dir": "unused",
            "render_attempt": row["render_attempt"], "render_task_id": row["task_id"],
            "preview_status": "rendering",
        }
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            directory = root / f"previews_{row['render_attempt']}"
            directory.mkdir()

            def download(ref, target):
                self.assertEqual(ref, output_ref)
                target.write_bytes(payload)

            with patch.object(render_tasks, "_load_resource_import_session_file", side_effect=lambda _sid: dict(stale_session)), \
                    patch.object(render_tasks, "_resource_import_temp_dir", return_value=root), \
                    patch.object(render_tasks.oss_storage, "download_file", side_effect=download), \
                    patch.object(render_tasks, "_validate_import_image", return_value=None), \
                    patch.object(render_tasks, "_compress_hd_image", side_effect=lambda path: path), \
                    patch.object(render_tasks, "_resource_import_operation", side_effect=lambda *args, **kwargs: nullcontext()), \
                    patch.object(render_tasks, "_write_resource_import_session", side_effect=OSError("disk temporarily unavailable")), \
                    self.assertLogs(render_tasks.logger, level="ERROR"):
                render_tasks.complete_render_task(self.db, row["task_id"], token, [page])

            completed = self.db.execute(
                "SELECT * FROM renderer_ppt_tasks WHERE task_id=?", (row["task_id"],)
            ).fetchone()
            self.assertEqual(completed["status"], "completed")
            self.assertTrue((directory / "page_0000.png").is_file())

            recovered = dict(stale_session)
            writes = []
            with patch.object(render_tasks, "_load_resource_import_session_file", side_effect=lambda _sid: dict(stale_session)), \
                    patch.object(render_tasks, "_resource_import_file", side_effect=lambda _session, path: Path(path)), \
                    patch.object(render_tasks, "_resource_import_operation", side_effect=lambda *args, **kwargs: nullcontext()), \
                    patch.object(render_tasks, "_write_resource_import_session", side_effect=lambda value: writes.append(dict(value))):
                self.assertTrue(render_tasks._recover_completed_session(completed, recovered))
            self.assertEqual(recovered["preview_status"], "ready")
            self.assertEqual(recovered["preview_paths"], [str(directory / "page_0000.png")])
            self.assertEqual(writes[-1]["preview_status"], "ready")


if __name__ == "__main__":
    unittest.main()
