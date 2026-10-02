"""Upgrade real legacy business tables without Git, production data or services."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from app import db as database
from app.config import settings
from app.core.permissions import can_manage_resource, can_manage_show, can_view_resource, can_view_show
from app.services.templates import can_manage_template, can_view_template


LEGACY_SCHEMA = Path(__file__).parent / 'fixtures' / 'schema_v23.sql'
STAMP = '2025-06-01T00:00:00Z'
LEGACY_SCOPE_TABLES = (
    'user_tags', 'resource_visibility_tags', 'resource_management_tags',
    'template_visibility_tags', 'template_management_tags',
)


class DatabaseUpgradeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='slideflow-upgrade-v23-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        paths = {
            'root_dir': self.root,
            'data_dir': self.root / 'data',
            'db_dir': self.root / 'data' / 'db',
            'assets_dir': self.root / 'data' / 'assets',
            'resources_dir': self.root / 'data' / 'assets' / 'resources',
            'templates_dir': self.root / 'data' / 'assets' / 'templates',
            'fonts_dir': self.root / 'data' / 'assets' / 'fonts',
            'thumbs_dir': self.root / 'data' / 'assets' / 'thumbs',
            'downloads_dir': self.root / 'data' / 'assets' / 'downloads',
            'log_dir': self.root / 'data' / 'logs',
            'db_path': self.root / 'data' / 'db' / 'legacy.sqlite',
            'storage_backend': 'local',
        }
        settings_patch = patch.multiple(settings, **paths)
        settings_patch.start()
        self.addCleanup(settings_patch.stop)
        settings.db_dir.mkdir(parents=True)
        self.db = self.connect()
        self.addCleanup(self.db.close)
        self.db.executescript(LEGACY_SCHEMA.read_text(encoding='utf-8'))
        self.legacy_tables = [row[0] for row in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        self.seed_legacy_data()

        # Keep startup's unrelated account/config maintenance away from any
        # developer configuration. The schema and data migrations run normally.
        for patcher in (
            patch.object(database, 'get_db', self.migration_connection),
            patch.object(database, 'prepare_initial_admin', return_value=False),
            patch.object(database, 'legacy_default_password_candidates', return_value=[]),
            patch.object(database, 'remove_legacy_default_password_config'),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def connect(self):
        connection = sqlite3.connect(settings.db_path)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys = ON')
        return connection

    @contextmanager
    def migration_connection(self):
        connection = self.connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def insert(self, table, **values):
        columns = ', '.join(values)
        placeholders = ', '.join('?' for _ in values)
        self.db.execute(f'INSERT INTO {table} ({columns}) VALUES ({placeholders})', tuple(values.values()))

    def seed_legacy_data(self):
        for user_id, username, role, labels in (
            (1, 'admin', 'system_admin', ''), (2, 'owner', 'user', ''),
            (3, 'member', 'admin', '部门-研发,职能-运营'), (4, 'outside', 'admin', '部门-销售'),
        ):
            self.insert('users', id=user_id, name=username, username=username,
                        username_key=username, password_hash='fixture-only-not-a-password',
                        role=role, tags=labels, session_version=user_id + 2,
                        created_at=STAMP, updated_at=STAMP)
        for tag_id, name in ((40, '部门-研发'), (41, '职能-运营'), (42, '部门-销售')):
            self.insert('user_tag_definitions', id=tag_id, name=name, label=name,
                        category='旧分组', sort_order=tag_id, created_by=1, created_at=STAMP)
        for user_id, name in ((3, '部门-研发'), (3, '职能-运营'), (4, '部门-销售')):
            self.insert('user_tags', user_id=user_id, tag_name=name)
        # The same spelling in the two definition tables has different IDs.
        for tag_id, name in ((10, '业务-通用'), (11, '放映-开场'), (12, '备用内容'), (13, '部门-研发')):
            self.insert('tags', id=tag_id, name=name, category='内容', label=name,
                        sort_order=tag_id, created_by=2, created_at=STAMP)
        for table, name in (('subject_tag_definitions', '旧主体'),
                            ('status_tag_definitions', '已发布'),
                            ('secrecy_tag_definitions', 'internal')):
            self.insert(table, id=1, name=name, category='旧分组', label=name,
                        created_by=1, created_at=STAMP)
        for resource_id, owner_id, tags_value, current in (
            (20, 2, '业务-通用, 新内容，业务-通用\n层级-新增', 3), (21, 4, '', 2),
        ):
            self.insert('resources', id=resource_id, detail_token=('A' if resource_id == 20 else 'B') * 43,
                        name=f'Legacy resource {resource_id}', owner_id=owner_id, subject='旧主体',
                        tags=tags_value, status='已发布', visibility_scope='partial' if resource_id == 20 else 'private',
                        management_scope='partial' if resource_id == 20 else 'private', secrecy_level='internal',
                        current_version=current, updated_by=3, created_at=STAMP, updated_at=STAMP)
        for version_id, resource_id, version in ((100, 20, 1), (101, 20, 2), (102, 20, 3), (110, 21, 1), (111, 21, 2)):
            self.insert('resource_versions', id=version_id, resource_id=resource_id, version_no=version,
                        ppt_path=f'assets/resources/{resource_id}/v{version}.pptx',
                        png_path=f'oss://fixture/resources/{resource_id}/v{version}.png',
                        font_names='["Legacy Font"]', missing_fonts='[]',
                        common_remark_html=f'<p>Version {version}</p>', change_note=f'Change {version}',
                        created_by=2, created_at=STAMP)
        for show_id, owner_id, version, labels in (
            (10, 2, 7, '放映-开场,业务-通用,放映-开场, 新放映'), (11, 4, 8, ''),
        ):
            self.insert('shows', id=show_id, name=f'Legacy show {show_id}', owner_id=owner_id,
                        subject='旧主体', tags=labels, status='已发布', visibility_scope='partial',
                        management_scope='partial', secrecy_level='internal', is_standard=1,
                        series_id='legacy-series', version_no=version, change_note=f'Release {version}',
                        updated_by=3, created_at=STAMP, updated_at=STAMP)
        for show_id, resource_id, version, order, hidden in ((10, 20, 1, 0, 0), (10, 21, 1, 1, 1), (11, 20, 2, 0, 0)):
            self.insert('show_resources', show_id=show_id, resource_id=resource_id,
                        version_no=version, sort_order=order, is_hidden=hidden)
        self.insert('templates', id=30, name='Legacy template', series='Legacy series', subject='旧主体',
                    platform='wps', ratio='16:9', template_type='content', office_file_name='legacy.pptx',
                    office_path='assets/templates/30/source.pptx', png_path='assets/templates/30/preview.png',
                    visibility_scope='partial', management_scope='partial', owner_id=4,
                    created_at=STAMP, updated_at=STAMP)
        for table, key, entity_id, name in (
            ('resource_visibility_tags', 'resource_id', 20, '部门-研发'),
            ('resource_management_tags', 'resource_id', 20, '职能-运营'),
            ('template_visibility_tags', 'template_id', 30, '部门-研发'),
            ('template_management_tags', 'template_id', 30, '职能-运营'),
        ):
            self.insert(table, **{key: entity_id, 'tag_name': name})
        for table, key, entity_id, user_id in (
            ('resource_visibility', 'resource_id', 20, 4),
            ('resource_management', 'resource_id', 20, 2),
            ('template_visibility', 'template_id', 30, 2),
            ('template_management', 'template_id', 30, 2),
            ('show_visibility', 'show_id', 10, 3), ('show_management', 'show_id', 10, 3),
        ):
            self.insert(table, **{key: entity_id, 'user_id': user_id})
        self.insert('personal_remarks', id=1, resource_id=20, version_id=100, user_id=3,
                    content_html='<p>Private legacy note</p>', updated_at=STAMP)
        self.insert('show_remarks', id=1, show_id=10, resource_id=20, user_id=3,
                    content_html='<p>Show legacy note</p>', updated_at=STAMP)
        self.db.commit()

    def rows(self, table):
        return [tuple(row) for row in self.db.execute(f'SELECT * FROM {table} ORDER BY rowid')]

    def snapshot(self, tables=None):
        return {table: self.rows(table) for table in tables or self.legacy_tables}

    def columns(self, table):
        return {row['name'] for row in self.db.execute(f'PRAGMA table_info({table})')}

    def row(self, table, entity_id):
        return self.db.execute(f'SELECT * FROM {table} WHERE id = ?', (entity_id,)).fetchone()

    def members(self, table, column, entity_id):
        return [tuple(row) for row in self.db.execute(
            f'SELECT t.id, t.name, rel.position FROM {table} rel JOIN tags t ON t.id = rel.tag_id '
            f'WHERE rel.{column} = ? ORDER BY rel.position, rel.tag_id', (entity_id,))]

    def assert_healthy(self):
        self.assertEqual(self.db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])

    def permission_matrix(self):
        resource = self.row('resources', 20)
        template = self.row('templates', 30)
        return {
            user_id: (can_view_resource(self.db, resource, self.row('users', user_id)),
                      can_manage_resource(self.db, resource, self.row('users', user_id)),
                      can_view_template(self.db, template, self.row('users', user_id)),
                      can_manage_template(self.db, template, self.row('users', user_id)))
            for user_id in (2, 3, 4)
        }

    def test_v23_content_tags_migrate_with_order_deduplication_and_existing_ids(self):
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone()[0], 23)
        self.assertNotIn('resource_tags', self.legacy_tables)
        self.assertNotIn('show_tags', self.legacy_tables)
        for table in LEGACY_SCOPE_TABLES:
            self.assertNotIn('tag_id', self.columns(table))
        database.init_db()
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone()[0], database.DB_SCHEMA_VERSION)
        resources = self.members('resource_tags', 'resource_id', 20)
        shows = self.members('show_tags', 'show_id', 10)
        self.assertEqual([(name, position) for _, name, position in resources],
                         [('业务-通用', 0), ('新内容', 1), ('层级-新增', 2)])
        self.assertEqual([(name, position) for _, name, position in shows],
                         [('放映-开场', 0), ('业务-通用', 1), ('新放映', 2)])
        self.assertEqual(resources[0][0], 10)
        self.assertEqual([shows[0][0], shows[1][0]], [11, 10])
        self.assertEqual(self.row('resources', 20)['tags'], '业务-通用,新内容,层级-新增')
        self.assertEqual(self.row('shows', 10)['tags'], '放映-开场,业务-通用,新放映')
        self.assertEqual(self.members('resource_tags', 'resource_id', 21), [])
        self.assertEqual(self.members('show_tags', 'show_id', 11), [])
        self.assertEqual(self.db.execute('SELECT count(*) FROM tags').fetchone()[0], 7)
        self.assert_healthy()

    def test_permission_label_ids_backfill_without_changing_access(self):
        before = self.permission_matrix()
        # Ordinary users cannot manage templates even with an explicit grant.
        self.assertEqual(before, {2: (True, True, True, False), 3: (True, True, True, True),
                                  4: (True, False, True, True)})
        database.init_db()
        self.assertEqual(self.permission_matrix(), before)
        for table, expected_ids in (
            ('user_tags', [40, 41, 42]), ('resource_visibility_tags', [40]),
            ('resource_management_tags', [41]), ('template_visibility_tags', [40]),
            ('template_management_tags', [41]),
        ):
            with self.subTest(table=table):
                self.assertEqual([row[0] for row in self.db.execute(f'SELECT tag_id FROM {table} ORDER BY rowid')], expected_ids)
        self.assertTrue(can_view_show(self.db, self.row('shows', 10), self.row('users', 3)))
        self.assertTrue(can_manage_show(self.db, self.row('shows', 10), self.row('users', 3)))
        self.assert_healthy()

    def test_versions_owners_assets_and_notes_survive_while_secrecy_is_retired(self):
        preserved = ('users', 'resource_versions', 'templates', 'show_resources', 'personal_remarks',
                     'show_remarks', 'resource_visibility', 'resource_management',
                     'template_visibility', 'template_management', 'show_visibility', 'show_management')
        before = self.snapshot(preserved)
        legacy_columns = {table: [row['name'] for row in self.db.execute(f'PRAGMA table_info({table})')] for table in preserved}
        entities = {(table, entity_id): dict(self.row(table, entity_id))
                    for table, ids in (('resources', (20, 21)), ('shows', (10, 11))) for entity_id in ids}
        database.init_db()
        migrated = {table: [tuple(row) for row in self.db.execute(
            f"SELECT {', '.join(legacy_columns[table])} FROM {table} ORDER BY rowid")] for table in preserved}
        self.assertEqual(migrated, before)
        self.assertEqual(self.db.execute('SELECT count(*) FROM resource_versions WHERE deleted_at IS NOT NULL').fetchone()[0], 0)
        for (table, entity_id), original in entities.items():
            current = dict(self.row(table, entity_id))
            if table == 'resources':
                self.assertIsNone(current.pop('deleted_at'))
                self.assertGreater(current.pop('next_version_no'), original['current_version'])
            self.assertEqual(current.pop('secrecy_level'), '')
            original.pop('secrecy_level')
            current.pop('tags')
            original.pop('tags')
            self.assertEqual(current, original)
        self.assertEqual(self.rows('secrecy_tag_definitions'), [])
        self.assertEqual(self.row('resources', 20)['current_version'], 3)
        self.assertEqual(self.rows('show_resources'), [(10, 20, 1, 0, 0), (10, 21, 1, 1, 1), (11, 20, 2, 0, 0)])
        self.assertEqual(self.row('subject_tag_definitions', 1)['name'], '旧主体')
        self.assertEqual(self.row('status_tag_definitions', 1)['name'], '已发布')
        self.assert_healthy()

    def test_archive_upgrade_reserves_dangling_versions_and_keeps_historical_empty_shows(self):
        self.db.execute('UPDATE show_resources SET version_no = 70 WHERE show_id = 10 AND resource_id = 20')
        self.db.execute('DELETE FROM show_resources WHERE show_id = 11')
        self.db.commit()
        database.init_db()
        self.assertEqual(self.row('resources', 20)['next_version_no'], 71)
        self.assertIsNotNone(self.row('shows', 11))
        self.assertIsNone(self.row('resources', 20)['deleted_at'])
        self.db.execute('UPDATE resources SET next_version_no = 89 WHERE id = 20')
        self.db.commit()
        database.init_db()
        self.assertEqual(self.row('resources', 20)['next_version_no'], 89)
        self.assertIsNotNone(self.row('shows', 11))
        self.assert_healthy()

    def test_repeated_startup_preserves_normalized_relations_over_stale_csv(self):
        database.init_db()
        self.db.execute("UPDATE tags SET name = '业务-已改名' WHERE id = 10")
        self.db.execute('DELETE FROM resource_tags WHERE resource_id = 20 AND position = 1')
        self.insert('resource_tags', resource_id=20, tag_id=12, position=7)
        self.db.execute("UPDATE resources SET tags = 'stale-resource-cache' WHERE id = 20")
        self.db.execute("UPDATE shows SET tags = 'stale-show-cache' WHERE id = 10")
        self.db.execute("UPDATE user_tag_definitions SET name = '部门-平台' WHERE id = 40")
        # The v23 user_tags name cache has no FK to definitions, while its new
        # stable ID still authorizes the renamed resource/template scope grants.
        self.assertEqual(self.db.execute('SELECT tag_name FROM user_tags WHERE tag_id = 40').fetchone()[0], '部门-研发')
        self.insert('show_visibility_tags', show_id=11, tag_name='部门-平台', tag_id=40)
        self.insert('show_management_tags', show_id=11, tag_name='职能-运营', tag_id=41)
        self.db.commit()
        tables = ('resource_tags', 'show_tags', 'tags', 'user_tag_definitions', *LEGACY_SCOPE_TABLES,
                  'show_visibility_tags', 'show_management_tags')
        before = self.snapshot(tables)
        permissions = self.permission_matrix()
        database.init_db()
        database.init_db()
        self.assertEqual(self.snapshot(tables), before)
        self.assertEqual(self.permission_matrix(), permissions)
        self.assertTrue(can_view_show(self.db, self.row('shows', 11), self.row('users', 3)))
        self.assertTrue(can_manage_show(self.db, self.row('shows', 11), self.row('users', 3)))
        self.assertEqual(self.db.execute("SELECT count(*) FROM tags WHERE name LIKE 'stale-%'").fetchone()[0], 0)
        self.assert_healthy()

    def test_v25_content_relations_are_not_reimported_during_id_upgrade(self):
        self.db.executescript('''
            CREATE TABLE resource_tags (
                resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
                tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(resource_id, tag_id));
            CREATE TABLE show_tags (
                show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
                tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(show_id, tag_id));
            INSERT INTO resource_tags VALUES (20, 12, 7);
            INSERT INTO show_tags VALUES (10, 11, 3);
            UPDATE resources SET tags = 'stale-v23-resource', secrecy_level = '';
            UPDATE shows SET tags = 'stale-v23-show', secrecy_level = '';
            DELETE FROM secrecy_tag_definitions;
            PRAGMA user_version = 25;
        ''')
        database.init_db()
        self.assertEqual(self.members('resource_tags', 'resource_id', 20), [(12, '备用内容', 7)])
        self.assertEqual(self.members('show_tags', 'show_id', 10), [(11, '放映-开场', 3)])
        self.assertEqual(self.db.execute('SELECT tag_id FROM resource_visibility_tags').fetchone()[0], 40)
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone()[0], database.DB_SCHEMA_VERSION)
        self.assertEqual(self.db.execute('SELECT count(*) FROM tags').fetchone()[0], 4)
        self.assert_healthy()

    def test_failure_after_real_backfill_rolls_back_legacy_data_and_can_retry(self):
        before = self.snapshot()
        original = database._migrate_normalized_user_tags

        def fail_after_backfill(connection):
            original(connection)
            self.assertIn('tag_id', {row['name'] for row in connection.execute('PRAGMA table_info(user_tags)')})
            self.assertGreater(connection.execute('SELECT count(*) FROM resource_tags').fetchone()[0], 0)
            raise sqlite3.OperationalError('injected migration failure after backfill')

        with patch.object(database, '_migrate_normalized_user_tags', side_effect=fail_after_backfill):
            with self.assertRaisesRegex(sqlite3.OperationalError, 'injected migration failure'):
                database.init_db()
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone()[0], 23)
        self.assertEqual(self.snapshot(), before)
        for table in LEGACY_SCOPE_TABLES:
            self.assertNotIn('tag_id', self.columns(table))
        # Empty additive tables may already exist from CREATE IF NOT EXISTS;
        # no partially migrated business data may remain in them.
        self.assertEqual(self.rows('resource_tags'), [])
        self.assertEqual(self.rows('show_tags'), [])
        self.assert_healthy()
        database.init_db()
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone()[0], database.DB_SCHEMA_VERSION)
        self.assertEqual(len(self.members('resource_tags', 'resource_id', 20)), 3)
        self.assertEqual(self.db.execute('SELECT count(*) FROM tags').fetchone()[0], 7)
        self.assertEqual(self.rows('show_resources'), before['show_resources'])
        self.assert_healthy()

    def test_future_schema_is_refused_without_changing_legacy_business_data(self):
        before = self.snapshot()
        self.db.execute(f'PRAGMA user_version = {database.DB_SCHEMA_VERSION + 1}')
        self.db.commit()
        with self.assertRaisesRegex(RuntimeError, 'schema'):
            database.init_db()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone()[0], database.DB_SCHEMA_VERSION + 1)
        self.assertIsNone(self.db.execute("SELECT 1 FROM sqlite_master WHERE name = 'resource_tags'").fetchone())
        self.assert_healthy()

    def test_missing_detail_token_backfill_preserves_existing_token_and_is_stable(self):
        self.db.execute("UPDATE resources SET detail_token = '' WHERE id = 21")
        self.db.commit()
        with patch.object(database, 'new_resource_detail_token', side_effect=['A' * 43, 'G' * 43]) as token:
            database.init_db()
            self.assertEqual(token.call_count, 2)
            database.init_db()
            self.assertEqual(token.call_count, 2)
        self.assertEqual(self.row('resources', 20)['detail_token'], 'A' * 43)
        self.assertEqual(self.row('resources', 21)['detail_token'], 'G' * 43)
        self.assert_healthy()

    def test_unmatched_legacy_user_label_remains_unprivileged(self):
        self.insert('user_tags', user_id=4, tag_name='deleted-definition')
        self.db.commit()
        before = self.permission_matrix()
        database.init_db()
        label = self.db.execute("SELECT tag_name, tag_id FROM user_tags WHERE tag_name = 'deleted-definition'").fetchone()
        self.assertEqual(tuple(label), ('deleted-definition', None))
        self.assertEqual(self.permission_matrix(), before)
        self.assertFalse(can_manage_resource(self.db, self.row('resources', 20), self.row('users', 4)))
        self.assert_healthy()


if __name__ == '__main__':
    unittest.main()
