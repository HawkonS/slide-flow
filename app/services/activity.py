"""User activity helpers used by the home workbench."""

from __future__ import annotations

import sqlite3


def record_login_event(
    db: sqlite3.Connection,
    user_id: int,
    method: str = "password",
) -> None:
    """Record a successful login inside the caller's transaction."""
    try:
        db.execute(
            """INSERT INTO user_login_events (user_id, occurred_at, method)
               VALUES (?, strftime('%Y-%m-%dT%H:%M:%S','now','localtime'), ?)""",
            (int(user_id), method),
        )
    except sqlite3.OperationalError as exc:
        # Legacy test databases may predate the activity migration; production
        # startup always initializes this table.
        if "no such table: user_login_events" not in str(exc):
            raise
