"""管理员下载记录查询路由。"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, Query

from app.core.permissions import require_admin
from app.routers.dependencies import db_read_dep


router = APIRouter()


@router.get("/admin/download-records")
def list_download_records(
    track_code: str = Query(""),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """分页查询下载记录，可按追踪码精确筛选。"""
    base_query = """
        FROM download_records dr
        LEFT JOIN users u ON dr.user_id = u.id
        LEFT JOIN shows s ON dr.show_id = s.id
    """
    conditions: list[str] = []
    params: list[Any] = []

    if track_code.strip():
        conditions.append("dr.track_code = ?")
        params.append(track_code.strip())

    where_clause = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    count_row = db.execute(
        f"SELECT COUNT(*) AS total {base_query}{where_clause}", params
    ).fetchone()
    total = int(count_row["total"]) if count_row is not None else 0

    offset = (page - 1) * page_size
    rows = db.execute(
        f"""
        SELECT dr.id, dr.track_code, dr.download_type, dr.client_ip, dr.downloaded_at,
               u.name AS user_name, u.username AS user_username,
               s.name AS show_name, s.id AS show_id
        {base_query}{where_clause}
        ORDER BY dr.downloaded_at DESC
        LIMIT ? OFFSET ?
        """,
        [*params, page_size, offset],
    ).fetchall()

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [
            {
                "id": row["id"],
                "track_code": row["track_code"],
                "user_name": row["user_name"] or "已删除用户",
                "user_username": row["user_username"] or "",
                "show_name": row["show_name"] or "已删除放映组",
                "show_id": row["show_id"],
                "download_type": row["download_type"],
                "client_ip": row["client_ip"],
                "downloaded_at": row["downloaded_at"],
            }
            for row in rows
        ],
    }
