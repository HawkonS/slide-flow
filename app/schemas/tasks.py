"""Schemas / tasks."""

from __future__ import annotations

from app.schemas.base import ApiPayload


class TaskDeletePayload(ApiPayload):
    task_ids: list[int]
