"""
用户管理路由模块
处理管理员对用户的 CRUD 操作
"""
import sqlite3
import secrets
import re
import json
import io
import mimetypes
import tempfile
import unicodedata
from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from PIL import Image, ImageOps, UnidentifiedImageError

from app.core.permissions import (
    ADMIN_ROLES,
    ROLE_OPERATIONS_ADMIN,
    ROLE_SYSTEM_ADMIN,
    ROLE_USER,
    require_admin,
    require_user,
    is_system_admin,
)
from app.core.security import hash_password, password_policy_error
from app.core.cache import invalidate_user
from app.core.user_profiles import (
    delete_managed_avatar,
    is_managed_avatar_ref,
    normalise_display_name,
    normalise_feishu_id,
    normalise_username,
    username_lookup_key,
    validate_avatar_url,
)
from app.core.oss import asset_url as oss_asset_url, is_oss_ref
from app.config import settings
from app.services.files import _safe_abs, persist_asset
from app.db import now_iso
from app.routers.dependencies import (
    UserPayload,
    UserDeletePayload,
    UserTransferDeletePayload,
    db_dep,
    db_read_dep,
    _serialize_user,
    _serialize_user_option,
)


router = APIRouter()
TEMPORARY_PASSWORD_TTL_HOURS = 24
USER_LIST_MAX_PAGE_SIZE = 100
USER_OPTIONS_MAX_LIMIT = 500
USER_BULK_DELETE_MAX = 1000
SQLITE_ID_CHUNK_SIZE = 500
USER_AVATAR_MAX_BYTES = 2 * 1024 * 1024
USER_AVATAR_MAX_PIXELS = 16_000_000
USER_SELECT_COLUMNS = (
    "id, name, username, role, feishu_id, avatar_url, tags, must_change_pwd, "
    "temporary_password_expires_at, last_login_at, created_at, updated_at"
)


def _temporary_password_expiry() -> str:
    return (datetime.utcnow() + timedelta(hours=TEMPORARY_PASSWORD_TTL_HOURS)).isoformat(timespec="seconds") + "Z"


def _activity_cutoffs(now: datetime | None = None) -> tuple[str, str]:
    """Return UTC cutoffs for the local calendar week and local calendar day."""
    local_now = now or datetime.now().astimezone()
    if local_now.tzinfo is None:
        local_now = local_now.astimezone()
    today_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=today_start.weekday())

    def as_utc_iso(value: datetime) -> str:
        return value.astimezone(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds") + "Z"

    return as_utc_iso(week_start), as_utc_iso(today_start)


def _normalise_user_tags(value: str) -> str:
    """Store user labels as a compact, deterministic comma-separated value."""
    tags: list[str] = []
    seen: set[str] = set()
    for item in re.split(r"[，,\s]+", value or ""):
        tag = item.strip()
        if tag and tag not in seen:
            if len(tag) > 64:
                raise HTTPException(400, "单个用户标签不能超过 64 个字符")
            if any(unicodedata.category(char).startswith("C") for char in tag):
                raise HTTPException(400, "用户标签不能包含控制字符")
            tags.append(tag)
            seen.add(tag)
    result = ",".join(tags)
    if len(result) > 1000:
        raise HTTPException(400, "用户标签总长度不能超过 1000 个字符")
    return result


def _normalised_username(value: str) -> str:
    try:
        return normalise_username(value)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


def _normalised_display_name(value: str) -> str:
    try:
        return normalise_display_name(value)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


def _normalised_feishu_id(value: str) -> str:
    try:
        return normalise_feishu_id(value)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


def _validated_avatar_url(value: str) -> str:
    try:
        return validate_avatar_url(value)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


def _validated_avatar_update(existing_ref: str, public_value: str, user_id: int) -> str:
    """Preserve a managed avatar when clients round-trip its public API URL."""
    value = (public_value or "").strip()
    if value == existing_ref:
        if is_managed_avatar_ref(existing_ref, user_id=user_id):
            return existing_ref
        return _validated_avatar_url(value)
    if (
        value.partition("?")[0] == f"/api/users/{user_id}/avatar"
        and is_managed_avatar_ref(existing_ref, user_id=user_id)
    ):
        return existing_ref
    return _validated_avatar_url(value)


def _validated_user_tags(
    db: sqlite3.Connection,
    value: str,
    *,
    existing_value: str = "",
) -> str:
    normalised = _normalise_user_tags(value)
    tags = [tag for tag in normalised.split(",") if tag]
    if settings.user_custom_user_tags and tags:
        next_sort = int(
            db.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM user_tag_definitions"
            ).fetchone()[0]
        )
        for tag in tags:
            if db.execute("SELECT 1 FROM user_tag_definitions WHERE name = ?", (tag,)).fetchone():
                continue
            if "-" in tag:
                category, label = (part.strip() for part in tag.split("-", 1))
                if not category or not label:
                    category, label = "未分类", tag
            else:
                category, label = "未分类", tag
            db.execute(
                "INSERT OR IGNORE INTO user_tag_definitions "
                "(name, category, label, sort_order, created_by, created_at) "
                "VALUES (?, ?, ?, ?, NULL, ?)",
                (tag, category, label, next_sort, now_iso()),
            )
            next_sort += 1
        return normalised
    if tags:
        placeholders = ",".join("?" for _ in tags)
        existing = {
            row["name"]
            for row in db.execute(
                f"SELECT name FROM user_tag_definitions WHERE name IN ({placeholders})",
                tags,
            ).fetchall()
        }
        historical = set(_normalise_user_tags(existing_value).split(",")) - {""}
        missing = [tag for tag in tags if tag not in existing and tag not in historical]
        if missing:
            raise HTTPException(400, f"以下标签不是已定义的用户标签：{'、'.join(missing[:5])}")
    return normalised


def _sync_user_tags(db: sqlite3.Connection, user_id: int, tags_value: str) -> None:
    db.execute("DELETE FROM user_tags WHERE user_id = ?", (user_id,))
    tags = [tag for tag in tags_value.split(",") if tag]
    db.executemany(
        "INSERT INTO user_tags (user_id, tag_name) VALUES (?, ?)",
        [(user_id, tag) for tag in tags],
    )


def _audit_admin_action(
    db: sqlite3.Connection,
    admin: sqlite3.Row | dict[str, Any],
    action: str,
    *,
    target_user_id: int | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    db.execute(
        """
        INSERT INTO admin_audit_events
            (actor_user_id, subject_user_id, action, details, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            int(admin["id"]),
            target_user_id,
            action,
            json.dumps(details or {}, ensure_ascii=False, separators=(",", ":")),
            now_iso(),
        ),
    )


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _id_chunks(values: list[int]) -> list[list[int]]:
    return [
        values[index:index + SQLITE_ID_CHUNK_SIZE]
        for index in range(0, len(values), SQLITE_ID_CHUNK_SIZE)
    ]


def _user_filter_clause(
    *,
    search: str,
    tag: str,
    tags: str,
    tags_mode: str,
) -> tuple[list[str], list[Any]]:
    """Build the shared search/tag filters for list and bulk selection APIs."""
    tag_values = (
        [item for item in _normalise_user_tags(tags).split(",") if item]
        if tags.strip()
        else ([tag.strip()] if tag.strip() else [])
    )
    search_filter = search.strip()
    where: list[str] = []
    params: list[Any] = []
    if tag_values:
        if tags_mode.strip().lower() == "all":
            for tag_value in tag_values:
                where.append(
                    "EXISTS (SELECT 1 FROM user_tags ut "
                    "WHERE ut.user_id = users.id AND ut.tag_name = ?)"
                )
                params.append(tag_value)
        else:
            placeholders = ", ".join("?" for _ in tag_values)
            where.append(
                "EXISTS (SELECT 1 FROM user_tags ut WHERE ut.user_id = users.id "
                f"AND ut.tag_name IN ({placeholders}))"
            )
            params.extend(tag_values)
    if search_filter:
        pattern = f"%{_escape_like(search_filter)}%"
        where.append(
            "(name LIKE ? ESCAPE '\\' COLLATE NOCASE "
            "OR username LIKE ? ESCAPE '\\' COLLATE NOCASE "
            "OR EXISTS (SELECT 1 FROM user_tags sut WHERE sut.user_id = users.id "
            "AND sut.tag_name LIKE ? ESCAPE '\\' COLLATE NOCASE))"
        )
        params.extend([pattern, pattern, pattern])
    return where, params


@router.get("/admin/users")
def list_users(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=USER_LIST_MAX_PAGE_SIZE),
    search: str = Query("", max_length=100),
    tag: str = Query("", max_length=64),
    tags: str = Query("", max_length=1000),
    tags_mode: str = Query("any", max_length=8),
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """获取管理员用户列表，支持服务端筛选和分页。"""
    # Keep the legacy single-tag parameter working while allowing the UI to
    # submit a comma-separated set with explicit any/all matching semantics.
    where, params = _user_filter_clause(
        search=search,
        tag=tag,
        tags=tags,
        tags_mode=tags_mode,
    )

    where_sql = f" WHERE {' AND '.join(where)}" if where else ""
    total = int(
        db.execute(f"SELECT COUNT(*) FROM users{where_sql}", params).fetchone()[0]
    )
    offset = (page - 1) * page_size
    rows = db.execute(
        f"SELECT {USER_SELECT_COLUMNS} FROM users{where_sql} "
        "ORDER BY id DESC LIMIT ? OFFSET ?",
        [*params, page_size, offset],
    ).fetchall()
    week_start, today_start = _activity_cutoffs()
    stats_row = db.execute(
        """
        SELECT
            COUNT(*) AS total_users,
            COALESCE(SUM(CASE WHEN last_login_at >= ? THEN 1 ELSE 0 END), 0) AS active_week,
            COALESCE(SUM(CASE WHEN last_login_at >= ? THEN 1 ELSE 0 END), 0) AS active_today
        FROM users
        """,
        (week_start, today_start),
    ).fetchone()

    available_tags = [
        row["name"]
        for row in db.execute(
            """
            SELECT name FROM (
                SELECT name, sort_order, id, 0 AS source_order FROM user_tag_definitions
                UNION ALL
                SELECT DISTINCT tag_name AS name, 2147483647, 2147483647, 1 FROM user_tags
            )
            GROUP BY name
            ORDER BY MIN(source_order), MIN(sort_order), MIN(id), name
            """
        ).fetchall()
        if row["name"]
    ]

    return {
        "users": [_serialize_user(row) for row in rows],
        "available_tags": available_tags,
        "page": page,
        "page_size": page_size,
        "total": total,
        "stats": {
            "total_users": int(stats_row["total_users"]),
            "active_week": int(stats_row["active_week"]),
            "active_today": int(stats_row["active_today"]),
        },
    }


@router.get("/admin/users/selection-ids")
def list_user_selection_ids(
    search: str = Query("", max_length=100),
    tag: str = Query("", max_length=64),
    tags: str = Query("", max_length=1000),
    tags_mode: str = Query("any", max_length=8),
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """Return every currently filtered user that the administrator may delete."""
    where, params = _user_filter_clause(
        search=search,
        tag=tag,
        tags=tags,
        tags_mode=tags_mode,
    )
    where.append("users.id != ?")
    params.append(int(admin["id"]))
    if not is_system_admin(admin):
        where.append("users.role != ?")
        params.append(ROLE_SYSTEM_ADMIN)

    where_sql = f" WHERE {' AND '.join(where)}"
    rows = db.execute(
        f"SELECT id FROM users{where_sql} ORDER BY id DESC LIMIT ?",
        [*params, USER_BULK_DELETE_MAX + 1],
    ).fetchall()
    if len(rows) > USER_BULK_DELETE_MAX:
        raise HTTPException(
            400,
            f"筛选结果超过 {USER_BULK_DELETE_MAX} 个可批量操作用户，请缩小筛选范围",
        )
    user_ids = [int(row["id"]) for row in rows]
    return {"user_ids": user_ids, "total": len(user_ids)}


@router.get("/users/options")
def user_options(
    search: str = Query("", max_length=100),
    tag: str = Query("", max_length=64),
    limit: int = Query(50, ge=0, le=USER_OPTIONS_MAX_LIMIT),
    ids: str = Query("", max_length=2000),
    _: Any = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """获取有上限的用户选项，用于异步搜索和按用户标签选择。"""
    # Scope pickers only need display identity; do not attach roles, Feishu IDs,
    # or each user's full label list. The optional tag filter returns identities
    # for one selected definition without broadening the response fields.
    selected_ids: list[int] = []
    for raw in ids.split(","):
        raw = raw.strip()
        if not raw:
            continue
        try:
            value = int(raw)
        except ValueError:
            raise HTTPException(400, "用户 ID 参数格式不正确") from None
        if value > 0 and value not in selected_ids:
            selected_ids.append(value)
    if len(selected_ids) > USER_OPTIONS_MAX_LIMIT:
        raise HTTPException(400, f"一次最多读取 {USER_OPTIONS_MAX_LIMIT} 个指定用户")

    where: list[str] = []
    params: list[Any] = []
    search_filter = search.strip()
    tag_filter = tag.strip()
    if tag_filter:
        if db.execute(
            "SELECT 1 FROM user_tag_definitions WHERE name = ?",
            (tag_filter,),
        ).fetchone() is None:
            return {"users": [], "total": 0}
        where.append(
            "EXISTS (SELECT 1 FROM user_tags ut "
            "WHERE ut.user_id = users.id AND ut.tag_name = ?)"
        )
        params.append(tag_filter)
    if search_filter:
        pattern = f"%{_escape_like(search_filter)}%"
        where.append(
            "(name LIKE ? ESCAPE '\\' COLLATE NOCASE "
            "OR username LIKE ? ESCAPE '\\' COLLATE NOCASE)"
        )
        params.extend([pattern, pattern])
    where_sql = f" WHERE {' AND '.join(where)}" if where else ""
    total = int(db.execute(f"SELECT COUNT(*) FROM users{where_sql}", params).fetchone()[0])
    rows = list(db.execute(
        "SELECT id, name, username, avatar_url FROM users"
        f"{where_sql} ORDER BY name COLLATE NOCASE, id LIMIT ?",
        [*params, limit],
    ).fetchall())
    if selected_ids:
        placeholders = ",".join("?" for _ in selected_ids)
        selected_rows = db.execute(
            "SELECT id, name, username, avatar_url FROM users "
            f"WHERE id IN ({placeholders})",
            selected_ids,
        ).fetchall()
        by_id = {int(row["id"]): row for row in rows}
        for row in selected_rows:
            by_id[int(row["id"])] = row
        rows = sorted(by_id.values(), key=lambda row: ((row["name"] or "").casefold(), int(row["id"])))
    return {"users": [_serialize_user_option(row) for row in rows], "total": total}


@router.get("/users/{user_id}/avatar")
def user_avatar(
    user_id: int,
    _: Any = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
):
    row = db.execute("SELECT avatar_url FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None or not row["avatar_url"]:
        raise HTTPException(404, "头像不存在")
    avatar_ref = row["avatar_url"]
    if not is_managed_avatar_ref(avatar_ref, user_id=user_id):
        raise HTTPException(404, "头像不存在")
    if is_oss_ref(avatar_ref):
        url = oss_asset_url(avatar_ref)
        if not url:
            raise HTTPException(404, "头像不存在")
        return RedirectResponse(
            url,
            status_code=307,
            headers={"Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer"},
        )
    path = _safe_abs(avatar_ref)
    if path is None or not path.is_file():
        raise HTTPException(404, "头像不存在")
    media_type = mimetypes.guess_type(Path(path).name)[0] or "application/octet-stream"
    return FileResponse(
        path,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=31536000, immutable", "Referrer-Policy": "no-referrer"},
    )


@router.post("/admin/users/{user_id}/avatar")
async def upload_user_avatar(
    user_id: int,
    avatar: UploadFile = File(...),
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    existing = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if existing is None:
        raise HTTPException(404, "用户不存在")
    if existing["role"] == ROLE_SYSTEM_ADMIN and not is_system_admin(admin):
        raise HTTPException(403, "只有系统管理员能修改系统管理员账号")

    content = await avatar.read(USER_AVATAR_MAX_BYTES + 1)
    if not content:
        raise HTTPException(400, "头像文件为空")
    if len(content) > USER_AVATAR_MAX_BYTES:
        raise HTTPException(413, "头像文件不能超过 2 MB")

    stored_ref = ""
    try:
        with tempfile.TemporaryDirectory(prefix="slide-flow-avatar-") as temp_dir:
            try:
                with Image.open(io.BytesIO(content)) as uploaded_image:
                    if uploaded_image.format not in {"PNG", "JPEG", "WEBP"}:
                        raise HTTPException(400, "头像仅支持 PNG、JPG 或 WebP 图片")
                    if uploaded_image.width * uploaded_image.height > USER_AVATAR_MAX_PIXELS:
                        raise HTTPException(400, "头像分辨率过大")
                    uploaded_image.load()
                    image = ImageOps.exif_transpose(uploaded_image)
                    if image.width * image.height > USER_AVATAR_MAX_PIXELS:
                        raise HTTPException(400, "头像分辨率过大")
                    image.thumbnail((512, 512), Image.Resampling.LANCZOS)
                    has_alpha = "A" in image.getbands() or "transparency" in image.info
                    if image.mode not in {"RGB", "RGBA"}:
                        image = image.convert("RGBA" if has_alpha else "RGB")
                    output = Path(temp_dir) / "avatar.png"
                    image.save(output, format="PNG", optimize=True)
            except (Image.DecompressionBombError, UnidentifiedImageError, OSError, ValueError):
                raise HTTPException(400, "头像文件不是有效图片") from None
            stored_ref = persist_asset(output, f"avatars/{user_id}")

        old_ref = existing["avatar_url"] or ""
        try:
            db.execute(
                "UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?",
                (stored_ref, now_iso(), user_id),
            )
            _audit_admin_action(db, admin, "user.avatar_upload", target_user_id=user_id)
            db.commit()
        except Exception:
            db.rollback()
            raise
        if old_ref != stored_ref:
            delete_managed_avatar(old_ref, user_id=user_id)
    except HTTPException:
        if stored_ref:
            delete_managed_avatar(stored_ref, user_id=user_id)
        raise
    except Exception:
        db.rollback()
        if stored_ref:
            delete_managed_avatar(stored_ref, user_id=user_id)
        raise

    invalidate_user(user_id)
    updated = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return {"user": _serialize_user(updated)}


@router.delete("/admin/users/{user_id}/avatar")
def delete_user_avatar(
    user_id: int,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    existing = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if existing is None:
        raise HTTPException(404, "用户不存在")
    if existing["role"] == ROLE_SYSTEM_ADMIN and not is_system_admin(admin):
        raise HTTPException(403, "只有系统管理员能修改系统管理员账号")
    old_ref = existing["avatar_url"] or ""
    try:
        db.execute(
            "UPDATE users SET avatar_url = '', updated_at = ? WHERE id = ?",
            (now_iso(), user_id),
        )
        _audit_admin_action(db, admin, "user.avatar_delete", target_user_id=user_id)
        db.commit()
    except Exception:
        db.rollback()
        raise
    delete_managed_avatar(old_ref, user_id=user_id)
    invalidate_user(user_id)
    updated = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return {"user": _serialize_user(updated)}


@router.post("/admin/users")
def create_user(
    payload: UserPayload,
    response: Response,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """创建新用户（运营管理员或系统管理员）"""
    name = _normalised_display_name(payload.name)
    username = _normalised_username(payload.username)
    feishu_id = _normalised_feishu_id(payload.feishu_id)
    if payload.role not in {ROLE_SYSTEM_ADMIN, ROLE_OPERATIONS_ADMIN, ROLE_USER}:
        raise HTTPException(400, "角色不正确")
    if payload.role == ROLE_SYSTEM_ADMIN and not is_system_admin(admin):
        raise HTTPException(403, "只有系统管理员能创建系统管理员")

    if payload.password:
        policy_error = password_policy_error(payload.password, username=username)
        if policy_error:
            raise HTTPException(400, policy_error)
    avatar_url = _validated_avatar_url(payload.avatar_url)
    tags = _validated_user_tags(db, payload.tags)

    # 不再使用全局共享默认密码。未指定时生成只展示一次的临时密码；
    # 管理员手工设置的密码同样视为临时密码，用户首次登录必须自行修改。
    must_change_pwd = 1
    plain_password: str | None = None
    if not payload.password:
        password = secrets.token_urlsafe(16)
        plain_password = password
    else:
        password = payload.password
    
    ts = now_iso()
    try:
        db.execute(
            """
            INSERT INTO users (
                name, username, username_key, password_hash, feishu_id, avatar_url, tags, role,
                must_change_pwd, temporary_password_expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                name,
                username,
                username_lookup_key(username),
                hash_password(password),
                feishu_id,
                avatar_url,
                tags,
                payload.role,
                must_change_pwd,
                _temporary_password_expiry(),
                ts,
                ts,
            ),
        )
        user_id = int(db.execute("SELECT last_insert_rowid()").fetchone()[0])
        _sync_user_tags(db, user_id, tags)
        _audit_admin_action(
            db,
            admin,
            "user.create",
            target_user_id=user_id,
            details={"username": username, "role": payload.role, "tags": tags.split(",") if tags else []},
        )
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        raise HTTPException(400, "用户名或飞书 ID 已存在") from None
    
    user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    resp: dict[str, Any] = {"user": _serialize_user(user)}
    if plain_password:
        resp["plain_password"] = plain_password
        response.headers["Cache-Control"] = "private, no-store"
    return resp


@router.put("/admin/users/{user_id}")
def update_user(
    user_id: int,
    payload: UserPayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """更新用户信息（运营管理员或系统管理员）"""
    name = _normalised_display_name(payload.name)
    username = _normalised_username(payload.username)
    feishu_id = _normalised_feishu_id(payload.feishu_id)
    if payload.role not in {ROLE_SYSTEM_ADMIN, ROLE_OPERATIONS_ADMIN, ROLE_USER}:
        raise HTTPException(400, "角色不正确")
    if payload.password:
        policy_error = password_policy_error(payload.password, username=username)
        if policy_error:
            raise HTTPException(400, policy_error)
    existing = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if existing is None:
        raise HTTPException(404, "用户不存在")
    avatar_url = _validated_avatar_update(existing["avatar_url"] or "", payload.avatar_url, user_id)
    tags = _validated_user_tags(db, payload.tags, existing_value=existing["tags"] or "")
    
    # 系统管理员的身份只能由系统管理员授予/撤销
    if not is_system_admin(admin):
        if existing["role"] == ROLE_SYSTEM_ADMIN:
            raise HTTPException(403, "只有系统管理员能修改系统管理员账号")
        if payload.role == ROLE_SYSTEM_ADMIN:
            raise HTTPException(403, "只有系统管理员能授予系统管理员角色")
    
    if int(existing["id"]) == int(admin["id"]) and payload.role not in ADMIN_ROLES:
        raise HTTPException(400, "不能取消自己的管理员角色")
    
    if (
        int(existing["id"]) == int(admin["id"])
        and existing["role"] == ROLE_SYSTEM_ADMIN
        and payload.role != ROLE_SYSTEM_ADMIN
    ):
        raise HTTPException(400, "不能取消自己的系统管理员角色")
    
    fields: list[Any] = [
        name,
        username,
        username_lookup_key(username),
        feishu_id,
        avatar_url,
        tags,
        payload.role,
        now_iso(),
    ]
    sql = (
        "UPDATE users SET name = ?, username = ?, username_key = ?, feishu_id = ?, "
        "avatar_url = ?, tags = ?, role = ?, updated_at = ?"
    )
    
    if payload.password:
        sql += ", password_hash = ?, must_change_pwd = 1, temporary_password_expires_at = ?, session_version = session_version + 1"
        fields.append(hash_password(payload.password))
        fields.append(_temporary_password_expiry())
    
    sql += " WHERE id = ?"
    fields.append(user_id)
    
    try:
        db.execute(sql, fields)
        _sync_user_tags(db, user_id, tags)
        changed_fields = [
            field
            for field, old, new in (
                ("name", existing["name"], name),
                ("username", existing["username"], username),
                ("feishu_id", existing["feishu_id"], feishu_id),
                ("avatar_url", existing["avatar_url"], avatar_url),
                ("tags", existing["tags"], tags),
                ("role", existing["role"], payload.role),
            )
            if old != new
        ]
        if payload.password:
            changed_fields.append("password")
        _audit_admin_action(
            db,
            admin,
            "user.update",
            target_user_id=user_id,
            details={
                "changed_fields": changed_fields,
                "role_before": existing["role"],
                "role_after": payload.role,
            },
        )
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        raise HTTPException(400, "用户名或飞书 ID 已存在") from None
    
    if existing["avatar_url"] != avatar_url:
        delete_managed_avatar(existing["avatar_url"] or "", user_id=user_id)
    user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    invalidate_user(user_id)
    return {"user": _serialize_user(user)}


@router.post("/admin/users/{user_id}/reset-password")
def reset_user_password(
    user_id: int,
    response: Response,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """Generate a one-time temporary password and invalidate old sessions."""
    if int(user_id) == int(admin["id"]):
        raise HTTPException(400, "不能在用户管理中重置当前账号，请使用修改密码功能")
    user = db.execute("SELECT id, role FROM users WHERE id = ?", (user_id,)).fetchone()
    if user is None:
        raise HTTPException(404, "用户不存在")
    if user["role"] == ROLE_SYSTEM_ADMIN and not is_system_admin(admin):
        raise HTTPException(403, "只有系统管理员能重置系统管理员账号")
    plain_password = secrets.token_urlsafe(16)
    try:
        db.execute(
            """
            UPDATE users
            SET password_hash = ?, must_change_pwd = 1, temporary_password_expires_at = ?,
                session_version = session_version + 1, updated_at = ?
            WHERE id = ?
            """,
            (hash_password(plain_password), _temporary_password_expiry(), now_iso(), user_id),
        )
        _audit_admin_action(db, admin, "user.password_reset", target_user_id=user_id)
        db.commit()
    except Exception:
        db.rollback()
        raise
    invalidate_user(user_id)
    updated = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    response.headers["Cache-Control"] = "private, no-store"
    return {"user": _serialize_user(updated), "plain_password": plain_password}


@router.delete("/admin/users/{user_id}")
def delete_user(
    user_id: int,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, bool]:
    """删除没有受保护关联数据的用户。"""
    if user_id == int(admin["id"]):
        raise HTTPException(400, "不能删除当前登录用户")
    
    target = db.execute("SELECT role, avatar_url FROM users WHERE id = ?", (user_id,)).fetchone()
    if target is None:
        raise HTTPException(404, "用户不存在")
    if target["role"] == ROLE_SYSTEM_ADMIN and not is_system_admin(admin):
        raise HTTPException(403, "只有系统管理员能删除系统管理员账号")
    
    try:
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        _audit_admin_action(
            db,
            admin,
            "user.delete",
            target_user_id=user_id,
            details={"role": target["role"]},
        )
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        raise HTTPException(400, "该用户关联了资源、放映、下载记录或任务等数据，无法直接删除。请先转移或删除相关数据后再试。") from None
    invalidate_user(user_id)
    delete_managed_avatar(target["avatar_url"] or "", user_id=user_id)
    return {"ok": True}


@router.post("/admin/users/bulk-delete")
def bulk_delete_users(
    payload: UserDeletePayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """批量删除用户，限制单次操作规模。"""
    user_ids = sorted({int(uid) for uid in payload.user_ids if int(uid) > 0})
    if not user_ids:
        raise HTTPException(400, "请选择要删除的用户")
    if len(user_ids) > USER_BULK_DELETE_MAX:
        raise HTTPException(400, f"一次最多删除 {USER_BULK_DELETE_MAX} 个用户")
    
    current_user_id = int(admin["id"])
    if current_user_id in user_ids:
        raise HTTPException(400, "不能删除当前登录用户")
    
    rows: list[sqlite3.Row] = []
    for chunk in _id_chunks(user_ids):
        placeholders = ",".join("?" for _ in chunk)
        rows.extend(
            db.execute(
                f"SELECT id, role, avatar_url FROM users WHERE id IN ({placeholders})",
                chunk,
            ).fetchall()
        )

    if len(rows) != len(user_ids):
        raise HTTPException(404, "部分用户不存在，请刷新列表后重试")

    if any(row["role"] == ROLE_SYSTEM_ADMIN for row in rows) and not is_system_admin(admin):
        raise HTTPException(403, "只有系统管理员能删除系统管理员账号")
    
    deleted_ids = [int(row["id"]) for row in rows]
    try:
        for chunk in _id_chunks(user_ids):
            placeholders = ",".join("?" for _ in chunk)
            db.execute(f"DELETE FROM users WHERE id IN ({placeholders})", chunk)
        _audit_admin_action(
            db,
            admin,
            "user.bulk_delete",
            details={"deleted_ids": deleted_ids, "count": len(deleted_ids)},
        )
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        raise HTTPException(400, "部分用户关联了资源、放映、下载记录或任务等数据，无法直接删除。请先转移或删除相关数据后再试。") from None
    
    for row in rows:
        invalidate_user(int(row["id"]))
        delete_managed_avatar(row["avatar_url"] or "", user_id=int(row["id"]))
    return {"ok": True, "deleted_ids": deleted_ids, "count": len(deleted_ids), "deleted": len(deleted_ids)}


@router.post("/admin/users/{user_id}/transfer-and-delete")
def transfer_and_delete_user(
    user_id: int,
    payload: UserTransferDeletePayload,
    admin: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """将用户关联数据转移给目标用户后删除该用户"""
    if user_id == int(admin["id"]):
        raise HTTPException(400, "不能删除当前登录用户")
    if user_id == payload.target_user_id:
        raise HTTPException(400, "不能将数据转移给自己")

    # 验证源用户存在
    source = db.execute("SELECT role, avatar_url FROM users WHERE id = ?", (user_id,)).fetchone()
    if source is None:
        raise HTTPException(404, "源用户不存在")
    if source["role"] == ROLE_SYSTEM_ADMIN and not is_system_admin(admin):
        raise HTTPException(403, "只有系统管理员能删除系统管理员账号")

    # 验证目标用户存在
    target = db.execute("SELECT id FROM users WHERE id = ?", (payload.target_user_id,)).fetchone()
    if target is None:
        raise HTTPException(404, "目标用户不存在")

    tid = payload.target_user_id

    try:
        # 转移所有权和审计归属字段。
        for table, col in (
            ("resources", "owner_id"),
            ("resources", "updated_by"),
            ("resource_versions", "created_by"),
            ("resource_share_tokens", "created_by"),
            ("templates", "owner_id"),
            ("fonts", "uploaded_by"),
            ("shows", "owner_id"),
            ("shows", "updated_by"),
            ("tasks", "owner_id"),
            ("task_events", "owner_id"),
            ("resource_import_commits", "owner_id"),
            ("tags", "created_by"),
            ("user_tag_definitions", "created_by"),
        ):
            db.execute(f"UPDATE {table} SET {col} = ? WHERE {col} = ?", (tid, user_id))

        # Preserve granted access/management rights. Existing target rows win.
        for table, entity_column in (
            ("resource_visibility", "resource_id"),
            ("resource_management", "resource_id"),
            ("show_visibility", "show_id"),
            ("show_management", "show_id"),
            ("template_visibility", "template_id"),
            ("template_management", "template_id"),
        ):
            db.execute(
                f"INSERT OR IGNORE INTO {table} ({entity_column}, user_id) "
                f"SELECT {entity_column}, ? FROM {table} WHERE user_id = ?",
                (tid, user_id),
            )

        for table, columns in (
            ("user_preferences", ("pref_key", "pref_value", "updated_at")),
            ("user_pinned_resources", ("resource_id", "pinned_at")),
            ("user_pinned_shows", ("show_id", "pinned_at")),
        ):
            column_sql = ", ".join(columns)
            db.execute(
                f"INSERT OR IGNORE INTO {table} (user_id, {column_sql}) "
                f"SELECT ?, {column_sql} FROM {table} WHERE user_id = ?",
                (tid, user_id),
            )
        for table, columns in (
            ("personal_remarks", ("resource_id", "version_id", "content_html", "updated_at")),
            ("show_remarks", ("show_id", "resource_id", "content_html", "updated_at")),
        ):
            column_sql = ", ".join(columns)
            db.execute(
                f"INSERT OR IGNORE INTO {table} ({column_sql}, user_id) "
                f"SELECT {column_sql}, ? FROM {table} WHERE user_id = ?",
                (tid, user_id),
            )

        db.execute("UPDATE download_records SET user_id = NULL WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        _audit_admin_action(
            db,
            admin,
            "user.transfer_delete",
            target_user_id=user_id,
            details={"transferred_to": tid, "source_role": source["role"]},
        )
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        raise HTTPException(400, "数据转移后仍无法删除用户，请联系技术支持。") from None
    except Exception:
        db.rollback()
        raise

    invalidate_user(user_id)
    invalidate_user(tid)
    delete_managed_avatar(source["avatar_url"] or "", user_id=user_id)
    return {"ok": True}
