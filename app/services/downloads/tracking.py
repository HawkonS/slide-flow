"""Services / downloads / tracking."""

from __future__ import annotations

from datetime import datetime
from fastapi import Request
import random
import sqlite3
import string


def _generate_track_code(db: sqlite3.Connection) -> str:
    """生成唯一的6位追踪码（大小写字母+数字）"""
    chars = string.ascii_letters + string.digits
    for _ in range(100):
        code = ''.join(random.choices(chars, k=6))
        exists = db.execute("SELECT 1 FROM download_records WHERE track_code = ?", (code,)).fetchone()
        if not exists:
            return code
    raise RuntimeError("无法生成唯一追踪码")


def _record_download(db: sqlite3.Connection, user: sqlite3.Row, request: Request, show_id: int, download_type: str) -> str:
    """记录下载并返回追踪码"""
    track_code = _generate_track_code(db)
    client_ip = request.headers.get("X-Forwarded-For", "").split(",")[0].strip() or (request.client.host if request.client else "")
    db.execute(
        "INSERT INTO download_records (track_code, user_id, show_id, download_type, client_ip, downloaded_at) VALUES (?, ?, ?, ?, ?, ?)",
        (track_code, user["id"], show_id, download_type, client_ip, datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    )
    db.commit()
    return track_code


def _compose_watermark_text(track_code: str, extra: str) -> str:
    """组合追踪码与前端传入的水印文本，返回最终水印字符串。"""
    parts = [track_code]
    cleaned = (extra or "").strip()
    if cleaned and cleaned != "__enabled__":  # 过滤前端占位标记
        parts.append(cleaned[:100])  # 限制附加文本最大100字符
    return " ".join(parts)
