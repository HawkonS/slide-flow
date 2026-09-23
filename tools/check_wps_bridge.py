"""Check local renderer task APIs without printing credentials."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings


def bounded_json(response: httpx.Response) -> dict:
    response.raise_for_status()
    if len(response.content) > 256 * 1024:
        raise RuntimeError("health response is too large")
    value = response.json()
    if not isinstance(value, dict):
        raise RuntimeError("health response is not an object")
    return value


def main() -> None:
    headers = {"Authorization": "Bearer " + settings.render_token, "Accept": "application/json"}
    timeout = httpx.Timeout(10, connect=5)
    try:
        with httpx.Client(
            base_url=f"http://127.0.0.1:{settings.port}", headers=headers,
            timeout=timeout, trust_env=False, follow_redirects=False,
        ) as client:
            fonts = bounded_json(client.get("/api/renderer/font-sync/status"))
            render = bounded_json(client.get("/api/renderer/render-tasks/status"))
    except Exception as exc:
        raise SystemExit(f"SlideFlow renderer task API check failed: {type(exc).__name__}") from None

    print(json.dumps({
        "ok": True,
        "font_queue": {key: fonts.get(key) for key in ("total", "queued", "running", "completed", "failed", "ready")},
        "render_pull_api": "reachable",
        "render_queue": {key: render.get(key) for key in ("queued", "running", "completed", "failed", "cancelled", "fonts_ready")},
        "next": "Run Test-SlideFlowBridge.ps1 on Windows to verify the reverse tunnel and local WPS renderer.",
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
