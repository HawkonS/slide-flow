"""Services / resource import / jobs."""

from __future__ import annotations

from app.config import settings
from app.services.resource_import.sessions import (
    _resource_import_root,
)
from fastapi import HTTPException
import asyncio
import contextvars
import fcntl


async def _run_resource_import_job(function, *args):
    # Cross-worker slots bound CPU/memory-heavy conversion work across the
    # whole service, not just within an individual Gunicorn worker.
    slots = _resource_import_root() / ".slots"
    slots.mkdir(exist_ok=True)
    handles = []
    try:
        for index in range(max(1, min(settings.max_concurrent_splits, 4))):
            handle = (slots / str(index)).open("a+b")
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                handle.close()
                continue
            handles.append(handle)
            break
        if not handles:
            raise HTTPException(429, "服务器正在处理其他导入，请稍后重试")
        # Keep an executor Future rather than an intermediate asyncio Task:
        # cancelling all request Tasks during shutdown must not mark this
        # job as finished while its underlying thread is still writing.
        context = contextvars.copy_context()
        job = asyncio.get_running_loop().run_in_executor(None, context.run, function, *args)
        cancellation: asyncio.CancelledError | None = None
        while True:
            try:
                result = await asyncio.shield(job)
                break
            except asyncio.CancelledError as exc:
                # Client disconnect + shutdown (or repeated Task.cancel)
                # can cancel this await more than once. Preserve both leases
                # until the actual thread completes, then propagate cancel.
                cancellation = cancellation or exc
                if job.done():
                    # Retrieve the outcome so a cancelled caller does not
                    # leave an unobserved worker exception behind.
                    try:
                        job.result()
                    except BaseException:
                        pass
                    raise cancellation
            except BaseException:
                if cancellation is not None:
                    raise cancellation
                raise
        if cancellation is not None:
            raise cancellation
        return result
    finally:
        for handle in handles:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()
