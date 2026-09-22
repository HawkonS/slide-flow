import json
import tempfile
import unittest
from pathlib import Path

from wps_renderer.config import Settings


TOKEN = "test-only-" + "x" * 40


class TLSConfigTests(unittest.TestCase):
    def test_non_loopback_requires_certificate_and_key(self):
        with self.assertRaisesRegex(ValueError, "certificate and private key"):
            Settings(wpscli="fake", data_dir=tempfile.mkdtemp(), token=TOKEN,
                     host="10.0.2.15", allow_network_bind=True)

    def test_non_loopback_accepts_ip_listener_with_tls_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cert = root / "renderer.crt.pem"
            key = root / "renderer.key.pem"
            cert.write_text("certificate", encoding="ascii")
            key.write_text("private-key", encoding="ascii")
            settings = Settings(wpscli="fake", data_dir=str(root / "data"), token=TOKEN,
                                host="10.0.2.15", allow_network_bind=True,
                                tls_cert_file=str(cert), tls_key_file=str(key))
            self.assertEqual(settings.tls_cert_file, str(cert))
            self.assertEqual(settings.tls_key_file, str(key))

    def test_certificate_and_key_must_be_a_pair(self):
        with tempfile.TemporaryDirectory() as directory:
            cert = Path(directory) / "renderer.crt.pem"
            cert.write_text("certificate", encoding="ascii")
            with self.assertRaisesRegex(ValueError, "configured together"):
                Settings(wpscli="fake", data_dir=directory, token=TOKEN,
                         tls_cert_file=str(cert))

    def test_relative_tls_paths_resolve_from_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "renderer.crt.pem").write_text("certificate", encoding="ascii")
            (root / "renderer.key.pem").write_text("private-key", encoding="ascii")
            (root / "config.json").write_text(json.dumps({
                "wpscli": "fake", "data_dir": "data", "token_file": "token.txt",
                "host": "10.0.2.15", "allow_network_bind": True,
                "tls_cert_file": "renderer.crt.pem", "tls_key_file": "renderer.key.pem",
            }), encoding="utf-8")
            (root / "token.txt").write_text(TOKEN, encoding="ascii")
            settings = Settings.load(root / "config.json")
            self.assertEqual(Path(settings.tls_cert_file).resolve(), (root / "renderer.crt.pem").resolve())
            self.assertEqual(Path(settings.tls_key_file).resolve(), (root / "renderer.key.pem").resolve())


if __name__ == "__main__":
    unittest.main()
