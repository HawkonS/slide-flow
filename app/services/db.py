"""Database dependencies shared by routers and services."""

from __future__ import annotations

import sqlite3


def db_dep():
    from app.db import get_write_db, release_db

    db = get_write_db()
    try:
        yield db
    finally:
        release_db(db, readonly=False)


def db_read_dep():
    from app.db import get_read_db, release_db

    db = get_read_db()
    try:
        yield db
    finally:
        release_db(db, readonly=True)
