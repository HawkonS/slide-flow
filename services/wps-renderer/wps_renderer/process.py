"""Own only the launched CLI process tree, never terminate unrelated WPS tasks."""
import ctypes
import os
import signal
import subprocess
import threading
import time

from .errors import RenderError


class ProcessTree:
    def __init__(self, command, memory_limit_bytes=1536 * 1024 * 1024):
        self.job = None
        self.memory_limit_bytes = memory_limit_bytes
        self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, shell=False, bufsize=0,
                                        creationflags=0x00000004 | 0x08000000 | 0x00004000 if os.name == "nt" else 0,
                                        start_new_session=os.name != "nt")
        if os.name == "nt":
            try:
                self._assign_windows_job()
            except Exception:
                self.process.kill()
                self.process.wait()
                if self.job:
                    self.kernel.CloseHandle(self.job)
                raise
        self.output = bytearray()
        self.reader = threading.Thread(target=self._drain, daemon=True)
        self.reader.start()

    def _assign_windows_job(self):
        from ctypes import wintypes
        class BASIC(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]
        class EXTENDED(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BASIC), ("IoInfo", IO), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        self.kernel.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                                        wintypes.DWORD, ctypes.c_void_p]
        self.job = self.kernel.CreateJobObjectW(None, None)
        limits = EXTENDED()
        limits.BasicLimitInformation.LimitFlags = 0x2000 | 0x200  # KILL_ON_JOB_CLOSE | JOB_MEMORY
        limits.JobMemoryLimit = self.memory_limit_bytes
        if not self.job or not self.kernel.SetInformationJobObject(self.job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise OSError("Cannot create owned WPS process job")
        if not self.kernel.AssignProcessToJobObject(self.job, wintypes.HANDLE(int(self.process._handle))):
            raise OSError("Cannot contain WPS process tree")
        ntdll = ctypes.WinDLL("ntdll")
        ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
        ntdll.NtResumeProcess.restype = ctypes.c_long
        if ntdll.NtResumeProcess(wintypes.HANDLE(int(self.process._handle))) != 0:
            raise OSError("Cannot start contained WPS process")

    def _drain(self):
        try:
            while True:
                chunk = self.process.stdout.read(4096)
                if not chunk:
                    break
                if len(self.output) < 16384:
                    self.output.extend(chunk[:16384 - len(self.output)])
        except (OSError, ValueError):
            pass

    def close(self):
        cleanup_error = None
        if self.job:
            from ctypes import wintypes
            class ACCOUNTING(ctypes.Structure):
                _fields_ = [("TotalUserTime", ctypes.c_longlong), ("TotalKernelTime", ctypes.c_longlong),
                            ("ThisPeriodTotalUserTime", ctypes.c_longlong), ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
                            ("TotalPageFaultCount", wintypes.DWORD), ("TotalProcesses", wintypes.DWORD),
                            ("ActiveProcesses", wintypes.DWORD), ("TotalTerminatedProcesses", wintypes.DWORD)]
            try:
                accounting = ACCOUNTING()
                if not self.kernel.QueryInformationJobObject(self.job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None):
                    cleanup_error = RenderError("process_cleanup_failed", "Unable to inspect the owned WPS process tree", 503)
                elif accounting.ActiveProcesses and not self.kernel.TerminateJobObject(self.job, 1):
                    cleanup_error = RenderError("process_cleanup_failed", "Unable to terminate the owned WPS process tree", 503)
                deadline = time.monotonic() + 10
                while cleanup_error is None or accounting.ActiveProcesses:
                    accounting = ACCOUNTING()
                    if not self.kernel.QueryInformationJobObject(self.job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None):
                        cleanup_error = cleanup_error or RenderError("process_cleanup_failed", "Unable to verify WPS process tree termination", 503)
                        break
                    if accounting.ActiveProcesses == 0:
                        break
                    if time.monotonic() >= deadline:
                        cleanup_error = cleanup_error or RenderError("process_cleanup_failed", "WPS process tree did not stop in time", 503)
                        break
                    time.sleep(0.02)
            finally:
                self.kernel.CloseHandle(self.job)
                self.job = None
        elif self.process.poll() is None:
            if os.name == "nt":
                self.process.kill()
            else:
                os.killpg(self.process.pid, signal.SIGKILL)
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.reader.join(timeout=2)
        self.process.stdout.close()
        if self.reader.is_alive():
            cleanup_error = cleanup_error or RenderError("process_cleanup_failed", "A WPS output reader remained active after process termination", 503)
        if cleanup_error:
            raise cleanup_error


def convert(wpscli, source, output, dpi, timeout, cancel, check_capacity, memory_limit_bytes=1536 * 1024 * 1024):
    output.mkdir(parents=True, exist_ok=True)
    command = [wpscli, "ppt2photo", str(source), "--output", str(output) + os.sep,
               "--suffix", "png", "--range", "1", "--dpi", str(dpi), "--timeout", str(timeout), "--json"]
    try:
        owned = ProcessTree(command, memory_limit_bytes)
    except OSError as exc:
        raise RenderError("renderer_unavailable", "Unable to launch the configured WPSCLI executable", 503) from exc
    deadline = time.monotonic() + timeout + 5
    try:
        while owned.process.poll() is None:
            if cancel.wait(0.15):
                raise RenderError("cancelled", "Render cancelled", 409)
            if time.monotonic() > deadline:
                raise RenderError("render_timeout", "WPSCLI exceeded its time limit", 504)
            check_capacity()
        code = owned.process.returncode
        if code:
            errors = {3: ("render_timeout", "WPSCLI timed out"), 100: ("wps_sign_in_required", "WPS account sign-in is required"),
                      101: ("wps_license_required", "WPS membership does not permit this operation"),
                      429: ("wps_quota_exceeded", "WPS conversion quota or rate limit exceeded")}
            error = errors.get(code, ("conversion_failed", f"WPSCLI conversion failed (exit {code})"))
            raise RenderError(*error)
    finally:
        owned.close()
