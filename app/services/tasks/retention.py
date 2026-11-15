"""Archive old terminal task rows without losing activity history."""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from datetime import datetime, timedelta

from app.db import get_db

logger = logging.getLogger(__name__)

ARCHIVE_AFTER_DAYS = 90
ARCHIVE_INTERVAL_SECONDS = 6 * 60 * 60


def archive_old_tasks(db: sqlite3.Connection, *, now: datetime | None = None) -> int:
    """Hide terminal tasks from active task lists after the retention window.

    Rows stay in the database so completed-task activity remains queryable.
    """
    current = now or datetime.now()
    cutoff = (current - timedelta(days=ARCHIVE_AFTER_DAYS)).strftime("%Y-%m-%dT%H:%M:%S")
    cursor = db.execute(
        """UPDATE tasks
           SET archived_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
           WHERE archived_at IS NULL
             AND status IN ('completed', 'failed', 'cancelled')
             AND COALESCE(completed_at, created_at) < ?""",
        (cutoff,),
    )
    db.commit()
    return int(cursor.rowcount or 0)


async def task_archive_loop() -> None:
    while True:
        try:
            with get_db() as db:
                archived = archive_old_tasks(db)
                if archived:
                    logger.info("Archived %s terminal tasks", archived)
        except Exception:
            logger.exception("Task archive loop failed")
        await asyncio.sleep(ARCHIVE_INTERVAL_SECONDS)
