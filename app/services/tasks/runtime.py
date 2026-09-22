"""Services / tasks / runtime."""

from __future__ import annotations

from app.config import settings
import asyncio
import concurrent.futures
import threading


_task_cancel_flags: dict[int, threading.Event] = {}


_pending_task_futures: dict[int, asyncio.Future] = {}  # type: ignore[type-arg]


_split_semaphore = asyncio.Semaphore(settings.max_concurrent_splits)


SPLIT_TASK_TIMEOUT = settings.split_task_timeout


_heavy_executor = concurrent.futures.ThreadPoolExecutor(
    max_workers=2, thread_name_prefix="heavy-task"
)
