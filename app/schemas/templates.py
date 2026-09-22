"""Schemas / templates."""

from __future__ import annotations

from app.schemas.base import ApiPayload


class TemplateDeletePayload(ApiPayload):
    template_ids: list[int]


class TemplatePayload(ApiPayload):
    name: str = ""
    series: str
    subject: str
    platform: str
    ratio: str
    template_type: str
    visibility_scope: str
    visible_user_ids: list[int] = []
    management_scope: str
    manage_user_ids: list[int] = []


class TemplateSeriesOrderPayload(ApiPayload):
    series: str
    template_ids: list[int]


class TemplateSubjectOrderPayload(ApiPayload):
    subject: str
    series: list[TemplateSeriesOrderPayload]


class TemplateOrderPayload(ApiPayload):
    template_ids: list[int] = []
    subjects: list[TemplateSubjectOrderPayload] = []
