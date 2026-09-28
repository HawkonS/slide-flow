"""Opt-in real Windows integration through the HTTP wizard routes.

The in-process request and the real Gunicorn/Windows workers deliberately use
the shared resource-import directory.  The smoke never calls commit or writes
business records, and always removes the temporary import session.
"""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.core.permissions import require_user
from app.db import get_db
from app.routers import resource_import as routes
from app.routers.dependencies import db_read_dep
from app.services.resource_import import sessions


def _delete_session(client: TestClient, session_id: str) -> None:
    """Use the public cleanup path and tolerate a worker releasing its lease."""
    last_response = None
    for attempt in range(6):
        last_response = client.delete(f"/api/resource-import/{session_id}")
        if last_response.status_code in {200, 404, 410}:
            return
        if last_response.status_code not in {409, 429, 502, 503, 504}:
            break
        retry_after = last_response.headers.get("Retry-After")
        try:
            delay = max(0.05, min(float(retry_after or 0), 2.0))
        except ValueError:
            delay = min(0.25 * 2**attempt, 2.0)
        time.sleep(delay)
    detail = last_response.text if last_response is not None else "no response"
    raise RuntimeError(f"failed to clean smoke import session {session_id}: {detail}")


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
    session_id = None
    result = None
    with TestClient(application) as client:
        try:
            with args.source.open("rb") as source:
                response = client.post(
                    "/api/resource-import/prepare",
                    data={"mode":"ppt"},
                    files={
                        "ppt_file": (
                            args.source.name,
                            source,
                            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                        )
                    },
                )
            response.raise_for_status()
            session = response.json()
            session_id = session["session_id"]
            assert session["preview_count"] == 0
            assert session["preview_status"] == "pending"
            assert not session["missing_fonts"], session["missing_fonts"]

            response = client.post(f"/api/resource-import/{session_id}/previews")
            response.raise_for_status()
            events = [json.loads(line) for line in response.text.splitlines() if line]
            assert events[-1]["type"] == "completed", events[-1]
            pages = [event for event in events if event["type"] == "page"]
            assert len(pages) == session["slide_count"]
            for event in pages:
                image = client.get(event["preview_url"])
                assert image.status_code == 200
                assert image.content.startswith(b"\x89PNG")

            stored = sessions._load_resource_import_session_file(session_id)
            assert stored is not None
            assert len(stored["split_paths"]) == session["slide_count"]
            assert stored["preview_status"] == "ready"
            result = {
                "ok": True,
                "pages": len(pages),
                "events": [event["type"] for event in events],
                "cancel_cleaned": True,
            }
        finally:
            if session_id is not None:
                _delete_session(client, session_id)
                assert sessions._load_resource_import_session_file(session_id) is None

    if result is not None:
        print(json.dumps(result, separators=(",", ":")))


if __name__=="__main__": main()
