"""
用户中心路由模块
处理用户首页统计、置顶、个人备注等功能
"""
import re
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.core.permissions import require_user, is_super_admin, can_view_resource, can_view_show
from app.db import now_iso
from app.routers.dependencies import db_dep


router = APIRouter()

_HTML_TAG_RE = re.compile(r"<[^>]*>")


def _resource_row(db: sqlite3.Connection, resource_id: int) -> sqlite3.Row:
    """获取资源行，不存在则抛出 404"""
    row = db.execute("SELECT * FROM resources WHERE id = ?", (resource_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "资源不存在")
    return row


def _show_row(db: sqlite3.Connection, show_id: int) -> sqlite3.Row:
    """获取演示行，不存在则抛出 404"""
    row = db.execute("SELECT * FROM shows WHERE id = ?", (show_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "演示不存在")
    return row


def _serialize_resource(db: sqlite3.Connection, row: sqlite3.Row, user: sqlite3.Row) -> dict[str, Any]:
    """序列化资源数据（简化版）"""
    from app.main import _version_row
    
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    current_version = _version_row(db, int(row["id"]))
    
    return {
        "id": row["id"],
        "name": row["name"],
        "owner_id": row["owner_id"],
        "owner_name": owner["name"] if owner else "",
        "resource_type": row["resource_type"],
        "subject": row["subject"],
        "tags": row["tags"],
        "status": row["status"],
        "current_version": current_version["version_no"] if current_version else 1,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _serialize_show(db: sqlite3.Connection, row: sqlite3.Row, user: sqlite3.Row) -> dict[str, Any]:
    """序列化演示数据（简化版）"""
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    
    return {
        "id": row["id"],
        "name": row["name"],
        "owner_id": row["owner_id"],
        "owner_name": owner["name"] if owner else "",
        "subject": row["subject"],
        "tags": row["tags"],
        "status": row["status"],
        "current_version": row["current_version"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


# ==================== 个人备注 ====================

@router.get("/me/personal-remarks")
def my_personal_remark_summary(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """当前用户有非空个人备注的资源 id 汇总（前端筛选用）。"""
    rows = db.execute(
        "SELECT DISTINCT resource_id, content_html FROM personal_remarks WHERE user_id = ?",
        (int(user["id"]),),
    ).fetchall()
    ids: set[int] = set()
    for r in rows:
        html = r["content_html"] or ""
        plain = _HTML_TAG_RE.sub("", html).replace("\xa0", " ").strip()
        if plain:
            ids.add(int(r["resource_id"]))
    return {"resource_ids": sorted(ids)}


# ==================== 置顶功能 ====================

@router.post("/me/pins/resources/{resource_id}")
def pin_resource(
    resource_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """置顶资源"""
    row = _resource_row(db, resource_id)
    if not can_view_resource(db, row, user):
        raise HTTPException(403, "无权访问该资源")
    db.execute(
        "INSERT OR IGNORE INTO user_pinned_resources (user_id, resource_id, pinned_at) VALUES (?, ?, ?)",
        (int(user["id"]), resource_id, now_iso()),
    )
    db.commit()
    return {"ok": True, "is_pinned": True}


@router.delete("/me/pins/resources/{resource_id}")
def unpin_resource(
    resource_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """取消置顶资源"""
    db.execute(
        "DELETE FROM user_pinned_resources WHERE user_id = ? AND resource_id = ?",
        (int(user["id"]), resource_id),
    )
    db.commit()
    return {"ok": True, "is_pinned": False}


@router.post("/me/pins/shows/{show_id}")
def pin_show(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """置顶演示"""
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无权访问该演示")
    db.execute(
        "INSERT OR IGNORE INTO user_pinned_shows (user_id, show_id, pinned_at) VALUES (?, ?, ?)",
        (int(user["id"]), show_id, now_iso()),
    )
    db.commit()
    return {"ok": True, "is_pinned": True}


@router.delete("/me/pins/shows/{show_id}")
def unpin_show(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """取消置顶演示"""
    db.execute(
        "DELETE FROM user_pinned_shows WHERE user_id = ? AND show_id = ?",
        (int(user["id"]), show_id),
    )
    db.commit()
    return {"ok": True, "is_pinned": False}


@router.get("/me/pins")
def list_my_pins(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """返回当前用户置顶的资源 / 放映；不再可见的项自动过滤。"""
    res_rows = db.execute(
        """
        SELECT r.* FROM user_pinned_resources p
        JOIN resources r ON r.id = p.resource_id
        WHERE p.user_id = ?
        ORDER BY p.pinned_at DESC
        """,
        (int(user["id"]),),
    ).fetchall()
    resources: list[dict[str, Any]] = []
    for row in res_rows:
        if not can_view_resource(db, row, user):
            continue
        resources.append(_serialize_resource(db, row, user))

    show_rows = db.execute(
        """
        SELECT s.* FROM user_pinned_shows p
        JOIN shows s ON s.id = p.show_id
        WHERE p.user_id = ?
        ORDER BY p.pinned_at DESC
        """,
        (int(user["id"]),),
    ).fetchall()
    shows: list[dict[str, Any]] = []
    for row in show_rows:
        if not can_view_show(db, row, user):
            continue
        shows.append(_serialize_show(db, row, user))

    return {"resources": resources, "shows": shows}


# ==================== 首页统计 ====================

@router.get("/me/home/stats")
def my_home_stats(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """首页数据概览：仅统计当前用户可见范围；超管看到全部。"""
    user_id = int(user["id"])
    super_admin = is_super_admin(user)

    def _visible_count(table: str, vis_table: str, vis_fk: str, *, where_extra: str = "") -> int:
        if super_admin:
            sql = f"SELECT COUNT(*) FROM {table} t"
            if where_extra:
                sql += f" WHERE {where_extra}"
            return int(db.execute(sql).fetchone()[0])
        sql = f"""
            SELECT COUNT(*) FROM {table} t
            WHERE (
                t.owner_id = ?
                OR t.visibility_scope = 'public'
                OR (t.visibility_scope = 'partial' AND EXISTS (
                    SELECT 1 FROM {vis_table} v WHERE v.{vis_fk} = t.id AND v.user_id = ?
                ))
            )
        """
        if where_extra:
            sql += f" AND ({where_extra})"
        return int(db.execute(sql, (user_id, user_id)).fetchone()[0])

    def _mine_count(table: str, *, where_extra: str = "") -> int:
        sql = f"SELECT COUNT(*) FROM {table} WHERE owner_id = ?"
        if where_extra:
            sql += f" AND ({where_extra})"
        return int(db.execute(sql, (user_id,)).fetchone()[0])

    resources_total = _visible_count(
        "resources", "resource_visibility", "resource_id",
        where_extra="t.resource_type = 'asset'",
    )
    resources_mine = _mine_count("resources", where_extra="resource_type = 'asset'")

    shows_total = _visible_count("shows", "show_visibility", "show_id")
    shows_mine = _mine_count("shows")

    templates_total = int(db.execute("SELECT COUNT(*) FROM templates").fetchone()[0])
    fonts_total = int(db.execute("SELECT COUNT(*) FROM fonts").fetchone()[0])

    return {
        "resources": {"total": resources_total, "mine": resources_mine},
        "shows": {"total": shows_total, "mine": shows_mine},
        "templates": {"total": templates_total},
        "fonts": {"total": fonts_total},
    }
