"""Cancellation-safe ownership for ASGI responses and blocking operations."""
import asyncio

from fastapi.responses import StreamingResponse


async def finish_thread(function, *args, on_cancel=None):
    """Never abandon a thread that still owns files or a queue reservation.

    asyncio cancellation cannot stop a worker thread. Shielding just the first
    await is insufficient: a second cancellation could otherwise race cleanup.
    """
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            if task.cancelled():
                raise
            cancelled = True
        except Exception:
            break
    try:
        result = task.result()
    except Exception:
        if cancelled:
            raise asyncio.CancelledError() from None
        raise
    if cancelled:
        if on_cancel is not None:
            # The callback is deliberately synchronous: no further ASGI
            # cancellation can interrupt its release of the owned reservation.
            on_cancel(result)
        raise asyncio.CancelledError()
    return result


class OwnedStreamingResponse(StreamingResponse):
    """Release the read lease even if sending headers fails before iteration.

    Starlette background tasks are not guaranteed to run when ASGI send raises
    or the response task is cancelled. A generator's finally is also insufficient
    if it has not been entered yet. The ASGI response itself owns this lease.
    """
    def __init__(self, *args, release, timeout_seconds=180, **kwargs):
        super().__init__(*args, **kwargs)
        self.release = release
        self.timeout_seconds = timeout_seconds

    async def __call__(self, scope, receive, send):
        try:
            await asyncio.wait_for(super().__call__(scope, receive, send), self.timeout_seconds)
        finally:
            self.release()
