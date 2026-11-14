"""
用户中心路由模块
处理用户首页统计、置顶、个人备注等功能
"""
import re
import sqlite3
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.core.permissions import (
    require_user,
    is_system_admin,
    can_view_resource,
    can_view_show,
    can_manage_resource,
    can_manage_show,
)
from app.db import now_iso
from app.routers.dependencies import db_dep, db_read_dep
from app.services.files import asset_preview_url
from app.services.tagging import tag_relation_join


router = APIRouter()

_HTML_TAG_RE = re.compile(r"<[^>]*>")


def _resource_row(db: sqlite3.Connection, resource_id: int) -> sqlite3.Row:
    """获取资源行，不存在则抛出 404"""
    row = db.execute("SELECT * FROM resources WHERE id = ? AND deleted_at IS NULL", (resource_id,)).fetchone()
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
    """序列化资源数据（完整版）"""
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    
    # 获取当前版本
    current_version = db.execute(
        """
        SELECT v.* FROM resource_versions v
        JOIN resources r ON r.id = v.resource_id AND r.current_version = v.version_no
        WHERE r.id = ?
        """,
        (int(row["id"]),),
    ).fetchone()
    
    version_id = current_version["id"] if current_version else None
    png_path = current_version["png_path"] if current_version else None
    resource_id = int(row["id"])
    
    return {
        "id": resource_id,
        "detail_token": row["detail_token"],
        "name": row["name"],
        "subject": row["subject"],
        "tags": row["tags"],
        "status": row["status"],
        "visibility_scope": row["visibility_scope"],
        "management_scope": row["management_scope"],
        "owner_id": row["owner_id"],
        "owner": {"id": owner["id"], "name": owner["name"], "username": owner["username"]} if owner else None,
        "current_version": current_version["version_no"] if current_version else 1,
        "current": {
            "id": version_id,
            "version_no": current_version["version_no"] if current_version else 1,
            "preview_url": asset_preview_url(png_path, thumb=True) or (f"/api/resources/{resource_id}/preview-thumb?version_id={version_id}" if png_path else None),
            "original_preview_url": asset_preview_url(png_path) or (f"/api/resources/{resource_id}/preview?version_id={version_id}" if png_path else None),
        } if current_version else None,
        "can_manage": can_manage_resource(db, row, user),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "is_pinned": True,  # 在置顶列表中，所以一定是 True
    }


def _serialize_show(db: sqlite3.Connection, row: sqlite3.Row, user: sqlite3.Row) -> dict[str, Any]:
    """序列化演示数据（完整版）"""
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    
    # 获取演示关联的资源
    resource_rows = db.execute(
        """
        SELECT sr.resource_id, sr.version_no, sr.is_hidden, r.name as resource_name
        FROM show_resources sr
        LEFT JOIN resources r ON r.id = sr.resource_id
        WHERE sr.show_id = ?
        ORDER BY sr.sort_order
        """,
        (int(row["id"]),),
    ).fetchall()
    
    resources = []
    for sr in resource_rows:
        if sr["resource_id"]:
            resource_id = int(sr["resource_id"])
            version_no = int(sr["version_no"])
            
            # 获取版本信息用于生成预览图 URL
            version_row = db.execute(
                "SELECT id, png_path FROM resource_versions WHERE resource_id = ? AND version_no = ?",
                (resource_id, version_no),
            ).fetchone()
            
            version_id = version_row["id"] if version_row else None
            png_path = version_row["png_path"] if version_row else None
            
            resource_row = db.execute(
                "SELECT * FROM resources WHERE id = ?",
                (resource_id,),
            ).fetchone()
            
            resource_accessible = bool(resource_row and can_view_resource(db, resource_row, user))
            if not resource_accessible:
                continue
            resources.append({
                "id": resource_id,
                "name": sr["resource_name"],
                "version_no": version_no,
                "is_hidden": bool(sr["is_hidden"]),
                "accessible": resource_accessible,
                "preview_url": asset_preview_url(png_path, thumb=True) or (f"/api/resources/{resource_id}/preview-thumb?version_id={version_id}" if png_path else None),
                "original_preview_url": asset_preview_url(png_path) or (f"/api/resources/{resource_id}/preview?version_id={version_id}" if png_path else None),
            })
    
    return {
        "id": row["id"],
        "name": row["name"],
        "subject": row["subject"],
        "tags": row["tags"],
        "status": row["status"],
        "is_standard": bool(row["is_standard"]),
        "visibility_scope": row["visibility_scope"],
        "management_scope": row["management_scope"],
        "owner_id": row["owner_id"],
        "owner": {"id": owner["id"], "name": owner["name"], "username": owner["username"]} if owner else None,
        "version_no": row["version_no"],
        "resources": resources,  # 必须包含 resources 字段
        "can_manage": can_manage_show(db, row, user),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "is_pinned": True,  # 在置顶列表中，所以一定是 True
    }


# ==================== 个人备注 ====================

@router.get("/me/personal-remarks")
def my_personal_remark_summary(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """当前用户有非空个人备注的资源 id 汇总（前端筛选用）。"""
    rows = db.execute(
        """SELECT DISTINCT pr.resource_id, pr.content_html FROM personal_remarks pr
        JOIN resources r ON r.id = pr.resource_id AND r.deleted_at IS NULL
        JOIN resource_versions v ON v.id = pr.version_id AND v.deleted_at IS NULL
        WHERE pr.user_id = ?""",
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
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """返回当前用户置顶的资源 / 放映；不再可见的项自动过滤。"""
    res_rows = db.execute(
        """
        SELECT r.* FROM user_pinned_resources p
        JOIN resources r ON r.id = p.resource_id
        WHERE p.user_id = ? AND r.deleted_at IS NULL
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
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """首页工作台统计：平台总数、我的可见/管理/创建和任务汇总。"""
    user_id = int(user["id"])
    system_admin = is_system_admin(user)

    def _scope_count(
        table: str,
        scope_column: str,
        link_table: str,
        link_fk: str,
        *,
        tag_table: str | None = None,
        where_extra: str = "",
    ) -> int:
        if system_admin:
            sql = f"SELECT COUNT(*) FROM {table} t"
            if where_extra:
                sql += f" WHERE {where_extra}"
            return int(db.execute(sql).fetchone()[0])
        tag_clause = ""
        params: list[int] = [user_id, user_id]
        if tag_table:
            tag_join = tag_relation_join(db, tag_table, "vt")
            tag_clause = f"""
                OR (t.{scope_column} = 'partial' AND EXISTS (
                    SELECT 1 FROM {tag_table} vt
                    JOIN user_tags ut ON {tag_join}
                    WHERE vt.{link_fk} = t.id AND ut.user_id = ?
                ))
            """
            params.append(user_id)
        sql = f"""
            SELECT COUNT(*) FROM {table} t
            WHERE (
                t.owner_id = ?
                OR t.{scope_column} = 'public'
                OR (t.{scope_column} = 'partial' AND EXISTS (
                    SELECT 1 FROM {link_table} v WHERE v.{link_fk} = t.id AND v.user_id = ?
                ))
                {tag_clause}
            )
        """
        if where_extra:
            sql += f" AND ({where_extra})"
        return int(db.execute(sql, params).fetchone()[0])

    def _mine_count(table: str, *, where_extra: str = "") -> int:
        sql = f"SELECT COUNT(*) FROM {table} WHERE owner_id = ?"
        if where_extra:
            sql += f" AND ({where_extra})"
        return int(db.execute(sql, (user_id,)).fetchone()[0])

    resources_total = int(db.execute("SELECT COUNT(*) FROM resources WHERE deleted_at IS NULL").fetchone()[0])
    resources_mine = _mine_count("resources", where_extra="deleted_at IS NULL")
    resources_visible = _scope_count(
        "resources", "visibility_scope", "resource_visibility", "resource_id",
        tag_table="resource_visibility_tags", where_extra="t.deleted_at IS NULL",
    )
    resources_managed = _scope_count(
        "resources", "management_scope", "resource_management", "resource_id",
        tag_table="resource_management_tags", where_extra="t.deleted_at IS NULL",
    )

    shows_total = int(db.execute("SELECT COUNT(*) FROM shows").fetchone()[0])
    shows_mine = _mine_count("shows")
    shows_visible = _scope_count(
        "shows", "visibility_scope", "show_visibility", "show_id",
        tag_table="show_visibility_tags",
    )
    shows_managed = _scope_count(
        "shows", "management_scope", "show_management", "show_id",
        tag_table="show_management_tags",
    )
    standard_shows = int(db.execute("SELECT COUNT(*) FROM shows WHERE is_standard = 1").fetchone()[0])

    templates_total = int(db.execute("SELECT COUNT(*) FROM templates").fetchone()[0])
    fonts_total = int(db.execute("SELECT COUNT(*) FROM fonts").fetchone()[0])

    def _own_task_count(extra: str = "") -> int:
        sql = "SELECT COUNT(*) FROM tasks WHERE owner_id = ?" + extra
        return int(db.execute(sql, (user_id,)).fetchone()[0])

    jobs_total_sql = "SELECT COUNT(*) FROM tasks"
    tasks_total = int(
        db.execute(jobs_total_sql).fetchone()[0]
        if system_admin
        else db.execute(jobs_total_sql + " WHERE owner_id = ?", (user_id,)).fetchone()[0]
    )
    tasks_upload = _own_task_count(" AND task_type = 'batch_split_import'")
    tasks_download = _own_task_count(" AND task_type = 'download'")
    tasks_unfinished = _own_task_count(" AND status NOT IN ('completed', 'cancelled')")
    tasks_failed = _own_task_count(" AND status = 'failed'")

    return {
        "resources": {
            "total": resources_total,
            "mine": resources_mine,
            "managed": resources_managed,
            "visible": resources_visible,
        },
        "shows": {
            "total": shows_total,
            "mine": shows_mine,
            "managed": shows_managed,
            "visible": shows_visible,
        },
        "standard_shows": standard_shows,
        "templates": {"total": templates_total},
        "fonts": {"total": fonts_total},
        "tasks": {
            "total": tasks_total,
            "upload": tasks_upload,
            "download": tasks_download,
            "unfinished": tasks_unfinished,
            "failed": tasks_failed,
        },
    }


@router.get("/me/activity")
def my_activity(
    days: int = 365,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """最近 N 天的登录/上传/下载活跃度（按完成日聚合）。"""
    safe_days = max(30, min(int(days), 730))
    end_day = date.today()
    start_day = end_day - timedelta(days=safe_days - 1)
    start = f"{start_day.isoformat()}T00:00:00"

    def _group(sql: str, args: tuple[Any, ...]) -> list[dict[str, Any]]:
        return [
            {"date": str(row["day"]), "count": int(row["count"])}
            for row in db.execute(sql, args).fetchall()
            if row["day"]
        ]

    login = _group(
        """SELECT substr(occurred_at, 1, 10) AS day, COUNT(*) AS count
           FROM user_login_events WHERE user_id = ? AND occurred_at >= ?
           GROUP BY day ORDER BY day""",
        (int(user["id"]), start),
    )
    upload = _group(
        """SELECT substr(completed_at, 1, 10) AS day, COUNT(*) AS count
           FROM tasks WHERE owner_id = ? AND task_type = 'batch_split_import'
             AND status = 'completed' AND completed_at IS NOT NULL AND completed_at >= ?
           GROUP BY day ORDER BY day""",
        (int(user["id"]), start),
    )
    download = _group(
        """SELECT substr(completed_at, 1, 10) AS day, COUNT(*) AS count
           FROM tasks WHERE owner_id = ? AND task_type = 'download'
             AND status = 'completed' AND completed_at IS NOT NULL AND completed_at >= ?
           GROUP BY day ORDER BY day""",
        (int(user["id"]), start),
    )
    return {
        "start": start_day.isoformat(),
        "end": end_day.isoformat(),
        "login": login,
        "upload": upload,
        "download": download,
    }
