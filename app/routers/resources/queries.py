"""Routers / resources / queries."""

from __future__ import annotations

from app.core.permissions import require_user
from app.routers.dependencies import (
    db_read_dep,
)
from app.services.common import (
    _reject_removed_query_params,
)
from app.services.resource_queries import (
    _build_resource_query_sql,
    _parse_csv,
)
from app.services.resources import (
    _serialize_resource_lite,
)
from app.services.files import asset_preview_url
from fastapi import APIRouter
from fastapi import Depends
from fastapi import Query
from fastapi import Request
from typing import Any
import sqlite3

router = APIRouter()


@router.get("/api/resources")
def list_resources(
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(30, ge=1, le=200),
    search: str = Query(""),
    tags: str = Query(""),
    tags_mode: str = Query("any"),
    subject: str = Query(""),
    status: str = Query("all"),
    secrecy: str = Query("all"),
    permission: str = Query("all"),
    remark_common: str = Query("all"),
    remark_personal: str = Query("all"),
    sort: str = Query("updated_desc"),
    manageable_only: bool = Query(False),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    _reject_removed_query_params(request, "tag", "resource_type")
    # SQL 级分页：可见性 + 筛选 + 排序全部下推到 SQL
    where_clause, order_sql, params = _build_resource_query_sql(
        user, manageable_only=manageable_only,
        search=search, tags=tags, tags_mode=tags_mode,
        subject=subject, status=status, secrecy=secrecy,
        permission=permission, remark_common=remark_common,
        remark_personal=remark_personal, sort=sort,
    )
    # 收集可见资源的标签/主体（用于前端筛选下拉）
    facet_rows = db.execute(
        f"SELECT r.tags, r.subject FROM resources r WHERE {where_clause}",
        params,
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
        f"SELECT COUNT(*) FROM resources r WHERE {where_clause}",
        params,
    ).fetchone()[0]
    # 分页取当前页
    offset = (page - 1) * page_size
    page_rows = db.execute(
        f"SELECT r.* FROM resources r WHERE {where_clause} ORDER BY {order_sql} LIMIT :lim OFFSET :off",
        {**params, "lim": page_size, "off": offset},
    ).fetchall()
    items = [_serialize_resource_lite(db, row, user) for row in page_rows]
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "all_tags": all_tags,
        "all_subjects": all_subjects,
    }


@router.get("/api/resources/ids")
def list_resource_ids(
    request: Request,
    search: str = Query(""),
    tags: str = Query(""),
    tags_mode: str = Query("any"),
    subject: str = Query(""),
    status: str = Query("all"),
    secrecy: str = Query("all"),
    permission: str = Query("all"),
    remark_common: str = Query("all"),
    remark_personal: str = Query("all"),
    sort: str = Query("updated_desc"),
    manageable_only: bool = Query(False),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """返回当前筛选条件下所有资源的 ID 列表（不含完整数据，用于全选）。

    复用 list_resources 的 SQL WHERE 构建逻辑，确保权限/可见性/筛选行为一致。
    """
    _reject_removed_query_params(request, "tag", "resource_type")
    where_clause, _, params = _build_resource_query_sql(
        user, manageable_only=manageable_only,
        search=search, tags=tags, tags_mode=tags_mode,
        subject=subject, status=status, secrecy=secrecy,
        permission=permission, remark_common=remark_common,
        remark_personal=remark_personal, sort=sort,
    )
    rows = db.execute(
        f"SELECT r.id FROM resources r WHERE {where_clause}", params,
    ).fetchall()
    return {"ids": [int(r["id"]) for r in rows]}


@router.get("/api/resources/pick")
def pick_resources(
    request: Request,
    page: int = Query(1, ge=1),
    page_size: int = Query(30, ge=1, le=100),
    search: str = Query(""),
    tags: str = Query(""),
    tags_mode: str = Query("any"),
    subject: str = Query(""),
    status: str = Query("active"),
    secrecy: str = Query("all"),
    permission: str = Query("all"),
    remark_common: str = Query("all"),
    remark_personal: str = Query("all"),
    sort: str = Query("updated_desc"),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """轻量级资源选择接口：SQL 级分页 + 多维筛选 + 排序，返回最小数据集"""
    _reject_removed_query_params(request, "tag", "resource_type")
    where_clause, order_sql, params = _build_resource_query_sql(
        user, search=search, tags=tags, tags_mode=tags_mode,
        subject=subject, status=status, secrecy=secrecy,
        permission=permission, remark_common=remark_common,
        remark_personal=remark_personal, sort=sort,
    )
    # 收集可见资源的标签/主体（用于前端筛选下拉）
    facet_rows = db.execute(
        f"SELECT r.tags, r.subject FROM resources r WHERE {where_clause}", params,
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
        f"SELECT COUNT(*) FROM resources r WHERE {where_clause}", params,
    ).fetchone()[0]
    # 分页取当前页
    offset = (page - 1) * page_size
    page_rows = db.execute(
        f"SELECT r.* FROM resources r WHERE {where_clause} ORDER BY {order_sql} LIMIT :lim OFFSET :off",
        {**params, "lim": page_size, "off": offset},
    ).fetchall()
    # 构造轻量结果
    items = []
    for row in page_rows:
        ver = db.execute(
            "SELECT id, png_path FROM resource_versions WHERE resource_id = ? AND version_no = ?",
            (row["id"], row["current_version"]),
        ).fetchone()
        preview_url = None
        if ver and ver["png_path"]:
            preview_url = asset_preview_url(ver["png_path"], thumb=True) or f"/api/resources/{row['id']}/preview-thumb?version_id={ver['id']}"
        items.append({
            "id": int(row["id"]),
            "name": row["name"],
            "tags": row["tags"],
            "subject": row["subject"] or "",
            "updated_at": row["updated_at"],
            "created_at": row["created_at"],
            "preview_url": preview_url,
        })
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "all_tags": all_tags,
        "all_subjects": all_subjects,
    }


@router.get("/api/resources/pick-ids")
def pick_resources_all_ids(
    request: Request,
    search: str = Query(""),
    tags: str = Query(""),
    tags_mode: str = Query("any"),
    subject: str = Query(""),
    status: str = Query("active"),
    secrecy: str = Query("all"),
    permission: str = Query("all"),
    remark_common: str = Query("all"),
    remark_personal: str = Query("all"),
    sort: str = Query("updated_desc"),
    user: sqlite3.Row = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """返回当前筛选条件下所有资源的 ID 列表（用于全部全选），SQL 级筛选"""
    _reject_removed_query_params(request, "tag", "resource_type")
    where_clause, _, params = _build_resource_query_sql(
        user, search=search, tags=tags, tags_mode=tags_mode,
        subject=subject, status=status, secrecy=secrecy,
        permission=permission, remark_common=remark_common,
        remark_personal=remark_personal, sort=sort,
    )
    rows = db.execute(
        f"SELECT r.id FROM resources r WHERE {where_clause}", params,
    ).fetchall()
    return {"ids": [int(r["id"]) for r in rows]}
