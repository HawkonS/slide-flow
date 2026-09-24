"""Windows pull worker for the application's durable font-install queue."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
import time
import urllib.error
import urllib.request
import urllib.parse
from pathlib import Path

from .font_validation import preflight_font

SHA256 = re.compile(r"^[0-9a-f]{64}$")
TASK_ID = re.compile(r"^[0-9a-f]{32}$")
MAX_FONT_BYTES = 64 * 1024 * 1024
MAX_METADATA_BYTES = 256 * 1024


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class FontSync:
    def __init__(self, config: dict):
        self.base_url = str(config["url"]).rstrip("/")
        token = config.get("token", "")
        if not token and config.get("token_file"):
            token = Path(config["token_file"]).read_text(encoding="utf-8").strip()
        self.token = str(token)
        self.interval = max(1, min(300, int(config.get("interval", 5))))
        self._registered = set()
        configured = config.get("install_dir") or os.path.join(os.environ.get("LOCALAPPDATA", str(Path.home())), "Microsoft", "Windows", "Fonts")
        self.install_dir = Path(configured).expanduser()
        parsed = urllib.parse.urlsplit(self.base_url)
        loopback = (parsed.hostname or "").lower() in {"127.0.0.1", "localhost", "::1"}
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username
                or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}
                or (parsed.scheme == "http" and not loopback)):
            raise ValueError("font task URL must use HTTPS unless connected through a loopback tunnel")
        if len(self.token) < 32 or any(ord(char) < 33 or ord(char) > 126 for char in self.token):
            raise ValueError("font task token is invalid")
        self.register_existing()

    def register_existing(self):
        if os.name != "nt" or not self.install_dir.is_dir():
            return
        for path in self.install_dir.iterdir():
            if path.is_file() and path.suffix.lower() in {".ttf", ".otf", ".ttc", ".otc"}:
                try:
                    self.register_once(path)
                except OSError:
                    pass

    def register_once(self, path: Path):
        key = str(path.resolve())
        if key in self._registered:
            return
        self.register(path)
        self._registered.add(key)

    def request(self, method, path, body=None, headers=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        request_headers = {"Authorization": "Bearer " + self.token,
                           "Accept": "application/json",
                           "Content-Type": "application/json"}
        request_headers.update(headers or {})
        request = urllib.request.Request(self.base_url + path, data=data, method=method,
                                          headers=request_headers)
        with urllib.request.urlopen(request, timeout=30) as response:
            content = response.read(MAX_METADATA_BYTES + 1)
            if len(content) > MAX_METADATA_BYTES:
                raise ValueError("font task response is too large")
            return content

    def download(self, task, target):
        lease_token = task.get("lease_token", "")
        headers = {"Authorization": "Bearer " + self.token}
        if lease_token:
            headers["X-Render-Lease"] = lease_token
        request = urllib.request.Request(self.base_url + task["download_url"],
                                          headers=headers)
        expected_size = task.get("size")
        if expected_size is not None and (
            type(expected_size) is not int or not 0 < expected_size <= MAX_FONT_BYTES
        ):
            raise ValueError("font task size is invalid")
        digest, written = hashlib.sha256(), 0
        target.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(request, timeout=60) as response, target.open("wb") as output:
            for block in iter(lambda: response.read(1024 * 1024), b""):
                written += len(block)
                if (expected_size is not None and written > expected_size) or written > MAX_FONT_BYTES:
                    raise ValueError("font file exceeds declared size")
                digest.update(block)
                output.write(block)
        if (expected_size is not None and written != expected_size) or digest.hexdigest() != task["sha256"]:
            raise ValueError("font SHA-256 mismatch")
        preflight_font(target)

    def install(self, task):
        suffix = Path(task["file_name"]).suffix.lower()
        if suffix not in {".ttf", ".otf", ".ttc", ".otc"}:
            raise ValueError("font task extension is invalid")
        # Content-addressed names prevent two uploads with the same original
        # filename from replacing one another in the Windows font directory.
        name = task["sha256"] + suffix
        self.install_dir.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(prefix="slideflow-font-", suffix=Path(name).suffix, dir=str(self.install_dir))
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            self.download(task, temporary)
            destination = self.install_dir / name
            if destination.exists():
                if _sha256_file(destination) != task["sha256"]:
                    raise OSError("content-addressed font path contains different bytes")
                temporary.unlink(missing_ok=True)
                self.register_once(destination)
                return
            os.replace(temporary, destination)
            self.register_once(destination)
        finally:
            temporary.unlink(missing_ok=True)

    def uninstall(self, task):
        candidates = {
            path for path in self.install_dir.glob(task["sha256"] + ".*")
            if path.is_file() and path.suffix.lower() in {".ttf", ".otf", ".ttc", ".otc"}
        } if self.install_dir.is_dir() else set()
        # Older workers used the original basename. It is safe to migrate that
        # path only when both the exact basename and content hash still match
        # the deletion receipt; never delete an unrelated same-name file.
        legacy_name = Path(task["file_name"]).name
        legacy = self.install_dir / legacy_name
        try:
            if (legacy.is_file() and legacy.suffix.lower() in {".ttf", ".otf", ".ttc", ".otc"}
                    and _sha256_file(legacy) == task["sha256"]):
                candidates.add(legacy)
        except OSError:
            pass
        for target in candidates:
            if os.name == "nt":
                import ctypes
                # Registration is session-scoped. Remove our matching count
                # before deleting the user-font file; absence is idempotent.
                key = str(target.resolve())
                if key in self._registered:
                    ctypes.windll.gdi32.RemoveFontResourceExW(str(target), 0, None)
                    self._registered.discard(key)
            target.unlink(missing_ok=True)

    @staticmethod
    def _validate_task(task, *, deletion=False):
        lease_token = task.get("lease_token", "")
        if (
            not isinstance(task, dict)
            or not isinstance(task.get("task_id"), str)
            or not TASK_ID.fullmatch(task["task_id"])
            or not isinstance(lease_token, str)
            or (lease_token and not 32 <= len(lease_token) <= 256)
            or not isinstance(task.get("sha256"), str)
            or not SHA256.fullmatch(task["sha256"])
            or not isinstance(task.get("file_name"), str)
        ):
            raise ValueError("font task payload is invalid")
        if not deletion and (
            not isinstance(task.get("download_url"), str)
            or not task["download_url"].startswith("/api/renderer/font-tasks/")
            or (task.get("size") is not None and type(task.get("size")) is not int)
        ):
            raise ValueError("font task payload is invalid")

    @staticmethod
    def register(path: Path):
        if os.name == "nt":
            import ctypes
            if not ctypes.windll.gdi32.AddFontResourceExW(str(path), 0, None):
                raise OSError("Windows rejected the font")

    def run_once(self):
        payload = json.loads(self.request("GET", "/api/renderer/font-tasks/claim?delete_tasks=1"))
        if not isinstance(payload, dict):
            raise ValueError("font task response must be a JSON object")
        task = payload.get("task")
        if not task:
            return False
        if task.get("action") == "delete":
            self._validate_task(task, deletion=True)
            try:
                self.uninstall(task)
            except Exception as exc:
                self.request("POST", f"/api/renderer/font-tasks/{task['task_id']}/result",
                             {"status": "failed", "error_code": type(exc).__name__},
                             {"X-Render-Lease": task["lease_token"]})
            else:
                self.request("POST", f"/api/renderer/font-tasks/{task['task_id']}/result",
                             {"status": "completed"},
                             {"X-Render-Lease": task["lease_token"]})
            return True
        if task.get("action") not in {None, "install"}:
            raise ValueError("font task action is invalid")
        self._validate_task(task)
        result_headers = (
            {"X-Render-Lease": task["lease_token"]}
            if task.get("lease_token") else None
        )
        try:
            self.install(task)
        except Exception as exc:
            self.request("POST", f"/api/renderer/font-tasks/{task['task_id']}/result",
                         {"status": "failed", "error_code": type(exc).__name__},
                         result_headers)
        else:
            self.request("POST", f"/api/renderer/font-tasks/{task['task_id']}/result",
                         {"status": "completed"},
                         result_headers)
        return True

    def run_forever(self):
        while True:
            try:
                if not self.run_once():
                    time.sleep(self.interval)
            except (urllib.error.URLError, TimeoutError, ValueError, OSError):
                time.sleep(self.interval)


def main():
    parser = argparse.ArgumentParser(description="Pull and install SlideFlow fonts")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    FontSync(config).run_forever()


if __name__ == "__main__":
    main()
