"""Real database regressions for show permission, iteration and public snapshots."""
import unittest

from app.db import now_iso
from app.routers import show_shares
from app.routers.shows import catalog, versions, remarks
from app.routers.dependencies import db_dep
from tests import test_resource_share_management as share_fixtures


class ShowReviewTests(unittest.TestCase):
    insert_user = share_fixtures.ResourceShareManagementTests.insert_user
    insert_resource = share_fixtures.ResourceShareManagementTests.insert_resource
    tearDown = share_fixtures.ResourceShareManagementTests.tearDown

    def setUp(self):
        share_fixtures.ResourceShareManagementTests.setUp(self)
        self.client.app.include_router(catalog.router)
        self.client.app.include_router(versions.router)
        self.client.app.include_router(remarks.router)
        self.client.app.include_router(show_shares.router)

        def transactional_db():
            try:
                yield self.db
            finally:
                if self.db.in_transaction:
                    self.db.rollback()
        self.client.app.dependency_overrides[db_dep] = transactional_db
        self.own, _ = self.insert_resource(owner=self.alice, name="可用页面")
        self.private, _ = self.insert_resource(owner=self.bob, name="不可见的商业计划")
        self.extra, _ = self.insert_resource(owner=self.alice, name="新增页面")
        self.show_id = self.insert_show([self.own, self.private])

    def insert_show(self, resource_ids):
        ts = now_iso()
        show_id = self.db.execute(
            """INSERT INTO shows (name, owner_id, subject, tags, status, visibility_scope,
               management_scope, is_standard, series_id, version_no, change_note, updated_by, created_at, updated_at)
               VALUES ('标准放映', ?, '', '', 'active', 'public', 'private', 1, ?, 1, '', ?, ?, ?)""",
            (self.alice['id'], f"test-{resource_ids}", self.alice['id'], ts, ts),
        ).lastrowid
        self.db.executemany("INSERT INTO show_resources (show_id, resource_id, version_no, sort_order, is_hidden) VALUES (?, ?, 1, ?, 0)",
                            [(show_id, rid, i) for i, rid in enumerate(resource_ids)])
        self.db.commit()
        return show_id

    def upgrade_resource(self, rid):
        self.db.execute("UPDATE resources SET current_version = 2 WHERE id = ?", (rid,))
        self.db.execute("""INSERT INTO resource_versions (resource_id, version_no, ppt_path, png_path,
                        change_note, common_remark_html, created_by, created_at)
                        VALUES (?, 2, 'new.pptx', 'new.png', '更新', '<p>新版备注</p>', ?, ?)""",
                        (rid, self.alice['id'], now_iso()))
        self.db.commit()

    def test_diff_and_update_checks_never_reveal_private_resource(self):
        self.upgrade_resource(self.own)
        self.upgrade_resource(self.private)
        response = self.client.get(f'/api/shows/{self.show_id}/check-updates')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([r['resource_id'] for r in response.json()['updates']], [self.own])
        response = self.client.get(f'/api/shows/{self.show_id}/resource-diff/{self.private}')
        self.assertEqual(response.status_code, 404)
        self.assertNotIn('商业计划', response.text)

    def test_new_private_pages_are_rejected_by_every_write_entrypoint(self):
        show_id = self.insert_show([self.own])
        for method, url, payload in [
            ('POST', '/api/shows', {'name': '放映', 'status': 'active', 'resource_ids': [self.private]}),
            ('PUT', f'/api/shows/{show_id}/resources', {'resource_ids': [self.own, self.private]}),
            ('POST', f'/api/shows/{show_id}/resources/append', {'resource_id': self.private}),
            ('POST', f'/api/shows/{show_id}/iterate', {'resource_ids': [self.own, self.private]}),
        ]:
            with self.subTest(url=url):
                response = self.client.request(method, url, json=payload)
                self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM shows').fetchone()[0], 2)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM show_resources WHERE show_id = ?', (show_id,)).fetchone()[0], 1)

    def test_existing_inaccessible_pages_remain_reorderable_without_iteration(self):
        result = self.client.put(f'/api/shows/{self.show_id}/resources', json={'resource_ids': [self.private, self.own]})
        self.assertEqual(result.status_code, 200, result.text)
        result = self.client.post(f'/api/shows/{self.show_id}/iterate', json={'resource_ids': [self.own, self.private]})
        self.assertEqual(result.status_code, 400, result.text)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM shows').fetchone()[0], 1)

    def test_content_iteration_keeps_pinned_versions_hidden_state_and_retained_notes(self):
        self.upgrade_resource(self.own)
        self.db.execute('UPDATE show_resources SET is_hidden = 1 WHERE resource_id = ?', (self.own,))
        for rid in [self.own, self.private]:
            self.db.execute('INSERT INTO show_remarks (show_id, resource_id, user_id, content_html, updated_at) VALUES (?, ?, ?, ?, ?)',
                            (self.show_id, rid, self.alice['id'], '<p>演讲要点</p>', now_iso()))
        self.db.commit()
        response = self.client.post(f'/api/shows/{self.show_id}/iterate', json={'resource_ids': [self.own, self.extra], 'name': ' 新版本 '})
        self.assertEqual(response.status_code, 200, response.text)
        new_id = response.json()['show']['id']
        self.assertEqual(response.json()['show']['name'], '新版本')
        page = self.db.execute('SELECT * FROM show_resources WHERE show_id = ? AND resource_id = ?', (new_id, self.own)).fetchone()
        self.assertEqual((page['version_no'], page['is_hidden']), (1, 1))
        notes = self.db.execute('SELECT resource_id, content_html FROM show_remarks WHERE show_id = ?', (new_id,)).fetchall()
        self.assertEqual([tuple(note) for note in notes], [(self.own, '<p>演讲要点</p>')])

    def test_upgrade_rejects_foreign_pages_private_pages_and_noop_without_creating_versions(self):
        self.upgrade_resource(self.private)
        for payload, status in [
            ({'resource_ids': [self.extra]}, 400),
            ({'resource_ids': [self.private]}, 403),
            ({'resource_ids': [self.own], 'remarks': {str(self.extra): '备注'}}, 400),
            ({'resource_ids': [self.own], 'remarks': {'bad': '备注'}}, 400),
            ({'resource_ids': [self.own]}, 400),
            ({'resource_ids': []}, 400),
        ]:
            with self.subTest(payload=payload):
                response = self.client.post(f'/api/shows/{self.show_id}/iterate-upgrade', json=payload)
                self.assertEqual(response.status_code, status, response.text)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM shows').fetchone()[0], 1)

    def test_in_place_upgrade_is_atomic_and_skips_inaccessible_pages_in_upgrade_all(self):
        self.upgrade_resource(self.own)
        self.upgrade_resource(self.private)
        url = f'/api/shows/{self.show_id}/upgrade'
        denied = self.client.post(url, json={'resource_ids': [self.own, self.private]})
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(self.db.execute('SELECT MAX(version_no) FROM show_resources').fetchone()[0], 1)
        response = self.client.post(url, json={'resource_ids': []})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([r['resource_id'] for r in response.json()['upgraded']], [self.own])

    def test_public_share_pins_order_and_versions_and_excludes_hidden_private_pages(self):
        self.db.execute('INSERT INTO show_resources VALUES (?, ?, 1, 2, 1)', (self.show_id, self.extra))
        self.db.commit()
        response = self.client.post(f'/api/shows/{self.show_id}/share-links', json={'expires_in_days': 7})
        self.assertEqual(response.status_code, 200, response.text)
        link = response.json()
        self.assertEqual(link['page_count'], 1)
        self.upgrade_resource(self.own)
        self.db.execute('UPDATE show_resources SET is_hidden = 0, version_no = 2 WHERE show_id = ?', (self.show_id,))
        self.db.commit()
        public_url = f"/api/show-shares/{link['token']}"
        payload = self.client.get(public_url).json()['show']
        self.assertEqual([(r['id'], r['version_no']) for r in payload['resources']], [(self.own, 1)])
        self.assertNotIn('remark', str(payload))
        self.assertEqual(self.client.get(f'{public_url}/preview/{self.private}').status_code, 404)
        self.assertEqual(self.client.get(f'{public_url}/preview/{self.extra}').status_code, 404)
        self.current_user = self.bob
        forbidden = self.client.delete(f"/api/shows/{self.show_id}/share-links/{link['id']}")
        self.assertEqual(forbidden.status_code, 404)
        self.current_user = self.alice
        self.assertEqual(self.client.delete(f"/api/shows/{self.show_id}/share-links/{link['id']}").status_code, 200)
        self.assertEqual(self.client.get(public_url).status_code, 404)
        self.assertEqual(self.client.get(f'{public_url}/preview/{self.own}').status_code, 404)

    def test_expired_show_shares_and_invalid_tokens_cannot_be_opened(self):
        link = self.client.post(f'/api/shows/{self.show_id}/share-links', json={'expires_in_days': 1}).json()
        self.db.execute("UPDATE show_share_tokens SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?", (link['id'],))
        self.db.commit()
        for token in [link['token'], 'invalid', 'x' * 43]:
            self.assertEqual(self.client.get(f'/api/show-shares/{token}').status_code, 404)

    def test_names_and_page_lists_reject_invalid_input(self):
        for payload in [{'name': '  '}, {'name': 'x' * 201}, {'name': 'ok', 'resource_ids': [self.own, self.own]}, {'name': 'ok', 'resource_ids': [-1]}]:
            self.assertEqual(self.client.post('/api/shows', json=payload).status_code, 422)

    def test_notes_require_an_accessible_page_in_the_show(self):
        for resource_id, expected in ((self.own, 200), (self.private, 403), (self.extra, 404), (99999, 404)):
            url = f'/api/shows/{self.show_id}/remarks/{resource_id}'
            with self.subTest(resource_id=resource_id):
                response = self.client.put(url, json={'content_html': '<p>演讲要点</p>'})
                self.assertEqual(response.status_code, expected, response.text)
                self.assertEqual(self.client.get(url).status_code, expected)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM show_remarks').fetchone()[0], 1)

    def test_removing_page_removes_notes_but_reordering_preserves_them(self):
        url = f'/api/shows/{self.show_id}/remarks/{self.own}'
        self.assertEqual(self.client.put(url, json={'content_html': '<p>演讲要点</p>'}).status_code, 200)
        for ids in ([self.private, self.own], [self.private]):
            response = self.client.put(f'/api/shows/{self.show_id}/resources', json={'resource_ids': ids})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(self.db.execute('SELECT COUNT(*) FROM show_remarks').fetchone()[0], int(self.own in ids))
        self.assertEqual(self.client.put(url, json={'content_html': '过期页面编辑'}).status_code, 404)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM show_remarks').fetchone()[0], 0)

    def test_archived_pinned_page_notes_remain_editable_but_missing_versions_do_not(self):
        self.db.execute('UPDATE resource_versions SET deleted_at = ? WHERE resource_id = ?', (now_iso(), self.own))
        self.db.execute('UPDATE resources SET deleted_at = ? WHERE id = ?', (now_iso(), self.own))
        self.db.commit()
        url = f'/api/shows/{self.show_id}/remarks/{self.own}'
        self.assertEqual(self.client.put(url, json={'content_html': '<p>保留页面</p>'}).status_code, 200)
        self.assertEqual(self.client.get(url).json()['content_html'], '<p>保留页面</p>')
        self.db.execute('UPDATE show_resources SET version_no = 99 WHERE resource_id = ?', (self.own,))
        self.db.commit()
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self.client.put(url, json={'content_html': ''}).status_code, 404)

    def test_detail_and_update_queries_do_not_grow_per_visible_page(self):
        ids = [self.insert_resource(owner=self.alice, name=f"性能页{i}")[0] for i in range(40)]
        show_id = self.insert_show(ids)
        for rid in ids:
            self.upgrade_resource(rid)
        statements = []
        self.db.set_trace_callback(statements.append)
        response = self.client.get(f'/api/shows/{show_id}')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()['show']['resources']), 40)
        self.assertLess(len(statements), 25, statements)
        statements.clear()
        response = self.client.get(f'/api/shows/{show_id}/check-updates')
        self.assertEqual(len(response.json()['updates']), 40)
        self.assertLess(len(statements), 5, statements)
        self.db.set_trace_callback(None)
