"""
链接管理路由模块
处理链接的 CRUD、排序和默认选择
"""
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.permissions import require_user, require_admin, require_super_admin, can_view_link, can_manage_link
from app.db import now_iso
from app.routers.dependencies import (
    LinkCreatePayload,
    LinkUpdatePayload,
    LinkDeletePayload,
    LinkOrderPayload,
    LinkSelectionPayload,
    db_dep,
    _row_to_dict,
    _validate_scope,
)


router = APIRouter()


def _link_scope_user_ids(db: sqlite3.Connection, table: str, link_id: int) -> list[int]:
    """获取链接的可见/管理用户 ID 列表"""
    rows = db.execute(f"SELECT user_id FROM {table} WHERE link_id = ? ORDER BY user_id", (link_id,)).fetchall()
    return [int(row["user_id"]) for row in rows]


def _set_link_scope_users(db: sqlite3.Connection, table: str, link_id: int, user_ids: list[int]) -> None:
    """设置链接的可见/管理用户"""
    db.execute(f"DELETE FROM {table} WHERE link_id = ?", (link_id,))
    for uid in sorted(set(user_ids)):
        db.execute(f"INSERT OR IGNORE INTO {table} (link_id, user_id) VALUES (?, ?)", (link_id, uid))


def _link_row(db: sqlite3.Connection, link_id: int) -> sqlite3.Row:
    """获取链接行，不存在则抛出 404"""
    row = db.execute("SELECT * FROM links WHERE id = ?", (link_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "链接不存在")
    return row


def _serialize_link(db: sqlite3.Connection, row: sqlite3.Row, user: sqlite3.Row) -> dict[str, Any]:
    """序列化链接数据"""
    owner = db.execute("SELECT id, name, username FROM users WHERE id = ?", (row["owner_id"],)).fetchone()
    visible_user_ids = _link_scope_user_ids(db, "link_visibility", int(row["id"]))
    manage_user_ids = _link_scope_user_ids(db, "link_management", int(row["id"]))
    
    return {
        "id": row["id"],
        "name": row["name"],
        "url": row["url"],
        "memo": row["memo"],
        "owner_id": row["owner_id"],
        "owner": _row_to_dict(owner) if owner else None,
        "visibility_scope": row["visibility_scope"],
        "management_scope": row["management_scope"],
        "is_enabled": bool(row["is_enabled"]),
        "network_env": row["networkEnv"] if "networkEnv" in row.keys() else "public_net",
        "sort_order": int(row["sort_order"]) if "sort_order" in row.keys() else 0,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "visible_user_ids": visible_user_ids,
        "manage_user_ids": manage_user_ids,
    }


@router.get("/links")
def list_links(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """获取链接列表"""
    rows = db.execute("SELECT * FROM links ORDER BY sort_order ASC, updated_at DESC, id DESC").fetchall()
    links = [_serialize_link(db, row, user) for row in rows if can_view_link(db, row, user)]
    return {"links": links}


@router.post("/links")
def create_link(
    payload: LinkCreatePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """创建链接"""
    visibility_scope = _validate_scope(payload.visibility_scope)
    management_scope = _validate_scope(payload.management_scope)
    
    ts = now_iso()
    db.execute(
        """
        INSERT INTO links (name, url, memo, owner_id, visibility_scope, management_scope, is_enabled, networkEnv, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (payload.name, payload.url, payload.memo, user["id"], visibility_scope, management_scope, 1 if payload.is_enabled else 0, payload.network_env, ts, ts),
    )
    link_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    
    _set_link_scope_users(db, "link_visibility", link_id, payload.visible_user_ids)
    _set_link_scope_users(db, "link_management", link_id, payload.manage_user_ids)
    db.commit()
    
    row = _link_row(db, link_id)
    return {"link": _serialize_link(db, row, user)}


@router.put("/links/{link_id}")
def update_link(
    link_id: int,
    payload: LinkUpdatePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """更新链接"""
    row = _link_row(db, link_id)
    if not can_manage_link(db, row, user):
        raise HTTPException(403, "无管理权限")
    
    visibility_scope = _validate_scope(payload.visibility_scope)
    management_scope = _validate_scope(payload.management_scope)
    
    db.execute(
        """
        UPDATE links
        SET name = ?, url = ?, memo = ?, visibility_scope = ?, management_scope = ?, is_enabled = ?, networkEnv = ?, updated_at = ?
        WHERE id = ?
        """,
        (payload.name, payload.url, payload.memo, visibility_scope, management_scope, 1 if payload.is_enabled else 0, payload.network_env, now_iso(), link_id),
    )
    
    _set_link_scope_users(db, "link_visibility", link_id, payload.visible_user_ids)
    _set_link_scope_users(db, "link_management", link_id, payload.manage_user_ids)
    db.commit()
    
    return {"link": _serialize_link(db, _link_row(db, link_id), user)}


@router.delete("/links/{link_id}")
def delete_link(
    link_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """删除链接"""
    row = _link_row(db, link_id)
    if not can_manage_link(db, row, user):
        raise HTTPException(403, "无管理权限")
    
    db.execute("DELETE FROM links WHERE id = ?", (link_id,))
    db.commit()
    
    return {"ok": True, "deleted": 1}


@router.post("/admin/links/bulk-delete")
def bulk_delete_links(
    payload: LinkDeletePayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """批量删除链接（管理员）"""
    link_ids = sorted({int(lid) for lid in payload.link_ids if int(lid) > 0})
    if not link_ids:
        raise HTTPException(400, "请选择要删除的链接")
    
    placeholders = ",".join("?" for _ in link_ids)
    rows = db.execute(f"SELECT id FROM links WHERE id IN ({placeholders})", link_ids).fetchall()
    
    if not rows:
        raise HTTPException(404, "未找到可删除的链接")
    
    db.execute(f"DELETE FROM links WHERE id IN ({placeholders})", link_ids)
    db.commit()
    
    return {"ok": True, "deleted": len(rows)}


@router.put("/admin/links/order")
def reorder_links(
    payload: LinkOrderPayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """排序链接（管理员）"""
    link_ids = [int(lid) for lid in payload.link_ids]
    if not link_ids:
        raise HTTPException(400, "请选择需要排序的链接")
    if len(link_ids) != len(set(link_ids)):
        raise HTTPException(400, "排序列表存在重复链接")
    
    placeholders = ",".join("?" for _ in link_ids)
    rows = db.execute(f"SELECT id FROM links WHERE id IN ({placeholders})", link_ids).fetchall()
    existing = {int(row["id"]) for row in rows}
    missing = [lid for lid in link_ids if lid not in existing]
    
    if missing:
        raise HTTPException(404, "部分链接不存在")
    
    now = now_iso()
    for index, lid in enumerate(link_ids, start=1):
        db.execute(
            "UPDATE links SET sort_order = ?, updated_at = ? WHERE id = ?",
            (index * 10, now, lid),
        )
    db.commit()
    
    return {"ok": True, "ordered": len(link_ids)}


@router.get("/links/my-selection")
def get_my_link_selection(
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """获取用户的默认链接选择"""
    rows = db.execute(
        """
        SELECT l.* FROM links l
        JOIN default_selected_links dsl ON dsl.link_id = l.id
        ORDER BY dsl.sort_order
        """,
    ).fetchall()
    links = [_serialize_link(db, row, user) for row in rows if can_view_link(db, row, user)]
    return {"links": links}


@router.get("/links/admin/defaults")
def get_default_link_selection(
    user: sqlite3.Row = Depends(require_super_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """获取默认链接选择（超管）"""
    rows = db.execute(
        """
        SELECT l.* FROM links l
        JOIN default_selected_links dsl ON dsl.link_id = l.id
        ORDER BY dsl.sort_order
        """,
    ).fetchall()
    links = [_serialize_link(db, row, user) for row in rows]
    return {"links": links}


@router.put("/links/admin/defaults")
def set_default_link_selection(
    payload: LinkSelectionPayload,
    user: sqlite3.Row = Depends(require_super_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """设置默认链接选择（超管）"""
    if len(payload.link_ids) > 5:
        raise HTTPException(400, "最多设置5个默认链接")
    
    for lid in payload.link_ids:
        _link_row(db, lid)
    
    db.execute("DELETE FROM default_selected_links")
    for index, lid in enumerate(payload.link_ids):
        db.execute(
            "INSERT OR IGNORE INTO default_selected_links (link_id, sort_order) VALUES (?, ?)",
            (lid, index),
        )
    db.commit()
    
    return get_default_link_selection(user, db)
