"""Schemas / shows."""

from __future__ import annotations

from app.schemas.base import ApiPayload


class ShowCreatePayload(ApiPayload):
    name: str
    subject: str = ""
    tags: str = ""
    status: str = "active"
    secrecy_level: str = "public"
    visibility_scope: str = "private"
    management_scope: str = "private"
    visible_user_ids: list[int] = []
    manage_user_ids: list[int] = []
    resource_ids: list[int] = []
    change_note: str = ""


class ShowUpdatePayload(ApiPayload):
    name: str
    subject: str = ""
    tags: str = ""
    status: str = "active"
    secrecy_level: str = "public"
    visibility_scope: str = "private"
    management_scope: str = "private"
    visible_user_ids: list[int] = []
    manage_user_ids: list[int] = []


class ShowResourcesPayload(ApiPayload):
    resource_ids: list[int] = []


class ShowResourceAppendPayload(ApiPayload):
    resource_id: int


class ShowResourceHiddenPayload(ApiPayload):
    hidden: bool


class ShowStandardPayload(ApiPayload):
    standard: bool


class ShowDuplicatePayload(ApiPayload):
    name: str


class ShowIteratePayload(ApiPayload):
    change_note: str = ""
    name: str | None = None
    resource_ids: list[int] | None = None


class ShowUpgradePayload(ApiPayload):
    resource_ids: list[int] = []


class ShowIterateUpgradePayload(ApiPayload):
    resource_ids: list[int] = []          # 要升级的资源ID列表
    remarks: dict[str, str] = {}          # {resource_id: remark_html} 放映备注
    change_note: str = ""                 # 版本变更说明


class ShowRemarkPayload(ApiPayload):
    content_html: str = ""
