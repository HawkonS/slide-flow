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

SAFE_NAME = re.compile(r"^[A-Za-z0-9 _().-]{1,180}\.(ttf|otf|ttc|otc)$", re.I)


class FontSync:
    def __init__(self, config: dict):
        self.base_url = str(config["url"]).rstrip("/")
        token = config.get("token", "")
        if not token and config.get("token_file"):
            token = Path(config["token_file"]).read_text(encoding="utf-8").strip()
        self.token = str(token)
        self.interval = max(1, min(300, int(config.get("interval", 5))))
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
                    self.register(path)
                except OSError:
                    pass

    def request(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(self.base_url + path, data=data, method=method,
                                          headers={"Authorization": "Bearer " + self.token,
                                                   "Accept": "application/json",
                                                   "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read()

    def download(self, task, target):
        request = urllib.request.Request(self.base_url + task["download_url"],
                                          headers={"Authorization": "Bearer " + self.token})
        digest = hashlib.sha256()
        target.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(request, timeout=60) as response, target.open("wb") as output:
            for block in iter(lambda: response.read(1024 * 1024), b""):
                digest.update(block)
                output.write(block)
        if digest.hexdigest() != task["sha256"]:
            raise ValueError("font SHA-256 mismatch")
        preflight_font(target)

    def install(self, task):
        name = Path(task["file_name"]).name
        if not SAFE_NAME.fullmatch(name):
            name = task["sha256"] + Path(task["file_name"]).suffix.lower()
        self.install_dir.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(prefix="slideflow-font-", suffix=Path(name).suffix, dir=str(self.install_dir))
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            self.download(task, temporary)
            destination = self.install_dir / name
            if destination.exists() and hashlib.sha256(destination.read_bytes()).hexdigest() == task["sha256"]:
                temporary.unlink(missing_ok=True)
                self.register(destination)
                return
            os.replace(temporary, destination)
            self.register(destination)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def register(path: Path):
        if os.name == "nt":
            import ctypes
            if not ctypes.windll.gdi32.AddFontResourceExW(str(path), 0, None):
                raise OSError("Windows rejected the font")

    def run_once(self):
        payload = json.loads(self.request("GET", "/api/renderer/font-tasks/claim"))
        task = payload.get("task")
        if not task:
            return False
        try:
            self.install(task)
        except Exception as exc:
            self.request("POST", f"/api/renderer/font-tasks/{task['task_id']}/result",
                         {"status": "failed", "error_code": type(exc).__name__})
        else:
            self.request("POST", f"/api/renderer/font-tasks/{task['task_id']}/result",
                         {"status": "completed"})
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
