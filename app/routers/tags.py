"""
标签管理路由模块
处理管理员预设标签的 CRUD 操作及标签配置
"""
from __future__ import annotations

import sqlite3
import re
import unicodedata
from collections import Counter
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from app.config import reload_settings, settings, write_properties
from app.core.permissions import require_admin, require_user
from app.db import now_iso
from app.routers.dependencies import ApiPayload, db_dep, db_read_dep


router = APIRouter()


# ==================== Pydantic 模型 ====================

class TagsCreatePayload(ApiPayload):
    tags: list[str] = Field(..., min_length=1, max_length=1000)


class TagUpdatePayload(ApiPayload):
    name: str = Field(..., min_length=1, max_length=64)


class TagsConfigPayload(ApiPayload):
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


def _validate_tag_name(raw_name: str) -> str:
    name = raw_name.strip()
    if not name:
        raise HTTPException(400, "标签名称不能为空")
    if len(name) > 64:
        raise HTTPException(400, "标签名称不能超过 64 个字符")
    if any(unicodedata.category(char).startswith("C") for char in name):
        raise HTTPException(400, "标签名称不能包含控制字符")
    if re.search(r"[，,\s]", name):
        raise HTTPException(400, "标签名称不能包含逗号、空格或换行")
    return name


def _replace_csv_tag(value: str, old_name: str, new_name: str) -> str:
    tags = [item.strip() for item in re.split(r"[，,\s]+", value or "") if item.strip()]
    replaced: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        current = new_name if tag == old_name else tag
        if current and current not in seen:
            replaced.append(current)
            seen.add(current)
    return ",".join(replaced)


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


def _tag_usage_counts(db: sqlite3.Connection) -> Counter[str]:
    """Scan each tag-bearing table once instead of issuing N queries per tag."""
    counts: Counter[str] = Counter()
    for table in ("resources", "shows"):
        for row in db.execute(f"SELECT tags FROM {table} WHERE tags <> ''").fetchall():
            counts.update(set(_replace_csv_tag(row["tags"], "", "").split(",")) - {""})
    for row in db.execute(
        "SELECT tag_name, COUNT(*) AS usage_count FROM user_tags GROUP BY tag_name"
    ).fetchall():
        counts[row["tag_name"]] += int(row["usage_count"])
    return counts


# ==================== 路由 ====================

@router.get("/tags")
def list_tags(
    _: Any = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
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
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """管理员视图：返回所有预设标签 + 使用次数 + 当前用户自定义标签配置"""
    rows = db.execute(
        "SELECT id, name, category, label, sort_order, created_at FROM tags ORDER BY sort_order, id"
    ).fetchall()

    usage_counts = _tag_usage_counts(db)
    tags: list[dict[str, Any]] = []
    for row in rows:
        item = _serialize_tag(row)
        item["usage_count"] = usage_counts[row["name"]]
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
        try:
            name = _validate_tag_name(raw_name)
        except HTTPException as exc:
            raise HTTPException(400, f"标签「{raw_name}」不合法：{exc.detail}") from None
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
    new_name = _validate_tag_name(payload.name)

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
    old_name = row["name"]
    try:
        db.execute(
            "UPDATE tags SET name = ?, category = ?, label = ? WHERE id = ?",
            (new_name, category, label, tag_id),
        )
        if old_name != new_name:
            db.execute(
                "UPDATE OR IGNORE user_tags SET tag_name = ? WHERE tag_name = ?",
                (new_name, old_name),
            )
            db.execute("DELETE FROM user_tags WHERE tag_name = ?", (old_name,))
            for table in ("users", "resources", "shows"):
                rows = db.execute(f"SELECT id, tags FROM {table} WHERE tags <> ''").fetchall()
                for item in rows:
                    db.execute(
                        f"UPDATE {table} SET tags = ? WHERE id = ?",
                        (_replace_csv_tag(item["tags"], old_name, new_name), int(item["id"])),
                    )
    except sqlite3.IntegrityError:
        db.rollback()
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
    """删除预设定义；历史业务数据和用户标签文本保持不变。"""
    row = db.execute("SELECT id, name FROM tags WHERE id = ?", (tag_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "标签不存在")
    db.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    db.commit()
    return {"ok": True}
