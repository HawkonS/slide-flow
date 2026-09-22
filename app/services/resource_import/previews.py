"""Progressive previews bound to an immutable source generation.

Caller holds the session operation lease until rendering/cleanup has really
stopped. Partial images are readable but are never eligible for commit.
"""
from __future__ import annotations
import shutil
import threading
import time
import uuid
from pathlib import Path
from app.config import settings

from app.core.ppt import split_pptx_to_single_pages
from app.services.files import _compress_hd_image
from app.services.resource_import.limits import RESOURCE_IMPORT_TTL
from app.services.resource_import.remote_fonts import sha256_file
from app.services.resource_import.font_tasks import wait_for_font_sync
from app.services.resource_import.remote_renderer import RemoteRenderer, RenderCancelled
from app.services.resource_import.rendering import RESOURCE_IMPORT_RENDERER_VERSION
from app.services.resource_import.sessions import _resource_import_file, _resource_import_temp_dir, _write_resource_import_session


def _preview_set_is_current(session: dict) -> bool:
    return session.get("mode") != "ppt" or (
        session.get("renderer_version") == RESOURCE_IMPORT_RENDERER_VERSION
        and session.get("preview_status") == "ready"
        and len(session.get("preview_paths", [])) == session.get("slide_count")
    )


def _render_and_publish_ppt_previews(session: dict, emit=None, cancel=None) -> list[Path]:
    emit = emit or (lambda event: None)
    cancel = cancel or threading.Event()
    source = _resource_import_file(session, session.get("source_path"))
    root = _resource_import_temp_dir(session)
    expected = int(session["slide_count"])
    if _preview_set_is_current(session):
        paths = [_resource_import_file(session, p) for p in session["preview_paths"]]
        for index in range(expected):
            emit({"type": "page", "index": index, "preview_url": f"/api/resource-import/{session['session_id']}/preview/{index}?attempt={session.get('render_attempt', '')}"})
        return paths
    attempt = uuid.uuid4().hex
    directory = root / f"previews_{attempt}"
    directory.mkdir()
    remote = None
    paths = [None] * expected
    session.update(preview_status="rendering", preview_error=None, preview_paths=[],
                   partial_preview_paths={}, render_attempt=attempt,
                   renderer_version=RESOURCE_IMPORT_RENDERER_VERSION,
                   expires_at=time.time() + RESOURCE_IMPORT_TTL)
    _write_resource_import_session(session)
    for child in root.iterdir():
        if child != directory and child.name.startswith("previews_") and child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
    try:
        remote = RemoteRenderer(cancel, lambda message: emit({"type": "progress", "message": message}))
        emit({"type": "progress", "message": "正在拆分单页并等待 Windows 字体同步完成"})
        if shutil.disk_usage(root).free < 1024 * 1024 * 1024:
            raise RuntimeError("主服务器临时空间不足，请稍后重试")
        singles = split_pptx_to_single_pages(source, directory / "sources", max_total_bytes=512 * 1024 * 1024)
        if len(singles) != expected:
            raise RuntimeError("PPT 拆分页数不一致，未提交渲染")
        remote.check()
        wait_for_font_sync(remote.check, timeout_seconds=settings.render_total_timeout)
        source_sha = sha256_file(source)
        split_hashes = [sha256_file(p) for p in singles]
        preview_bytes = 0

        def publish(index, path):
            nonlocal preview_bytes
            if cancel.is_set():
                raise RenderCancelled("渲染已取消")
            if index < 0 or index >= expected or paths[index] is not None:
                raise RuntimeError("渲染页码重复或越界")
            preview_bytes += path.stat().st_size
            if preview_bytes > 512 * 1024 * 1024:
                raise RuntimeError("本次高清图总量超过 512 MB，请减少每次导入页数")
            # Confirm exactly the HD asset that commit will copy. Resizing or
            # format conversion must not happen only after the user confirms.
            path = _compress_hd_image(path)
            paths[index] = path
            session["partial_preview_paths"][str(index)] = str(path)
            session["expires_at"] = time.time() + RESOURCE_IMPORT_TTL
            _write_resource_import_session(session)
            emit({"type": "page", "index": index, "preview_url": f"/api/resource-import/{session['session_id']}/preview/{index}?attempt={attempt}"})

        render_pages = getattr(remote, "render_pages", None)
        if callable(render_pages):
            render_pages(list(enumerate(singles)), directory, publish)
        else:
            # Compatibility for test doubles and older in-process clients;
            # production RemoteRenderer always uses the page-only protocol.
            remote.render(list(enumerate(singles)), [], [], directory, publish)
        remote.check()
        if any(path is None for path in paths):
            raise RuntimeError("预览图片尚未全部完成")
        session.update(preview_paths=[str(p) for p in paths], partial_preview_paths={},
                       preview_hashes=[sha256_file(p) for p in paths],
                       split_paths=[str(p) for p in singles], split_hashes=split_hashes,
                       rendered_source_sha256=source_sha, preview_status="ready", preview_error=None,
                       expires_at=time.time() + RESOURCE_IMPORT_TTL)
        _write_resource_import_session(session)
        return paths
    except BaseException as exc:
        session.update(preview_status="error", preview_error=str(exc) or "图片渲染失败",
                       preview_paths=[], partial_preview_paths={}, split_paths=[], split_hashes=[])
        _write_resource_import_session(session)
        shutil.rmtree(directory, ignore_errors=True)
        raise
    finally:
        if remote is not None:
            remote.close()
