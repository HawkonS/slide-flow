"""FastAPI application assembly.

Business rules live in routers/services; this module only wires the runtime,
middleware, lifecycle and route registration.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.core.errors import OSS_CONFIGURATION_MESSAGE, OSS_UNAVAILABLE_MESSAGE
from app.core.oss import StorageConfigurationError, StorageUnavailableError
from app.lifecycle import lifespan
from app.middleware.http import ResponseCacheMiddleware, SecurityHeadersMiddleware, SlowRequestLogger
from app.middleware.resource_import import ResourceImportRequestGuard
from app.web.static import _StaticFilesWithHashedCache, router as static_router

logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    app = FastAPI(title=settings.site_name, lifespan=lifespan)

    @app.exception_handler(StorageConfigurationError)
    async def storage_configuration_error_handler(
        _request: Request, exc: StorageConfigurationError,
    ) -> JSONResponse:
        # OSS is intentionally not optional in production.  Return a stable,
        # actionable response for misconfiguration instead of Starlette's
        # generic 500 page (which hides the actual deployment problem).
        return JSONResponse(
            status_code=503,
            content={"detail": OSS_CONFIGURATION_MESSAGE},
            headers={"Cache-Control": "no-store", "Retry-After": "0"},
        )

    @app.exception_handler(StorageUnavailableError)
    async def storage_unavailable_error_handler(
        _request: Request, _exc: StorageUnavailableError,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={"detail": OSS_UNAVAILABLE_MESSAGE},
            headers={"Cache-Control": "no-store", "Retry-After": "3"},
        )

    allowed_origins = [origin.strip() for origin in settings.allowed_host.split(",") if origin.strip()]
    if allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=allowed_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    else:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["*"],
            allow_headers=["*"],
        )
    app.add_middleware(SlowRequestLogger)
    if settings.response_cache_enabled:
        app.add_middleware(ResponseCacheMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(ResourceImportRequestGuard)
    app.add_middleware(GZipMiddleware, minimum_size=1000)

    from app.routers import auth, config, download_records, feishu_auth, fonts, pages, system, tags, user_center, users
    from app.routers import downloads, presentation, resource_import, resource_shares, task_events, tasks, templates, renderer_font_tasks, renderer_render_tasks
    from app.routers.resources import files as resource_files
    from app.routers.resources import mutations as resource_mutations
    from app.routers.resources import queries as resource_queries
    from app.routers.resources import remarks as resource_remarks
    from app.routers.shows import catalog as show_catalog
    from app.routers.shows import downloads as show_downloads
    from app.routers.shows import remarks as show_remarks
    from app.routers.shows import versions as show_versions

    for module in (pages, config, system, auth, user_center, users, fonts, tags, download_records):
        app.include_router(module.router, prefix="/api", tags=[module.__name__.rsplit(".", 1)[-1]])
    for module in (
        resource_import, resource_shares, resource_queries, resource_mutations, resource_remarks, resource_files,
        templates, show_catalog, show_versions, show_remarks, show_downloads,
        downloads, task_events, presentation, tasks,
        renderer_font_tasks,
        renderer_render_tasks,
    ):
        app.include_router(module.router)
    try:
        app.include_router(feishu_auth.router, prefix="/api", tags=["feishu_auth"])
    except Exception as exc:
        logger.warning("飞书 SSO 模块加载失败，已跳过注册: %s", exc)

    app.mount("/static", _StaticFilesWithHashedCache(directory=settings.static_dir), name="static")
    # SPA catch-all must be registered last.
    app.include_router(static_router)
    # Including routers may merge their empty lifespan contexts. Keep the
    # single application lifecycle explicit so startup/shutdown ownership is
    # visible and testable in one module.
    app.router.lifespan_context = lifespan
    return app


app = create_app()
