"""Services / downloads / cleanup."""

from __future__ import annotations

from datetime import datetime
from datetime import timedelta
from pathlib import Path
import asyncio
import json
import logging

logger = logging.getLogger(__name__)


async def _download_cleanup_loop() -> None:
    """每小时清理超过 24h 的已完成下载任务产生的文件，并标记其 result_data 为 expired。"""
    from app.db import get_write_db, release_db
    while True:
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            return
        try:
            cutoff = (datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%S")
            db = get_write_db()
            try:
                expired = db.execute(
                    "SELECT id, result_data FROM tasks"
                    " WHERE task_type = 'download' AND status = 'completed'"
                    " AND completed_at IS NOT NULL AND completed_at < ?",
                    (cutoff,),
                ).fetchall()
                for task in expired:
                    try:
                        result = json.loads(task["result_data"] or "{}")
                    except (ValueError, TypeError):
                        result = {}
                    if result.get("expired"):
                        continue
                    fp = result.get("file_path")
                    if fp:
                        try:
                            Path(fp).unlink(missing_ok=True)
                        except Exception:
                            logger.warning("清理过期下载文件失败 task_id=%s path=%s", task["id"], fp, exc_info=True)
                    db.execute(
                        "UPDATE tasks SET result_data = ?,"
                        " updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')"
                        " WHERE id = ?",
                        (json.dumps({"expired": True}), task["id"]),
                    )
                db.execute(
                    "DELETE FROM task_events WHERE created_at < ?",
                    (cutoff,),
                )
                db.commit()
            finally:
                release_db(db, readonly=False)
        except Exception as exc:
            logger.error("Download cleanup error: %s", exc, exc_info=True)
