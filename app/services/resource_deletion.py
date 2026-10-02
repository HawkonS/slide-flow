"""Preview and atomically resolve fixed-version references before deletion."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import sqlite3
import time

from fastapi import HTTPException

from app.config import settings
from app.core.permissions import can_manage_resource, can_manage_show, can_view_show
from app.db import now_iso
from app.services.files import _delete_resource_files

logger = logging.getLogger(__name__)


def _digest(snapshot: dict, issued: str) -> str:
    message = issued + ':' + json.dumps(snapshot, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    return hmac.new(settings.secret_key.encode(), message.encode(), hashlib.sha256).hexdigest()


def _token(snapshot: dict) -> str:
    issued = str(int(time.time()))
    return issued + '.' + _digest(snapshot, issued)


def _check_token(snapshot: dict, token: str | None) -> None:
    try:
        issued, signature = (token or '').split('.', 1)
        age = time.time() - int(issued)
        valid = 0 <= age <= 900 and hmac.compare_digest(signature, _digest(snapshot, issued))
    except (ValueError, TypeError):
        valid = False
    if not valid:
        raise HTTPException(409, '删除影响已发生变化或确认已过期，请重新查看清单并确认')


def _plan(db: sqlite3.Connection, ids: list[int], scope: str, user: sqlite3.Row) -> dict:
    if scope not in {'all', 'latest'}:
        raise HTTPException(400, '删除范围不正确')
    ids = sorted(set(ids))
    if not ids or len(ids) > 1000 or any(type(rid) is not int or rid <= 0 for rid in ids):
        raise HTTPException(400, '请选择 1 至 1000 项素材')
    targets, resource_rows, version_rows = [], [], []
    for rid in ids:
        row = db.execute('SELECT * FROM resources WHERE id = ? AND deleted_at IS NULL', (rid,)).fetchone()
        if row is None:
            raise HTTPException(404, '素材不存在或已删除，请刷新列表')
        if not can_manage_resource(db, row, user):
            raise HTTPException(403, '部分素材无管理权限')
        versions = db.execute('SELECT * FROM resource_versions WHERE resource_id = ? ORDER BY version_no', (rid,)).fetchall()
        active = [v for v in versions if v['deleted_at'] is None]
        if not active:
            raise HTTPException(409, '素材已无有效版本，请刷新列表')
        selected = active if scope == 'all' else active[-1:]
        if not selected:
            raise HTTPException(409, '素材已无有效版本，请刷新列表')
        targets.append({'id': rid, 'name': row['name'], 'version_count': len(active),
                        'version_nos': [int(v['version_no']) for v in selected],
                        'selected_version_count': len(selected),
                        'delete_resource': scope == 'all' or len(active) <= 1})
        resource_rows.append(dict(row))
        version_rows.extend(dict(v) for v in selected)
    keys = {(v['resource_id'], v['version_no']) for v in version_rows}
    # A full resource deletion must also remove active share snapshots that
    # still point at an archived version. The archived rows themselves are
    # not re-deleted or counted as target versions.
    reference_version_ids = {
        v['id'] for rid in ids
        for v in db.execute('SELECT id FROM resource_versions WHERE resource_id = ?', (rid,)).fetchall()
    } if scope == 'all' else {v['id'] for v in version_rows}
    placeholders = ','.join('?' for _ in ids)
    direct = [dict(row) for row in db.execute(
        f'SELECT * FROM show_resources WHERE resource_id IN ({placeholders}) ORDER BY show_id, resource_id', ids)
        if scope == 'all' or (row['resource_id'], row['version_no']) in keys]
    shares = [dict(row) for row in db.execute(f'''
        SELECT p.share_id, p.version_id, p.sort_order, st.show_id, st.created_by, st.expires_at,
               (SELECT COUNT(*) FROM show_share_pages q WHERE q.share_id = p.share_id) AS page_count
        FROM show_share_pages p JOIN resource_versions v ON v.id = p.version_id
        JOIN show_share_tokens st ON st.id = p.share_id
        WHERE v.resource_id IN ({placeholders}) AND st.revoked_at IS NULL AND st.expires_at > ?
        ORDER BY st.show_id, p.share_id, p.version_id''', [*ids, now_iso()]) if row['version_id'] in reference_version_ids]
    show_ids = sorted({r['show_id'] for r in [*direct, *shares]})
    visible, snapshots, empty_ids, restricted = [], [], [], 0
    can_remove = True
    for sid in show_ids:
        row = db.execute('SELECT * FROM shows WHERE id = ?', (sid,)).fetchone()
        pages = [dict(p) for p in db.execute('SELECT * FROM show_resources WHERE show_id = ? ORDER BY sort_order, resource_id', (sid,))]
        removed = [p for p in direct if p['show_id'] == sid]
        remaining = len(pages) - len(removed)
        delete_show = bool(removed) and remaining == 0
        if delete_show:
            empty_ids.append(sid)
        manageable = can_manage_show(db, row, user)
        can_remove = can_remove and manageable
        snapshots.append({'show': dict(row), 'pages': pages, 'can_manage': manageable, 'can_view': can_view_show(db, row, user)})
        if not can_view_show(db, row, user):
            restricted += 1
            continue
        owner = db.execute('SELECT id, name, username FROM users WHERE id = ?', (row['owner_id'],)).fetchone()
        visible.append({'id': sid, 'name': row['name'], 'version_no': row['version_no'],
                        'owner': {'id': int(owner['id']), 'name': owner['name'], 'username': owner['username']} if owner else None,
                        'can_manage': manageable, 'page_count': len(pages), 'removed_pages': len(removed),
                        'remaining_pages': remaining, 'will_delete': delete_show,
                        'references': [{'resource_id': p['resource_id'], 'version_no': p['version_no'], 'hidden': bool(p['is_hidden'])} for p in removed],
                        'share_count': len({s['share_id'] for s in shares if s['show_id'] == sid})})
    snapshot = {'operation': 'delete', 'user_id': int(user['id']), 'scope': scope, 'resources': resource_rows,
                'versions': version_rows, 'shows': snapshots, 'shares': shares}
    public = {'scope': scope, 'targets': targets, 'shows': visible, 'show_count': len(show_ids),
              'restricted_show_count': restricted, 'has_references': bool(direct or shares),
              'removed_pages': len(direct), 'empty_show_count': len(empty_ids),
              'removed_share_pages': len(shares),
              'share_count': len({s['share_id'] for s in shares}),
              'available_actions': ['preserve', 'remove'] if can_remove else ['preserve'],
              'confirmation_token': _token(snapshot)}
    return {'public': public, 'snapshot': snapshot, 'direct': direct, 'shares': shares,
            'show_ids': show_ids, 'empty_ids': empty_ids, 'versions': version_rows}


def preview_resource_deletion(db: sqlite3.Connection, ids: list[int], scope: str, user: sqlite3.Row) -> dict:
    # All counts and the token describe the same SQLite read snapshot.
    with db:
        if not db.in_transaction:
            db.execute('BEGIN')
        return _plan(db, ids, scope, user)['public']


def collect_archived_versions(db: sqlite3.Connection) -> None:
    """Remove unreferenced archive rows; queue file cleanup in the same transaction."""
    candidates = db.execute('''SELECT v.* FROM resource_versions v WHERE v.deleted_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM show_resources sr WHERE sr.resource_id = v.resource_id AND sr.version_no = v.version_no)
        AND NOT EXISTS (SELECT 1 FROM show_share_pages p JOIN show_share_tokens st ON st.id = p.share_id
                        WHERE p.version_id = v.id AND st.revoked_at IS NULL AND st.expires_at > ?)
        ORDER BY v.id LIMIT 200''', (now_iso(),)).fetchall()
    for version in candidates:
        db.execute('DELETE FROM resource_versions WHERE id = ?', (version['id'],))
        paths = [p for p in (version['ppt_path'], version['png_path']) if p and not db.execute(
            'SELECT 1 FROM resource_versions WHERE ppt_path = ? OR png_path = ? LIMIT 1', (p, p)).fetchone()]
        db.execute('INSERT INTO resource_file_gc (paths_json, version_ids_json, created_at) VALUES (?, ?, ?)',
                   (json.dumps(paths), json.dumps([int(version['id'])]), now_iso()))
    db.execute('''DELETE FROM resources WHERE deleted_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM resource_versions v WHERE v.resource_id = resources.id)
        AND NOT EXISTS (SELECT 1 FROM show_resources sr WHERE sr.resource_id = resources.id)''')


def drain_file_gc(db: sqlite3.Connection) -> None:
    try:
        tasks = db.execute('SELECT * FROM resource_file_gc ORDER BY id LIMIT 100').fetchall()
    except Exception:
        logger.exception('Could not read archived file cleanup queue; will retry')
        return
    for task in tasks:
        try:
            _delete_resource_files(json.loads(task['paths_json']), json.loads(task['version_ids_json']), strict=True)
            db.execute('DELETE FROM resource_file_gc WHERE id = ?', (task['id'],))
            db.commit()
        except Exception:
            db.rollback()
            logger.exception('Archived resource files awaiting retry, cleanup_id=%s', task['id'])


def maintain_archives(db: sqlite3.Connection) -> None:
    try:
        with db:
            if not db.in_transaction:
                db.execute('BEGIN IMMEDIATE')
            collect_archived_versions(db)
        drain_file_gc(db)
    except Exception:
        logger.exception('Archived resource cleanup will retry')


def delete_resources(db: sqlite3.Connection, ids: list[int], scope: str, user: sqlite3.Row,
                     action: str | None, token: str | None, *, rollback: bool = False) -> dict:
    with db:
        if not db.in_transaction:
            db.execute('BEGIN IMMEDIATE')
        plan = _plan(db, ids, scope, user)
        preview = plan['public']
        if rollback and any(t['version_count'] <= 1 for t in preview['targets']):
            raise HTTPException(400, '仅剩 1 个版本，无法继续回退；如需清空请使用删除资源')
        if preview['has_references'] and action is None:
            raise HTTPException(409, '素材被放映引用，请先查看影响并选择保留页面或同步移除')
        if token is not None or preview['has_references']:
            _check_token(plan['snapshot'], token)
        action = action or 'remove'
        if action not in preview['available_actions']:
            raise HTTPException(403, '对部分引用放映无管理权限，请选择保留放映页面')
        ts = now_iso()
        deleted_show_ids = []
        # Reserve numbers before removing even dangling fixed-version references.
        for target in preview['targets']:
            rid = target['id']
            db.execute('''UPDATE resources SET next_version_no = MAX(next_version_no, current_version + 1,
                COALESCE((SELECT MAX(version_no) + 1 FROM resource_versions WHERE resource_id = ?), 2),
                COALESCE((SELECT MAX(version_no) + 1 FROM show_resources WHERE resource_id = ?), 2)) WHERE id = ?''', (rid, rid, rid))
        if action == 'remove':
            for page in plan['direct']:
                db.execute('DELETE FROM show_resources WHERE show_id = ? AND resource_id = ?', (page['show_id'], page['resource_id']))
                db.execute('DELETE FROM show_remarks WHERE show_id = ? AND resource_id = ?', (page['show_id'], page['resource_id']))
            for page in plan['shares']:
                db.execute('DELETE FROM show_share_pages WHERE share_id = ? AND version_id = ?', (page['share_id'], page['version_id']))
            for share_id in {p['share_id'] for p in plan['shares']}:
                db.execute('''UPDATE show_share_tokens SET revoked_at = ? WHERE id = ?
                    AND NOT EXISTS (SELECT 1 FROM show_share_pages WHERE share_id = ?)''', (ts, share_id, share_id))
            for sid in plan['show_ids']:
                if sid in plan['empty_ids']:
                    db.execute('DELETE FROM shows WHERE id = ?', (sid,))
                    deleted_show_ids.append(sid)
                else:
                    pages = db.execute('SELECT resource_id FROM show_resources WHERE show_id = ? ORDER BY sort_order, resource_id', (sid,)).fetchall()
                    for order, page in enumerate(pages):
                        db.execute('UPDATE show_resources SET sort_order = ? WHERE show_id = ? AND resource_id = ?', (order, sid, page['resource_id']))
                    db.execute('UPDATE shows SET updated_at = ?, updated_by = ? WHERE id = ?', (ts, user['id'], sid))
        for target in preview['targets']:
            rid = target['id']
            for version in plan['versions']:
                if version['resource_id'] == rid:
                    db.execute('UPDATE resource_versions SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?', (ts, version['id']))
            if target['delete_resource']:
                db.execute('UPDATE resources SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?', (ts, ts, user['id'], rid))
                db.execute('DELETE FROM user_pinned_resources WHERE resource_id = ?', (rid,))
                db.execute('UPDATE resource_share_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE resource_id = ?', (ts, rid))
            else:
                previous = db.execute('SELECT MAX(version_no) FROM resource_versions WHERE resource_id = ? AND deleted_at IS NULL', (rid,)).fetchone()[0]
                db.execute('UPDATE resources SET current_version = ?, updated_at = ?, updated_by = ? WHERE id = ?', (previous, ts, user['id'], rid))
        collect_archived_versions(db)
        result = {'ok': True, 'scope': scope, 'reference_action': action, 'resource_ids': sorted(set(ids)),
                  'deleted': sum(t['delete_resource'] for t in preview['targets']),
                  'deleted_versions': len(plan['versions']), 'affected_show_ids': plan['show_ids'],
                  'deleted_show_ids': deleted_show_ids, 'removed_pages': preview['removed_pages'] if action == 'remove' else 0,
                  'removed_share_pages': preview['removed_share_pages'] if action == 'remove' else 0}
    # A filesystem failure must never turn a committed deletion into an API failure.
    drain_file_gc(db)
    return result


def cleanup_missing_resources(db: sqlite3.Connection, show_id: int, user: sqlite3.Row,
                              *, preview: bool, token: str | None) -> dict:
    with db:
        if not db.in_transaction:
            db.execute('BEGIN' if preview else 'BEGIN IMMEDIATE')
        show = db.execute('SELECT * FROM shows WHERE id = ?', (show_id,)).fetchone()
        if show is None:
            raise HTTPException(404, '放映不存在或已被删除')
        if not can_manage_show(db, show, user):
            raise HTTPException(403, '无放映管理权限')
        pages = [dict(p) for p in db.execute('''SELECT sr.*, r.id AS existing_resource_id, v.id AS existing_version_id
            FROM show_resources sr LEFT JOIN resources r ON r.id = sr.resource_id
            LEFT JOIN resource_versions v ON v.resource_id = sr.resource_id AND v.version_no = sr.version_no
            WHERE sr.show_id = ? ORDER BY sr.sort_order, sr.resource_id''', (show_id,))]
        missing = [p for p in pages if p['existing_resource_id'] is None or p['existing_version_id'] is None]
        snapshot = {'operation': 'cleanup', 'user_id': int(user['id']), 'show': dict(show), 'pages': pages}
        remaining = len(pages) - len(missing)
        if preview:
            return {'show_id': show_id, 'name': show['name'], 'missing_count': len(missing),
                    'remaining_pages': remaining, 'will_delete': remaining == 0, 'confirmation_token': _token(snapshot)}
        _check_token(snapshot, token)
        for page in missing:
            db.execute('DELETE FROM show_resources WHERE show_id = ? AND resource_id = ?', (show_id, page['resource_id']))
            db.execute('DELETE FROM show_remarks WHERE show_id = ? AND resource_id = ?', (show_id, page['resource_id']))
        missing_ids = sorted({int(page['resource_id']) for page in missing})
        if missing_ids:
            marks = ','.join('?' for _ in missing_ids)
            share_ids = [int(row['id']) for row in db.execute(
                'SELECT id FROM show_share_tokens WHERE show_id = ?', (show_id,)
            ).fetchall()]
            for share_id in share_ids:
                db.execute(f'''DELETE FROM show_share_pages
                    WHERE share_id = ? AND version_id IN
                      (SELECT id FROM resource_versions WHERE resource_id IN ({marks}))''',
                           [share_id, *missing_ids])
                db.execute('''UPDATE show_share_tokens SET revoked_at = ? WHERE id = ?
                    AND NOT EXISTS (SELECT 1 FROM show_share_pages WHERE share_id = ?)''',
                           (now_iso(), share_id, share_id))
        if remaining == 0:
            db.execute('DELETE FROM shows WHERE id = ?', (show_id,))
        else:
            for order, page in enumerate(p for p in pages if p not in missing):
                db.execute('UPDATE show_resources SET sort_order = ? WHERE show_id = ? AND resource_id = ?', (order, show_id, page['resource_id']))
            db.execute('UPDATE shows SET updated_at = ?, updated_by = ? WHERE id = ?', (now_iso(), user['id'], show_id))
        collect_archived_versions(db)
    drain_file_gc(db)
    return {'ok': True, 'reference_action': 'remove', 'resource_ids': [], 'affected_show_ids': [show_id],
            'deleted_show_ids': [show_id] if remaining == 0 else [], 'removed_pages': len(missing), 'deleted': 0, 'deleted_versions': 0}


async def archive_cleanup_loop() -> None:
    def sweep() -> None:
        from app.db import get_write_db, release_db
        db = get_write_db()
        try:
            maintain_archives(db)
        finally:
            release_db(db, readonly=False)
    while True:
        await asyncio.sleep(60)
        try:
            await asyncio.to_thread(sweep)
        except Exception:
            logger.exception('Archived resource sweep failed; will retry')
