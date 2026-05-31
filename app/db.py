from __future__ import annotations

import json
import shutil
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path

from app.config import settings
from app.core.fonts import missing_fonts, normalize_font_name
from app.core.ppt import detect_ppt_fonts
from app.core.security import hash_password
from app.core.storage import copy_into, safe_filename


DEFAULT_RESOURCE_SUBJECT = settings.default_resource_subject


def now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def known_font_aliases(db: sqlite3.Connection) -> set[str]:
    """返回已上传字体的归一化别名集合，用于 PPT 缺失字体检测。"""
    aliases: set[str] = set()
    try:
        rows = db.execute("SELECT aliases FROM fonts").fetchall()
    except sqlite3.OperationalError:
        return aliases
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
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_db() -> None:
    settings.db_dir.mkdir(parents=True, exist_ok=True)
    settings.resources_dir.mkdir(parents=True, exist_ok=True)
    settings.templates_dir.mkdir(parents=True, exist_ok=True)
    settings.fonts_dir.mkdir(parents=True, exist_ok=True)
    settings.downloads_dir.mkdir(parents=True, exist_ok=True)
    settings.thumbs_dir.mkdir(parents=True, exist_ok=True)

    with get_db() as db:
        db.executescript(
            """
            DROP TABLE IF EXISTS resource_materials;

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                feishu_id TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL CHECK(role IN ('super_admin', 'admin', 'user')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS resources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                owner_id INTEGER NOT NULL REFERENCES users(id),
                resource_type TEXT NOT NULL CHECK(resource_type IN ('asset', 'template')),
                template_type TEXT,
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

            CREATE TABLE IF NOT EXISTS show_remarks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content_html TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                UNIQUE(show_id, resource_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                memo TEXT NOT NULL DEFAULT '',
                owner_id INTEGER NOT NULL REFERENCES users(id),
                visibility_scope TEXT NOT NULL CHECK(visibility_scope IN ('public', 'partial', 'private')),
                management_scope TEXT NOT NULL CHECK(management_scope IN ('public', 'partial', 'private')),
                is_enabled INTEGER NOT NULL DEFAULT 1,
                networkEnv TEXT NOT NULL DEFAULT 'public_net',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS link_visibility (
                link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(link_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS link_management (
                link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(link_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS user_selected_links (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
                sort_order INTEGER NOT NULL DEFAULT 0,
                UNIQUE(user_id, link_id)
            );

            CREATE TABLE IF NOT EXISTS default_selected_links (
                link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
                sort_order INTEGER NOT NULL DEFAULT 0,
                UNIQUE(link_id)
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
                task_type TEXT NOT NULL CHECK(task_type IN ('split_import', 'batch_split_import')),
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
                download_type TEXT NOT NULL CHECK(download_type IN ('pdf', 'pptx_images', 'pptx', 'pptx_fonts', 'zip', 'zip_fonts')),
                client_ip TEXT NOT NULL DEFAULT '',
                downloaded_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_download_records_track_code ON download_records(track_code);
            CREATE INDEX IF NOT EXISTS idx_download_records_downloaded_at ON download_records(downloaded_at);

            """
        )

        # Migration: add version iteration fields to shows
        try:
            db.execute("ALTER TABLE shows ADD COLUMN series_id TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
        try:
            db.execute("ALTER TABLE shows ADD COLUMN version_no INTEGER NOT NULL DEFAULT 1")
        except Exception:
            pass
        try:
            db.execute("ALTER TABLE shows ADD COLUMN change_note TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass

        # Backfill series_id for existing shows
        rows = db.execute("SELECT id FROM shows WHERE series_id = ''").fetchall()
        for row in rows:
            db.execute("UPDATE shows SET series_id = ? WHERE id = ?", (uuid.uuid4().hex[:10], row["id"]))
        if rows:
            db.commit()

        # Migration: add is_hidden to show_resources
        try:
            db.execute("ALTER TABLE show_resources ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass

        # Migration: add upload_progress to tasks
        try:
            db.execute("ALTER TABLE tasks ADD COLUMN upload_progress INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass

        # Migration: 扩展 tasks.status CHECK 约束以支持 'uploading'
        # SQLite 不支持直接修改 CHECK，需要重建表
        tasks_sql_row = db.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
        ).fetchone()
        if tasks_sql_row and "'uploading'" not in (tasks_sql_row["sql"] or ""):
            db.executescript(
                """
                PRAGMA foreign_keys = OFF;
                CREATE TABLE tasks_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_type TEXT NOT NULL CHECK(task_type IN ('split_import', 'batch_split_import')),
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
                INSERT INTO tasks_new (
                    id, task_type, status, owner_id, params, progress, upload_progress,
                    total, message, result_data, error_message, created_at, updated_at, completed_at
                )
                SELECT
                    id, task_type, status, owner_id, params, progress,
                    COALESCE(upload_progress, 0), total, message, result_data, error_message,
                    created_at, updated_at, completed_at
                FROM tasks;
                DROP TABLE tasks;
                ALTER TABLE tasks_new RENAME TO tasks;
                CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
                CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
                PRAGMA foreign_keys = ON;
                """
            )

        # 服务启动时，将未完成的任务重置为 failed
        db.execute(
            "UPDATE tasks SET status = 'failed', error_message = '服务重启，任务中断',"
            " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
            " WHERE status IN ('uploading', 'pending', 'processing')"
        )

        ensure_schema(db)
        seed_default_users(db)
        migrate_resource_templates(db)
        seed_initial_templates(db)
        seed_initial_resources(db)
        db.commit()


def ensure_schema(db: sqlite3.Connection) -> None:
    resource_columns = {row["name"] for row in db.execute("PRAGMA table_info(resources)").fetchall()}
    if "subject" not in resource_columns:
        db.execute("ALTER TABLE resources ADD COLUMN subject TEXT NOT NULL DEFAULT ''")
    if "status" not in resource_columns:
        db.execute("ALTER TABLE resources ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
    if "scene" in resource_columns:
        # 清理已废弃的 scene 字段（SQLite 3.35+ 支持 DROP COLUMN）
        try:
            db.execute("ALTER TABLE resources DROP COLUMN scene")
        except sqlite3.OperationalError:
            pass
    db.execute("UPDATE resources SET subject = ? WHERE resource_type = 'asset' AND TRIM(COALESCE(subject, '')) = ''", (DEFAULT_RESOURCE_SUBJECT,))
    db.execute("UPDATE resources SET status = 'active' WHERE TRIM(COALESCE(status, '')) = ''")
    template_columns = {row["name"] for row in db.execute("PRAGMA table_info(templates)").fetchall()}
    if "series" not in template_columns:
        db.execute("ALTER TABLE templates ADD COLUMN series TEXT NOT NULL DEFAULT ''")
    if "font_names" not in template_columns:
        db.execute("ALTER TABLE templates ADD COLUMN font_names TEXT NOT NULL DEFAULT '[]'")
    if "missing_fonts" not in template_columns:
        db.execute("ALTER TABLE templates ADD COLUMN missing_fonts TEXT NOT NULL DEFAULT '[]'")
    added_subject_order = "subject_order" not in template_columns
    if added_subject_order:
        db.execute("ALTER TABLE templates ADD COLUMN subject_order INTEGER NOT NULL DEFAULT 0")
    added_series_order = "series_order" not in template_columns
    if added_series_order:
        db.execute("ALTER TABLE templates ADD COLUMN series_order INTEGER NOT NULL DEFAULT 0")
    added_sort_order = "sort_order" not in template_columns
    if added_sort_order:
        db.execute("ALTER TABLE templates ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
    db.execute("UPDATE templates SET series = COALESCE(NULLIF(series, ''), NULLIF(subject, ''), '默认系列') WHERE series = ''")
    type_labels = {"cover": "封面", "catalog": "目录", "content": "正文", "other": "其他"}
    platform_labels = {"wps": "WPS", "microsoft": "Microsoft"}
    if added_sort_order:
        rows = db.execute(
            "SELECT id FROM templates ORDER BY subject COLLATE NOCASE, series COLLATE NOCASE, id"
        ).fetchall()
        for index, row in enumerate(rows, start=1):
            db.execute("UPDATE templates SET sort_order = ? WHERE id = ?", (index * 10, row["id"]))
    if added_subject_order:
        subjects = db.execute(
            "SELECT subject FROM templates GROUP BY subject ORDER BY MIN(sort_order), subject COLLATE NOCASE"
        ).fetchall()
        for index, row in enumerate(subjects, start=1):
            db.execute("UPDATE templates SET subject_order = ? WHERE subject = ?", (index * 10, row["subject"]))
    if added_series_order:
        subjects = db.execute(
            "SELECT subject FROM templates GROUP BY subject ORDER BY MIN(subject_order), subject COLLATE NOCASE"
        ).fetchall()
        for subject_row in subjects:
            series_rows = db.execute(
                """
                SELECT series FROM templates
                WHERE subject = ?
                GROUP BY series
                ORDER BY MIN(sort_order), series COLLATE NOCASE
                """,
                (subject_row["subject"],),
            ).fetchall()
            for index, series_row in enumerate(series_rows, start=1):
                db.execute(
                    "UPDATE templates SET series_order = ? WHERE subject = ? AND series = ?",
                    (index * 10, subject_row["subject"], series_row["series"]),
                )
    for row in db.execute(
        "SELECT id, series, subject, platform, ratio, template_type, office_file_name, office_path, font_names FROM templates"
    ).fetchall():
        suffix = Path(row["office_file_name"] or row["office_path"]).suffix.lower() or ".pptx"
        display = f"{row['subject']}-{row['series']}-{type_labels.get(row['template_type'], row['template_type'])}-{platform_labels.get(row['platform'], row['platform'])}-{row['ratio']}"
        generated = safe_filename(f"{display}{suffix}")
        if row["office_file_name"] != generated:
            db.execute("UPDATE templates SET name = ?, office_file_name = ? WHERE id = ?", (display, generated, row["id"]))
        if row["font_names"] == "[]":
            office_path = settings.abs_path(row["office_path"])
            if office_path and office_path.exists():
                fonts = detect_ppt_fonts(office_path)
                missing = missing_fonts(fonts, known_font_aliases(db))
                db.execute(
                    "UPDATE templates SET font_names = ?, missing_fonts = ? WHERE id = ?",
                    (json.dumps(fonts, ensure_ascii=False), json.dumps(missing, ensure_ascii=False), row["id"]),
                )

    # fonts 表：补齐 aliases JSON 列，从旧 family_name（以 " / " 分隔）迁移
    font_columns = {row["name"] for row in db.execute("PRAGMA table_info(fonts)").fetchall()}
    if "aliases" not in font_columns:
        db.execute("ALTER TABLE fonts ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]'")
    for row in db.execute("SELECT id, family_name, aliases FROM fonts").fetchall():
        if row["aliases"] and row["aliases"] != "[]":
            continue
        parts: list[str] = []
        seen: set[str] = set()
        for piece in (row["family_name"] or "").split(" / "):
            alias = piece.strip()
            key = alias.lower()
            if alias and key not in seen:
                parts.append(alias)
                seen.add(key)
        display = parts[0] if parts else (row["family_name"] or "")
        db.execute(
            "UPDATE fonts SET aliases = ?, family_name = ? WHERE id = ?",
            (json.dumps(parts, ensure_ascii=False), display, row["id"]),
        )

    # resources 表：添加 updated_by 列
    if "updated_by" not in resource_columns:
        db.execute("ALTER TABLE resources ADD COLUMN updated_by INTEGER REFERENCES users(id)")

    # shows 表：添加 updated_by 列
    show_columns = {row["name"] for row in db.execute("PRAGMA table_info(shows)").fetchall()}
    if "updated_by" not in show_columns:
        db.execute("ALTER TABLE shows ADD COLUMN updated_by INTEGER REFERENCES users(id)")

    # links 表：添加 networkEnv 列
    link_columns = {row["name"] for row in db.execute("PRAGMA table_info(links)").fetchall()}
    if "networkEnv" not in link_columns:
        db.execute("ALTER TABLE links ADD COLUMN networkEnv TEXT NOT NULL DEFAULT 'public_net'")
    # links 表：添加 sort_order 列，并以现有更新时间为序回填初始排序值
    if "sort_order" not in link_columns:
        db.execute("ALTER TABLE links ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        link_rows = db.execute(
            "SELECT id FROM links ORDER BY updated_at DESC, id DESC"
        ).fetchall()
        for index, link_row in enumerate(link_rows, start=1):
            db.execute(
                "UPDATE links SET sort_order = ? WHERE id = ?",
                (index * 10, link_row["id"]),
            )

    # download_records 表：将 user_id 改为可空（允许删除用户时保留下载记录）
    dr_columns = {row["name"]: row for row in db.execute("PRAGMA table_info(download_records)").fetchall()}
    if "user_id" in dr_columns and dr_columns["user_id"]["notnull"]:
        db.executescript("""
            PRAGMA foreign_keys = OFF;
            CREATE TABLE download_records_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                track_code TEXT NOT NULL UNIQUE,
                user_id INTEGER REFERENCES users(id),
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                download_type TEXT NOT NULL CHECK(download_type IN ('pdf', 'pptx_images', 'pptx', 'pptx_fonts', 'zip', 'zip_fonts')),
                client_ip TEXT NOT NULL DEFAULT '',
                downloaded_at TEXT NOT NULL
            );
            INSERT INTO download_records_new SELECT * FROM download_records;
            DROP TABLE download_records;
            ALTER TABLE download_records_new RENAME TO download_records;
            CREATE INDEX IF NOT EXISTS idx_download_records_track_code ON download_records(track_code);
            CREATE INDEX IF NOT EXISTS idx_download_records_downloaded_at ON download_records(downloaded_at);
            PRAGMA foreign_keys = ON;
        """)


def _scope_user_ids(db: sqlite3.Connection, table: str, id_column: str, item_id: int) -> list[int]:
    rows = db.execute(f"SELECT user_id FROM {table} WHERE {id_column} = ? ORDER BY user_id", (item_id,)).fetchall()
    return [int(row["user_id"]) for row in rows]


def _set_template_scope_users(db: sqlite3.Connection, table: str, template_id: int, user_ids: list[int]) -> None:
    db.execute(f"DELETE FROM {table} WHERE template_id = ?", (template_id,))
    for user_id in sorted(set(user_ids)):
        db.execute(f"INSERT OR IGNORE INTO {table} (template_id, user_id) VALUES (?, ?)", (template_id, user_id))


def migrate_resource_templates(db: sqlite3.Connection) -> None:
    rows = db.execute("SELECT * FROM resources WHERE resource_type = 'template' ORDER BY id").fetchall()
    if not rows:
        return
    existing_names = {
        row["name"]
        for row in db.execute("SELECT name FROM templates").fetchall()
    }
    for row in rows:
        latest = db.execute(
            """
            SELECT v.* FROM resource_versions v
            JOIN resources r ON r.id = v.resource_id AND r.current_version = v.version_no
            WHERE v.resource_id = ?
            """,
            (row["id"],),
        ).fetchone()
        if latest is None or row["name"] in existing_names:
            continue
        ts = row["updated_at"] or now_iso()
        template_type = row["template_type"] if row["template_type"] in {"cover", "catalog", "content"} else "other"
        ppt_path = settings.abs_path(latest["ppt_path"])
        fonts = detect_ppt_fonts(ppt_path) if ppt_path and ppt_path.exists() else []
        missing = missing_fonts(fonts, known_font_aliases(db))
        db.execute(
            """
            INSERT INTO templates (
                name, series, subject, platform, ratio, template_type,
                office_file_name, office_path, png_path, font_names, missing_fonts, subject_order, series_order, sort_order,
                visibility_scope, management_scope, owner_id, created_at, updated_at
            ) VALUES (?, ?, ?, 'wps', '16:9', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["name"],
                row["subject"] or "未设置系列",
                row["subject"] or "未设置主体",
                template_type,
                Path(latest["ppt_path"]).name,
                latest["ppt_path"],
                latest["png_path"],
                json.dumps(fonts, ensure_ascii=False),
                json.dumps(missing, ensure_ascii=False),
                int(row["id"]) * 10,
                10,
                int(row["id"]) * 10,
                row["visibility_scope"],
                row["management_scope"],
                row["owner_id"],
                row["created_at"],
                ts,
            ),
        )
        template_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        _set_template_scope_users(
            db,
            "template_visibility",
            template_id,
            _scope_user_ids(db, "resource_visibility", "resource_id", int(row["id"])),
        )
        _set_template_scope_users(
            db,
            "template_management",
            template_id,
            _scope_user_ids(db, "resource_management", "resource_id", int(row["id"])),
        )
        existing_names.add(row["name"])
    db.execute("DELETE FROM resources WHERE resource_type = 'template'")


def seed_default_users(db: sqlite3.Connection) -> None:
    existing = db.execute("SELECT COUNT(*) AS total FROM users").fetchone()["total"]
    if existing:
        return
    ts = now_iso()
    users = [
        ("Hawkon", "Hawkon", hash_password(settings.default_password), "", "super_admin", ts, ts),
        ("Demo", "demo", hash_password(settings.default_password), "", "user", ts, ts),
    ]
    db.executemany(
        """
        INSERT INTO users (name, username, password_hash, feishu_id, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        users,
    )


def _admin_id(db: sqlite3.Connection) -> int:
    row = db.execute("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").fetchone()
    return int(row["id"])


def _insert_resource(
    db: sqlite3.Connection,
    *,
    name: str,
    owner_id: int,
    resource_type: str,
    template_type: str | None,
    subject: str,
    tags: str,
    ppt_path: Path,
    png_path: Path | None,
    common_remark_html: str,
) -> None:
    ts = now_iso()
    db.execute(
        """
        INSERT INTO resources (
            name, owner_id, resource_type, template_type, subject, tags,
            visibility_scope, management_scope, secrecy_level,
            current_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'public', 'private', 'public', 1, ?, ?)
        """,
        (name, owner_id, resource_type, template_type, subject, tags, ts, ts),
    )
    resource_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    fonts = detect_ppt_fonts(ppt_path)
    missing = missing_fonts(fonts, known_font_aliases(db))
    db.execute(
        """
        INSERT INTO resource_versions (
            resource_id, version_no, ppt_path, png_path, font_names, missing_fonts,
            common_remark_html, change_note, created_by, created_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, '初始化导入', ?, ?)
        """,
        (
            resource_id,
            settings.store_path(ppt_path),
            settings.store_path(png_path) if png_path else None,
            json.dumps(fonts, ensure_ascii=False),
            json.dumps(missing, ensure_ascii=False),
            common_remark_html,
            owner_id,
            ts,
        ),
    )


def seed_initial_resources(db: sqlite3.Connection) -> None:
    existing = db.execute("SELECT COUNT(*) AS total FROM resources WHERE resource_type = 'asset'").fetchone()["total"]
    if existing:
        return

    sample_dir = Path("/tools/ppt_cloud/sucai")
    if not sample_dir.exists():
        return
    ppt_files = sorted(sample_dir.glob("*.pptx"))
    png_files = sorted(sample_dir.glob("*.png"))
    if not ppt_files:
        return

    admin_id = _admin_id(db)
    seed_dir = settings.resources_dir / "seed"
    if seed_dir.exists():
        shutil.rmtree(seed_dir)
    seed_dir.mkdir(parents=True, exist_ok=True)
    preview = png_files[0] if png_files else None

    first_ppt = ppt_files[0]
    asset_dir = seed_dir / "asset_1"
    ppt_copy = copy_into(first_ppt, asset_dir, "v1_")
    png_copy = copy_into(preview, asset_dir, "preview_") if preview else None
    _insert_resource(
        db,
        name=first_ppt.stem,
        owner_id=admin_id,
        resource_type="asset",
        template_type=None,
        subject=DEFAULT_RESOURCE_SUBJECT,
        tags="样例,单页PPT",
        ppt_path=ppt_copy,
        png_path=png_copy,
        common_remark_html="从 /tools/ppt_cloud/sucai 自动导入的样例素材。",
    )


def seed_initial_templates(db: sqlite3.Connection) -> None:
    existing = db.execute("SELECT COUNT(*) AS total FROM templates").fetchone()["total"]
    if existing:
        return

    sample_dir = Path("/tools/ppt_cloud/sucai")
    if not sample_dir.exists():
        return
    ppt_files = sorted(sample_dir.glob("*.pptx"))
    png_files = sorted(sample_dir.glob("*.png"))
    if not ppt_files:
        return

    admin_id = _admin_id(db)
    seed_dir = settings.templates_dir / "seed"
    if seed_dir.exists():
        shutil.rmtree(seed_dir)
    seed_dir.mkdir(parents=True, exist_ok=True)
    preview = png_files[0] if png_files else None
    template_rows = [
        ("封面模板", "cover"),
        ("目录模板", "catalog"),
        ("正文模板", "content"),
    ]
    ts = now_iso()
    for index, (name, template_type) in enumerate(template_rows):
        if index >= len(ppt_files):
            break
        template_dir = seed_dir / f"template_{index + 1}"
        office_copy = copy_into(ppt_files[index], template_dir, "office_")
        png_copy = copy_into(preview, template_dir, "preview_") if preview else None
        db.execute(
            """
            INSERT INTO templates (
                name, series, subject, platform, ratio, template_type,
                office_file_name, office_path, png_path, font_names, missing_fonts, subject_order, series_order, sort_order,
                visibility_scope, management_scope, owner_id, created_at, updated_at
            ) VALUES (?, '系统预置', '系统预置', 'wps', '16:9', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public', 'private', ?, ?, ?)
            """,
            (
                f"系统预置-系统预置-{ {'cover': '封面', 'catalog': '目录', 'content': '正文'}[template_type] }-WPS-16:9",
                template_type,
                safe_filename(f"系统预置-系统预置-{ {'cover': '封面', 'catalog': '目录', 'content': '正文'}[template_type] }-WPS-16:9{ppt_files[index].suffix.lower()}"),
                settings.store_path(office_copy),
                settings.store_path(png_copy) if png_copy else None,
                json.dumps(detect_ppt_fonts(office_copy), ensure_ascii=False),
                json.dumps(missing_fonts(detect_ppt_fonts(office_copy), known_font_aliases(db)), ensure_ascii=False),
                10,
                10,
                (index + 1) * 10,
                admin_id,
                ts,
                ts,
            ),
        )
