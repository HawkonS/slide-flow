"""Durable font-install tasks consumed by the Windows renderer."""
from __future__ import annotations

import hashlib
import sqlite3
import time
import uuid
from pathlib import Path

from app.db import now_iso


def ensure_schema(db: sqlite3.Connection) -> None:
    db.execute("""
        CREATE TABLE IF NOT EXISTS renderer_font_tasks (
            task_id TEXT PRIMARY KEY,
            font_id INTEGER NOT NULL REFERENCES fonts(id) ON DELETE CASCADE,
            sha256 TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'completed', 'failed')),
            lease_until REAL,
            attempts INTEGER NOT NULL DEFAULT 0,
            error_code TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            UNIQUE(font_id, sha256)
        )
    """)


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
    rows = db.execute("SELECT id, file_path FROM fonts ORDER BY id").fetchall()
    for row in rows:
        path = Path(row["file_path"])
        if not path.is_absolute():
            from app.config import settings
            path = settings.abs_path(row["file_path"])
        if path and path.is_file():
            create_font_task(db, int(row["id"]), path)


def claim_font_task(db: sqlite3.Connection, lease_seconds: int = 120):
    ensure_schema(db)
    now = time.time()
    row = db.execute(
        "SELECT t.*, f.file_name, f.file_path FROM renderer_font_tasks t "
        "JOIN fonts f ON f.id=t.font_id "
        "WHERE t.status='queued' OR (t.status='running' AND t.lease_until<?) "
        "ORDER BY t.created_at LIMIT 1", (now,)
    ).fetchone()
    if not row:
        return None
    db.execute("UPDATE renderer_font_tasks SET status='running', lease_until=?, attempts=attempts+1, updated_at=? WHERE task_id=?",
               (now + lease_seconds, now_iso(), row["task_id"]))
    db.commit()
    return db.execute("SELECT t.*, f.file_name, f.file_path FROM renderer_font_tasks t JOIN fonts f ON f.id=t.font_id WHERE t.task_id=?", (row["task_id"],)).fetchone()


def update_font_task(db: sqlite3.Connection, task_id: str, status: str, error_code: str | None = None) -> None:
    if status not in {"completed", "failed"}:
        raise ValueError("invalid font task status")
    if status == "failed":
        row = db.execute("SELECT attempts FROM renderer_font_tasks WHERE task_id=?", (task_id,)).fetchone()
        # A transient install failure is retried by the next poll cycle; after
        # five attempts it becomes a hard failure and blocks rendering.
        status = "queued" if row and int(row["attempts"]) < 5 else "failed"
    db.execute("UPDATE renderer_font_tasks SET status=?, lease_until=NULL, error_code=?, updated_at=? WHERE task_id=?",
               (status, error_code, now_iso(), task_id))
    db.commit()


def font_sync_status(db: sqlite3.Connection) -> dict[str, int | bool]:
    ensure_all_font_tasks(db)
    db.commit()
    rows = db.execute("SELECT status, COUNT(*) AS count FROM renderer_font_tasks GROUP BY status").fetchall()
    counts = {str(row["status"]): int(row["count"]) for row in rows}
    total = sum(counts.values())
    return {"total": total, "queued": counts.get("queued", 0), "running": counts.get("running", 0),
            "completed": counts.get("completed", 0), "failed": counts.get("failed", 0),
            "ready": total == counts.get("completed", 0) and counts.get("failed", 0) == 0}


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
