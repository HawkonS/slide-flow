"""
字体管理路由模块
处理字体的上传、下载、删除等功能
"""
import json
import sqlite3
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse

from app.core.fonts import validate_font_file
from app.core.permissions import require_user, require_admin
from app.core.storage import save_upload
from app.db import now_iso
from app.config import settings
from app.routers.dependencies import (
    FontDeletePayload,
    db_dep,
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


@router.get("/fonts")
def list_fonts(
    _: Any = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
) -> dict[str, Any]:
    """获取字体列表"""
    rows = db.execute("SELECT * FROM fonts ORDER BY created_at DESC, id DESC").fetchall()
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
            }
        )
    return {"fonts": items}


@router.post("/fonts/upload")
async def upload_font(
    font_file: UploadFile = File(...),
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
    
    aliases = sorted({name.strip() for name in names if name and name.strip()}, key=str.lower)
    display = aliases[0] if aliases else Path(font_file.filename or path.name).stem
    
    ts = now_iso()
    db.execute(
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
    db.commit()
    
    return {"ok": True, "family": display, "aliases": aliases}


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
    db.execute("DELETE FROM fonts WHERE id = ?", (font_id,))
    db.commit()
    
    if path is not None:
        path.unlink(missing_ok=True)
    
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
    db.execute(f"DELETE FROM fonts WHERE id IN ({placeholders})", font_ids)
    db.commit()
    
    for path in paths:
        if path is not None:
            path.unlink(missing_ok=True)
    
    return {"ok": True, "deleted": len(rows)}


@router.get("/fonts/{font_id}/download")
def download_uploaded_font(
    font_id: int,
    _: Any = Depends(require_user),
    db: sqlite3.Connection = Depends(db_dep),
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
