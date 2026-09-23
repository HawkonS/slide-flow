from __future__ import annotations

import json
import os
import queue
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from app.config import (
    legacy_default_password_candidates,
    remove_legacy_default_password_config,
    settings,
)
from app.core.bootstrap import prepare_initial_admin
from app.core.fonts import normalize_font_name

DB_SCHEMA_VERSION = 8


def now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def known_font_aliases(db: sqlite3.Connection) -> set[str]:
    """返回已上传字体的归一化别名集合，用于 PPT 缺失字体检测。"""
    aliases: set[str] = set()
    rows = db.execute("SELECT aliases FROM fonts").fetchall()
    for row in rows:
        raw = row["aliases"] or "[]"
        try:
            for alias in json.loads(raw):
                if isinstance(alias, str) and alias.strip():
                    aliases.add(normalize_font_name(alias))
        except (ValueError, TypeError):
            continue
    return aliases


def get_db() -> sqlite3.Connection:
    settings.db_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(settings.db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 8000")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA cache_size = -20000")
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute("PRAGMA mmap_size = 268435456")
    return conn


class _ConnectionPool:
    """进程内 SQLite 连接池，减少连接创建/销毁开销"""

    def __init__(self, db_path: Path, max_size: int = 10, readonly: bool = False):
        self._pool: queue.Queue[sqlite3.Connection] = queue.Queue(maxsize=max_size)
        self._db_path = db_path
        self._readonly = readonly

    def acquire(self) -> sqlite3.Connection:
        """从池中获取连接，池空则新建"""
        try:
            conn = self._pool.get_nowait()
            # 验证连接可用
            try:
                conn.execute("SELECT 1")
                return conn
            except sqlite3.Error:
                try:
                    conn.close()
                except Exception:
                    pass
                return self._create()
        except queue.Empty:
            return self._create()

    def release(self, conn: sqlite3.Connection) -> None:
        """归还连接到池中，池满则关闭"""
        try:
            self._pool.put_nowait(conn)
        except queue.Full:
            try:
                conn.close()
            except Exception:
                pass

    def _create(self) -> sqlite3.Connection:
        """创建新连接并应用 PRAGMA 优化"""
        if self._readonly:
            conn = sqlite3.connect(
                f"file:{self._db_path}?mode=ro", uri=True, check_same_thread=False
            )
        else:
            conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 8000")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA cache_size = -20000")
        conn.execute("PRAGMA temp_store = MEMORY")
        conn.execute("PRAGMA mmap_size = 268435456")
        return conn

    def close_all(self) -> None:
        """关闭池中所有连接"""
        while not self._pool.empty():
            try:
                conn = self._pool.get_nowait()
                conn.close()
            except (queue.Empty, Exception):
                break


# ── 全局连接池实例（进程级别）──
_read_pool: _ConnectionPool | None = None
_write_pool: _ConnectionPool | None = None


def _ensure_pools() -> None:
    """懒初始化连接池"""
    global _read_pool, _write_pool
    if _read_pool is None:
        pool_size = getattr(settings, 'db_pool_size', 10)
        _read_pool = _ConnectionPool(settings.db_path, max_size=pool_size, readonly=True)
        _write_pool = _ConnectionPool(settings.db_path, max_size=max(pool_size // 2, 3), readonly=False)


def get_read_db() -> sqlite3.Connection:
    """获取只读连接（用于 GET 请求，不阻塞写操作）"""
    _ensure_pools()
    return _read_pool.acquire()


def get_write_db() -> sqlite3.Connection:
    """获取读写连接（用于写操作）"""
    _ensure_pools()
    return _write_pool.acquire()


def release_db(conn: sqlite3.Connection, readonly: bool = False) -> None:
    """归还连接到对应池"""
    _ensure_pools()
    if readonly:
        _read_pool.release(conn)
    else:
        # A route may raise after a write but before its explicit commit.
        # Never return that open transaction to the pool, where a later
        # request could observe or accidentally commit partial state.
        if conn.in_transaction:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
        _write_pool.release(conn)


def init_db() -> None:
    settings.db_dir.mkdir(parents=True, exist_ok=True)
    settings.resources_dir.mkdir(parents=True, exist_ok=True)
    settings.templates_dir.mkdir(parents=True, exist_ok=True)
    settings.fonts_dir.mkdir(parents=True, exist_ok=True)
    settings.downloads_dir.mkdir(parents=True, exist_ok=True)
    settings.thumbs_dir.mkdir(parents=True, exist_ok=True)

    with get_db() as db:
        existing_tables = {
            row["name"]
            for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }
        schema_version = int(db.execute("PRAGMA user_version").fetchone()[0])
        if existing_tables and schema_version > DB_SCHEMA_VERSION:
            raise RuntimeError(
                f"数据库 schema 版本过高（当前 {schema_version}，应用支持到 {DB_SCHEMA_VERSION}）。"
                "请先升级应用，避免旧版本覆盖新数据。"
            )
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                feishu_id TEXT NOT NULL DEFAULT '',
                avatar_url TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL CHECK(role IN ('system_admin', 'admin', 'user')),
                must_change_pwd INTEGER NOT NULL DEFAULT 0,
                session_version INTEGER NOT NULL DEFAULT 1,
                temporary_password_expires_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS resource_import_commits (
                session_id TEXT PRIMARY KEY,
                owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                result_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS resources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                owner_id INTEGER NOT NULL REFERENCES users(id),
                subject TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
                visibility_scope TEXT NOT NULL CHECK(visibility_scope IN ('public', 'partial', 'private')),
                management_scope TEXT NOT NULL CHECK(management_scope IN ('public', 'partial', 'private')),
                secrecy_level TEXT NOT NULL CHECK(secrecy_level IN ('public', 'confidential', 'secret')),
                current_version INTEGER NOT NULL DEFAULT 1,
                updated_by INTEGER REFERENCES users(id),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS resource_visibility (
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (resource_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS resource_management (
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (resource_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS resource_share_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                token_hash TEXT NOT NULL UNIQUE,
                created_by INTEGER NOT NULL REFERENCES users(id),
                expires_at TEXT NOT NULL,
                revoked_at TEXT,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_resource_share_tokens_resource
                ON resource_share_tokens(resource_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_resource_share_tokens_active
                ON resource_share_tokens(token_hash, expires_at, revoked_at);

            CREATE TABLE IF NOT EXISTS resource_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                version_no INTEGER NOT NULL,
                ppt_path TEXT NOT NULL,
                png_path TEXT,
                font_names TEXT NOT NULL DEFAULT '[]',
                missing_fonts TEXT NOT NULL DEFAULT '[]',
                common_remark_html TEXT NOT NULL DEFAULT '',
                change_note TEXT NOT NULL DEFAULT '',
                created_by INTEGER NOT NULL REFERENCES users(id),
                created_at TEXT NOT NULL,
                UNIQUE(resource_id, version_no)
            );

            CREATE TABLE IF NOT EXISTS templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                series TEXT NOT NULL DEFAULT '',
                subject TEXT NOT NULL,
                platform TEXT NOT NULL CHECK(platform IN ('wps', 'microsoft')),
                ratio TEXT NOT NULL CHECK(ratio IN ('16:9', '4:3')),
                template_type TEXT NOT NULL CHECK(template_type IN ('cover', 'catalog', 'content', 'other')),
                office_file_name TEXT NOT NULL,
                office_path TEXT NOT NULL,
                png_path TEXT,
                font_names TEXT NOT NULL DEFAULT '[]',
                missing_fonts TEXT NOT NULL DEFAULT '[]',
                subject_order INTEGER NOT NULL DEFAULT 0,
                series_order INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0,
                visibility_scope TEXT NOT NULL CHECK(visibility_scope IN ('public', 'partial', 'private')),
                management_scope TEXT NOT NULL CHECK(management_scope IN ('public', 'partial', 'private')),
                owner_id INTEGER NOT NULL REFERENCES users(id),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS template_visibility (
                template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (template_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS template_management (
                template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (template_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS personal_remarks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                version_id INTEGER NOT NULL REFERENCES resource_versions(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content_html TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                UNIQUE(resource_id, version_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS fonts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                family_name TEXT NOT NULL,
                aliases TEXT NOT NULL DEFAULT '[]',
                file_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                uploaded_by INTEGER NOT NULL REFERENCES users(id),
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS renderer_font_tasks (
                task_id TEXT PRIMARY KEY,
                font_id INTEGER NOT NULL REFERENCES fonts(id) ON DELETE CASCADE,
                sha256 TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'completed', 'failed')),
                lease_until REAL,
                attempts INTEGER NOT NULL DEFAULT 0,
                error_code TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(font_id, sha256)
            );
            CREATE INDEX IF NOT EXISTS idx_renderer_font_tasks_claim
                ON renderer_font_tasks(status, lease_until, created_at);

            CREATE TABLE IF NOT EXISTS renderer_ppt_tasks (
                task_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                render_attempt TEXT NOT NULL,
                parent_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
                status TEXT NOT NULL DEFAULT 'queued'
                    CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
                lease_token_hash TEXT,
                lease_until REAL,
                worker_id TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                source_manifest TEXT NOT NULL,
                result_manifest TEXT,
                error_code TEXT,
                objects_cleaned_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(session_id, render_attempt)
            );
            CREATE INDEX IF NOT EXISTS idx_renderer_ppt_tasks_claim
                ON renderer_ppt_tasks(status, lease_until, created_at);
            CREATE INDEX IF NOT EXISTS idx_renderer_ppt_tasks_session
                ON renderer_ppt_tasks(session_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS shows (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                owner_id INTEGER NOT NULL REFERENCES users(id),
                subject TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
                visibility_scope TEXT NOT NULL CHECK(visibility_scope IN ('public', 'partial', 'private')),
                management_scope TEXT NOT NULL CHECK(management_scope IN ('public', 'partial', 'private')),
                secrecy_level TEXT NOT NULL CHECK(secrecy_level IN ('public', 'confidential', 'secret')),
                is_standard INTEGER NOT NULL DEFAULT 0 CHECK(is_standard IN (0, 1)),
                created_at TEXT NOT NULL,
                series_id TEXT NOT NULL DEFAULT '',
                version_no INTEGER NOT NULL DEFAULT 1,
                change_note TEXT NOT NULL DEFAULT '',
                updated_by INTEGER REFERENCES users(id),
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS show_visibility (
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (show_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS show_management (
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (show_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS show_resources (
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                version_no INTEGER NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_hidden INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (show_id, resource_id)
            );

            CREATE INDEX IF NOT EXISTS idx_shows_standard ON shows(is_standard);

            CREATE TABLE IF NOT EXISTS show_remarks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content_html TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                UNIQUE(show_id, resource_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS user_preferences (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                pref_key TEXT NOT NULL,
                pref_value TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_id, pref_key)
            );

            CREATE TABLE IF NOT EXISTS user_pinned_resources (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                pinned_at TEXT NOT NULL,
                PRIMARY KEY (user_id, resource_id)
            );

            CREATE TABLE IF NOT EXISTS user_pinned_shows (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                pinned_at TEXT NOT NULL,
                PRIMARY KEY (user_id, show_id)
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_type TEXT NOT NULL CHECK(task_type IN ('batch_split_import', 'download')),
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('uploading', 'pending', 'processing', 'completed', 'failed', 'cancelled')),
                owner_id INTEGER NOT NULL REFERENCES users(id),
                params TEXT NOT NULL DEFAULT '{}',
                progress INTEGER NOT NULL DEFAULT 0,
                upload_progress INTEGER NOT NULL DEFAULT 0,
                total INTEGER NOT NULL DEFAULT 0,
                message TEXT,
                result_data TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
                completed_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

            CREATE TABLE IF NOT EXISTS download_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                track_code TEXT NOT NULL UNIQUE,
                user_id INTEGER REFERENCES users(id),
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                download_type TEXT NOT NULL CHECK(download_type IN ('pdf', 'pptx_images', 'pptx', 'pptx_fonts', 'pptx_pages', 'zip', 'zip_fonts')),
                client_ip TEXT NOT NULL DEFAULT '',
                downloaded_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_download_records_track_code ON download_records(track_code);
            CREATE INDEX IF NOT EXISTS idx_download_records_downloaded_at ON download_records(downloaded_at);

            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL DEFAULT '未分类',
                label TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_by INTEGER NOT NULL REFERENCES users(id),
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS task_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
            );

            CREATE INDEX IF NOT EXISTS idx_task_events_owner_id
                ON task_events(owner_id, id);
            CREATE INDEX IF NOT EXISTS idx_task_events_created_at
                ON task_events(created_at);

            CREATE TABLE IF NOT EXISTS runtime_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
            );

            -- 持久化登录失败计数，确保多 Gunicorn worker 共享限流状态。
            CREATE TABLE IF NOT EXISTS auth_login_attempts (
                key TEXT PRIMARY KEY,
                failure_count INTEGER NOT NULL DEFAULT 0,
                window_started_at REAL NOT NULL,
                locked_until REAL NOT NULL DEFAULT 0,
                updated_at REAL NOT NULL
            );

            """
        )
        # Serialize additive migrations across Gunicorn workers. Without the
        # write lock, two workers starting together could both observe a
        # missing column and one would fail with "duplicate column".
        db.execute("BEGIN IMMEDIATE")
        try:
            _migrate_schema(db, schema_version)
            db.execute(f"PRAGMA user_version = {DB_SCHEMA_VERSION}")
            db.commit()
        except Exception:
            db.rollback()
            raise
        _recover_interrupted_tasks(db)
        prepare_initial_admin(db, legacy_default_password_candidates())
        remove_legacy_default_password_config()
        # Idempotency receipts are only needed long enough for a lost client
        # response to be checked; retaining them forever would itself become
        # a small metadata leak.
        cutoff = (datetime.utcnow() - timedelta(days=7)).isoformat(timespec="seconds") + "Z"
        db.execute("DELETE FROM resource_import_commits WHERE created_at < ?", (cutoff,))
        db.commit()


def _migrate_schema(db: sqlite3.Connection, schema_version: int) -> None:
    """Apply additive, idempotent migrations without requiring data deletion."""
    columns = {
        row["name"]
        for row in db.execute("PRAGMA table_info(users)").fetchall()
    }
    if "avatar_url" not in columns:
        db.execute("ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''")
    if "tags" not in columns:
        db.execute("ALTER TABLE users ADD COLUMN tags TEXT NOT NULL DEFAULT ''")
    if "session_version" not in columns:
        db.execute("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1")
    if "temporary_password_expires_at" not in columns:
        db.execute("ALTER TABLE users ADD COLUMN temporary_password_expires_at TEXT")
    render_columns = {
        row["name"]
        for row in db.execute("PRAGMA table_info(renderer_ppt_tasks)").fetchall()
    }
    if "objects_cleaned_at" not in render_columns:
        db.execute("ALTER TABLE renderer_ppt_tasks ADD COLUMN objects_cleaned_at TEXT")


def _recover_interrupted_tasks(db: sqlite3.Connection) -> None:
    """Mark tasks interrupted by a new service boot exactly once.

    Gunicorn runs FastAPI startup once per worker. ``SLIDEFLOW_BOOT_ID`` is
    shared by all workers from one ``run.sh`` invocation, so replacement and
    sibling workers do not incorrectly fail tasks owned by another worker.
    """
    boot_id = os.environ.get("SLIDEFLOW_BOOT_ID", "").strip()
    should_recover = True
    if boot_id:
        marker = db.execute(
            """
            INSERT INTO runtime_state (key, value)
            VALUES ('task_recovery_boot_id', ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
            WHERE runtime_state.value <> excluded.value
            """,
            (boot_id,),
        )
        should_recover = marker.rowcount > 0

    if should_recover:
        # Windows pull jobs are durable and intentionally survive an API
        # restart. Their worker will either finish the active lease or let it
        # expire and be reclaimed. Keep the user-facing parent task pending.
        db.execute(
            "UPDATE tasks SET status = 'pending', message = '等待 Windows 转换节点领取任务…',"
            " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
            " WHERE status IN ('pending', 'processing')"
            " AND task_type = 'batch_split_import'"
            " AND json_extract(params, '$.workflow_state') = 'rendering'"
        )
        db.execute(
            "UPDATE tasks SET status = 'failed', error_message = '服务重启，任务中断',"
            " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
            " WHERE status IN ('uploading', 'pending', 'processing')"
            " AND NOT (task_type = 'batch_split_import'"
            " AND json_extract(params, '$.workflow_state') = 'rendering')"
        )
    db.commit()
