"""Schemas / shows."""

from __future__ import annotations

from app.schemas.base import ApiPayload
from typing import Annotated
from pydantic import Field, StringConstraints, field_validator


ShowName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
PositiveId = Annotated[int, Field(gt=0)]


class ShowPayload(ApiPayload):
    @field_validator("resource_ids", check_fields=False)
    @classmethod
    def unique_pages(cls, value):
        if value is not None and len(value) != len(set(value)):
            raise ValueError("同一素材不能重复添加，请检查页面列表")
        return value


class ShowCreatePayload(ShowPayload):
    name: ShowName
    subject: str = Field(default="", max_length=500)
    tags: str = Field(default="", max_length=2000)
    status: str = ""
    visibility_scope: str = "private"
    management_scope: str = "private"
    visible_user_ids: list[int] = Field(default_factory=list)
    visible_user_tags: list[str] = Field(default_factory=list)
    manage_user_ids: list[int] = Field(default_factory=list)
    manage_user_tags: list[str] = Field(default_factory=list)
    resource_ids: list[PositiveId] = Field(default_factory=list, max_length=1000)
    change_note: str = Field(default="", max_length=5000)


class ShowUpdatePayload(ShowPayload):
    name: ShowName
    subject: str = Field(default="", max_length=500)
    tags: str = Field(default="", max_length=2000)
    status: str = ""
    visibility_scope: str = "private"
    management_scope: str = "private"
    visible_user_ids: list[int] = Field(default_factory=list)
    visible_user_tags: list[str] = Field(default_factory=list)
    manage_user_ids: list[int] = Field(default_factory=list)
    manage_user_tags: list[str] = Field(default_factory=list)


class ShowResourcesPayload(ShowPayload):
    resource_ids: list[PositiveId] = Field(default_factory=list, max_length=1000)


class ShowResourceAppendPayload(ShowPayload):
    resource_id: PositiveId


class ShowResourceHiddenPayload(ShowPayload):
    hidden: bool


class ShowStandardPayload(ShowPayload):
    standard: bool


class ShowDuplicatePayload(ShowPayload):
    name: ShowName


class ShowIteratePayload(ShowPayload):
    change_note: str = Field(default="", max_length=5000)
    name: ShowName | None = None
    resource_ids: list[PositiveId] | None = Field(default=None, max_length=1000)


class ShowUpgradePayload(ShowPayload):
    resource_ids: list[PositiveId] = Field(default_factory=list, max_length=1000)


class ShowIterateUpgradePayload(ShowPayload):
    resource_ids: list[PositiveId] = Field(default_factory=list, max_length=1000)          # 要升级的资源ID列表
    remarks: dict[str, Annotated[str, Field(max_length=100_000)]] = Field(default_factory=dict, max_length=1000)          # {resource_id: remark_html} 放映备注
    change_note: str = Field(default="", max_length=5000)                 # 版本变更说明
    name: ShowName | None = None                # 可选的新版本名称


class ShowRemarkPayload(ShowPayload):
    content_html: str = Field(default="", max_length=100_000)
