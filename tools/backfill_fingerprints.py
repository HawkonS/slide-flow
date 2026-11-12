#!/usr/bin/env python3
"""Backfill image and text fingerprints for every current resource version.

This is an operational maintenance command. It only writes the two dedup cache
tables; resources, versions, shows and files are never modified. It is safe to
run while the service is online, although a low-traffic window is preferable
when thousands of PPTX files must be parsed.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.db import get_db  # noqa: E402
from app.services.fingerprints import (  # noqa: E402
    HASH_VERSION,
    TEXT_EXTRACTOR_VERSION,
    ensure_fingerprints,
    ensure_text_fingerprints,
)


ROW_SQL = """
SELECT r.id AS resource_id, r.current_version AS version_no,
       v.png_path, v.ppt_path,
       f.dhash AS fp_dhash, f.version_no AS fp_version,
       f.hash_version AS fp_hash_version,
       tf.text AS text_value, tf.version_no AS text_version,
       tf.extractor_version AS text_extractor_version
FROM resources r
JOIN resource_versions v
  ON v.resource_id = r.id AND v.version_no = r.current_version AND v.deleted_at IS NULL
LEFT JOIN resource_fingerprints f ON f.resource_id = r.id
LEFT JOIN resource_text_fingerprints tf ON tf.resource_id = r.id
WHERE r.deleted_at IS NULL
ORDER BY r.id
"""

COUNT_SQL = """
SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN v.png_path IS NOT NULL AND (
           f.dhash IS NULL OR f.version_no IS NULL OR f.version_no != r.current_version
           OR COALESCE(f.hash_version, 0) != ?
       ) THEN 1 ELSE 0 END), 0) AS image_pending,
       COALESCE(SUM(CASE WHEN v.ppt_path IS NOT NULL AND (
           tf.text IS NULL OR tf.version_no IS NULL OR tf.version_no != r.current_version
           OR COALESCE(tf.extractor_version, 0) != ?
       ) THEN 1 ELSE 0 END), 0) AS text_pending
FROM resources r
JOIN resource_versions v
  ON v.resource_id = r.id AND v.version_no = r.current_version AND v.deleted_at IS NULL
LEFT JOIN resource_fingerprints f ON f.resource_id = r.id
LEFT JOIN resource_text_fingerprints tf ON tf.resource_id = r.id
WHERE r.deleted_at IS NULL
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill duplicate fingerprints for all current resources")
    parser.add_argument("--image-batch", type=int, default=200, help="image fingerprints per pass (default 200)")
    parser.add_argument("--text-batch", type=int, default=40, help="PPTX text extractions per pass (default 40)")
    parser.add_argument("--image-workers", type=int, default=8, help="parallel OSS image reads (default 8)")
    parser.add_argument("--text-workers", type=int, default=4, help="parallel PPTX parses (default 4)")
    parser.add_argument("--max-passes", type=int, default=200, help="stop after this many passes (default 200)")
    parser.add_argument("--dry-run", action="store_true", help="only print pending counts")
    return parser.parse_args()


def counts(db: sqlite3.Connection) -> tuple[int, int, int]:
    row = db.execute(COUNT_SQL, (HASH_VERSION, TEXT_EXTRACTOR_VERSION)).fetchone()
    return int(row["total"]), int(row["image_pending"]), int(row["text_pending"])


def main() -> int:
    args = parse_args()
    db = get_db()
    try:
        try:
            db.execute("SELECT 1 FROM resource_fingerprints LIMIT 1")
            db.execute("SELECT 1 FROM resource_text_fingerprints LIMIT 1")
        except sqlite3.OperationalError as exc:
            print(f"数据库尚未完成新版迁移，请先启动新版服务：{exc}", file=sys.stderr)
            return 2

        total, image_pending, text_pending = counts(db)
        print(f"当前有效单页素材 {total} 个：图片待补 {image_pending}，文字待补 {text_pending}")
        if args.dry_run or (image_pending == 0 and text_pending == 0):
            return 0

        started = time.time()
        last_image = image_pending
        last_text = text_pending
        for pass_no in range(1, max(1, args.max_passes) + 1):
            rows = db.execute(ROW_SQL).fetchall()
            image_stored, _ = ensure_fingerprints(
                db, rows, limit=max(1, args.image_batch), workers=max(1, args.image_workers)
            )
            text_stored, _ = ensure_text_fingerprints(
                db, rows, limit=max(1, args.text_batch), workers=max(1, args.text_workers)
            )
            db.commit()
            _, image_pending, text_pending = counts(db)
            elapsed = int(time.time() - started)
            print(
                f"[{pass_no}] 新增图片指纹 {image_stored}、文字指纹 {text_stored}；"
                f"剩余 图片 {image_pending}、文字 {text_pending}；已用 {elapsed}s"
            )
            if image_pending == 0 and text_pending == 0:
                print("完成：全部有效素材已补齐图片和文字指纹。")
                return 0
            if image_stored == 0 and text_stored == 0 and image_pending == last_image and text_pending == last_text:
                print("本轮没有新增缓存；可能存在临时 OSS 读取失败，稍后重新运行即可。")
                return 2
            last_image, last_text = image_pending, text_pending
        print(f"已达到最大轮数 {args.max_passes}，仍有待补项；请重新运行继续。")
        return 2
    except KeyboardInterrupt:
        print("已中断；已完成批次均已提交，重新运行会从剩余项继续。", file=sys.stderr)
        return 130
    except Exception as exc:
        db.rollback()
        print(f"补指纹失败：{exc}", file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
