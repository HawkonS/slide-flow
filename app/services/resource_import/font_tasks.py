"""Durable font-install tasks consumed by the Windows renderer."""
from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3
import time
import uuid
from pathlib import Path

from app.config import settings
from app.db import now_iso


FONT_LEASE_SECONDS = 600
MAX_FONT_ATTEMPTS = 5


def _token_hash(token: str) -> str:
    return hmac.new(
        settings.secret_key.encode("utf-8"), token.encode("utf-8"), hashlib.sha256,
    ).hexdigest()


def ensure_schema(db: sqlite3.Connection) -> None:
    db.execute("""
        CREATE TABLE IF NOT EXISTS renderer_font_tasks (
            task_id TEXT PRIMARY KEY,
            font_id INTEGER NOT NULL REFERENCES fonts(id) ON DELETE CASCADE,
            sha256 TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'completed', 'failed')),
            lease_token_hash TEXT,
            lease_until REAL,
            attempts INTEGER NOT NULL DEFAULT 0,
            error_code TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            UNIQUE(font_id, sha256)
        )
    """)
    columns = {
        row["name"]
        for row in db.execute("PRAGMA table_info(renderer_font_tasks)").fetchall()
    }
    if "lease_token_hash" not in columns:
        db.execute("ALTER TABLE renderer_font_tasks ADD COLUMN lease_token_hash TEXT")
    db.execute("""
        CREATE TABLE IF NOT EXISTS renderer_font_delete_tasks (
            task_id TEXT PRIMARY KEY,
            sha256 TEXT NOT NULL UNIQUE,
            file_name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'completed', 'failed')),
            lease_token_hash TEXT,
            lease_until REAL,
            attempts INTEGER NOT NULL DEFAULT 0,
            error_code TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_renderer_font_delete_tasks_claim "
        "ON renderer_font_delete_tasks(status, lease_until, created_at)"
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def create_font_task(db: sqlite3.Connection, font_id: int, path: Path) -> str:
    digest = sha256_file(path)
    now = now_iso()
    task_id = uuid.uuid4().hex
    ensure_schema(db)
    # A byte-identical font may be re-uploaded before an earlier deletion
    # task is consumed. Cancel that stale cleanup so the worker cannot install
    # the new reference and then immediately remove the same hash.
    db.execute("DELETE FROM renderer_font_delete_tasks WHERE sha256=?", (digest,))
    db.execute(
        "INSERT OR IGNORE INTO renderer_font_tasks "
        "(task_id,font_id,sha256,created_at,updated_at) VALUES (?,?,?,?,?)",
        (task_id, font_id, digest, now, now),
    )
    row = db.execute("SELECT task_id FROM renderer_font_tasks WHERE font_id=? AND sha256=?", (font_id, digest)).fetchone()
    return str(row[0])


def font_task_ready(db: sqlite3.Connection, font_id: int, sha256: str) -> bool:
    ensure_schema(db)
    row = db.execute("SELECT status FROM renderer_font_tasks WHERE font_id=? AND sha256=?", (font_id, sha256)).fetchone()
    return bool(row and row[0] == "completed")


def ensure_all_font_tasks(db: sqlite3.Connection) -> None:
    """Backfill tasks for fonts uploaded before pull-based synchronization."""
    ensure_schema(db)
    # Uploaded fonts are immutable and create their task in the same database
    # transaction.  Only hash legacy rows that have no task at all; hashing the
    # complete font library on every worker poll causes unbounded repeated I/O.
    rows = db.execute(
        "SELECT f.id, f.file_path FROM fonts f "
        "LEFT JOIN renderer_font_tasks t ON t.font_id=f.id "
        "WHERE t.font_id IS NULL ORDER BY f.id"
    ).fetchall()
    for row in rows:
        path = Path(row["file_path"])
        if not path.is_absolute():
            from app.config import settings
            path = settings.abs_path(row["file_path"])
        if path and path.is_file():
            create_font_task(db, int(row["id"]), path)


def queue_font_deletions(db: sqlite3.Connection, font_ids: list[int]) -> int:
    """Queue idempotent Windows cleanup for hashes no longer in the library."""
    ensure_schema(db)
    ids = sorted({int(font_id) for font_id in font_ids if int(font_id) > 0})
    if not ids:
        return 0
    placeholders = ",".join("?" for _ in ids)
    rows = db.execute(
        f"SELECT t.font_id, t.sha256, f.file_name FROM renderer_font_tasks t "
        f"JOIN fonts f ON f.id=t.font_id WHERE t.font_id IN ({placeholders})",
        ids,
    ).fetchall()
    queued = 0
    for row in rows:
        other = db.execute(
            f"SELECT 1 FROM renderer_font_tasks WHERE sha256=? "
            f"AND font_id NOT IN ({placeholders}) LIMIT 1",
            [row["sha256"], *ids],
        ).fetchone()
        if other is not None:
            continue
        now = now_iso()
        task_id = uuid.uuid4().hex
        changed = db.execute(
            "INSERT INTO renderer_font_delete_tasks "
            "(task_id,sha256,file_name,status,created_at,updated_at) "
            "VALUES (?,?,?,'queued',?,?) ON CONFLICT(sha256) DO UPDATE SET "
            "file_name=excluded.file_name,status='queued',lease_token_hash=NULL,lease_until=NULL,"
            "attempts=0,error_code=NULL,updated_at=excluded.updated_at",
            (task_id, row["sha256"], row["file_name"], now, now),
        )
        queued += max(0, changed.rowcount)
    return queued


def _leased_font_task(
    db: sqlite3.Connection, task_id: str, lease_token: str, *, allow_legacy: bool = False,
) -> sqlite3.Row:
    row = db.execute(
        "SELECT t.*, f.file_name, f.file_path FROM renderer_font_tasks t "
        "JOIN fonts f ON f.id=t.font_id WHERE t.task_id=?",
        (task_id,),
    ).fetchone()
    if row is None:
        raise KeyError(task_id)
    legacy_first_attempt = allow_legacy and not lease_token and int(row["attempts"]) == 1
    token_matches = bool(lease_token and row["lease_token_hash"] and hmac.compare_digest(
        str(row["lease_token_hash"]), _token_hash(lease_token),
    ))
    if row["status"] != "running" or not (token_matches or legacy_first_attempt):
        raise PermissionError("lease_lost")
    if float(row["lease_until"] or 0) <= time.time():
        raise PermissionError("lease_expired")
    return row


def claim_font_task(
    db: sqlite3.Connection, lease_seconds: int = FONT_LEASE_SECONDS,
) -> tuple[sqlite3.Row, str] | None:
    ensure_schema(db)
    now = time.time()
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute(
            "UPDATE renderer_font_tasks SET status='failed', lease_token_hash=NULL, "
            "lease_until=NULL, error_code='lease_exhausted', updated_at=? "
            "WHERE status='running' AND lease_until<? AND attempts>=?",
            (now_iso(), now, MAX_FONT_ATTEMPTS),
        )
        row = db.execute(
            "SELECT t.*, f.file_name, f.file_path FROM renderer_font_tasks t "
            "JOIN fonts f ON f.id=t.font_id WHERE "
            "t.status='queued' OR (t.status='running' AND t.lease_until<? AND t.attempts<?) "
            "ORDER BY t.created_at, t.task_id LIMIT 1",
            (now, MAX_FONT_ATTEMPTS),
        ).fetchone()
        if row is None:
            db.commit()
            return None
        token = secrets.token_urlsafe(32)
        changed = db.execute(
            "UPDATE renderer_font_tasks SET status='running', lease_token_hash=?, lease_until=?, "
            "attempts=attempts+1, error_code=NULL, updated_at=? WHERE task_id=? AND "
            "(status='queued' OR (status='running' AND lease_until<? AND attempts<?))",
            (
                _token_hash(token), now + lease_seconds, now_iso(), row["task_id"],
                now, MAX_FONT_ATTEMPTS,
            ),
        )
        if changed.rowcount != 1:
            db.rollback()
            return None
        db.commit()
        claimed = db.execute(
            "SELECT t.*, f.file_name, f.file_path FROM renderer_font_tasks t "
            "JOIN fonts f ON f.id=t.font_id WHERE t.task_id=?",
            (row["task_id"],),
        ).fetchone()
        return claimed, token
    except Exception:
        db.rollback()
        raise


def get_leased_font_task(
    db: sqlite3.Connection, task_id: str, lease_token: str, *, allow_legacy: bool = False,
) -> sqlite3.Row:
    return _leased_font_task(db, task_id, lease_token, allow_legacy=allow_legacy)


def update_font_task(
    db: sqlite3.Connection, task_id: str, lease_token: str,
    status: str, error_code: str | None = None, *, allow_legacy: bool = False,
) -> str:
    if status not in {"completed", "failed"}:
        raise ValueError("invalid font task status")
    db.execute("BEGIN IMMEDIATE")
    try:
        row = _leased_font_task(db, task_id, lease_token, allow_legacy=allow_legacy)
        if status == "failed":
            # A transient install failure is retried by the next poll cycle;
            # after the bounded attempt count it blocks rendering explicitly.
            status = "queued" if int(row["attempts"]) < MAX_FONT_ATTEMPTS else "failed"
        db.execute(
            "UPDATE renderer_font_tasks SET status=?, lease_token_hash=NULL, lease_until=NULL, "
            "error_code=?, updated_at=? WHERE task_id=?",
            (status, error_code, now_iso(), task_id),
        )
        db.commit()
        return status
    except Exception:
        db.rollback()
        raise


def _leased_font_delete_task(
    db: sqlite3.Connection, task_id: str, lease_token: str,
) -> sqlite3.Row:
    row = db.execute(
        "SELECT * FROM renderer_font_delete_tasks WHERE task_id=?", (task_id,),
    ).fetchone()
    if row is None:
        raise KeyError(task_id)
    if (
        row["status"] != "running"
        or not row["lease_token_hash"]
        or not hmac.compare_digest(str(row["lease_token_hash"]), _token_hash(lease_token))
    ):
        raise PermissionError("lease_lost")
    if float(row["lease_until"] or 0) <= time.time():
        raise PermissionError("lease_expired")
    return row


def claim_font_delete_task(
    db: sqlite3.Connection, lease_seconds: int = FONT_LEASE_SECONDS,
) -> tuple[sqlite3.Row, str] | None:
    ensure_schema(db)
    now = time.time()
    db.execute("BEGIN IMMEDIATE")
    try:
        has_render_table = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='renderer_ppt_tasks'"
        ).fetchone()
        if has_render_table and db.execute(
            "SELECT 1 FROM renderer_ppt_tasks WHERE status='running' LIMIT 1"
        ).fetchone():
            db.commit()
            return None
        db.execute(
            "UPDATE renderer_font_delete_tasks SET status='failed', lease_token_hash=NULL, "
            "lease_until=NULL,error_code='lease_exhausted',updated_at=? "
            "WHERE status='running' AND lease_until<? AND attempts>=?",
            (now_iso(), now, MAX_FONT_ATTEMPTS),
        )
        row = db.execute(
            "SELECT * FROM renderer_font_delete_tasks WHERE status='queued' OR "
            "(status='running' AND lease_until<? AND attempts<?) "
            "ORDER BY created_at, task_id LIMIT 1",
            (now, MAX_FONT_ATTEMPTS),
        ).fetchone()
        if row is None:
            db.commit()
            return None
        token = secrets.token_urlsafe(32)
        changed = db.execute(
            "UPDATE renderer_font_delete_tasks SET status='running',lease_token_hash=?,"
            "lease_until=?,attempts=attempts+1,error_code=NULL,updated_at=? WHERE task_id=? AND "
            "(status='queued' OR (status='running' AND lease_until<? AND attempts<?))",
            (_token_hash(token), now + lease_seconds, now_iso(), row["task_id"], now, MAX_FONT_ATTEMPTS),
        )
        if changed.rowcount != 1:
            db.rollback()
            return None
        db.commit()
        return db.execute(
            "SELECT * FROM renderer_font_delete_tasks WHERE task_id=?", (row["task_id"],),
        ).fetchone(), token
    except Exception:
        db.rollback()
        raise


def update_font_delete_task(
    db: sqlite3.Connection, task_id: str, lease_token: str,
    status: str, error_code: str | None = None,
) -> str:
    if status not in {"completed", "failed"}:
        raise ValueError("invalid font deletion status")
    db.execute("BEGIN IMMEDIATE")
    try:
        row = _leased_font_delete_task(db, task_id, lease_token)
        if status == "failed":
            status = "queued" if int(row["attempts"]) < MAX_FONT_ATTEMPTS else "failed"
        db.execute(
            "UPDATE renderer_font_delete_tasks SET status=?,lease_token_hash=NULL,lease_until=NULL,"
            "error_code=?,updated_at=? WHERE task_id=?",
            (status, error_code, now_iso(), task_id),
        )
        db.commit()
        return status
    except Exception:
        db.rollback()
        raise


def font_sync_status(db: sqlite3.Connection) -> dict[str, int | bool]:
    ensure_all_font_tasks(db)
    db.commit()
    rows = db.execute(
        "SELECT t.status, COUNT(*) AS count FROM renderer_font_tasks t "
        "JOIN fonts f ON f.id=t.font_id GROUP BY t.status"
    ).fetchall()
    counts = {str(row["status"]): int(row["count"]) for row in rows}
    deletion_rows = db.execute(
        "SELECT status, COUNT(*) AS count FROM renderer_font_delete_tasks GROUP BY status"
    ).fetchall()
    deletion_counts = {str(row["status"]): int(row["count"]) for row in deletion_rows}
    total = sum(counts.values())
    deletions_pending = deletion_counts.get("queued", 0) + deletion_counts.get("running", 0)
    deletion_failures = deletion_counts.get("failed", 0)
    return {"total": total, "queued": counts.get("queued", 0), "running": counts.get("running", 0),
            "completed": counts.get("completed", 0), "failed": counts.get("failed", 0),
            "deletions_pending": deletions_pending, "deletions_failed": deletion_failures,
            "ready": total == counts.get("completed", 0) and counts.get("failed", 0) == 0
            and deletions_pending == 0 and deletion_failures == 0}


def wait_for_font_sync(check, timeout_seconds: int = 600) -> None:
    """Block rendering until the complete standard font library is synced."""
    deadline = time.monotonic() + timeout_seconds
    while True:
        check()
        db = __import__("app.db", fromlist=["get_db"]).get_db()
        try:
            state = font_sync_status(db)
        finally:
            db.close()
        if state["failed"]:
            raise RuntimeError("Windows 字体同步失败，未开始转换 PNG")
        if state["ready"]:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError("Windows 字体尚未全部安装，未开始转换 PNG")
        time.sleep(2)
