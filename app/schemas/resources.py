"""Schemas / resources."""

from __future__ import annotations

from app.schemas.base import ApiPayload
from pydantic import Field


class MetadataPayload(ApiPayload):
    name: str
    subject: str = ""
    tags: str = ""
    status: str = ""
    visibility_scope: str
    visible_user_ids: list[int] = Field(default_factory=list)
    visible_user_tags: list[str] = Field(default_factory=list)
    management_scope: str
    manage_user_ids: list[int] = Field(default_factory=list)
    manage_user_tags: list[str] = Field(default_factory=list)
    secrecy_level: str


class ShareLinkPayload(ApiPayload):
    """分享链接有效期；原始令牌只在创建响应中返回一次。"""

    expires_in_days: int = Field(default=7, ge=1, le=30)


class CommonRemarkPayload(ApiPayload):
    content_html: str
    apply_scope: str = "latest"
    version_id: int | None = None


class PersonalRemarkPayload(ApiPayload):
    content_html: str
    version_id: int | None = None
