"""Routers / shows / catalog."""

from __future__ import annotations

from app.core.permissions import can_manage_show
from app.core.permissions import can_view_resource
from app.core.permissions import can_view_show
from app.core.permissions import is_system_admin
from app.core.permissions import require_admin
from app.core.permissions import require_user
from app.db import now_iso
from app.routers.dependencies import (
    db_dep,
    db_read_dep,
)
from app.schemas.shows import (
    ShowCreatePayload,
    ShowDuplicatePayload,
    ShowResourceAppendPayload,
    ShowResourceHiddenPayload,
    ShowResourcesPayload,
    ShowStandardPayload,
    ShowUpdatePayload,
)
from app.services.common import (
    _reject_removed_query_params,
    _validate_resource_status,
    _validate_scope,
)
from app.services.resource_queries import (
    _PICK_SORT_KEYS,
    _csv_tag_sql_match,
    _parse_csv,
)
from app.services.resources import (
    _resource_row,
)
from app.schemas.resources import MissingResourceCleanupPayload
from app.services.resource_deletion import cleanup_missing_resources, maintain_archives
from app.services.shows import (
    _serialize_show,
    _serialize_show_lite,
    _set_show_scope_tags,
    _set_show_scope_users,
    _show_row,
    _show_scope_tag_names,
    _show_scope_user_ids,
)
from app.services.resources import _normalise_scope_tags
from app.services.tagging import entity_tag_names, set_entity_tags, tag_relation_join
from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from fastapi import Query
from fastapi import Request
from typing import Any
import sqlite3
import uuid

router = APIRouter()


@router.get("/api/shows")
def list_shows(
    request: Request,
    series_id: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(30, ge=1, le=200),
    search: str = Query(""),
    tags: str = Query(""),
    tags_mode: str = Query("any"),
    subject: str = Query(""),
    status: str = Query("all"),
    permission: str = Query("all"),
    sort: str = Query("updated_desc"),
    standard_only: bool = Query(False),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    _reject_removed_query_params(request, "tag")
    uid = int(user["id"])
    system_admin = is_system_admin(user)

    # ── 可见性 SQL 条件 ──
    vis_params: dict[str, Any] = {"vis_uid": uid}
    if system_admin:
        vis_cond = "1=1"
    else:
        visibility_tag_join = tag_relation_join(db, "show_visibility_tags", "svt", "ut")
        vis_cond = (
            "(s.owner_id = :vis_uid"
            " OR s.visibility_scope = 'public'"
            " OR (s.visibility_scope = 'partial' AND s.id IN"
            " (SELECT show_id FROM show_visibility WHERE user_id = :vis_uid))"
            " OR (s.visibility_scope = 'partial' AND EXISTS ("
            " SELECT 1 FROM show_visibility_tags svt"
            f" JOIN user_tags ut ON {visibility_tag_join}"
            " WHERE svt.show_id = s.id AND ut.user_id = :vis_uid)))"
        )

    # ── series_id 查询：返回完整数据（用于版本切换） ──
    if series_id is not None:
        rows = db.execute(
            f"SELECT s.* FROM shows s WHERE s.series_id = :sid AND {vis_cond}",
            {**vis_params, "sid": series_id},
        ).fetchall()
        shows = [_serialize_show(db, row, user) for row in rows]
        return {"shows": shows}

    # ── CTE：可见 + 每个 series 只保留最大 version_no（同版本取最新 id） ──
    cte = f"""
        WITH visible AS (
            SELECT s.* FROM shows s WHERE {vis_cond}
              {"AND s.is_standard = 1" if standard_only else ""}
        ),
        deduped AS (
            SELECT v.* FROM visible v
            INNER JOIN (
                SELECT series_id, MAX(COALESCE(version_no, 0)) AS max_ver
                FROM visible GROUP BY series_id
            ) g ON v.series_id = g.series_id
               AND COALESCE(v.version_no, 0) = g.max_ver
            WHERE v.id = (
                SELECT MAX(v2.id) FROM visible v2
                WHERE v2.series_id = v.series_id
                  AND COALESCE(v2.version_no, 0) = g.max_ver
            )
        )
    """

    # ── 筛选 WHERE 片段 ──
    where_parts: list[str] = []
    params: dict[str, Any] = {}

    if status and status != "all":
        where_parts.append("COALESCE(status, 'active') = :fl_status")
        params["fl_status"] = status
    if subject and subject != "all":
        where_parts.append("COALESCE(subject, '') = :fl_subject")
        params["fl_subject"] = subject
    if permission == "created":
        where_parts.append("owner_id = :perm_uid")
        params["perm_uid"] = uid
    elif permission == "managed":
        if not system_admin:
            management_tag_join = tag_relation_join(db, "show_management_tags", "smt", "ut")
            where_parts.append(
                "(owner_id = :m_uid"
                " OR management_scope = 'public'"
                " OR (management_scope = 'partial' AND id IN"
                " (SELECT show_id FROM show_management WHERE user_id = :m_uid))"
                " OR (management_scope = 'partial' AND EXISTS ("
                " SELECT 1 FROM show_management_tags smt"
                f" JOIN user_tags ut ON {management_tag_join}"
                " WHERE smt.show_id = id AND ut.user_id = :m_uid)))"
            )
            params["m_uid"] = uid
    q = search.strip()
    if q:
        where_parts.append(
            "(LOWER(COALESCE(name, '')) LIKE :fl_q"
            " OR LOWER(COALESCE(subject, '')) LIKE :fl_q)"
        )
        params["fl_q"] = f"%{q.lower()}%"
    tag_list = _parse_csv(tags)
    if tag_list:
        mode = (tags_mode or "any").lower()
        if mode == "all":
            for i, t in enumerate(tag_list):
                param_name = f"stg{i}"
                where_parts.append(
                    "EXISTS (SELECT 1 FROM show_tags st "
                    "JOIN tags tag_def ON tag_def.id = st.tag_id "
                    f"WHERE st.show_id = id AND tag_def.name = :{param_name})"
                )
                params[param_name] = t
        else:
            or_parts = []
            for i, t in enumerate(tag_list):
                param_name = f"stg{i}"
                or_parts.append(
                    "EXISTS (SELECT 1 FROM show_tags st "
                    "JOIN tags tag_def ON tag_def.id = st.tag_id "
                    f"WHERE st.show_id = id AND tag_def.name = :{param_name})"
                )
                params[param_name] = t
            where_parts.append(f"({' OR '.join(or_parts)})")

    filter_sql = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    # 排序
    sort_key = sort if sort in _PICK_SORT_KEYS else "updated_desc"
    if sort_key.startswith("name"):
        order = "LOWER(COALESCE(name, '')) DESC" if sort_key.endswith("_desc") else "LOWER(COALESCE(name, '')) ASC"
    elif sort_key.startswith("created"):
        order = "COALESCE(created_at, '') DESC, id DESC" if sort_key.endswith("_desc") else "COALESCE(created_at, '') ASC, id ASC"
    else:
        order = "COALESCE(updated_at, '') DESC, id DESC" if sort_key.endswith("_desc") else "COALESCE(updated_at, '') ASC, id ASC"

    all_params = {**vis_params, **params}

    # 收集标签/主体
    facet_rows = db.execute(
        f"{cte} SELECT tags, subject FROM deduped{filter_sql}",
        all_params,
    ).fetchall()
    all_tags_set: set[str] = set()
    all_subjects_set: set[str] = set()
    for fr in facet_rows:
        all_tags_set.update(_parse_csv(fr["tags"] or ""))
        if fr["subject"]:
            all_subjects_set.add(fr["subject"])
    all_tags = sorted(all_tags_set)
    all_subjects = sorted(all_subjects_set)

    # 总数
    total: int = db.execute(
        f"{cte} SELECT COUNT(*) FROM deduped{filter_sql}",
        all_params,
    ).fetchone()[0]

    # 分页
    offset = (page - 1) * page_size
    page_rows = db.execute(
        f"{cte} SELECT * FROM deduped{filter_sql} ORDER BY {order} LIMIT :lim OFFSET :off",
        {**all_params, "lim": page_size, "off": offset},
    ).fetchall()
    items = [_serialize_show_lite(db, row, user) for row in page_rows]
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "all_tags": all_tags,
        "all_subjects": all_subjects,
    }


@router.post("/api/shows")
def create_show(
    payload: ShowCreatePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    visibility_scope = _validate_scope(payload.visibility_scope)
    management_scope = _validate_scope(payload.management_scope)
    status = _validate_resource_status(payload.status)
    visible_user_tags = _normalise_scope_tags(db, payload.visible_user_tags)
    manage_user_tags = _normalise_scope_tags(db, payload.manage_user_tags)
    if visibility_scope == "partial" and not payload.visible_user_ids and not visible_user_tags:
        raise HTTPException(400, "可见范围为部分时请至少选择一位用户或一个用户标签")
    if management_scope == "partial" and not payload.manage_user_ids and not manage_user_tags:
        raise HTTPException(400, "管理范围为部分时请至少选择一位用户或一个用户标签")
    for rid in payload.resource_ids:
        if not can_view_resource(db, _resource_row(db, rid), user):
            raise HTTPException(403, "部分素材不可访问，请重新选择")
    ts = now_iso()
    series_id = uuid.uuid4().hex[:10]
    db.execute(
        """
        INSERT INTO shows (name, owner_id, subject, tags, status, visibility_scope, management_scope, is_standard, series_id, version_no, change_note, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (payload.name, user["id"], payload.subject, payload.tags, status, visibility_scope, management_scope, 0, series_id, 1, payload.change_note, user["id"], ts, ts),
    )
    show_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    set_entity_tags(
        db,
        relation_table="show_tags",
        entity_column="show_id",
        entity_id=show_id,
        names=payload.tags,
        cache_table="shows",
        created_by=int(user["id"]),
    )
    _set_show_scope_users(db, "show_visibility", show_id, payload.visible_user_ids)
    _set_show_scope_tags(db, show_id, visible_user_tags)
    _set_show_scope_users(db, "show_management", show_id, payload.manage_user_ids)
    _set_show_scope_tags(db, show_id, manage_user_tags, "show_management_tags")
    for index, rid in enumerate(payload.resource_ids):
        res_row = db.execute("SELECT current_version FROM resources WHERE id = ?", (rid,)).fetchone()
        version_no = int(res_row["current_version"]) if res_row else 1
        db.execute(
            "INSERT OR IGNORE INTO show_resources (show_id, resource_id, version_no, sort_order) VALUES (?, ?, ?, ?)",
            (show_id, rid, version_no, index),
        )
    db.commit()
    row = _show_row(db, show_id)
    return {"show": _serialize_show(db, row, user)}


@router.get("/api/shows/{show_id}")
def get_show(
    show_id: int,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    return {"show": _serialize_show(db, row, user)}


@router.put("/api/shows/{show_id}")
def update_show(
    show_id: int,
    payload: ShowUpdatePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_manage_show(db, row, user):
        raise HTTPException(403, "无管理权限")
    visibility_scope = _validate_scope(payload.visibility_scope)
    management_scope = _validate_scope(payload.management_scope)
    status = _validate_resource_status(payload.status)
    visible_user_tags = _normalise_scope_tags(db, payload.visible_user_tags)
    manage_user_tags = _normalise_scope_tags(db, payload.manage_user_tags)
    if visibility_scope == "partial" and not payload.visible_user_ids and not visible_user_tags:
        raise HTTPException(400, "可见范围为部分时请至少选择一位用户或一个用户标签")
    if management_scope == "partial" and not payload.manage_user_ids and not manage_user_tags:
        raise HTTPException(400, "管理范围为部分时请至少选择一位用户或一个用户标签")
    db.execute(
        """
        UPDATE shows
        SET name = ?, subject = ?, tags = ?, status = ?, visibility_scope = ?, management_scope = ?, updated_by = ?, updated_at = ?
        WHERE id = ?
        """,
        (payload.name, payload.subject, payload.tags, status, visibility_scope, management_scope, user["id"], now_iso(), show_id),
    )
    set_entity_tags(
        db,
        relation_table="show_tags",
        entity_column="show_id",
        entity_id=show_id,
        names=payload.tags,
        cache_table="shows",
        created_by=int(user["id"]),
    )
    _set_show_scope_users(db, "show_visibility", show_id, payload.visible_user_ids)
    _set_show_scope_tags(db, show_id, visible_user_tags)
    _set_show_scope_users(db, "show_management", show_id, payload.manage_user_ids)
    _set_show_scope_tags(db, show_id, manage_user_tags, "show_management_tags")
    db.commit()
    maintain_archives(db)
    return {"show": _serialize_show(db, _show_row(db, show_id), user)}


@router.patch("/api/admin/shows/{show_id}/standard")
def update_show_standard(
    show_id: int,
    payload: ShowStandardPayload,
    _: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """将整个放映版本系列标记为或取消为标准放映。"""
    row = _show_row(db, show_id)
    db.execute(
        "UPDATE shows SET is_standard = ?, updated_at = ? WHERE series_id = ?",
        (1 if payload.standard else 0, now_iso(), row["series_id"]),
    )
    db.commit()
    maintain_archives(db)
    return {"ok": True, "standard": bool(payload.standard), "series_id": row["series_id"]}


@router.delete("/api/shows/{show_id}")
def delete_show(
    show_id: int,
    scope: str = Query("latest"),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """删除放映。

    scope=latest：仅删除系列中的最新版本（默认，保留原有单行删除行为）；
    scope=all：删除整个放映系列的所有版本。
    """
    row = _show_row(db, show_id)
    if not can_manage_show(db, row, user):
        raise HTTPException(403, "无管理权限")
    if scope not in {"latest", "all"}:
        raise HTTPException(400, "删除范围不正确")
    series_id = row["series_id"]
    if scope == "all":
        target_rows = db.execute(
            "SELECT * FROM shows WHERE series_id = ?", (series_id,)
        ).fetchall()
    else:
        latest_row = db.execute(
            "SELECT * FROM shows WHERE series_id = ?"
            " ORDER BY COALESCE(version_no, 0) DESC, id DESC LIMIT 1",
            (series_id,),
        ).fetchone()
        target_rows = [latest_row] if latest_row is not None else [row]
    for target in target_rows:
        if not can_manage_show(db, target, user):
            raise HTTPException(403, "对部分版本无管理权限，无法删除")
    for target in target_rows:
        db.execute("DELETE FROM shows WHERE id = ?", (int(target["id"]),))
    db.commit()
    maintain_archives(db)
    return {"ok": True, "scope": scope, "deleted": len(target_rows)}


@router.patch("/api/shows/{show_id}/resources/{resource_id}/hidden")
def update_show_resource_hidden(
    show_id: int,
    resource_id: int,
    payload: ShowResourceHiddenPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    row = _show_row(db, show_id)
    if not can_manage_show(db, row, user):
        raise HTTPException(403, "无管理权限")
    sr = db.execute(
        "SELECT 1 FROM show_resources WHERE show_id = ? AND resource_id = ?",
        (show_id, resource_id),
    ).fetchone()
    if sr is None:
        raise HTTPException(404, "放映中未找到该资源")
    db.execute(
        "UPDATE show_resources SET is_hidden = ? WHERE show_id = ? AND resource_id = ?",
        (1 if payload.hidden else 0, show_id, resource_id),
    )
    db.commit()
    maintain_archives(db)
    return {"ok": True}


@router.put("/api/shows/{show_id}/resources")
def update_show_resources(
    show_id: int,
    payload: ShowResourcesPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    row = _show_row(db, show_id)
    if not can_manage_show(db, row, user):
        raise HTTPException(403, "无管理权限")
    existing = {
        int(r["resource_id"]): int(r["version_no"])
        for r in db.execute("SELECT resource_id, version_no FROM show_resources WHERE show_id = ?", (show_id,)).fetchall()
    }
    existing_hidden = {
        int(r["resource_id"]): int(r["is_hidden"])
        for r in db.execute("SELECT resource_id, is_hidden FROM show_resources WHERE show_id = ?", (show_id,)).fetchall()
    }
    for rid in set(payload.resource_ids) - existing.keys():
        if not can_view_resource(db, _resource_row(db, rid), user):
            raise HTTPException(403, "部分新增素材不可访问，请重新选择")
    removed_ids = existing.keys() - set(payload.resource_ids)
    if removed_ids:
        marks = ','.join('?' for _ in removed_ids)
        db.execute(
            f"DELETE FROM show_remarks WHERE show_id = ? AND resource_id IN ({marks})",
            [show_id, *removed_ids],
        )
    db.execute("DELETE FROM show_resources WHERE show_id = ?", (show_id,))
    for index, rid in enumerate(payload.resource_ids):
        version_no = existing.get(rid)
        if version_no is None:
            res_row = db.execute("SELECT current_version FROM resources WHERE id = ?", (rid,)).fetchone()
            version_no = int(res_row["current_version"]) if res_row else 1
        is_hidden = existing_hidden.get(rid, 0)
        db.execute(
            "INSERT OR IGNORE INTO show_resources (show_id, resource_id, version_no, sort_order, is_hidden) VALUES (?, ?, ?, ?, ?)",
            (show_id, rid, version_no, index, is_hidden),
        )
    db.execute("UPDATE shows SET updated_by = ?, updated_at = ? WHERE id = ?", (user["id"], now_iso(), show_id))
    db.commit()
    maintain_archives(db)
    return {"show": _serialize_show(db, _show_row(db, show_id), user)}


@router.post("/api/shows/{show_id}/resources/append")
def append_show_resource(
    show_id: int,
    payload: ShowResourceAppendPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    row = _show_row(db, show_id)
    if not can_manage_show(db, row, user):
        raise HTTPException(403, "无管理权限")
    if not can_view_resource(db, _resource_row(db, payload.resource_id), user):
        raise HTTPException(403, "该素材不可访问，请重新选择")
    max_order_row = db.execute(
        "SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM show_resources WHERE show_id = ?",
        (show_id,),
    ).fetchone()
    max_order = int(max_order_row["max_order"]) if max_order_row is not None else -1
    res_row = db.execute(
        "SELECT current_version FROM resources WHERE id = ?", (payload.resource_id,)
    ).fetchone()
    version_no = int(res_row["current_version"]) if res_row else 1
    cursor = db.execute(
        "INSERT OR IGNORE INTO show_resources (show_id, resource_id, version_no, sort_order, is_hidden) VALUES (?, ?, ?, ?, 0)",
        (show_id, payload.resource_id, version_no, max_order + 1),
    )
    added = cursor.rowcount > 0
    if added:
        db.execute(
            "UPDATE shows SET updated_by = ?, updated_at = ? WHERE id = ?",
            (user["id"], now_iso(), show_id),
        )
    db.commit()
    maintain_archives(db)
    return {"show": _serialize_show(db, _show_row(db, show_id), user), "added": added}


@router.post("/api/shows/{show_id}/duplicate")
def duplicate_show(
    show_id: int,
    payload: ShowDuplicatePayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    if not db.in_transaction:
        db.execute("BEGIN IMMEDIATE")
    row = _show_row(db, show_id)
    if not can_view_show(db, row, user):
        raise HTTPException(403, "无可见权限")
    ts = now_iso()
    new_series_id = uuid.uuid4().hex[:10]
    db.execute(
        """
        INSERT INTO shows (name, owner_id, subject, tags, status, visibility_scope, management_scope, is_standard, series_id, version_no, change_note, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (payload.name, user["id"], row["subject"], row["tags"], row["status"], row["visibility_scope"], row["management_scope"], 0, new_series_id, 1, "", user["id"], ts, ts),
    )
    new_show_id = int(db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
    set_entity_tags(
        db,
        relation_table="show_tags",
        entity_column="show_id",
        entity_id=new_show_id,
        names=entity_tag_names(
            db,
            relation_table="show_tags",
            entity_column="show_id",
            entity_id=int(show_id),
            fallback=row["tags"] or "",
        ),
        cache_table="shows",
        created_by=int(user["id"]),
    )
    visible_ids = _show_scope_user_ids(db, "show_visibility", show_id)
    manage_ids = _show_scope_user_ids(db, "show_management", show_id)
    manage_tags = _show_scope_tag_names(db, show_id, "show_management_tags")
    _set_show_scope_users(db, "show_visibility", new_show_id, visible_ids)
    _set_show_scope_tags(db, new_show_id, _show_scope_tag_names(db, show_id))
    _set_show_scope_users(db, "show_management", new_show_id, manage_ids)
    _set_show_scope_tags(db, new_show_id, manage_tags, "show_management_tags")
    resource_rows = db.execute(
        "SELECT resource_id, version_no, sort_order, is_hidden FROM show_resources WHERE show_id = ? ORDER BY sort_order",
        (show_id,),
    ).fetchall()
    for sr in resource_rows:
        db.execute(
            "INSERT OR IGNORE INTO show_resources (show_id, resource_id, version_no, sort_order, is_hidden) VALUES (?, ?, ?, ?, ?)",
            (new_show_id, sr["resource_id"], sr["version_no"], sr["sort_order"], sr["is_hidden"]),
        )
    db.commit()
    maintain_archives(db)
    return {"show": _serialize_show(db, _show_row(db, new_show_id), user)}


@router.post("/api/shows/{show_id}/cleanup-missing-resources")
def cleanup_show_missing_resources(
    show_id: int,
    payload: MissingResourceCleanupPayload,
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    return cleanup_missing_resources(db, show_id, user, preview=payload.preview, token=payload.confirmation_token)
