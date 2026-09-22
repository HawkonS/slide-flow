"""Application entrypoint used by Gunicorn/Uvicorn."""

from app.application import app, create_app

__all__ = ["app", "create_app"]
