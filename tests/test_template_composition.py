from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pptx import Presentation
from pptx.util import Inches

from app.config import settings
from app.core.permissions import require_user
from app.db import init_db, now_iso
from app.routers import templates
from app.routers.dependencies import db_dep, db_read_dep
from app.services.files import _init_allowed_file_dirs


class TemplateCompositionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="slideflow-template-compose-")
        root = Path(self.temporary.name)
        paths = {
            "root_dir": root,
            "data_dir": root / "data",
            "db_dir": root / "data" / "db",
            "assets_dir": root / "data" / "assets",
            "resources_dir": root / "data" / "assets" / "resources",
            "templates_dir": root / "data" / "assets" / "templates",
            "fonts_dir": root / "data" / "assets" / "fonts",
            "thumbs_dir": root / "data" / "assets" / "thumbs",
            "downloads_dir": root / "data" / "assets" / "downloads",
            "log_dir": root / "data" / "logs",
            "db_path": root / "data" / "db" / "slide_flow.db",
        }
        self.patchers = [patch.object(settings, name, value) for name, value in paths.items()]
        self.patchers.append(patch.object(settings, "storage_backend", "local"))
        for patcher in self.patchers:
            patcher.start()

        init_db()
        _init_allowed_file_dirs()
        self.db = sqlite3.connect(settings.db_path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.alice = self.insert_user("alice")
        self.bob = self.insert_user("bob")
        self.current_user = self.alice

        app = FastAPI()
        app.include_router(templates.router)

        def override_user():
            return self.current_user

        def override_db():
            yield self.db

        app.dependency_overrides[require_user] = override_user
        app.dependency_overrides[db_dep] = override_db
        app.dependency_overrides[db_read_dep] = override_db
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.db.close()
        for patcher in reversed(self.patchers):
            patcher.stop()
        _init_allowed_file_dirs()
        self.temporary.cleanup()

    def insert_user(self, username: str) -> sqlite3.Row:
        timestamp = now_iso()
        user_id = int(
            self.db.execute(
                """
                INSERT INTO users (
                    name, username, username_key, password_hash, role, created_at, updated_at
                ) VALUES (?, ?, ?, 'not-used', 'user', ?, ?)
                """,
                (username.title(), username, username, timestamp, timestamp),
            ).lastrowid
        )
        self.db.commit()
        row = self.db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        assert row is not None
        return row

    def insert_template(
        self,
        *,
        name: str,
        owner: sqlite3.Row,
        text: str,
        ratio: str = "16:9",
        visibility_scope: str = "public",
    ) -> int:
        settings.templates_dir.mkdir(parents=True, exist_ok=True)
        path = settings.templates_dir / (name + ".pptx")
        presentation = Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1))
        box.text_frame.text = text
        presentation.save(path)

        timestamp = now_iso()
        template_id = int(
            self.db.execute(
                """
                INSERT INTO templates (
                    name, series, subject, platform, ratio, template_type,
                    office_file_name, office_path, png_path, font_names, missing_fonts,
                    subject_order, series_order, sort_order,
                    visibility_scope, management_scope, owner_id, created_at, updated_at
                ) VALUES (?, '系列', '主体', 'wps', ?, 'content', ?, ?, NULL, '[]', '[]',
                          10, 10, 10, ?, 'private', ?, ?, ?)
                """,
                (
                    name,
                    ratio,
                    path.name,
                    str(path),
                    visibility_scope,
                    int(owner["id"]),
                    timestamp,
                    timestamp,
                ),
            ).lastrowid
        )
        self.db.commit()
        return template_id

    def test_combines_selected_templates_in_requested_order(self):
        first_id = self.insert_template(name="第一页", owner=self.alice, text="FIRST")
        second_id = self.insert_template(name="第二页", owner=self.alice, text="SECOND")

        response = self.client.post(
            "/api/templates/compose-download",
            json={"template_ids": [second_id, first_id]},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.headers["content-type"],
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        )

        output = settings.downloads_dir / "combined.pptx"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(response.content)
        presentation = Presentation(output)
        slide_texts = [
            " ".join(shape.text for shape in slide.shapes if hasattr(shape, "text"))
            for slide in presentation.slides
        ]
        self.assertEqual(len(slide_texts), 2)
        self.assertIn("SECOND", slide_texts[0])
        self.assertIn("FIRST", slide_texts[1])

    def test_rejects_mixed_ratios_and_invisible_templates(self):
        wide_id = self.insert_template(name="宽屏", owner=self.alice, text="WIDE")
        standard_id = self.insert_template(
            name="四比三",
            owner=self.alice,
            text="STANDARD",
            ratio="4:3",
        )
        mixed = self.client.post(
            "/api/templates/compose-download",
            json={"template_ids": [wide_id, standard_id]},
        )
        self.assertEqual(mixed.status_code, 400, mixed.text)
        self.assertIn("相同比例", mixed.json()["detail"])

        private_id = self.insert_template(
            name="他人私有",
            owner=self.bob,
            text="PRIVATE",
            visibility_scope="private",
        )
        forbidden = self.client.post(
            "/api/templates/compose-download",
            json={"template_ids": [wide_id, private_id]},
        )
        self.assertEqual(forbidden.status_code, 403, forbidden.text)


if __name__ == "__main__":
    unittest.main()
