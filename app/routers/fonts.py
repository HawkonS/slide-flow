"""
字体管理路由模块
处理字体的上传、下载、删除等功能
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from app.core.fonts import validate_font_file
from app.core.permissions import require_user, require_admin
from app.core.storage import safe_filename, save_upload
from app.db import now_iso
from app.services.resource_import.font_tasks import create_font_task, queue_font_deletions
from app.config import settings
from app.routers.dependencies import (
    FontDeletePayload,
    FontDownloadPayload,
    db_dep,
    db_read_dep,
    _font_aliases_from_row,
)


router = APIRouter()


def _uploaded_font_abs(stored_path: str | None) -> Path | None:
    """获取字体文件的绝对路径，并进行安全校验"""
    path = settings.abs_path(stored_path)
    if path is None:
        return None
    try:
        path.resolve().relative_to(settings.fonts_dir.resolve())
    except ValueError:
        return None
    return path


def _content_disposition(filename: str) -> str:
    """生成下载文件的 Content-Disposition 头"""
    quoted = quote(filename)
    return f"attachment; filename*=UTF-8''{quoted}"


def _install_dir() -> Path:
    """返回当前服务用户的字体目录，不修改系统级目录。"""
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Microsoft" / "Windows" / "Fonts"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Fonts"
    return Path.home() / ".local" / "share" / "fonts"


def _install_font(path: Path) -> Path:
    """将字体安装到服务用户目录，并尽力刷新 fontconfig 缓存。"""
    target_dir = _install_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / path.name
    shutil.copy2(path, target)
    _refresh_font_cache(target_dir)
    return target


def _refresh_font_cache(target_dir: Path | None = None) -> None:
    """刷新 fontconfig 缓存；系统未提供该命令时静默跳过。"""
    font_dir = target_dir or _install_dir()
    try:
        subprocess.run(
            ["fc-cache", "-f", str(font_dir)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        pass


def _installation_path(db: sqlite3.Connection, font_id: int) -> Path | None:
    row = db.execute(
        "SELECT value FROM runtime_state WHERE key = ?",
        (f"font_install:{font_id}",),
    ).fetchone()
    if not row or not row["value"]:
        return None
    try:
        path = Path(row["value"]).expanduser().resolve()
        path.relative_to(_install_dir().resolve())
        return path if path.is_file() else None
    except (ValueError, OSError, TypeError):
        return None


def _set_installation_path(db: sqlite3.Connection, font_id: int, path: Path | None) -> None:
    key = f"font_install:{font_id}"
    if path is None:
        db.execute("DELETE FROM runtime_state WHERE key = ?", (key,))
    else:
        db.execute(
            "INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (key, str(path), now_iso()),
        )


@router.get("/fonts")
def list_fonts(
    _: Any = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> dict[str, Any]:
    """获取字体列表"""
    rows = db.execute(
        "SELECT fonts.*, users.name AS uploader_name, users.username AS uploader_username "
        "FROM fonts LEFT JOIN users ON users.id = fonts.uploaded_by "
        "ORDER BY fonts.created_at DESC, fonts.id DESC"
    ).fetchall()
    items: list[dict[str, Any]] = []
    for row in rows:
        aliases = _font_aliases_from_row(row)
        family = row["family_name"] or (aliases[0] if aliases else row["file_name"])
        items.append(
            {
                "id": row["id"],
                "family": family,
                "aliases": aliases,
                "file_name": row["file_name"],
                "download_url": f"/api/fonts/{row['id']}/download",
                "created_at": row["created_at"],
                "uploaded_by": row["uploader_name"] or row["uploader_username"] or "未知",
                "installed_on_server": _installation_path(db, int(row["id"])) is not None,
            }
        )
    return {"fonts": items}


@router.post("/fonts/upload")
async def upload_font(
    font_file: UploadFile = File(...),
    display_name: str = Form(default="", max_length=100),
    install_on_server: bool = Form(default=False),
    user: sqlite3.Row = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """上传字体文件（管理员）"""
    target_dir = settings.fonts_dir
    path = await save_upload(font_file, target_dir, "font_")
    
    valid, names = validate_font_file(path)
    if not valid:
        path.unlink(missing_ok=True)
        raise HTTPException(400, "只能上传可解析的字体文件（TTF/OTF/TTC/OTC）")
    
    detected_aliases = {name.strip() for name in names if name and name.strip()}
    custom_name = display_name.strip()
    display = custom_name or (sorted(detected_aliases, key=str.lower)[0] if detected_aliases else Path(font_file.filename or path.name).stem)
    aliases = sorted({display, *detected_aliases}, key=str.lower)
    
    ts = now_iso()
    cursor = db.execute(
        """
        INSERT INTO fonts (family_name, aliases, file_name, file_path, uploaded_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            display,
            json.dumps(aliases, ensure_ascii=False),
            font_file.filename or path.name,
            settings.store_path(path),
            user["id"],
            ts,
        ),
    )
    font_id = int(cursor.lastrowid)
    # Every uploaded font is synchronized to Windows through the pull queue.
    # The renderer never receives a PPT font manifest or font bytes inline.
    create_font_task(db, font_id, path)
    installed_path: Path | None = None
    if install_on_server:
        try:
            installed_path = _install_font(path)
            _set_installation_path(db, font_id, installed_path)
        except (OSError, shutil.Error) as exc:
            db.rollback()
            path.unlink(missing_ok=True)
            raise HTTPException(500, f"字体已上传但服务器安装失败：{exc}") from exc
    db.commit()
    
    return {
        "ok": True,
        "id": font_id,
        "family": display,
        "aliases": aliases,
        "installed_on_server": installed_path is not None,
    }


@router.delete("/admin/fonts/{font_id}")
def delete_font(
    font_id: int,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """删除字体（管理员）"""
    row = db.execute("SELECT * FROM fonts WHERE id = ?", (font_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "字体不存在")
    
    path = _uploaded_font_abs(row["file_path"])
    installed_path = _installation_path(db, font_id)
    queue_font_deletions(db, [font_id])
    db.execute("DELETE FROM fonts WHERE id = ?", (font_id,))
    _set_installation_path(db, font_id, None)
    db.commit()
    
    if path is not None:
        path.unlink(missing_ok=True)
    if installed_path is not None and installed_path != path:
        installed_path.unlink(missing_ok=True)
        _refresh_font_cache()
    
    return {"ok": True, "deleted": 1}


@router.post("/admin/fonts/bulk-delete")
def bulk_delete_fonts(
    payload: FontDeletePayload,
    _: Any = Depends(require_admin),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """批量删除字体（管理员）"""
    font_ids = sorted({int(font_id) for font_id in payload.font_ids if int(font_id) > 0})
    if not font_ids:
        raise HTTPException(400, "请选择要删除的字体")
    
    placeholders = ",".join("?" for _ in font_ids)
    rows = db.execute(f"SELECT * FROM fonts WHERE id IN ({placeholders})", font_ids).fetchall()
    
    if not rows:
        raise HTTPException(404, "未找到可删除的字体")
    
    paths = [_uploaded_font_abs(row["file_path"]) for row in rows]
    installed_paths = [_installation_path(db, int(row["id"])) for row in rows]
    queue_font_deletions(db, font_ids)
    db.execute(f"DELETE FROM fonts WHERE id IN ({placeholders})", font_ids)
    for font_id in font_ids:
        _set_installation_path(db, font_id, None)
    db.commit()
    
    for path in paths:
        if path is not None:
            path.unlink(missing_ok=True)
    for path in installed_paths:
        if path is not None:
            path.unlink(missing_ok=True)
    if any(path is not None for path in installed_paths):
        _refresh_font_cache()
    
    return {"ok": True, "deleted": len(rows)}


@router.post("/fonts/bulk-download")
def bulk_download_fonts(
    payload: FontDownloadPayload,
    _: Any = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> FileResponse:
    """将当前用户选择的字体打包为 ZIP 下载。"""
    font_ids = list(dict.fromkeys(int(font_id) for font_id in payload.font_ids if int(font_id) > 0))
    if not font_ids:
        raise HTTPException(400, "请选择要下载的字体")

    placeholders = ",".join("?" for _ in font_ids)
    rows = db.execute(
        f"SELECT id, file_name, file_path FROM fonts WHERE id IN ({placeholders})",
        font_ids,
    ).fetchall()
    rows_by_id = {int(row["id"]): row for row in rows}
    available = []
    for font_id in font_ids:
        row = rows_by_id.get(font_id)
        if row is None:
            continue
        path = _uploaded_font_abs(row["file_path"])
        if path is not None and path.is_file():
            available.append((row, path))

    if not available:
        raise HTTPException(404, "所选字体文件不存在")

    settings.downloads_dir.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        prefix="fonts_",
        suffix=".zip",
        dir=settings.downloads_dir,
        delete=False,
    )
    archive_path = Path(handle.name)
    handle.close()

    used_names: set[str] = set()
    try:
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for row, path in available:
                original = safe_filename(row["file_name"] or path.name)
                candidate = original
                stem = Path(original).stem
                suffix = Path(original).suffix
                index = 2
                while candidate.lower() in used_names:
                    candidate = f"{stem}_{index}{suffix}"
                    index += 1
                used_names.add(candidate.lower())
                archive.write(path, arcname=candidate)
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise

    return FileResponse(
        archive_path,
        media_type="application/zip",
        headers={"Content-Disposition": _content_disposition(f"标准字体_{len(available)}个.zip")},
        background=BackgroundTask(archive_path.unlink, missing_ok=True),
    )


@router.get("/fonts/{font_id}/download")
def download_uploaded_font(
    font_id: int,
    _: Any = Depends(require_user),
    db: sqlite3.Connection = Depends(db_read_dep),
) -> FileResponse:
    """下载字体文件"""
    row = db.execute("SELECT * FROM fonts WHERE id = ?", (font_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "字体不存在")
    
    path = _uploaded_font_abs(row["file_path"])
    if path is None or not path.exists():
        raise HTTPException(404, "字体文件不存在")
    
    return FileResponse(
        path,
        headers={"Content-Disposition": _content_disposition(row["file_name"])}
    )
