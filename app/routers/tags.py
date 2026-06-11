"""
标签管理路由模块
处理管理员预设标签的 CRUD 操作及标签配置
"""
from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.config import reload_settings, settings, write_properties
from app.core.permissions import require_admin, require_user
from app.db import now_iso
from app.routers.dependencies import db_dep


router = APIRouter()


# ==================== Pydantic 模型 ====================

class TagsCreatePayload(BaseModel):
    tags: list[str]


class TagUpdatePayload(BaseModel):
    name: str


class TagsConfigPayload(BaseModel):
    user_custom_tags: bool


# ==================== 工具函数 ====================

def split_tag_name(name: str) -> tuple[str, str]:
    """按首个 '-' 拆分为 (category, label)"""
    if '-' in name:
        cat, lab = name.split('-', 1)
        cat, lab = cat.strip(), lab.strip()
        if cat and lab:
            return cat, lab
    return '未分类', name.strip()


def _serialize_tag(row: sqlite3.Row) -> dict[str, Any]:
    """序列化标签数据"""
    return {
        "id": row["id"],
        "name": row["name"],
        "category": row["category"],
        "label": row["label"],
        "sort_order": row["sort_order"],
        "created_at": row["created_at"],
    }


def _count_tag_usage(db: sqlite3.Connection, tag_name: str) -> int:
    """统计标签在 resources 和 shows 表 CSV 字段中的使用次数"""
    pattern = f"%,{tag_name},%"
    count_resources = db.execute(
        "SELECT COUNT(*) FROM resources WHERE (',' || COALESCE(tags, '') || ',') LIKE :pattern",
        {"pattern": pattern},
    ).fetchone()[0]
    count_shows = db.execute(
        "SELECT COUNT(*) FROM shows WHERE (',' || COALESCE(tags, '') || ',') LIKE :pattern",
        {"pattern": pattern},
    ).fetchone()[0]
    return int(count_resources) + int(count_shows)


# ==================== 路由 ====================

@router.get("/tags")
def list_tags(
    _: Any = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """获取所有预设标签，按 category 分组（任意登录用户可调用）"""
    rows = db.execute(
        "SELECT id, name, category, label, sort_order FROM tags ORDER BY sort_order, id"
    ).fetchall()

    # 按 category 分组，记录每组的首个 sort_order 用于排序
    groups_map: dict[str, dict[str, Any]] = {}
    for row in rows:
        cat = row["category"]
        if cat not in groups_map:
            groups_map[cat] = {
                "category": cat,
                "first_sort": row["sort_order"],
                "tags": [],
            }
        groups_map[cat]["tags"].append({
            "id": row["id"],
            "name": row["name"],
            "label": row["label"],
            "sort_order": row["sort_order"],
        })

    # category 按首个标签的 sort_order 排序
    groups = sorted(groups_map.values(), key=lambda g: (g["first_sort"], g["category"]))
    # 移除辅助字段
    for g in groups:
        g.pop("first_sort", None)

    return {"groups": groups}


@router.get("/admin/tags")
def admin_list_tags(
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """管理员视图：返回所有预设标签 + 使用次数 + 当前用户自定义标签配置"""
    rows = db.execute(
        "SELECT id, name, category, label, sort_order, created_at FROM tags ORDER BY sort_order, id"
    ).fetchall()

    tags: list[dict[str, Any]] = []
    for row in rows:
        item = _serialize_tag(row)
        item["usage_count"] = _count_tag_usage(db, row["name"])
        tags.append(item)

    return {
        "tags": tags,
        "user_custom_tags": settings.user_custom_tags,
    }


@router.post("/admin/tags")
def admin_create_tags(
    payload: TagsCreatePayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """批量创建预设标签（管理员）"""
    created: list[dict[str, Any]] = []
    skipped: list[str] = []
    seen_in_payload: set[str] = set()

    # 取当前最大 sort_order 用于新增
    row = db.execute("SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM tags").fetchone()
    next_sort = int(row["max_sort"]) + 1

    created_at = now_iso()
    created_by = admin["id"]

    for raw_name in payload.tags:
        if not isinstance(raw_name, str):
            continue
        name = raw_name.strip()
        if not name:
            continue
        if name in seen_in_payload:
            continue
        seen_in_payload.add(name)

        # 检查是否已存在
        exists = db.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
        if exists is not None:
            skipped.append(name)
            continue

        category, label = split_tag_name(name)
        try:
            cur = db.execute(
                "INSERT INTO tags (name, category, label, sort_order, created_by, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (name, category, label, next_sort, created_by, created_at),
            )
        except sqlite3.IntegrityError:
            skipped.append(name)
            continue

        new_id = cur.lastrowid
        created.append({
            "id": new_id,
            "name": name,
            "category": category,
            "label": label,
            "sort_order": next_sort,
            "created_at": created_at,
        })
        next_sort += 1

    db.commit()
    return {"created": created, "skipped": skipped}


@router.put("/admin/tags/config")
def admin_update_tags_config(
    payload: TagsConfigPayload,
    _: Any = Depends(require_admin),
) -> dict[str, Any]:
    """更新 user_custom_tags 配置项（管理员），写入 properties 并热加载"""
    new_value = bool(payload.user_custom_tags)
    write_properties({"app.user_custom_tags": "true" if new_value else "false"})
    reload_settings()
    return {"user_custom_tags": settings.user_custom_tags}


@router.put("/admin/tags/{tag_id}")
def admin_update_tag(
    tag_id: int,
    payload: TagUpdatePayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """修改标签 name，自动重新拆分 category/label（管理员）"""
    new_name = payload.name.strip()
    if not new_name:
        raise HTTPException(400, "标签名称不能为空")

    row = db.execute(
        "SELECT id, name, category, label, sort_order, created_at FROM tags WHERE id = ?",
        (tag_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "标签不存在")

    # 检查冲突（排除自己）
    conflict = db.execute(
        "SELECT id FROM tags WHERE name = ? AND id != ?",
        (new_name, tag_id),
    ).fetchone()
    if conflict is not None:
        raise HTTPException(409, "标签名称已存在")

    category, label = split_tag_name(new_name)
    try:
        db.execute(
            "UPDATE tags SET name = ?, category = ?, label = ? WHERE id = ?",
            (new_name, category, label, tag_id),
        )
    except sqlite3.IntegrityError:
        raise HTTPException(409, "标签名称已存在")
    db.commit()

    updated = db.execute(
        "SELECT id, name, category, label, sort_order, created_at FROM tags WHERE id = ?",
        (tag_id,),
    ).fetchone()
    return _serialize_tag(updated)


@router.delete("/admin/tags/{tag_id}")
def admin_delete_tag(
    tag_id: int,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """删除预设标签（不影响 resources/shows 中已使用的 CSV 数据）"""
    row = db.execute("SELECT id FROM tags WHERE id = ?", (tag_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "标签不存在")
    db.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    db.commit()
    return {"ok": True}
