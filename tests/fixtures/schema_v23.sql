-- Frozen schema-23 business tables and indexes, captured from the v23 initializer.
-- Contains no application or production data. Tests load this SQL directly, never Git.
-- Unrelated service/task tables are created normally by the current initializer.

CREATE TABLE users (
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

CREATE TABLE user_tag_definitions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL DEFAULT '未分类',
                label TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_default_filter INTEGER NOT NULL DEFAULT 0,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL
            );

CREATE TABLE user_tags (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tag_name TEXT NOT NULL,
                PRIMARY KEY (user_id, tag_name)
            );

CREATE TABLE tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL DEFAULT '未分类',
                label TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_default_filter INTEGER NOT NULL DEFAULT 0,
                created_by INTEGER NOT NULL REFERENCES users(id),
                created_at TEXT NOT NULL
            );

CREATE TABLE subject_tag_definitions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL DEFAULT '未分类',
                label TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_default_filter INTEGER NOT NULL DEFAULT 0,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL
            );

CREATE TABLE status_tag_definitions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL DEFAULT '未分类',
                label TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_default_filter INTEGER NOT NULL DEFAULT 0,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL
            );

CREATE TABLE secrecy_tag_definitions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL DEFAULT '未分类',
                label TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_default_filter INTEGER NOT NULL DEFAULT 0,
                created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL
            );

CREATE TABLE resources (
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

CREATE TABLE resource_versions (
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

CREATE TABLE resource_visibility (
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (resource_id, user_id)
            );

CREATE TABLE resource_management (
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (resource_id, user_id)
            );

CREATE TABLE resource_visibility_tags (
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                tag_name TEXT NOT NULL REFERENCES user_tag_definitions(name) ON UPDATE CASCADE ON DELETE CASCADE,
                PRIMARY KEY (resource_id, tag_name)
            );

CREATE TABLE resource_management_tags (
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                tag_name TEXT NOT NULL REFERENCES user_tag_definitions(name) ON UPDATE CASCADE ON DELETE CASCADE,
                PRIMARY KEY (resource_id, tag_name)
            );

CREATE TABLE templates (
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

CREATE TABLE template_visibility (
                template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (template_id, user_id)
            );

CREATE TABLE template_management (
                template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (template_id, user_id)
            );

CREATE TABLE template_visibility_tags (
                template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
                tag_name TEXT NOT NULL REFERENCES user_tag_definitions(name) ON UPDATE CASCADE ON DELETE CASCADE,
                PRIMARY KEY (template_id, tag_name)
            );

CREATE TABLE template_management_tags (
                template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
                tag_name TEXT NOT NULL REFERENCES user_tag_definitions(name) ON UPDATE CASCADE ON DELETE CASCADE,
                PRIMARY KEY (template_id, tag_name)
            );

CREATE TABLE shows (
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

CREATE TABLE show_resources (
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                version_no INTEGER NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_hidden INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (show_id, resource_id)
            );

CREATE TABLE show_visibility (
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (show_id, user_id)
            );

CREATE TABLE show_management (
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                PRIMARY KEY (show_id, user_id)
            );

CREATE TABLE personal_remarks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                version_id INTEGER NOT NULL REFERENCES resource_versions(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content_html TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                UNIQUE(resource_id, version_id, user_id)
            );

CREATE TABLE show_remarks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content_html TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                UNIQUE(show_id, resource_id, user_id)
            );

CREATE INDEX idx_resource_management_tags_name
                ON resource_management_tags(tag_name, resource_id);

CREATE INDEX idx_resource_visibility_tags_name
                ON resource_visibility_tags(tag_name, resource_id);

CREATE UNIQUE INDEX idx_resources_detail_token ON resources(detail_token) WHERE detail_token <> '';

CREATE INDEX idx_shows_standard ON shows(is_standard);

CREATE INDEX idx_template_management_tags_name
                ON template_management_tags(tag_name, template_id);

CREATE INDEX idx_template_visibility_tags_name
                ON template_visibility_tags(tag_name, template_id);

CREATE INDEX idx_user_tags_name_user
                ON user_tags(tag_name, user_id);

CREATE UNIQUE INDEX idx_users_feishu_id_nonempty ON users(feishu_id) WHERE feishu_id <> '';

CREATE INDEX idx_users_last_login_at ON users(last_login_at);

CREATE INDEX idx_users_name_nocase ON users(name COLLATE NOCASE, id);

CREATE UNIQUE INDEX idx_users_username_key ON users(username_key);

CREATE UNIQUE INDEX idx_users_username_nocase ON users(username COLLATE NOCASE);

PRAGMA user_version = 23;
