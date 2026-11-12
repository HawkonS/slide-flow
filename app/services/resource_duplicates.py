"""Find and merge duplicate single-page resources by perceptual fingerprint."""

from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any

from fastapi import HTTPException

from app.core.permissions import can_manage_resource, can_manage_show, manageable_resource_ids
from app.db import now_iso
from app.services.files import asset_preview_url
from app.services.fingerprints import (
    HASH_VERSION,
    MAX_DUPLICATE_DISTANCE,
    ensure_fingerprints,
    ensure_text_fingerprints,
    hamming_distance,
    parse_dhash,
    text_for_resources,
)
from app.services.resource_deletion import delete_resources

logger = logging.getLogger(__name__)

MAX_MERGE_GROUP = 50


def _manageable_rows(db: sqlite3.Connection, user: sqlite3.Row) -> list[sqlite3.Row]:
    rows = db.execute(
        """
        SELECT r.id AS id, r.id AS resource_id, r.name, r.owner_id,
               r.visibility_scope, r.management_scope, r.created_at,
               r.current_version AS version_no, v.png_path, v.id AS version_id, v.ppt_path,
               f.dhash AS fp_dhash, f.version_no AS fp_version, f.hash_version AS fp_hash_version,
               tf.text AS text_value, tf.version_no AS text_version,
               tf.extractor_version AS text_extractor_version,
               u.name AS owner_name, u.username AS owner_username
        FROM resources r
        JOIN resource_versions v
          ON v.resource_id = r.id AND v.version_no = r.current_version AND v.deleted_at IS NULL
        LEFT JOIN users u ON u.id = r.owner_id
        LEFT JOIN resource_fingerprints f ON f.resource_id = r.id
        LEFT JOIN resource_text_fingerprints tf ON tf.resource_id = r.id
        WHERE r.deleted_at IS NULL
        ORDER BY r.id
        """
    ).fetchall()
    manageable = manageable_resource_ids(db, user)
    return [row for row in rows if int(row["id"]) in manageable]


def _chunks(values: list[int], size: int = 500):
    for offset in range(0, len(values), size):
        yield values[offset:offset + size]


def _usage_counts(db: sqlite3.Connection, resource_ids: list[int]) -> dict[int, int]:
    counts: dict[int, int] = {}
    for chunk in _chunks(sorted(set(resource_ids))):
        placeholders = ",".join("?" for _ in chunk)
        for row in db.execute(
            f"SELECT resource_id, COUNT(*) AS total FROM show_resources WHERE resource_id IN ({placeholders}) GROUP BY resource_id",
            chunk,
        ):
            counts[int(row["resource_id"])] = int(row["total"])
    return counts


def _show_ids_for(db: sqlite3.Connection, resource_ids: list[int]) -> set[int]:
    if not resource_ids:
        return set()
    show_ids: set[int] = set()
    for chunk in _chunks(sorted(set(resource_ids))):
        placeholders = ",".join("?" for _ in chunk)
        show_ids.update(
            int(row["show_id"])
            for row in db.execute(
                f"SELECT DISTINCT show_id FROM show_resources WHERE resource_id IN ({placeholders})",
                chunk,
            )
        )
    return show_ids


def _shows_for_resources(db: sqlite3.Connection, resource_ids: list[int], user: sqlite3.Row) -> list[dict[str, Any]]:
    if not resource_ids:
        return []
    rows: list[sqlite3.Row] = []
    for chunk in _chunks(sorted(set(resource_ids))):
        placeholders = ",".join("?" for _ in chunk)
        rows.extend(db.execute(
            f"""SELECT sr.show_id, sr.sort_order, s.name, s.owner_id, s.management_scope
                FROM show_resources sr JOIN shows s ON s.id = sr.show_id
                WHERE sr.resource_id IN ({placeholders})
                ORDER BY s.id, sr.sort_order""",
            chunk,
        ).fetchall())
    shows: dict[int, dict[str, Any]] = {}
    for row in rows:
        show_id = int(row["show_id"])
        entry = shows.get(show_id)
        if entry is None:
            entry = {
                "id": show_id,
                "name": row["name"],
                "pages": [],
                "manageable": can_manage_show(db, row, user),
            }
            shows[show_id] = entry
        entry["pages"].append(int(row["sort_order"]) + 1)
    for entry in shows.values():
        entry["pages"] = sorted(set(entry["pages"]))
    return list(shows.values())


def _resource_payload(row: sqlite3.Row, used_by_shows: int) -> dict[str, Any]:
    preview = asset_preview_url(row["png_path"], thumb=True) or f"/api/resources/{row['resource_id']}/preview-thumb?version_id={row['version_id']}"
    return {
        "id": int(row["resource_id"]),
        "name": row["name"],
        "version_no": int(row["version_no"]),
        "preview_url": preview,
        "owner_name": row["owner_name"] or row["owner_username"] or "",
        "used_by_shows": used_by_shows,
        "created_at": row["created_at"],
    }


def scan_duplicates(db: sqlite3.Connection, user: sqlite3.Row, *, limit: int = 120) -> dict[str, Any]:
    """Cluster manageable resources whose current previews look identical."""
    rows = _manageable_rows(db, user)
    processed, remaining = ensure_fingerprints(db, rows, limit=limit)
    if processed:
        db.commit()
    stored = {
        int(row["resource_id"]): (int(row["version_no"]), row["dhash"])
        for row in db.execute("SELECT resource_id, version_no, dhash FROM resource_fingerprints WHERE hash_version = ?", (HASH_VERSION,))
    }
    entries: list[tuple[sqlite3.Row, int]] = []
    for row in rows:
        entry = stored.get(int(row["resource_id"]))
        if entry is None or not entry[1] or entry[0] != int(row["version_no"]):
            continue
        entries.append((row, parse_dhash(entry[1])))

    clusters: list[dict[str, Any]] = []
    for row, value in entries:
        for cluster in clusters:
            if hamming_distance(cluster["fingerprint"], value) <= MAX_DUPLICATE_DISTANCE:
                cluster["members"].append(row)
                break
        else:
            clusters.append({"fingerprint": value, "members": [row]})

    text_remaining = 0
    for cluster in clusters:
        members = cluster["members"]
        if len(members) < 2:
            continue
        processed, pending = ensure_text_fingerprints(db, members, limit=40)
        if processed:
            db.commit()
        text_remaining += pending
    all_ids = [int(member["resource_id"]) for cluster in clusters for member in cluster["members"]]
    texts = text_for_resources(db, all_ids)
    for cluster in clusters:
        for member in cluster["members"]:
            resource_id = int(member["resource_id"])
            if resource_id not in texts and not member["ppt_path"]:
                texts[resource_id] = ""

    groups: list[dict[str, Any]] = []
    for cluster in clusters:
        members = cluster["members"]
        if len(members) < 2:
            continue
        if any(int(member["resource_id"]) not in texts for member in members):
            continue
        by_text: dict[str, list[sqlite3.Row]] = {}
        for member in members:
            by_text.setdefault(texts[int(member["resource_id"])], []).append(member)
        for text_value, text_members in by_text.items():
            if len(text_members) < 2:
                continue
            members = text_members
            ids = [int(member["resource_id"]) for member in members]
            usage = _usage_counts(db, ids)
            show_ids = _show_ids_for(db, ids)
            mergeable = True
            reason: str | None = None
            for show_id in show_ids:
                show = db.execute("SELECT * FROM shows WHERE id = ?", (show_id,)).fetchone()
                if show is None or not can_manage_show(db, show, user):
                    mergeable = False
                    reason = "部分引用放映无管理权限，无法合并引用"
                    break
            resources = sorted(
                (_resource_payload(member, usage.get(int(member["resource_id"]), 0)) for member in members),
                key=lambda item: (-item["used_by_shows"], -item["id"]),
            )
            foreign_resource_ids = [
                int(member["resource_id"]) for member in members
                if int(member["owner_id"]) != int(user["id"])
            ]
            foreign_show_ids = [
                show_id for show_id in show_ids
                if int((db.execute("SELECT owner_id FROM shows WHERE id = ?", (show_id,)).fetchone() or {"owner_id": 0})["owner_id"]) != int(user["id"])
            ]
            if len(resources) > MAX_MERGE_GROUP + 1:
                mergeable = False
                reason = f"同组超过 {MAX_MERGE_GROUP} 个，请分批处理"
            groups.append({
                "resources": resources,
                "show_count": len(show_ids),
                "shows": _shows_for_resources(db, ids, user),
                "mergeable": mergeable,
                "reason": reason,
                "text_checked": bool(text_value),
                "foreign_resource_count": len(foreign_resource_ids),
                "foreign_show_count": len(foreign_show_ids),
            })
    groups.sort(key=lambda group: (-len(group["resources"]), -group["show_count"]))
    return {
        "status": "warming" if remaining > 0 or text_remaining > 0 else "ready",
        "total": len(rows),
        "checked": max(0, len(rows) - remaining),
        "remaining": remaining,
        "text_remaining": text_remaining,
        "groups": groups,
    }


def merge_duplicates(
    db: sqlite3.Connection,
    canonical_id: int,
    duplicate_ids: list[int],
    user: sqlite3.Row,
    *,
    acknowledge_foreign: bool = False,
) -> dict[str, Any]:
    """Point every duplicate page at the canonical resource, then remove the duplicates."""
    if type(canonical_id) is not int or canonical_id <= 0:
        raise HTTPException(400, "请选择要保留的素材")
    if (
        not isinstance(duplicate_ids, list)
        or not duplicate_ids
        or len(duplicate_ids) > MAX_MERGE_GROUP
        or any(type(rid) is not int or rid <= 0 for rid in duplicate_ids)
    ):
        raise HTTPException(400, f"请选择 1 至 {MAX_MERGE_GROUP} 个要合并的素材")
    duplicate_ids = sorted(set(duplicate_ids))
    if canonical_id in duplicate_ids:
        raise HTTPException(400, "保留素材不能同时出现在要合并的列表里")

    try:
        ids = [canonical_id, *duplicate_ids]
        placeholders = ",".join("?" for _ in ids)
        rows = db.execute(
            f"SELECT * FROM resources WHERE id IN ({placeholders}) AND deleted_at IS NULL",
            ids,
        ).fetchall()
        by_id = {int(row["id"]): row for row in rows}
        if len(by_id) != len(ids):
            raise HTTPException(404, "部分素材不存在或已删除，请刷新后重试")
        for row in rows:
            if not can_manage_resource(db, row, user):
                raise HTTPException(403, "部分素材无管理权限")
        canonical = by_id[canonical_id]
        canonical_version = int(canonical["current_version"])

        show_ids = _show_ids_for(db, duplicate_ids)
        foreign_show_ids: list[int] = []
        for show_id in show_ids:
            show = db.execute("SELECT * FROM shows WHERE id = ?", (show_id,)).fetchone()
            if show is None or not can_manage_show(db, show, user):
                raise HTTPException(403, "部分引用放映无管理权限，无法合并引用")
            if int(show["owner_id"]) != int(user["id"]):
                foreign_show_ids.append(show_id)

        foreign_resource_ids = [rid for rid in duplicate_ids if int(by_id[rid]["owner_id"]) != int(user["id"])]
        if (foreign_resource_ids or foreign_show_ids) and not acknowledge_foreign:
            raise HTTPException(409, "这组素材包含他人素材或他人放映，请确认后再合并")

        # Fixed-version share snapshots cannot be rewritten safely; require an
        # explicit revoke instead of silently removing them during a merge.
        placeholders = ",".join("?" for _ in duplicate_ids)
        active_shares = db.execute(
            f"""SELECT COUNT(*) FROM show_share_pages p
                JOIN resource_versions v ON v.id = p.version_id
                JOIN show_share_tokens st ON st.id = p.share_id
                WHERE v.resource_id IN ({placeholders}) AND st.revoked_at IS NULL AND st.expires_at > ?""",
            [*duplicate_ids, now_iso()],
        ).fetchone()[0]
        if active_shares:
            raise HTTPException(409, "部分素材仍被生效中的分享链接引用，请先撤销相关分享后再合并")

        # Merge requires matching text as well as matching images. The scan
        # already groups by text, but the API must not rely on the UI.
        text_rows = db.execute(
            f"""SELECT r.id AS resource_id, r.current_version AS version_no, v.ppt_path,
                       tf.text AS text_value, tf.version_no AS text_version,
                       tf.extractor_version AS text_extractor_version
                FROM resources r
                JOIN resource_versions v ON v.resource_id = r.id AND v.version_no = r.current_version AND v.deleted_at IS NULL
                LEFT JOIN resource_text_fingerprints tf ON tf.resource_id = r.id
                WHERE r.id IN ({",".join("?" for _ in ids)})""",
            ids,
        ).fetchall()
        processed, remaining = ensure_text_fingerprints(db, text_rows, limit=MAX_MERGE_GROUP + 5, workers=4)
        if remaining:
            raise HTTPException(409, "文字内容尚未比对完成，请稍后重新扫描再合并")
        texts = text_for_resources(db, ids)
        missing_text_ids = [rid for rid in ids if rid not in texts]
        if missing_text_ids:
            # Image-only resources legitimately have no PPTX/text source. They
            # are treated as empty text; a resource with a PPTX but no cached
            # text is a retryable failure and must not be merged blindly.
            text_by_id = {int(row["resource_id"]): row for row in text_rows}
            for resource_id in missing_text_ids:
                ppt_path = text_by_id.get(resource_id)
                if ppt_path is None or not ppt_path["ppt_path"]:
                    texts[resource_id] = ""
                else:
                    raise HTTPException(409, "部分素材缺少文字信息，请重新扫描后再合并")
        if len(set(texts.values())) != 1:
            raise HTTPException(409, "这些素材的文字内容不同，不能合并")

        # Refuse a stale merge: the user reviewed a group while the files changed.
        fingerprints: dict[int, int] = {}
        for resource_id in ids:
            row = db.execute(
                """SELECT f.dhash, f.version_no, f.hash_version FROM resource_fingerprints f
                   JOIN resources r ON r.id = f.resource_id
                   WHERE f.resource_id = ? AND f.version_no = r.current_version""",
                (resource_id,),
            ).fetchone()
            if row is None or not row["dhash"] or int(row["hash_version"] or 0) != HASH_VERSION:
                raise HTTPException(409, "素材指纹已失效，请重新扫描后合并")
            fingerprints[resource_id] = parse_dhash(row["dhash"])
        for duplicate_id in duplicate_ids:
            if hamming_distance(fingerprints[canonical_id], fingerprints[duplicate_id]) > MAX_DUPLICATE_DISTANCE:
                raise HTTPException(409, "素材内容已变化，请重新扫描后合并")

        # Text extraction above can be slow; commit any cache writes first so
        # the writer lock only covers the fast, authoritative re-check and the
        # page/sort renumbering below.
        if processed:
            db.commit()
        if not db.in_transaction:
            db.execute("BEGIN IMMEDIATE")

        fresh_rows = db.execute(
            f"SELECT * FROM resources WHERE id IN ({','.join('?' for _ in ids)}) AND deleted_at IS NULL",
            ids,
        ).fetchall()
        fresh_by_id = {int(row["id"]): row for row in fresh_rows}
        if len(fresh_by_id) != len(ids):
            raise HTTPException(409, "素材已变化，请重新扫描后合并")
        for row in fresh_rows:
            if not can_manage_resource(db, row, user):
                raise HTTPException(409, "素材权限已变化，请重新扫描后合并")
        for resource_id in ids:
            if int(fresh_by_id[resource_id]["current_version"]) != int(by_id[resource_id]["current_version"]):
                raise HTTPException(409, "素材版本已变化，请重新扫描后合并")
        canonical = fresh_by_id[canonical_id]
        canonical_version = int(canonical["current_version"])

        fresh_show_ids = _show_ids_for(db, duplicate_ids)
        fresh_foreign_show_ids: list[int] = []
        for show_id in fresh_show_ids:
            show = db.execute("SELECT * FROM shows WHERE id = ?", (show_id,)).fetchone()
            if show is None or not can_manage_show(db, show, user):
                raise HTTPException(409, "引用放映的权限已变化，请重新扫描后合并")
            if int(show["owner_id"]) != int(user["id"]):
                fresh_foreign_show_ids.append(show_id)
        fresh_foreign_resource_ids = [rid for rid in duplicate_ids if int(fresh_by_id[rid]["owner_id"]) != int(user["id"])]
        if (fresh_foreign_resource_ids or fresh_foreign_show_ids) and not acknowledge_foreign:
            raise HTTPException(409, "这组素材包含他人素材或他人放映，请确认后再合并")

        placeholders = ",".join("?" for _ in duplicate_ids)
        fresh_active_shares = db.execute(
            f"""SELECT COUNT(*) FROM show_share_pages p
                JOIN resource_versions v ON v.id = p.version_id
                JOIN show_share_tokens st ON st.id = p.share_id
                WHERE v.resource_id IN ({placeholders}) AND st.revoked_at IS NULL AND st.expires_at > ?""",
            [*duplicate_ids, now_iso()],
        ).fetchone()[0]
        if fresh_active_shares:
            raise HTTPException(409, "部分素材仍被生效中的分享链接引用，请先撤销相关分享后再合并")

        fresh_fingerprints: dict[int, int] = {}
        for resource_id in ids:
            row = db.execute(
                """SELECT f.dhash, f.version_no, f.hash_version FROM resource_fingerprints f
                   JOIN resources r ON r.id = f.resource_id
                   WHERE f.resource_id = ? AND f.version_no = r.current_version""",
                (resource_id,),
            ).fetchone()
            if row is None or not row["dhash"] or int(row["hash_version"] or 0) != HASH_VERSION:
                raise HTTPException(409, "素材指纹已变化，请重新扫描后合并")
            fresh_fingerprints[resource_id] = parse_dhash(row["dhash"])
        for duplicate_id in duplicate_ids:
            if hamming_distance(fresh_fingerprints[canonical_id], fresh_fingerprints[duplicate_id]) > MAX_DUPLICATE_DISTANCE:
                raise HTTPException(409, "素材内容已变化，请重新扫描后合并")

        fresh_texts = text_for_resources(db, ids)
        for resource_id in ids:
            if resource_id not in fresh_texts:
                row = db.execute(
                    "SELECT v.ppt_path FROM resources r JOIN resource_versions v ON v.resource_id = r.id AND v.version_no = r.current_version WHERE r.id = ?",
                    (resource_id,),
                ).fetchone()
                if row is None or not row["ppt_path"]:
                    fresh_texts[resource_id] = ""
                else:
                    raise HTTPException(409, "素材文字信息已变化，请重新扫描后合并")
        if len(set(fresh_texts.values())) != 1:
            raise HTTPException(409, "这些素材的文字内容不同，不能合并")

        foreign_show_ids = fresh_foreign_show_ids
        foreign_resource_ids = fresh_foreign_resource_ids
        moved_pages = 0
        collapsed_pages = 0
        affected_shows: set[int] = set()
        ts = now_iso()
        for duplicate_id in duplicate_ids:
            pages = db.execute(
                "SELECT show_id, is_hidden FROM show_resources WHERE resource_id = ?",
                (duplicate_id,),
            ).fetchall()
            for page in pages:
                show_id = int(page["show_id"])
                affected_shows.add(show_id)
                exists = db.execute(
                    "SELECT 1 FROM show_resources WHERE show_id = ? AND resource_id = ?",
                    (show_id, canonical_id),
                ).fetchone()
                if exists:
                    db.execute(
                        "DELETE FROM show_resources WHERE show_id = ? AND resource_id = ?",
                        (show_id, duplicate_id),
                    )
                    db.execute(
                        "DELETE FROM show_remarks WHERE show_id = ? AND resource_id = ?",
                        (show_id, duplicate_id),
                    )
                    collapsed_pages += 1
                else:
                    db.execute(
                        "UPDATE show_resources SET resource_id = ?, version_no = ? WHERE show_id = ? AND resource_id = ?",
                        (canonical_id, canonical_version, show_id, duplicate_id),
                    )
                    db.execute(
                        "UPDATE OR IGNORE show_remarks SET resource_id = ? WHERE show_id = ? AND resource_id = ?",
                        (canonical_id, show_id, duplicate_id),
                    )
                    db.execute(
                        "DELETE FROM show_remarks WHERE show_id = ? AND resource_id = ?",
                        (show_id, duplicate_id),
                    )
                    moved_pages += 1
            db.execute(
                "UPDATE OR IGNORE show_remarks SET resource_id = ? WHERE resource_id = ?",
                (canonical_id, duplicate_id),
            )
            db.execute("DELETE FROM show_remarks WHERE resource_id = ?", (duplicate_id,))
        for show_id in affected_shows:
            pages = db.execute(
                "SELECT resource_id FROM show_resources WHERE show_id = ? ORDER BY sort_order, resource_id",
                (show_id,),
            ).fetchall()
            for order, page in enumerate(pages):
                db.execute(
                    "UPDATE show_resources SET sort_order = ? WHERE show_id = ? AND resource_id = ?",
                    (order, show_id, page["resource_id"]),
                )
            db.execute(
                "UPDATE shows SET updated_at = ?, updated_by = ? WHERE id = ?",
                (ts, user["id"], show_id),
            )
        db.commit()
    except Exception:
        db.rollback()
        raise

    deleted: list[int] = []
    for duplicate_id in duplicate_ids:
        try:
            if not db.in_transaction:
                db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM show_resources WHERE resource_id = ? LIMIT 1", (duplicate_id,)).fetchone():
                db.rollback()
                continue
            delete_resources(db, [duplicate_id], "all", user, action="remove", token=None)
            deleted.append(duplicate_id)
        except HTTPException:
            if db.in_transaction:
                db.rollback()
        except Exception:
            if db.in_transaction:
                db.rollback()
            logger.exception("删除重复素材失败: resource_id=%s", duplicate_id)
    try:
        db.execute(
            """INSERT INTO resource_duplicate_merges (
                   actor_id, canonical_id, duplicate_ids, moved_pages, collapsed_pages,
                   affected_show_ids, foreign_resource_ids, foreign_show_ids, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                int(user["id"]), canonical_id, json.dumps(duplicate_ids, ensure_ascii=False),
                moved_pages, collapsed_pages, json.dumps(sorted(affected_shows), ensure_ascii=False),
                json.dumps(foreign_resource_ids, ensure_ascii=False),
                json.dumps(foreign_show_ids, ensure_ascii=False), now_iso(),
            ),
        )
        db.commit()
    except Exception:
        db.rollback()
    skipped = [rid for rid in duplicate_ids if rid not in deleted]
    return {
        "ok": True,
        "canonical_id": canonical_id,
        "merged": len(deleted),
        "deleted": deleted,
        "skipped": skipped,
        "moved_pages": moved_pages,
        "collapsed_pages": collapsed_pages,
        "affected_show_ids": sorted(affected_shows),
    }
