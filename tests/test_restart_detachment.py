"""Run the restart shell against an isolated HTTP server, never the real app."""

from __future__ import annotations

import os
from pathlib import Path
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import unittest
import urllib.request


@unittest.skipUnless(os.name == "posix", "Restart scripts require POSIX sessions")
class RestartDetachmentTests(unittest.TestCase):
    def test_service_survives_cleanup_of_the_restart_process_group(self):
        repository = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix="slideflow-restart-detach-") as temporary:
            root = Path(temporary)
            (root / "tools").mkdir()
            for name in ("restart.sh", "runtime_operation.sh"):
                shutil.copy2(repository / "tools" / name, root / "tools" / name)

            # Exercise the old macOS nohup path even when CI runs on Linux.
            binaries = root / "bin"
            binaries.mkdir()
            for name, body in {
                "uname": "printf 'Darwin\n'",
                "systemctl": "printf 'not-found\n'",
            }.items():
                executable = binaries / name
                executable.write_text("#!/bin/sh\n" + body + "\n")
                executable.chmod(0o755)

            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            (root / "slide_flow.properties").write_text(
                f"server.port={port}\nlog.dir=data/logs\n"
                "startup.script=run.sh\nsystem.service_name=slideflow-detach-test\n"
            )
            (root / "server.py").write_text(
                "import os\nfrom pathlib import Path\n"
                "from http.server import BaseHTTPRequestHandler\n"
                "from socketserver import TCPServer\n"
                "class Handler(BaseHTTPRequestHandler):\n"
                "    def do_GET(self):\n"
                "        self.send_response(200)\n"
                "        self.end_headers()\n"
                "        self.wfile.write(b'{}')\n"
                "    def log_message(self, *args): pass\n"
                # TCPServer avoids HTTPServer's reverse-DNS lookup on bind.
                f"server = TCPServer(('127.0.0.1', {port}), Handler)\n"
                "Path('server.pid').write_text(str(os.getpid()))\n"
                "server.serve_forever()\n"
            )
            (root / "run.sh").write_text(
                f"#!/bin/sh\nexec {shlex.quote(sys.executable)} server.py\n"
            )
            environment = {
                key: value for key, value in os.environ.items()
                if not key.startswith(("SLIDEFLOW_OPERATION_", "SLIDEFLOW_UPGRADE_"))
            }
            environment.update(
                PATH=str(binaries) + os.pathsep + os.environ.get("PATH", ""),
                SLIDEFLOW_OPERATION_START_DELAY="0",
            )
            process = subprocess.Popen(
                ["bash", str(root / "tools" / "restart.sh")],
                cwd=root, env=environment, start_new_session=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            try:
                stdout, stderr = process.communicate(timeout=25)
                self.assertEqual(process.returncode, 0, stdout + stderr)
                server_pid = int((root / "server.pid").read_text())
                self.assertNotEqual(
                    os.getsid(server_pid), process.pid,
                    "The new service must not inherit the restart command's session",
                )
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/api/config", timeout=3
                ) as response:
                    self.assertEqual(response.status, 200)
            finally:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                if process.poll() is None:
                    process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()
                pid_file = root / "server.pid"
                if pid_file.exists():
                    try:
                        os.kill(int(pid_file.read_text()), signal.SIGTERM)
                    except ProcessLookupError:
                        pass


if __name__ == "__main__":
    unittest.main()
