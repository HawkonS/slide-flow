"""Live Windows-only containment probe; no WPS or user processes are killed."""
import ctypes
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from ctypes import wintypes

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wps_renderer.process import ProcessTree


def main():
    with tempfile.TemporaryDirectory(prefix="wps-process-probe-") as temporary:
        pid_file = Path(temporary) / "child.pid"
        command = [sys.executable, "-c", "import subprocess,sys,time,pathlib; p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);pathlib.Path(sys.argv[1]).write_text(str(p.pid));time.sleep(60)", str(pid_file)]
        tree = ProcessTree(command)
        try:
            deadline = time.monotonic() + 10
            while not pid_file.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            if not pid_file.exists():
                raise RuntimeError("Probe child failed to start")
            child = int(pid_file.read_text())
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel.OpenProcess(0x100000, False, child)
            if not handle: raise RuntimeError("Cannot observe the owned probe child")
            try:
                tree.close()
                if kernel.WaitForSingleObject(handle, 10000) != 0:
                    raise RuntimeError("Owned grandchild survived Job Object closure")
            finally:
                kernel.CloseHandle(handle)
        finally:
            if tree.job is not None: tree.close()
        print("PASS: parent and grandchild terminated on owned Job Object close")


if __name__ == "__main__": main()
