from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
import psutil
from pathlib import Path
from unittest.mock import patch

from app.routers import system
from app.services.system_upgrade import (
    OperationOwnershipLost,
    UpgradeAlreadyRunning,
    begin_operation,
    begin_upgrade,
    finish_operation,
    get_operation_state,
    get_upgrade_state,
    record_operation_process,
    upgrade_paths,
    write_upgrade_state,
)


class SystemUpgradeStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-system-upgrade-")
        self.root = Path(self.temporary.name)
        self.state_path, self.lock_path = upgrade_paths(self.root)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_upgrade_is_exclusive_and_new_boot_completes_restart(self) -> None:
        state = begin_upgrade(
            self.state_path,
            self.lock_path,
            source_boot_id="boot-old",
            now=100,
        )
        with self.assertRaises(UpgradeAlreadyRunning):
            begin_upgrade(
                self.state_path,
                self.lock_path,
                source_boot_id="boot-old",
                now=101,
            )

        state.update(
            state="restarting",
            message="restarting",
            updated_at="1970-01-01T00:01:41+00:00",
        )
        write_upgrade_state(self.state_path, state)
        current = get_upgrade_state(
            self.state_path,
            self.lock_path,
            current_boot_id="boot-old",
            now=102,
        )
        self.assertEqual(current["state"], "restarting")
        self.assertTrue(self.lock_path.exists())

        completed = get_upgrade_state(
            self.state_path,
            self.lock_path,
            current_boot_id="boot-new",
            now=103,
        )
        self.assertEqual(completed["state"], "succeeded")
        self.assertFalse(self.lock_path.exists())

    def test_stale_active_upgrade_fails_and_releases_lock(self) -> None:
        state = begin_upgrade(
            self.state_path,
            self.lock_path,
            source_boot_id="boot-old",
            now=100,
        )
        state.update(
            state="running",
            message="running",
            updated_at="1970-01-01T00:01:40+00:00",
        )
        write_upgrade_state(self.state_path, state)

        failed = get_upgrade_state(
            self.state_path,
            self.lock_path,
            current_boot_id="boot-old",
            now=100 + 31 * 60,
        )
        self.assertEqual(failed["state"], "failed")
        self.assertFalse(self.lock_path.exists())

    def test_stale_timestamp_does_not_expire_a_live_operation_process(self) -> None:
        state = begin_operation(
            self.state_path,
            self.lock_path,
            operation="upgrade",
            source_boot_id="boot-old",
            now=100,
        )
        current_process = psutil.Process()
        state = record_operation_process(
            self.state_path,
            self.lock_path,
            state,
            process_pid=current_process.pid,
            process_started_at=current_process.create_time(),
        )
        state.update(
            state="running",
            updated_at="1970-01-01T00:01:40+00:00",
        )
        write_upgrade_state(self.state_path, state)

        current = get_operation_state(
            self.state_path,
            self.lock_path,
            current_boot_id="boot-old",
            now=100 + 31 * 60,
        )

        self.assertEqual(current["state"], "running")
        self.assertTrue(self.lock_path.exists())
        with self.assertRaises(UpgradeAlreadyRunning):
            begin_operation(
                self.state_path,
                self.lock_path,
                operation="restart",
                source_boot_id="boot-old",
                now=100 + 31 * 60,
            )

    def test_terminal_state_never_blocks_a_new_upgrade(self) -> None:
        first = begin_upgrade(
            self.state_path,
            self.lock_path,
            source_boot_id="boot-old",
            now=100,
        )
        first.update(state="failed", message="failed")
        write_upgrade_state(self.state_path, first)

        second = begin_upgrade(
            self.state_path,
            self.lock_path,
            source_boot_id="boot-old",
            now=101,
        )
        self.assertNotEqual(first["job_id"], second["job_id"])

    def test_terminal_state_cannot_remove_a_different_jobs_lock(self) -> None:
        old = begin_upgrade(
            self.state_path,
            self.lock_path,
            source_boot_id="boot-old",
            now=100,
        )
        old.update(state="failed", message="failed")
        write_upgrade_state(self.state_path, old)
        self.lock_path.write_text("new-job", encoding="ascii")

        with self.assertRaises(UpgradeAlreadyRunning):
            begin_upgrade(
                self.state_path,
                self.lock_path,
                source_boot_id="boot-old",
                now=101,
            )
        self.assertEqual(self.lock_path.read_text(encoding="ascii"), "new-job")

    def test_stale_state_cannot_remove_a_different_jobs_fresh_lock(self) -> None:
        old = begin_upgrade(
            self.state_path,
            self.lock_path,
            source_boot_id="boot-old",
            now=100,
        )
        old.update(
            state="running",
            message="running",
            updated_at="1970-01-01T00:01:40+00:00",
        )
        write_upgrade_state(self.state_path, old)
        self.lock_path.write_text("new-job", encoding="ascii")

        with self.assertRaises(UpgradeAlreadyRunning):
            begin_upgrade(
                self.state_path,
                self.lock_path,
                source_boot_id="boot-old",
                now=100 + 31 * 60,
            )
        self.assertEqual(self.lock_path.read_text(encoding="ascii"), "new-job")

    def test_stale_lock_mtime_cannot_remove_a_different_jobs_lock(self) -> None:
        old = begin_upgrade(
            self.state_path,
            self.lock_path,
            source_boot_id="boot-old",
            now=100,
        )
        old.update(state="running", updated_at="1970-01-01T00:01:40+00:00")
        write_upgrade_state(self.state_path, old)
        self.lock_path.write_text("new-job", encoding="ascii")
        os.utime(self.lock_path, (100, 100))

        with self.assertRaises(UpgradeAlreadyRunning):
            begin_upgrade(
                self.state_path,
                self.lock_path,
                source_boot_id="boot-old",
                now=100 + 31 * 60,
            )
        self.assertEqual(self.lock_path.read_text(encoding="ascii"), "new-job")

    def test_orphaned_stale_lock_can_be_reclaimed(self) -> None:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        self.lock_path.write_text("orphan-job", encoding="ascii")
        os.utime(self.lock_path, (100, 100))

        current = begin_upgrade(
            self.state_path,
            self.lock_path,
            source_boot_id="boot-old",
            now=100 + 31 * 60,
        )

        self.assertNotEqual(current["job_id"], "orphan-job")
        self.assertEqual(self.lock_path.read_text(encoding="ascii"), current["job_id"])

    def test_mismatched_owner_temporarily_hides_old_state(self) -> None:
        old = begin_upgrade(
            self.state_path,
            self.lock_path,
            source_boot_id="boot-old",
            now=100,
        )
        self.lock_path.write_text("new-job", encoding="ascii")

        current = get_operation_state(
            self.state_path,
            self.lock_path,
            current_boot_id="boot-old",
            now=101,
        )

        self.assertIsNone(current)
        self.assertEqual(self.lock_path.read_text(encoding="ascii"), "new-job")
        persisted = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["job_id"], old["job_id"])

    def test_superseded_job_cannot_overwrite_new_state(self) -> None:
        old = begin_upgrade(
            self.state_path,
            self.lock_path,
            source_boot_id="boot-old",
            now=100,
        )
        new_state = dict(old, job_id="new-job", operation="restart")
        write_upgrade_state(self.state_path, new_state)
        self.lock_path.write_text("new-job", encoding="ascii")

        with self.assertRaises(OperationOwnershipLost):
            finish_operation(
                self.state_path,
                self.lock_path,
                dict(old, state="failed"),
            )

        persisted = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["job_id"], "new-job")
        self.assertEqual(self.lock_path.read_text(encoding="ascii"), "new-job")

    def test_restart_and_upgrade_share_one_operation_lock(self) -> None:
        restart = begin_operation(
            self.state_path,
            self.lock_path,
            operation="restart",
            source_boot_id="boot-old",
            now=100,
        )
        self.assertEqual(restart["operation"], "restart")
        with self.assertRaises(UpgradeAlreadyRunning):
            begin_upgrade(
                self.state_path,
                self.lock_path,
                source_boot_id="boot-old",
                now=101,
            )


class SystemRuntimeTests(unittest.TestCase):
    @patch("app.routers.system.subprocess.run")
    def test_missing_systemd_unit_is_direct_mode(self, run) -> None:
        run.return_value = subprocess.CompletedProcess([], 0, stdout="not-found\n")
        self.assertEqual(
            system._systemd_service_state("slide-flow"),
            (False, "unknown", "unknown"),
        )
        self.assertEqual(run.call_count, 1)

    @patch("app.routers.system.subprocess.run")
    def test_loaded_systemd_unit_reports_active_and_enabled(self, run) -> None:
        run.return_value = subprocess.CompletedProcess(
            [],
            0,
            stdout="LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n",
        )
        self.assertEqual(
            system._systemd_service_state("custom-slide-flow"),
            (True, "running", "enabled"),
        )
        self.assertEqual(run.call_count, 1)

    @patch("app.routers.system.subprocess.run")
    def test_failed_systemd_unit_is_not_reported_as_stopped(self, run) -> None:
        run.return_value = subprocess.CompletedProcess(
            [],
            0,
            stdout="LoadState=loaded\nActiveState=failed\nUnitFileState=masked\n",
        )
        self.assertEqual(
            system._systemd_service_state("custom-slide-flow"),
            (True, "failed", "masked"),
        )

    def test_upgrade_endpoint_starts_persistent_job_with_expected_environment(self) -> None:
        with tempfile.TemporaryDirectory(prefix="slideflow-upgrade-route-") as temporary:
            root = Path(temporary)
            (root / "tools").mkdir()
            (root / "tools" / "update.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
            data_dir = root / "data"
            log_dir = root / "logs"

            with (
                patch.object(system.settings, "root_dir", root),
                patch.object(system.settings, "data_dir", data_dir),
                patch.object(system.settings, "log_dir", log_dir),
                patch("app.routers.system.subprocess.Popen") as popen,
            ):
                popen.return_value.pid = 4321
                result = system.api_admin_system_upgrade(_={"role": "system_admin"})

            self.assertEqual(result["state"], "queued")
            self.assertTrue(result["job_id"])
            kwargs = popen.call_args.kwargs
            self.assertEqual(kwargs["env"]["SLIDEFLOW_UPGRADE_JOB_ID"], result["job_id"])
            self.assertEqual(kwargs["env"]["SLIDEFLOW_OPERATION_JOB_ID"], result["job_id"])
            self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
            state = json.loads((data_dir / ".system_upgrade_state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["job_id"], result["job_id"])

    def test_restart_endpoint_starts_persistent_operation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="slideflow-restart-route-") as temporary:
            root = Path(temporary)
            (root / "tools").mkdir()
            (root / "tools" / "restart.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
            data_dir = root / "data"
            log_dir = root / "logs"

            with (
                patch.object(system.settings, "root_dir", root),
                patch.object(system.settings, "data_dir", data_dir),
                patch.object(system.settings, "log_dir", log_dir),
                patch("app.routers.system.subprocess.Popen") as popen,
            ):
                popen.return_value.pid = 9876
                result = system.api_admin_system_restart(_={"role": "system_admin"})

            self.assertEqual(result["state"], "queued")
            self.assertTrue(result["job_id"])
            kwargs = popen.call_args.kwargs
            self.assertEqual(kwargs["env"]["SLIDEFLOW_OPERATION_TYPE"], "restart")
            self.assertEqual(kwargs["env"]["SLIDEFLOW_OPERATION_JOB_ID"], result["job_id"])

    def test_restart_script_failure_persists_failed_state(self) -> None:
        repository_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix="slideflow-restart-script-") as temporary:
            root = Path(temporary)
            tools_dir = root / "tools"
            tools_dir.mkdir()
            shutil.copy2(repository_root / "tools" / "restart.sh", tools_dir / "restart.sh")
            shutil.copy2(
                repository_root / "tools" / "runtime_operation.sh",
                tools_dir / "runtime_operation.sh",
            )
            (root / "slide_flow.properties").write_text(
                "server.port=18088\n"
                "log.dir=data/logs\n"
                "startup.script=missing-run.sh\n"
                "system.service_name=slide-flow-test\n"
                "system.sudo_password=\n",
                encoding="utf-8",
            )
            state_path, lock_path = upgrade_paths(root / "data")
            state = begin_operation(
                state_path,
                lock_path,
                operation="restart",
                source_boot_id="boot-old",
            )
            env = os.environ.copy()
            env.update(
                SLIDEFLOW_OPERATION_JOB_ID=state["job_id"],
                SLIDEFLOW_OPERATION_TYPE="restart",
                SLIDEFLOW_OPERATION_STATE_FILE=str(state_path),
                SLIDEFLOW_OPERATION_LOCK_FILE=str(lock_path),
                SLIDEFLOW_OPERATION_SOURCE_BOOT_ID="boot-old",
                SLIDEFLOW_OPERATION_START_DELAY="0",
            )

            result = subprocess.run(
                ["bash", str(tools_dir / "restart.sh")],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
            )

            self.assertNotEqual(result.returncode, 0)
            persisted = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(persisted["state"], "failed")
            self.assertIn("服务重启失败", persisted["message"])
            self.assertFalse(lock_path.exists())

    def test_update_script_rejects_dirty_worktree_and_releases_lock(self) -> None:
        repository_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix="slideflow-update-script-") as temporary:
            root = Path(temporary)
            tools_dir = root / "tools"
            tools_dir.mkdir()
            for filename in ("update.sh", "runtime_operation.sh", "restart.sh"):
                shutil.copy2(repository_root / "tools" / filename, tools_dir / filename)
            (root / "slide_flow.properties").write_text(
                "server.port=18089\n"
                "log.dir=data/logs\n"
                "startup.script=run.sh\n"
                "system.service_name=slide-flow-test\n"
                "system.sudo_password=\n",
                encoding="utf-8",
            )
            (root / "run.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
            (root / "stop.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")

            def git(*args: str) -> subprocess.CompletedProcess[str]:
                return subprocess.run(
                    ["git", *args],
                    cwd=root,
                    check=True,
                    capture_output=True,
                    text=True,
                )

            git("init", "-q")
            git("config", "user.email", "test@example.com")
            git("config", "user.name", "SlideFlow Test")
            git("add", ".")
            git("commit", "-qm", "initial")
            git("branch", "-M", "main")
            remote = root / "remote.git"
            subprocess.run(
                ["git", "init", "-q", "--bare", str(remote)],
                check=True,
                capture_output=True,
                text=True,
            )
            git("remote", "add", "origin", str(remote))
            git("push", "-q", "-u", "origin", "main")
            (root / "run.sh").write_text("#!/usr/bin/env bash\n# dirty\n", encoding="utf-8")

            state_path, lock_path = upgrade_paths(root / "data")
            state = begin_operation(
                state_path,
                lock_path,
                operation="upgrade",
                source_boot_id="boot-old",
            )
            env = os.environ.copy()
            env.update(
                SLIDEFLOW_OPERATION_JOB_ID=state["job_id"],
                SLIDEFLOW_OPERATION_TYPE="upgrade",
                SLIDEFLOW_OPERATION_STATE_FILE=str(state_path),
                SLIDEFLOW_OPERATION_LOCK_FILE=str(lock_path),
                SLIDEFLOW_OPERATION_SOURCE_BOOT_ID="boot-old",
                SLIDEFLOW_OPERATION_START_DELAY="0",
            )

            result = subprocess.run(
                ["bash", str(tools_dir / "update.sh")],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )

            self.assertNotEqual(result.returncode, 0)
            persisted = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(persisted["state"], "failed")
            self.assertFalse(lock_path.exists())


if __name__ == "__main__":
    unittest.main()
