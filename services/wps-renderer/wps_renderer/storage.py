import hashlib
import os
import re
import shutil
from pathlib import Path

from .errors import RenderError

JOB_ID = re.compile(r"^[0-9a-f]{32}$")


class Storage:
    def __init__(self, root):
        supplied = Path(root).absolute()
        if supplied.is_symlink() or supplied == Path(supplied.anchor) or supplied == Path.home():
            raise ValueError("Use a dedicated renderer data directory")
        if supplied.exists() and getattr(supplied.lstat(), "st_file_attributes", 0) & 0x400:
            raise ValueError("Renderer data root cannot be a reparse point")
        self.root = supplied.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        marker = self.root / ".wps-renderer-v1"
        if marker.is_symlink() or (marker.exists() and getattr(marker.lstat(), "st_file_attributes", 0) & 0x400):
            raise ValueError("Renderer ownership marker cannot be a reparse point")
        if not marker.exists() and any(self.root.iterdir()):
            raise ValueError("Refusing an existing non-empty data directory without the renderer ownership marker")
        marker.touch(exist_ok=True)
        self.handle = None
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, ctypes.c_wchar_p]
            self.kernel.CreateMutexW.restype = wintypes.HANDLE
            self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            name = "Global\\SlideFlowWpsRenderer_" + hashlib.sha256(str(self.root).casefold().encode()).hexdigest()
            # mkdir(exist_ok=True) can leave ERROR_ALREADY_EXISTS in thread
            # last-error storage. It is not evidence of an existing mutex.
            ctypes.set_last_error(0)
            self.handle = self.kernel.CreateMutexW(None, False, name)
            if not self.handle or ctypes.get_last_error() == 183:
                if self.handle:
                    self.kernel.CloseHandle(self.handle)
                raise RuntimeError("Another renderer process owns this data directory; use one worker only")
        else:
            import fcntl
            self.handle = open(self.root / ".lock", "a+b")
            try:
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                self.handle.close()
                raise RuntimeError("Another renderer process owns this data directory") from exc

    def directory(self, job_id):
        if not JOB_ID.fullmatch(job_id):
            raise RenderError("not_found", "Job does not exist", 404)
        target = self.root / job_id
        if target.is_symlink() or (target.exists() and target.resolve().parent != self.root):
            raise RenderError("unsafe_storage", "Unsafe renderer storage entry", 500)
        # Windows junctions are not always classified as symlinks.
        if target.exists() and getattr(target.lstat(), "st_file_attributes", 0) & 0x400:
            raise RenderError("unsafe_storage", "Reparse points are not allowed in renderer storage", 500)
        return target

    def remove(self, job_id):
        directory = self.directory(job_id)
        if directory.exists():
            shutil.rmtree(directory)

    def size(self):
        total = 0
        pending = [self.root]
        while pending:
            directory = pending.pop()
            try:
                entries = list(os.scandir(directory))
            except FileNotFoundError:
                continue  # An acknowledged page can disappear during accounting.
            for entry in entries:
                try:
                    stat_result = entry.stat(follow_symlinks=False)
                    attributes = getattr(stat_result, "st_file_attributes", 0)
                    if entry.is_symlink() or attributes & 0x400:
                        raise RenderError("unsafe_storage", "Reparse points are not allowed in renderer storage", 500)
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(entry.path)
                    elif entry.is_file(follow_symlinks=False):
                        total += stat_result.st_size
                except FileNotFoundError:
                    continue
        return total

    def close(self):
        if self.handle is not None:
            if os.name == "nt":
                self.kernel.CloseHandle(self.handle)
            else:
                self.handle.close()
            self.handle = None
