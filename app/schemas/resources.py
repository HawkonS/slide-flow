"""Schemas / resources."""

from __future__ import annotations

from app.schemas.base import ApiPayload


class MetadataPayload(ApiPayload):
    name: str
    subject: str = ""
    tags: str = ""
    status: str = "active"
    visibility_scope: str
    visible_user_ids: list[int] = []
    management_scope: str
    manage_user_ids: list[int] = []
    secrecy_level: str


class CommonRemarkPayload(ApiPayload):
    content_html: str
    apply_scope: str = "latest"
    version_id: int | None = None


class PersonalRemarkPayload(ApiPayload):
    content_html: str
    version_id: int | None = None
