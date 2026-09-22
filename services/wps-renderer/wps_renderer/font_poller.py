"""Optional pull worker for independent font-install tasks."""
from __future__ import annotations

import hashlib
import time
from pathlib import Path


class FontTaskPoller:
    def __init__(self, fetch_task, report, install, interval=5):
        self.fetch_task = fetch_task
        self.report = report
        self.install = install
        self.interval = interval

    def run_once(self):
        task = self.fetch_task()
        if not task:
            return False
        task_id = task["task_id"]
        try:
            path = Path(task["path"])
            expected = task["sha256"]
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != expected:
                raise ValueError("font checksum mismatch")
            self.install(path)
        except Exception:
            self.report(task_id, "failed")
        else:
            self.report(task_id, "completed")
        return True

    def run_forever(self, stop_event):
        while not stop_event.is_set():
            if not self.run_once():
                stop_event.wait(self.interval)
