from __future__ import annotations

import json
import os
import queue
import re
import secrets
import sqlite3
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path

from app.config import (
    legacy_default_password_candidates,
    remove_legacy_default_password_config,
    settings,
)
from app.core.bootstrap import prepare_initial_admin
from app.core.fonts import normalize_font_name

DB_SCHEMA_VERSION = 28


def is_sqlite_busy_error(exc: BaseException) -> bool:
    """Return whether SQLite rejected work because another writer is active."""
    if not isinstance(exc, sqlite3.OperationalError):
        return False
    error_code = getattr(exc, "sqlite_errorcode", None)
    if isinstance(error_code, int) and (error_code & 0xFF) in {
        sqlite3.SQLITE_BUSY,
        sqlite3.SQLITE_LOCKED,
    }:
        return True
    message = str(exc).lower()
    return "database is locked" in message or "database table is locked" in message


def new_resource_detail_token() -> str:
    """Create a non-sequential, URL-safe identifier for a resource detail page."""
    return secrets.token_urlsafe(32)


def now_iso(timespec: str = "seconds") -> str:
    return datetime.utcnow().isoformat(timespec=timespec) + "Z"


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
                username_key TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                feishu_id TEXT NOT NULL DEFAULT '',
                avatar_url TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL CHECK(role IN ('system_admin', 'admin', 'user')),
                must_change_pwd INTEGER NOT NULL DEFAULT 0,
                session_version INTEGER NOT NULL DEFAULT 1,
                temporary_password_expires_at TEXT,
                last_login_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS user_tags (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tag_name TEXT NOT NULL,
                tag_id INTEGER REFERENCES user_tag_definitions(id) ON DELETE CASCADE,
                PRIMARY KEY (user_id, tag_name)
            );

            CREATE INDEX IF NOT EXISTS idx_user_tags_name_user
                ON user_tags(tag_name, user_id);

            CREATE TABLE IF NOT EXISTS user_tag_definitions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL DEFAULT '未分类',
                label TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_default_filter INTEGER NOT NULL DEFAULT 0,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS subject_tag_definitions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL DEFAULT '未分类',
                label TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_default_filter INTEGER NOT NULL DEFAULT 0,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS status_tag_definitions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL DEFAULT '未分类',
                label TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_default_filter INTEGER NOT NULL DEFAULT 0,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS admin_audit_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_user_id INTEGER,
                subject_user_id INTEGER,
                action TEXT NOT NULL,
                details TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_admin_audit_events_created
                ON admin_audit_events(created_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_admin_audit_events_target
                ON admin_audit_events(subject_user_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS resource_import_commits (
                session_id TEXT PRIMARY KEY,
                owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                result_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS resources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                detail_token TEXT NOT NULL DEFAULT '',
                name TEXT NOT NULL,
                owner_id INTEGER NOT NULL REFERENCES users(id),
                subject TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                visibility_scope TEXT NOT NULL CHECK(visibility_scope IN ('public', 'partial', 'private')),
                management_scope TEXT NOT NULL CHECK(management_scope IN ('public', 'partial', 'private')),
                secrecy_level TEXT NOT NULL,
                current_version INTEGER NOT NULL DEFAULT 1,
                updated_by INTEGER REFERENCES users(id),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS resource_tags (
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                position INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (resource_id, tag_id)
            );

            CREATE INDEX IF NOT EXISTS idx_resource_tags_tag_resource
                ON resource_tags(tag_id, resource_id);

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

            CREATE TABLE IF NOT EXISTS resource_visibility_tags (
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                tag_name TEXT NOT NULL REFERENCES user_tag_definitions(name) ON UPDATE CASCADE ON DELETE CASCADE,
                tag_id INTEGER REFERENCES user_tag_definitions(id) ON DELETE CASCADE,
                PRIMARY KEY (resource_id, tag_name)
            );

            CREATE INDEX IF NOT EXISTS idx_resource_visibility_tags_name
                ON resource_visibility_tags(tag_name, resource_id);

            CREATE TABLE IF NOT EXISTS resource_management_tags (
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                tag_name TEXT NOT NULL REFERENCES user_tag_definitions(name) ON UPDATE CASCADE ON DELETE CASCADE,
                tag_id INTEGER REFERENCES user_tag_definitions(id) ON DELETE CASCADE,
                PRIMARY KEY (resource_id, tag_name)
            );

            CREATE INDEX IF NOT EXISTS idx_resource_management_tags_name
                ON resource_management_tags(tag_name, resource_id);

            CREATE TABLE IF NOT EXISTS resource_share_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                token_hash TEXT NOT NULL UNIQUE,
                token_ciphertext TEXT,
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

            CREATE TABLE IF NOT EXISTS template_visibility_tags (
                template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
                tag_name TEXT NOT NULL REFERENCES user_tag_definitions(name) ON UPDATE CASCADE ON DELETE CASCADE,
                tag_id INTEGER REFERENCES user_tag_definitions(id) ON DELETE CASCADE,
                PRIMARY KEY (template_id, tag_name)
            );

            CREATE INDEX IF NOT EXISTS idx_template_visibility_tags_name
                ON template_visibility_tags(tag_name, template_id);

            CREATE TABLE IF NOT EXISTS template_management_tags (
                template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
                tag_name TEXT NOT NULL REFERENCES user_tag_definitions(name) ON UPDATE CASCADE ON DELETE CASCADE,
                tag_id INTEGER REFERENCES user_tag_definitions(id) ON DELETE CASCADE,
                PRIMARY KEY (template_id, tag_name)
            );

            CREATE INDEX IF NOT EXISTS idx_template_management_tags_name
                ON template_management_tags(tag_name, template_id);

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

            CREATE TABLE IF NOT EXISTS embedded_font_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                font_id INTEGER NOT NULL REFERENCES fonts(id) ON DELETE CASCADE,
                source_sha256 TEXT NOT NULL,
                face_key TEXT NOT NULL,
                aliases TEXT NOT NULL DEFAULT '[]',
                variant TEXT NOT NULL,
                cache_ref TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'ready'
                    CHECK(status IN ('queued', 'processing', 'ready', 'failed')),
                converter_version TEXT NOT NULL,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(font_id, source_sha256, face_key, converter_version)
            );
            CREATE INDEX IF NOT EXISTS idx_embedded_font_cache_lookup
                ON embedded_font_cache(font_id, status, converter_version);

            CREATE TABLE IF NOT EXISTS renderer_font_tasks (
                task_id TEXT PRIMARY KEY,
                font_id INTEGER NOT NULL REFERENCES fonts(id) ON DELETE CASCADE,
                sha256 TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'completed', 'failed')),
                lease_token_hash TEXT,
                lease_until REAL,
                attempts INTEGER NOT NULL DEFAULT 0,
                error_code TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(font_id, sha256)
            );
            CREATE INDEX IF NOT EXISTS idx_renderer_font_tasks_claim
                ON renderer_font_tasks(status, lease_until, created_at);

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
            );
            CREATE INDEX IF NOT EXISTS idx_renderer_font_delete_tasks_claim
                ON renderer_font_delete_tasks(status, lease_until, created_at);

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
                status TEXT NOT NULL DEFAULT '',
                visibility_scope TEXT NOT NULL CHECK(visibility_scope IN ('public', 'partial', 'private')),
                management_scope TEXT NOT NULL CHECK(management_scope IN ('public', 'partial', 'private')),
                secrecy_level TEXT NOT NULL DEFAULT '',
                is_standard INTEGER NOT NULL DEFAULT 0 CHECK(is_standard IN (0, 1)),
                created_at TEXT NOT NULL,
                series_id TEXT NOT NULL DEFAULT '',
                version_no INTEGER NOT NULL DEFAULT 1,
                change_note TEXT NOT NULL DEFAULT '',
                updated_by INTEGER REFERENCES users(id),
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS show_tags (
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                position INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (show_id, tag_id)
            );

            CREATE INDEX IF NOT EXISTS idx_show_tags_tag_show
                ON show_tags(tag_id, show_id);

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

            CREATE TABLE IF NOT EXISTS show_visibility_tags (
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                tag_name TEXT NOT NULL REFERENCES user_tag_definitions(name) ON UPDATE CASCADE ON DELETE CASCADE,
                tag_id INTEGER REFERENCES user_tag_definitions(id) ON DELETE CASCADE,
                PRIMARY KEY (show_id, tag_name)
            );

            CREATE INDEX IF NOT EXISTS idx_show_visibility_tags_name
                ON show_visibility_tags(tag_name, show_id);

            CREATE TABLE IF NOT EXISTS show_management_tags (
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                tag_name TEXT NOT NULL REFERENCES user_tag_definitions(name) ON UPDATE CASCADE ON DELETE CASCADE,
                tag_id INTEGER REFERENCES user_tag_definitions(id) ON DELETE CASCADE,
                PRIMARY KEY (show_id, tag_name)
            );

            CREATE INDEX IF NOT EXISTS idx_show_management_tags_name
                ON show_management_tags(tag_name, show_id);

            CREATE TABLE IF NOT EXISTS show_share_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                token_hash TEXT NOT NULL UNIQUE,
                token_ciphertext TEXT,
                created_by INTEGER NOT NULL REFERENCES users(id),
                expires_at TEXT NOT NULL,
                revoked_at TEXT,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_show_share_tokens_show
                ON show_share_tokens(show_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_show_share_tokens_active
                ON show_share_tokens(token_hash, expires_at, revoked_at);

            CREATE TABLE IF NOT EXISTS show_share_pages (
                share_id INTEGER NOT NULL REFERENCES show_share_tokens(id) ON DELETE CASCADE,
                version_id INTEGER NOT NULL REFERENCES resource_versions(id) ON DELETE CASCADE,
                sort_order INTEGER NOT NULL,
                PRIMARY KEY (share_id, version_id)
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
                is_default_filter INTEGER NOT NULL DEFAULT 0,
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
        if schema_version < 19:
            _relax_resource_metadata_constraints(db)
        if schema_version < 23:
            _relax_show_metadata_constraints(db)
        # Serialize additive migrations across Gunicorn workers. Without the
        # write lock, two workers starting together could both observe a
        # missing column and one would fail with "duplicate column".
        db.execute("BEGIN IMMEDIATE")
        try:
            # A different worker may have migrated while this process waited
            # for the writer lock. Never replay an older migration or reset
            # a newer application's schema version using the initial read.
            schema_version = int(db.execute("PRAGMA user_version").fetchone()[0])
            if schema_version > DB_SCHEMA_VERSION:
                raise RuntimeError(
                    f"数据库 schema 版本过高（当前 {schema_version}，应用支持到 {DB_SCHEMA_VERSION}）。"
                    "请先升级应用，避免旧版本覆盖新数据。"
                )
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
    for table in ("resources", "resource_versions"):
        columns = {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}
        if "deleted_at" not in columns:
            db.execute(f"ALTER TABLE {table} ADD COLUMN deleted_at TEXT")
    columns = {row["name"] for row in db.execute("PRAGMA table_info(resources)")}
    if "next_version_no" not in columns:
        db.execute("ALTER TABLE resources ADD COLUMN next_version_no INTEGER NOT NULL DEFAULT 2")
        db.execute("""UPDATE resources SET next_version_no = MAX(
            current_version,
            COALESCE((SELECT MAX(version_no) FROM resource_versions v WHERE v.resource_id = resources.id), 0),
            COALESCE((SELECT MAX(version_no) FROM show_resources sr WHERE sr.resource_id = resources.id), 0)
        ) + 1""")
    db.execute("""CREATE TABLE IF NOT EXISTS resource_file_gc (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paths_json TEXT NOT NULL, version_ids_json TEXT NOT NULL, created_at TEXT NOT NULL
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_resource_versions_deleted ON resource_versions(deleted_at)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_show_resources_version ON show_resources(resource_id, version_no)")
    resource_columns = {
        row["name"]
        for row in db.execute("PRAGMA table_info(resources)").fetchall()
    }
    if "detail_token" not in resource_columns:
        db.execute("ALTER TABLE resources ADD COLUMN detail_token TEXT NOT NULL DEFAULT ''")
    missing_token_rows = db.execute(
        "SELECT id FROM resources WHERE detail_token = '' OR detail_token IS NULL ORDER BY id"
    ).fetchall()
    # Most startups have nothing to backfill. Avoid materializing every
    # resource token in each worker merely to enter an empty migration loop.
    existing_tokens = (
        {
            str(row["detail_token"])
            for row in db.execute(
                "SELECT detail_token FROM resources WHERE detail_token <> ''"
            ).fetchall()
        }
        if missing_token_rows
        else set()
    )
    for row in missing_token_rows:
        token = new_resource_detail_token()
        while token in existing_tokens:
            token = new_resource_detail_token()
        db.execute(
            "UPDATE resources SET detail_token = ? WHERE id = ?",
            (token, int(row["id"])),
        )
        existing_tokens.add(token)
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_detail_token "
        "ON resources(detail_token) WHERE detail_token <> ''"
    )
    share_token_columns = {
        row["name"]
        for row in db.execute("PRAGMA table_info(resource_share_tokens)").fetchall()
    }
    if "token_ciphertext" not in share_token_columns:
        db.execute("ALTER TABLE resource_share_tokens ADD COLUMN token_ciphertext TEXT")
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
    if "last_login_at" not in columns:
        db.execute("ALTER TABLE users ADD COLUMN last_login_at TEXT")
    username_key_missing = "username_key" not in columns
    if username_key_missing:
        db.execute("ALTER TABLE users ADD COLUMN username_key TEXT NOT NULL DEFAULT ''")
    render_columns = {
        row["name"]
        for row in db.execute("PRAGMA table_info(renderer_ppt_tasks)").fetchall()
    }
    if "objects_cleaned_at" not in render_columns:
        db.execute("ALTER TABLE renderer_ppt_tasks ADD COLUMN objects_cleaned_at TEXT")

    # Default filter state belongs to tag definitions rather than deployment
    # properties. Keep the schema migration additive for existing databases.
    tag_definition_tables = (
        "tags",
        "subject_tag_definitions",
        "status_tag_definitions",
        "user_tag_definitions",
    )
    for table in tag_definition_tables:
        tag_columns = {
            row["name"] for row in db.execute(f"PRAGMA table_info({table})").fetchall()
        }
        if "is_default_filter" not in tag_columns:
            db.execute(
                f"ALTER TABLE {table} ADD COLUMN is_default_filter INTEGER NOT NULL DEFAULT 0"
            )

    # Secrecy metadata was retired in schema version 24. Keep the legacy
    # columns for old readers and migrations, but remove all stored values and
    # definitions so the platform cannot expose or reuse them. Run this
    # idempotently on every startup so a database already marked as version 24
    # cannot retain values written by an older process.
    _retire_secrecy_metadata(db)

    from app.services.tag_defaults import migrate_tag_defaults
    migrate_tag_defaults(db, schema_version)
    _maintain_resource_metadata_tags(db)
    if schema_version < 25:
        _migrate_normalized_content_tags(db)
    _migrate_normalized_user_tags(db)
    font_task_columns = {
        row["name"]
        for row in db.execute("PRAGMA table_info(renderer_font_tasks)").fetchall()
    }
    if "lease_token_hash" not in font_task_columns:
        db.execute("ALTER TABLE renderer_font_tasks ADD COLUMN lease_token_hash TEXT")

    # Version 13 adds a Unicode-aware login key. Move every row through a
    # temporary username first so normalization remains safe under the legacy
    # case-sensitive UNIQUE constraint.
    needs_username_key_migration = (
        schema_version < 13
        or username_key_missing
        or db.execute("SELECT 1 FROM users WHERE username_key = '' LIMIT 1").fetchone() is not None
    )
    if needs_username_key_migration:
        from app.core.user_profiles import normalise_username, username_lookup_key

        usernames = db.execute("SELECT id, username FROM users ORDER BY id").fetchall()
        used_usernames: set[str] = set()
        final_usernames: dict[int, str] = {}
        for row in usernames:
            user_id = int(row["id"])
            raw_base = (row["username"] or "").strip() or f"user-{user_id}"
            try:
                base = normalise_username(raw_base)
            except ValueError:
                base = f"user-{user_id}"
            base = base[:50]
            candidate = base
            collision_index = 0
            while username_lookup_key(candidate) in used_usernames:
                collision_index += 1
                suffix = (
                    f"-{user_id}"
                    if collision_index == 1
                    else f"-{user_id}-{collision_index}"
                )
                candidate = f"{base[:max(1, 50 - len(suffix))]}{suffix}"
            used_usernames.add(username_lookup_key(candidate))
            final_usernames[user_id] = candidate

        # Move all rows through guaranteed-unique temporary values first. A
        # direct trim can otherwise collide with another row under the old
        # case-sensitive UNIQUE constraint before that other row is renamed.
        reserved = {str(row["username"]) for row in usernames} | set(final_usernames.values())
        temporary_usernames: dict[int, str] = {}
        for row in usernames:
            user_id = int(row["id"])
            suffix = 0
            while True:
                temporary = f"__sf_user_{user_id}_{suffix}__"[:50]
                if temporary not in reserved:
                    break
                suffix += 1
            reserved.add(temporary)
            temporary_usernames[user_id] = temporary
            db.execute("UPDATE users SET username = ? WHERE id = ?", (temporary, user_id))
        for user_id, username in final_usernames.items():
            db.execute(
                "UPDATE users SET username = ?, username_key = ? WHERE id = ?",
                (username, username_lookup_key(username), user_id),
            )

    # Version 11 normalizes user labels into an indexed relation. Keep the
    # legacy users.tags column as a response/editing cache while all new writes
    # update both representations in one transaction.
    if schema_version < 11:
        feishu_ids = db.execute(
            "SELECT id, feishu_id FROM users WHERE feishu_id <> '' ORDER BY id"
        ).fetchall()
        used_feishu_ids: set[str] = set()
        final_feishu_ids: dict[int, str] = {}
        for row in feishu_ids:
            feishu_id = (row["feishu_id"] or "").strip()
            if feishu_id and feishu_id not in used_feishu_ids:
                used_feishu_ids.add(feishu_id)
                final_feishu_ids[int(row["id"])] = feishu_id
        db.execute("UPDATE users SET feishu_id = '' WHERE feishu_id <> ''")
        for user_id, feishu_id in final_feishu_ids.items():
            db.execute("UPDATE users SET feishu_id = ? WHERE id = ?", (feishu_id, user_id))

        rows = db.execute("SELECT id, tags FROM users ORDER BY id").fetchall()
        for row in rows:
            seen: set[str] = set()
            normalised_tags: list[str] = []
            for raw_tag in re.split(r"[，,\s]+", row["tags"] or ""):
                tag = raw_tag.strip()[:64]
                if not tag or tag in seen:
                    continue
                if len(",".join([*normalised_tags, tag])) > 1000:
                    break
                seen.add(tag)
                normalised_tags.append(tag)
                db.execute(
                    "INSERT OR IGNORE INTO user_tags (user_id, tag_name) VALUES (?, ?)",
                    (int(row["id"]), tag),
                )
            normalised_value = ",".join(normalised_tags)
            if normalised_value != (row["tags"] or ""):
                db.execute(
                    "UPDATE users SET tags = ? WHERE id = ?",
                    (normalised_value, int(row["id"])),
                )

    # Version 14 separates user-label definitions from resource-label
    # definitions.  Existing assignments are promoted into the new definition
    # table so upgrades never make an already assigned label disappear from
    # the user editor.
    if schema_version < 14:
        existing_names = {
            str(row["tag_name"]).strip()
            for row in db.execute(
                "SELECT DISTINCT tag_name FROM user_tags WHERE tag_name <> ''"
            ).fetchall()
            if str(row["tag_name"] or "").strip()
        }
        for row in db.execute("SELECT tags FROM users WHERE tags <> ''").fetchall():
            existing_names.update(
                tag.strip()
                for tag in re.split(r"[，,\s]+", row["tags"] or "")
                if tag.strip()
            )
        next_sort = int(
            db.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM user_tag_definitions"
            ).fetchone()[0]
        )
        created_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        for name in sorted(existing_names):
            if len(name) > 64 or any(unicodedata.category(char).startswith("C") for char in name):
                continue
            if re.search(r"[，,\s]", name):
                continue
            if "-" in name:
                category, label = (part.strip() for part in name.split("-", 1))
                if not category or not label:
                    category, label = "未分类", name
            else:
                category, label = "未分类", name
            cursor = db.execute(
                "INSERT OR IGNORE INTO user_tag_definitions "
                "(name, category, label, sort_order, created_by, created_at) "
                "VALUES (?, ?, ?, ?, NULL, ?)",
                (name, category, label, next_sort, created_at),
            )
            if cursor.rowcount:
                next_sort += 1
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase "
        "ON users(username COLLATE NOCASE)"
    )
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_key "
        "ON users(username_key)"
    )
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_feishu_id_nonempty "
        "ON users(feishu_id) WHERE feishu_id <> ''"
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_users_name_nocase "
        "ON users(name COLLATE NOCASE, id)"
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_users_last_login_at "
        "ON users(last_login_at)"
    )


def _relax_resource_metadata_constraints(db: sqlite3.Connection) -> None:
    """Remove legacy status/secrecy CHECK constraints without losing child rows."""
    resource_columns = {
        str(row["name"]) for row in db.execute("PRAGMA table_info(resources)").fetchall()
    }
    if "detail_token" not in resource_columns:
        db.execute("ALTER TABLE resources ADD COLUMN detail_token TEXT NOT NULL DEFAULT ''")
    schema_sql_row = db.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resources'"
    ).fetchone()
    schema_sql = str(schema_sql_row[0] or "") if schema_sql_row else ""
    if "CHECK(status IN" not in schema_sql and "CHECK(secrecy_level IN" not in schema_sql:
        return

    db.execute("PRAGMA foreign_keys = OFF")
    try:
        db.execute("BEGIN EXCLUSIVE")
        db.execute(
            """
            CREATE TABLE resources_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                detail_token TEXT NOT NULL DEFAULT '',
                name TEXT NOT NULL,
                owner_id INTEGER NOT NULL REFERENCES users(id),
                subject TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                visibility_scope TEXT NOT NULL CHECK(visibility_scope IN ('public', 'partial', 'private')),
                management_scope TEXT NOT NULL CHECK(management_scope IN ('public', 'partial', 'private')),
                secrecy_level TEXT NOT NULL,
                current_version INTEGER NOT NULL DEFAULT 1,
                updated_by INTEGER REFERENCES users(id),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        db.execute(
            """
            INSERT INTO resources_new (
                id, detail_token, name, owner_id, subject, tags, status,
                visibility_scope, management_scope, secrecy_level, current_version,
                updated_by, created_at, updated_at
            )
            SELECT id, detail_token, name, owner_id, subject, tags, status,
                   visibility_scope, management_scope, secrecy_level, current_version,
                   updated_by, created_at, updated_at
            FROM resources
            """
        )
        db.execute("DROP TABLE resources")
        db.execute("ALTER TABLE resources_new RENAME TO resources")
        db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_detail_token "
            "ON resources(detail_token) WHERE detail_token <> ''"
        )
        violations = db.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise RuntimeError("资源表迁移后外键校验失败")
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.execute("PRAGMA foreign_keys = ON")


def _relax_show_metadata_constraints(db: sqlite3.Connection) -> None:
    """Remove legacy show status/secrecy enums while preserving relations."""
    schema_sql_row = db.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'shows'"
    ).fetchone()
    schema_sql = str(schema_sql_row[0] or "") if schema_sql_row else ""
    if not schema_sql:
        return
    if "CHECK(status IN" not in schema_sql and "CHECK(secrecy_level IN" not in schema_sql:
        return

    db.execute("PRAGMA foreign_keys = OFF")
    try:
        db.execute("BEGIN EXCLUSIVE")
        db.execute(
            """
            CREATE TABLE shows_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                owner_id INTEGER NOT NULL REFERENCES users(id),
                subject TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                visibility_scope TEXT NOT NULL CHECK(visibility_scope IN ('public', 'partial', 'private')),
                management_scope TEXT NOT NULL CHECK(management_scope IN ('public', 'partial', 'private')),
                secrecy_level TEXT NOT NULL DEFAULT '',
                is_standard INTEGER NOT NULL DEFAULT 0 CHECK(is_standard IN (0, 1)),
                created_at TEXT NOT NULL,
                series_id TEXT NOT NULL DEFAULT '',
                version_no INTEGER NOT NULL DEFAULT 1,
                change_note TEXT NOT NULL DEFAULT '',
                updated_by INTEGER REFERENCES users(id),
                updated_at TEXT NOT NULL
            )
            """
        )
        db.execute(
            """
            INSERT INTO shows_new (
                id, name, owner_id, subject, tags, status, visibility_scope,
                management_scope, secrecy_level, is_standard, created_at, series_id,
                version_no, change_note, updated_by, updated_at
            )
            SELECT id, name, owner_id, subject, tags, status, visibility_scope,
                   management_scope, secrecy_level, is_standard, created_at, series_id,
                   version_no, change_note, updated_by, updated_at
            FROM shows
            """
        )
        db.execute("DROP TABLE shows")
        db.execute("ALTER TABLE shows_new RENAME TO shows")
        db.execute("CREATE INDEX IF NOT EXISTS idx_shows_standard ON shows(is_standard)")
        violations = db.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise RuntimeError("放映表迁移后外键校验失败")
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.execute("PRAGMA foreign_keys = ON")


def _maintain_resource_metadata_tags(db: sqlite3.Connection) -> None:
    """Keep metadata choices explicitly administrator-maintained.

    Older releases generated subject and status definitions from built-in
    defaults or historical resource values. Remove only those known generated
    rows, then keep every remaining metadata definition flat.
    """
    legacy_secrecy_table = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'secrecy_tag_definitions'"
    ).fetchone()
    if legacy_secrecy_table is not None:
        db.execute("DELETE FROM secrecy_tag_definitions")

    has_defaults = db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tag_default_rules'").fetchone() is not None
    def protected(domain: str) -> str:
        return (f" AND id NOT IN (SELECT tag_id FROM tag_default_rules WHERE domain = '{domain}')"
                if has_defaults else "")

    db.execute(
        "DELETE FROM subject_tag_definitions "
        "WHERE created_by IS NULL AND is_default_filter = 0" + protected("subject")
    )
    db.execute(
        "UPDATE subject_tag_definitions SET category = '主体', label = name"
    )
    for table, category in (("status_tag_definitions", "状态"),):
        db.execute(
            f"DELETE FROM {table} "
            "WHERE created_by IS NULL AND is_default_filter = 0 "
            "AND category IN ('系统默认', '历史值')" + protected("status")
        )
        db.execute(
            f"UPDATE {table} SET category = ?, label = name",
            (category,),
        )


def _migrate_normalized_content_tags(db: sqlite3.Connection) -> None:
    """Backfill resource/show tag relations from legacy CSV columns."""
    from app.services.tagging import migrate_entity_tags

    migrate_entity_tags(
        db,
        entity_table="resources",
        relation_table="resource_tags",
        entity_column="resource_id",
    )
    migrate_entity_tags(
        db,
        entity_table="shows",
        relation_table="show_tags",
        entity_column="show_id",
    )


def _migrate_normalized_user_tags(db: sqlite3.Connection) -> None:
    """Add and backfill IDs for user labels and scope grants."""
    relation_specs = (
        ("user_tags", "tag_id", "tag_name", "user_tag_definitions"),
        ("resource_visibility_tags", "tag_id", "tag_name", "user_tag_definitions"),
        ("resource_management_tags", "tag_id", "tag_name", "user_tag_definitions"),
        ("show_visibility_tags", "tag_id", "tag_name", "user_tag_definitions"),
        ("show_management_tags", "tag_id", "tag_name", "user_tag_definitions"),
        ("template_visibility_tags", "tag_id", "tag_name", "user_tag_definitions"),
        ("template_management_tags", "tag_id", "tag_name", "user_tag_definitions"),
    )
    for table, id_column, name_column, definition_table in relation_specs:
        table_exists = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table,),
        ).fetchone()
        if table_exists is None:
            continue
        columns = {
            str(row["name"]) for row in db.execute(f"PRAGMA table_info({table})").fetchall()
        }
        if id_column not in columns:
            db.execute(
                f"ALTER TABLE {table} ADD COLUMN {id_column} INTEGER"
            )
        db.execute(
            f"UPDATE {table} SET {id_column} = ("
            f"SELECT id FROM {definition_table} d "
            f"WHERE d.name = {table}.{name_column}"
            f") WHERE {id_column} IS NULL"
        )
        entity_column = "user_id" if table == "user_tags" else (
            "template_id" if table.startswith("template_") else
            "show_id" if table.startswith("show_") else "resource_id"
        )
        db.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{table}_{'id_user' if table == 'user_tags' else 'id'} "
            f"ON {table}({id_column}, {entity_column})"
        )


def _retire_secrecy_metadata(db: sqlite3.Connection) -> None:
    """Clear retired secrecy metadata while preserving legacy schema columns.

    Existing deployments may still have secrecy columns or the old definition
    table. The columns remain intentionally so older migrations and readers can
    open the database, but the current platform must never retain or write the
    retired values.
    """
    table_names = {
        str(row["name"])
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    if "secrecy_tag_definitions" in table_names:
        db.execute("DELETE FROM secrecy_tag_definitions")

    for table in ("resources", "shows"):
        if table not in table_names:
            continue
        columns = {
            str(row["name"]) for row in db.execute(f"PRAGMA table_info({table})").fetchall()
        }
        if "secrecy_level" in columns:
            db.execute(f"UPDATE {table} SET secrecy_level = '' WHERE secrecy_level <> ''")


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
        from app.core.errors import render_public_message

        now = now_iso()
        # A terminal parent owns the workflow lifecycle. Never let a stale
        # Windows lease continue after that parent was cancelled, failed or
        # completed.
        db.execute(
            "UPDATE renderer_ppt_tasks SET status='cancelled', lease_token_hash=NULL,"
            " lease_until=NULL, updated_at=?"
            " WHERE status IN ('queued','running') AND (parent_task_id IS NULL OR parent_task_id IN ("
            " SELECT id FROM tasks WHERE status IN ('completed','failed','cancelled')))",
            (now,),
        )

        # The SQLite child receipt is authoritative across service restarts.
        # Session JSON is a publication cache and may lag the child by one
        # filesystem write, so reconstruct every active parent from its newest
        # durable render generation.
        rows = db.execute(
            "SELECT r.*, p.status AS parent_status, p.params AS parent_params"
            " FROM renderer_ppt_tasks r JOIN tasks p ON p.id=r.parent_task_id"
            " WHERE p.task_type='batch_split_import'"
            " AND p.status IN ('uploading','pending','processing')"
            " ORDER BY r.parent_task_id, r.created_at DESC, r.rowid DESC"
        ).fetchall()
        recovered_parent_ids: list[int] = []
        seen: set[int] = set()
        for row in rows:
            parent_id = int(row["parent_task_id"])
            if parent_id in seen:
                continue
            seen.add(parent_id)
            recovered_parent_ids.append(parent_id)
            # A parent can only publish its newest render generation. Cancel
            # any older active generation left by legacy code or a partial
            # migration so it cannot later overwrite the recovered state.
            db.execute(
                "UPDATE renderer_ppt_tasks SET status='cancelled', lease_token_hash=NULL,"
                " lease_until=NULL, updated_at=? WHERE parent_task_id=? AND task_id<>?"
                " AND status IN ('queued','running')",
                (now, parent_id, row["task_id"]),
            )
            try:
                params = json.loads(row["parent_params"] or "{}")
            except (TypeError, ValueError, json.JSONDecodeError):
                params = {}
            try:
                source_manifest = json.loads(row["source_manifest"] or "{}")
            except (TypeError, ValueError, json.JSONDecodeError):
                source_manifest = {}
            pages = source_manifest.get("pages", [])
            total = len(pages) if isinstance(pages, list) else 0
            params.update({
                "render_task_id": row["task_id"],
                "render_attempt": row["render_attempt"],
                "render_total": total,
            })
            status = str(row["status"])
            if status in {"queued", "running"}:
                from app.services.resource_import.render_tasks import _accepted_render_results
                try:
                    accepted, _, _ = _accepted_render_results(row)
                    completed = len(accepted)
                except (TypeError, ValueError, KeyError):
                    completed = 0
                params.update({
                    "workflow_state": "rendering",
                    "preview_status": "rendering",
                    "preview_error": None,
                    "render_stage": "queued" if status == "queued" else "rendering",
                    "render_completed": completed,
                    "render_worker_attempt": int(row["attempts"]),
                })
                message = f"已完成 {completed} / {total} 页图片渲染" if completed else "等待 Windows 转换节点领取任务…"
                db.execute(
                    "UPDATE tasks SET status='pending', progress=?, total=?,"
                    " message=?, error_message=NULL, params=?,"
                    " updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id=?",
                    (completed, total, message, json.dumps(params, ensure_ascii=False), parent_id),
                )
            elif status == "completed":
                params.update({
                    "workflow_state": "awaiting_confirmation",
                    "preview_status": "ready",
                    "preview_error": None,
                    "render_stage": "completed",
                    "render_completed": total,
                })
                db.execute(
                    "UPDATE tasks SET status='pending', progress=?, total=?,"
                    " message='图片已渲染，等待确认导入', error_message=NULL, params=?,"
                    " updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id=?",
                    (total, total, json.dumps(params, ensure_ascii=False), parent_id),
                )
            else:
                message = (
                    "该图片渲染任务已取消，请重新生成"
                    if status == "cancelled"
                    else render_public_message(row["error_code"])
                )
                params.update({
                    "workflow_state": "awaiting_render",
                    "preview_status": "error",
                    "preview_error": message,
                    "render_stage": "failed",
                    "render_completed": 0,
                })
                db.execute(
                    "UPDATE tasks SET status='pending', progress=0, total=?, message=?,"
                    " error_message=?, params=?,"
                    " updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id=?",
                    (total, message, message, json.dumps(params, ensure_ascii=False), parent_id),
                )

        placeholders = ",".join("?" for _ in recovered_parent_ids)
        exclusion = f" AND id NOT IN ({placeholders})" if placeholders else ""
        db.execute(
            "UPDATE tasks SET status='failed', error_message='服务重启，任务中断',"
            " updated_at=strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
            " WHERE status IN ('uploading','pending','processing')" + exclusion,
            recovered_parent_ids,
        )
    db.commit()
