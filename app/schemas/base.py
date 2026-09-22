"""Shared strict request-model base, independent from HTTP routers."""

from pydantic import BaseModel, ConfigDict


class ApiPayload(BaseModel):
    """Current-version API payloads reject fields outside their declared schema."""

    model_config = ConfigDict(extra="forbid")
