"""Services / resource queries."""

from __future__ import annotations

from app.core.permissions import is_system_admin
from typing import Any
import sqlite3


def _parse_csv(value: str) -> list[str]:
    """将逗号分隔（中英文逗号）的字符串解析为去重去空的列表，保持出现顺序"""
    if not value:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for piece in value.replace("，", ",").split(","):
        piece = piece.strip()
        if piece and piece not in seen:
            seen.add(piece)
            out.append(piece)
    return out


def _resource_visibility_sql(
    user: sqlite3.Row,
    alias: str = "r",
    manageable_only: bool = False,
) -> tuple[str, dict[str, Any]]:
    """构建资源可见性 + 可管理性 SQL WHERE 片段。

    将 Python 层的 can_view_resource / can_manage_resource 判定
    完全下推到 SQL，避免全表加载到内存。
    """
    uid = int(user["id"])
    params: dict[str, Any] = {"vis_uid": uid}

    if is_system_admin(user):
        cond = "1=1"
    else:
        cond = (
            f"({alias}.owner_id = :vis_uid"
            f" OR {alias}.visibility_scope = 'public'"
            f" OR ({alias}.visibility_scope = 'partial' AND {alias}.id IN"
            f" (SELECT resource_id FROM resource_visibility WHERE user_id = :vis_uid)))"
        )

    if manageable_only:
        params["mgmt_uid"] = uid
        if not is_system_admin(user):
            cond += (
                f" AND ({alias}.owner_id = :mgmt_uid"
                f" OR {alias}.management_scope = 'public'"
                f" OR ({alias}.management_scope = 'partial' AND {alias}.id IN"
                f" (SELECT resource_id FROM resource_management WHERE user_id = :mgmt_uid)))"
            )

    return cond, params


def _csv_tag_sql_match(
    column: str, tag: str, param_name: str
) -> tuple[str, dict[str, str]]:
    """CSV 存储的标签字段的 SQL 精确子串匹配。

    用 ',col,' LIKE '%,tag,%' 模式避免 'java' 误匹配 'javascript'。
    """
    return (
        f"(',' || COALESCE({column}, '') || ',') LIKE :{param_name}",
        {param_name: f"%,{tag},%"},
    )


def _build_resource_query_sql(
    user: sqlite3.Row,
    *,
    manageable_only: bool = False,
    search: str = "",
    tags: str = "",
    tags_mode: str = "any",
    subject: str = "",
    status: str = "all",
    secrecy: str = "all",
    permission: str = "all",
    remark_common: str = "all",
    remark_personal: str = "all",
    sort: str = "updated_desc",
) -> tuple[str, str, dict[str, Any]]:
    """构建资源列表 SQL WHERE 条件 + 排序。

    返回 (where_clause, order_sql, params_dict)。
    调用方自行拼接 SELECT / COUNT 语句。
    """
    vis_cond, params = _resource_visibility_sql(user, "r", manageable_only)

    where_parts = [vis_cond]

    # ── 标量筛选 ──
    if status and status != "all":
        where_parts.append("COALESCE(r.status, 'active') = :fl_status")
        params["fl_status"] = status
    if subject and subject != "all":
        where_parts.append("COALESCE(r.subject, '') = :fl_subject")
        params["fl_subject"] = subject
    if secrecy and secrecy != "all":
        where_parts.append("COALESCE(r.secrecy_level, '') = :fl_secrecy")
        params["fl_secrecy"] = secrecy

    # permission 筛选
    if permission == "created":
        where_parts.append("r.owner_id = :perm_uid")
        params["perm_uid"] = int(user["id"])
    elif permission == "managed":
        m_uid = int(user["id"])
        if not is_system_admin(user):
            where_parts.append(
                "(r.owner_id = :m_uid"
                " OR r.management_scope = 'public'"
                " OR (r.management_scope = 'partial' AND r.id IN"
                " (SELECT resource_id FROM resource_management WHERE user_id = :m_uid)))"
            )
            params["m_uid"] = m_uid

    # 搜索
    q = search.strip()
    if q:
        where_parts.append(
            "(LOWER(COALESCE(r.name, '')) LIKE :fl_q"
            " OR LOWER(COALESCE(r.subject, '')) LIKE :fl_q)"
        )
        params["fl_q"] = f"%{q.lower()}%"

    # 标签筛选
    tag_list = _parse_csv(tags)
    if tag_list:
        mode = (tags_mode or "any").lower()
        if mode == "all":
            for i, t in enumerate(tag_list):
                clause, tp = _csv_tag_sql_match("r.tags", t, f"tg{i}")
                where_parts.append(clause)
                params.update(tp)
        else:
            or_parts = []
            for i, t in enumerate(tag_list):
                clause, tp = _csv_tag_sql_match("r.tags", t, f"tg{i}")
                or_parts.append(clause)
                params.update(tp)
            where_parts.append(f"({' OR '.join(or_parts)})")

    # 通用备注筛选
    if remark_common == "has":
        where_parts.append(
            "EXISTS (SELECT 1 FROM resource_versions rv"
            " WHERE rv.resource_id = r.id AND rv.version_no = r.current_version"
            " AND rv.common_remark_html IS NOT NULL"
            " AND TRIM(REPLACE(REPLACE(rv.common_remark_html, '<', ' '), '>', ' ')) != '')"
        )
    elif remark_common == "none":
        where_parts.append(
            "NOT EXISTS (SELECT 1 FROM resource_versions rv"
            " WHERE rv.resource_id = r.id AND rv.version_no = r.current_version"
            " AND rv.common_remark_html IS NOT NULL"
            " AND TRIM(REPLACE(REPLACE(rv.common_remark_html, '<', ' '), '>', ' ')) != '')"
        )

    # 个人备注筛选
    if remark_personal == "has":
        where_parts.append(
            "EXISTS (SELECT 1 FROM personal_remarks pr"
            " WHERE pr.resource_id = r.id AND pr.user_id = :pr_uid"
            " AND TRIM(REPLACE(REPLACE(pr.content_html, '<', ' '), '>', ' ')) != '')"
        )
        params["pr_uid"] = int(user["id"])
    elif remark_personal == "none":
        where_parts.append(
            "NOT EXISTS (SELECT 1 FROM personal_remarks pr"
            " WHERE pr.resource_id = r.id AND pr.user_id = :pr_uid"
            " AND TRIM(REPLACE(REPLACE(pr.content_html, '<', ' '), '>', ' ')) != '')"
        )
        params["pr_uid"] = int(user["id"])

    where_clause = " AND ".join(where_parts)

    # 排序
    sort_key = sort if sort in _PICK_SORT_KEYS else "updated_desc"
    if sort_key.startswith("name"):
        order = "LOWER(COALESCE(r.name, ''))"
        order += " DESC" if sort_key.endswith("_desc") else " ASC"
    elif sort_key.startswith("created"):
        order = "COALESCE(r.created_at, '') DESC, r.id DESC" if sort_key.endswith("_desc") else "COALESCE(r.created_at, '') ASC, r.id ASC"
    else:
        order = "COALESCE(r.updated_at, '') DESC, r.id DESC" if sort_key.endswith("_desc") else "COALESCE(r.updated_at, '') ASC, r.id ASC"

    return where_clause, order, params


_PICK_SORT_KEYS = {
    "updated_desc",
    "updated_asc",
    "created_desc",
    "created_asc",
    "name_desc",
    "name_asc",
}
