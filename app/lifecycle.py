"""Application startup/shutdown lifecycle."""

from __future__ import annotations

import asyncio
import concurrent.futures
from contextlib import asynccontextmanager

from app.config import settings
from app.db import init_db
from app.services.downloads.cleanup import _download_cleanup_loop
from app.services.files import _init_allowed_file_dirs
from app.services.resource_import.sessions import _cleanup_expired_resource_imports, _resource_import_cleanup_loop
from app.services.tasks.runtime import _heavy_executor


@asynccontextmanager
async def lifespan(app):
    loop = asyncio.get_running_loop()
    loop.set_default_executor(
        concurrent.futures.ThreadPoolExecutor(
            max_workers=settings.thread_pool_size,
            thread_name_prefix="fastapi-worker",
        )
    )
    init_db()
    _cleanup_expired_resource_imports()
    _init_allowed_file_dirs()
    cleanup_tasks = [
        asyncio.create_task(_download_cleanup_loop(), name="download-cleanup"),
        asyncio.create_task(_resource_import_cleanup_loop(), name="resource-import-cleanup"),
    ]
    try:
        yield
    finally:
        for task in cleanup_tasks:
            task.cancel()
        await asyncio.gather(*cleanup_tasks, return_exceptions=True)
        _heavy_executor.shutdown(wait=False, cancel_futures=False)
