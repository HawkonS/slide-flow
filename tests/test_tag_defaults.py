from __future__ import annotations

import unittest

from app.db import init_db, now_iso
from app.services.tag_defaults import migrate_tag_defaults
from tests import test_user_management as fixtures


class TagDefaultsTests(unittest.TestCase):
    setUp = fixtures.UserManagementTests.setUp
    tearDown = fixtures.UserManagementTests.tearDown
    insert_user = fixtures.UserManagementTests.insert_user
    create_tag = fixtures.UserManagementTests.create_tag
    create_user_tag = fixtures.UserManagementTests.create_user_tag
    client_for = fixtures.UserManagementTests.client_for

    def metadata(self, domain, name, owner=None):
        row = self.db.execute(
            f"INSERT INTO {domain}_tag_definitions (name, category, label, sort_order, created_by, created_at) VALUES (?, ?, ?, 0, ?, ?)",
            (name, domain, name, owner, now_iso()),
        )
        self.db.commit()
        return int(row.lastrowid)

    def change(self, client, *changes):
        return client.patch("/api/admin/tag-defaults", json={"changes": [
            {"scene": scene, "domain": domain, "tag_ids": ids} for scene, domain, ids in changes
        ]})

    def test_scene_isolation_single_values_and_public_projection(self):
        admin = self.insert_user("admin", role="system_admin")
        first, second = [self.metadata("status", name, admin) for name in ("草稿", "正式")]
        tag = self.create_tag("产品", admin)
        with self.client_for(admin) as client:
            response = self.change(client, ("resource_list", "status", [first]),
                                   ("show_list", "status", [second]), ("show_create", "resource", [tag]))
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(len(response.json()["scenes"]), 8)
            self.change(client, ("resource_list", "status", [second]))
            config = client.get("/api/config").json()
            self.assertEqual(config["tag_defaults"]["resource_list"]["status"], "正式")
            self.assertEqual(config["tag_defaults"]["show_list"]["status"], "正式")
            self.assertIsNone(config["tag_defaults"]["resource_manage"]["status"])
            self.assertIsNone(config["tag_defaults"]["standard_show_list"]["status"])
            self.assertEqual(config["tag_defaults"]["show_create"]["resource_tags"], ["产品"])
            self.assertEqual(config["default_filters"]["status"], "正式")
            tags = client.get("/api/admin/status-tags").json()["tags"]
            self.assertEqual(next(t for t in tags if t["id"] == second)["default_scopes"], ["resource_list", "show_list"])

    def test_invalid_batch_does_not_partially_save(self):
        admin = self.insert_user("admin", role="system_admin")
        first, second = [self.metadata("status", name, admin) for name in ("草稿", "正式")]
        with self.client_for(admin) as client:
            for bad in [("user_list", "status", [first]), ("unknown", "status", [first]),
                        ("show_list", "status", [999999]), ("show_list", "status", [first, second]),
                        ("show_list", "status", [first, first])]:
                response = self.change(client, ("resource_list", "status", [first]), bad)
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(self.db.execute("SELECT COUNT(*) FROM tag_default_rules").fetchone()[0], 0)

    def test_defaults_require_admin(self):
        user = self.insert_user("reader")
        with self.client_for(user) as client:
            self.assertEqual(client.get("/api/admin/tag-defaults").status_code, 403)
            self.assertEqual(self.change(client, ("show_list", "resource", [])).status_code, 403)

    def test_rename_and_delete_rules_for_each_domain(self):
        admin = self.insert_user("admin", role="system_admin")
        entries = [
            ("resource", "/api/admin/tags", self.create_tag("old-resource", admin), "show_create"),
            ("user", "/api/admin/user-tags", self.create_user_tag("old-user", admin), "user_list"),
            ("subject", "/api/admin/subject-tags", self.metadata("subject", "old-subject", admin), "resource_create"),
            ("status", "/api/admin/status-tags", self.metadata("status", "old-status", admin), "resource_picker"),
        ]
        with self.client_for(admin) as client:
            for domain, endpoint, tag_id, scene in entries:
                self.assertEqual(self.change(client, (scene, domain, [tag_id])).status_code, 200)
                response = client.put(f"{endpoint}/{tag_id}", json={"name": f"new-{domain}"})
                self.assertEqual(response.status_code, 200, response.text)
                key = {"resource": "resource_tags", "user": "user_tags"}.get(domain, domain)
                value = client.get("/api/config").json()["tag_defaults"][scene][key]
                self.assertEqual(value, [f"new-{domain}"] if domain in ("resource", "user") else f"new-{domain}")
                self.assertEqual(client.delete(f"{endpoint}/{tag_id}").status_code, 200)
                self.assertEqual(self.db.execute("SELECT COUNT(*) FROM tag_default_rules WHERE domain = ?", (domain,)).fetchone()[0], 0)

    def test_migration_preserves_only_legacy_scenes_and_clear_survives_restart(self):
        admin = self.insert_user("admin", role="system_admin")
        tag = self.create_tag("产品", admin)
        subject = self.metadata("subject", "主体", admin)
        self.db.execute("UPDATE tags SET is_default_filter = 1 WHERE id = ?", (tag,))
        self.db.execute("UPDATE subject_tag_definitions SET is_default_filter = 1 WHERE id = ?", (subject,))
        migrate_tag_defaults(self.db, 27)
        self.db.commit()
        scenes = {row[0] for row in self.db.execute("SELECT DISTINCT scene FROM tag_default_rules")}
        self.assertEqual(scenes, {"resource_list", "resource_manage"})
        with self.client_for(admin) as client:
            self.change(client, ("resource_list", "resource", []), ("resource_manage", "resource", []))
            init_db()
            init_db()
            self.assertEqual(client.get("/api/config").json()["tag_defaults"]["resource_list"]["resource_tags"], [])

    def test_startup_keeps_metadata_referenced_only_by_new_scenes(self):
        admin = self.insert_user("admin", role="system_admin")
        subject = self.metadata("subject", "保留主体")
        status = self.metadata("status", "保留状态")
        self.db.execute("UPDATE status_tag_definitions SET category = '历史值' WHERE id = ?", (status,))
        self.db.commit()
        with self.client_for(admin) as client:
            self.change(client, ("show_create", "subject", [subject]), ("resource_picker", "status", [status]))
            init_db()
            config = client.get("/api/config").json()["tag_defaults"]
            self.assertEqual(config["show_create"]["subject"], "保留主体")
            self.assertEqual(config["resource_picker"]["status"], "保留状态")


if __name__ == "__main__":
    unittest.main()
