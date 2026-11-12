"""Login rate-limit and proxy-IP handling tests."""

from __future__ import annotations

import sqlite3
import time
import unittest

from starlette.requests import Request

from app.routers import auth


def make_request(peer: str, headers: dict[str, str] | None = None) -> Request:
    raw_headers = [(key.lower().encode(), value.encode()) for key, value in (headers or {}).items()]
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": raw_headers,
        "client": (peer, 12345),
        "scheme": "http",
        "server": ("testserver", 80),
        "query_string": b"",
    })


class LoginRateLimitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.execute(
            """CREATE TABLE auth_login_attempts (
                key TEXT PRIMARY KEY, failure_count INTEGER, window_started_at REAL,
                locked_until REAL, updated_at REAL
            )"""
        )

    def test_proxy_header_is_only_trusted_from_loopback(self) -> None:
        loopback = make_request("127.0.0.1", {"x-real-ip": "203.0.113.9"})
        direct = make_request("198.51.100.4", {"x-real-ip": "203.0.113.9"})
        self.assertEqual(auth._get_client_ip(loopback), "203.0.113.9")
        self.assertEqual(auth._get_client_ip(direct), "198.51.100.4")

    def test_username_lockout_is_scoped_to_the_attempting_ip(self) -> None:
        username = "shared-user"
        for _ in range(auth._LOGIN_MAX_FAILS):
            auth._record_login_failure(self.db, "203.0.113.1", username)
        allowed, _ = auth._check_login_rate_limit(self.db, "203.0.113.1", username)
        self.assertFalse(allowed)
        allowed_other_ip, _ = auth._check_login_rate_limit(self.db, "203.0.113.2", username)
        self.assertTrue(allowed_other_ip)

    def test_success_clears_pair_but_not_ip_quota(self) -> None:
        username = "shared-user"
        for _ in range(auth._LOGIN_MAX_FAILS):
            auth._record_login_failure(self.db, "203.0.113.1", username)
        auth._clear_login_failures(self.db, "203.0.113.1", username)
        key = f"pair:203.0.113.1:{username}"
        self.assertIsNone(self.db.execute("SELECT 1 FROM auth_login_attempts WHERE key = ?", (key,)).fetchone())
        self.assertIsNotNone(self.db.execute("SELECT 1 FROM auth_login_attempts WHERE key = 'ip:203.0.113.1'").fetchone())
        allowed, _ = auth._check_login_rate_limit(self.db, "203.0.113.1", username)
        self.assertFalse(allowed)

    def test_window_expires(self) -> None:
        username = "shared-user"
        for _ in range(auth._LOGIN_MAX_FAILS):
            auth._record_login_failure(self.db, "203.0.113.1", username)
        self.db.execute("UPDATE auth_login_attempts SET window_started_at = ?, locked_until = ?", (time.time() - auth._LOGIN_WINDOW - 5, 0))
        self.db.commit()
        allowed, _ = auth._check_login_rate_limit(self.db, "203.0.113.1", username)
        self.assertTrue(allowed)


if __name__ == "__main__":
    unittest.main()
