"""Opt-in real Windows integration through the HTTP wizard routes.

Uses an isolated import root and in-process test client, reads the existing
standard font library, and never calls commit or writes business records.
"""
import argparse
import json
import sys
import tempfile
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.core.permissions import require_user
from app.db import get_db
from app.routers import resource_import as routes
from app.routers.dependencies import db_read_dep
from app.services.resource_import import sessions, jobs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    application = FastAPI()
    application.include_router(routes.router)
    application.dependency_overrides[require_user] = lambda:{"id":1}
    def database():
        db = get_db()
        try: yield db
        finally: db.close()
    application.dependency_overrides[db_read_dep] = database
    with tempfile.TemporaryDirectory(prefix="slideflow-http-smoke-") as temp, ExitStack() as stack:
        root = Path(temp).resolve()
        for module in (routes,sessions,jobs):
            stack.enter_context(patch.object(module,"_resource_import_root",return_value=root))
        client = stack.enter_context(TestClient(application))
        with args.source.open("rb") as source:
            response = client.post("/api/resource-import/prepare",data={"mode":"ppt"},files={"ppt_file":(args.source.name,source,"application/vnd.openxmlformats-officedocument.presentationml.presentation")})
        response.raise_for_status()
        session = response.json()
        sid = session["session_id"]
        assert session["preview_count"]==0 and session["preview_status"]=="pending"
        assert not session["missing_fonts"], session["missing_fonts"]
        response = client.post(f"/api/resource-import/{sid}/previews")
        response.raise_for_status()
        events = [json.loads(line) for line in response.text.splitlines() if line]
        assert events[-1]["type"]=="completed", events[-1]
        pages = [e for e in events if e["type"]=="page"]
        assert len(pages)==session["slide_count"]
        for event in pages:
            image = client.get(event["preview_url"])
            assert image.status_code==200 and image.content.startswith(b"\x89PNG")
        stored = sessions._load_resource_import_session_file(sid)
        assert len(stored["split_paths"])==session["slide_count"]
        assert stored["preview_status"]=="ready"
        response = client.delete(f"/api/resource-import/{sid}")
        response.raise_for_status()
        assert not (root/sid).exists()
        print(json.dumps({"ok":True,"pages":len(pages),"events":[e["type"] for e in events],"cancel_cleaned":True}))


if __name__=="__main__": main()
