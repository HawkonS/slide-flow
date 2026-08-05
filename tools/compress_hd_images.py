#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SlideFlow 高清图批量压缩工具

根据 slide_flow.properties 中的 image.hd.* 配置，
扫描 data/assets/resources/ 下所有资源预览图（preview_*.png），
对超过阈值的图片等比缩放。根据 image.hd.format 决定输出格式：
  - jpeg：转为 JPEG 保存同时同步更新数据库 resource_versions.png_path。
  - png：仍以 PNG 保存（覆盖原文件），后缀不变，无需更新数据库。

用法:
    python tools/compress_hd_images.py             # 实际执行压缩
    python tools/compress_hd_images.py --dry-run   # 仅扫描并报告
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print("\033[91m[ERROR]\033[0m 未检测到 Pillow，请先执行: pip install Pillow")
    sys.exit(1)


# ---------------- 颜色与日志 ----------------

GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
BLUE = "\033[94m"
CYAN = "\033[96m"
RESET = "\033[0m"


def log_info(msg: str) -> None:
    print(f"{GREEN}[INFO]{RESET} {msg}")


def log_warn(msg: str) -> None:
    print(f"{YELLOW}[WARN]{RESET} {msg}")


def log_error(msg: str) -> None:
    print(f"{RED}[ERROR]{RESET} {msg}")


def log_step(msg: str) -> None:
    print(f"{BLUE}[STEP]{RESET} {msg}")


def log_dry(msg: str) -> None:
    print(f"{CYAN}[DRY-RUN]{RESET} {msg}")


# ---------------- 路径常量 ----------------

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROPERTIES_FILE = PROJECT_ROOT / "slide_flow.properties"
RESOURCES_DIR = PROJECT_ROOT / "data" / "assets" / "resources"
DB_PATH = PROJECT_ROOT / "data" / "db" / "slide_flow.db"


# ---------------- 配置读取 ----------------

def read_properties(path: Path) -> dict[str, str]:
    """逐行解析 INI 格式的 properties 文件，与 app/config.py 行为一致。"""
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


class HdImageConfig:
    def __init__(self, props: dict[str, str]) -> None:
        self.max_resolution = int(props.get("image.hd.max_resolution", "2560"))
        self.dpi = int(props.get("image.hd.dpi", "300"))
        self.format = props.get("image.hd.format", "png").lower()
        self.quality = int(props.get("image.hd.quality", "90"))

    def describe(self) -> str:
        return (
            f"max_resolution={self.max_resolution}, "
            f"dpi={self.dpi}, format={self.format}, quality={self.quality}"
        )


# ---------------- 文件扫描 ----------------

def scan_preview_pngs(root: Path) -> list[Path]:
    """扫描 resources 目录下所有 preview_*.png 文件。"""
    if not root.exists():
        return []
    # 仅一层子目录（每个资源 UUID 一个目录）
    return sorted(root.glob("*/preview_*.png"))


# ---------------- 压缩处理 ----------------

def needs_compress(img_path: Path, cfg: HdImageConfig) -> tuple[bool, int, int]:
    """检查图片是否需要压缩。返回 (是否需要, 宽, 高)。"""
    with Image.open(img_path) as im:
        w, h = im.size
    return max(w, h) > cfg.max_resolution, w, h


def compress_one(img_path: Path, cfg: HdImageConfig) -> Path:
    """对单个 PNG 进行压缩。

    - 若 cfg.format == "jpeg"：保存为同目录 .jpg，删除原 PNG，返回新路径。
    - 其他情况（默认 png）：以 PNG 无损格式覆盖原文件，路径不变。
    """
    fmt = cfg.format.lower()
    with Image.open(img_path) as im:
        # 等比缩放，最长边不超过 max_resolution
        im.thumbnail((cfg.max_resolution, cfg.max_resolution), Image.LANCZOS)

        if fmt == "jpeg":
            # 处理透明通道，填充白色背景
            if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
                background = Image.new("RGB", im.size, (255, 255, 255))
                rgba = im.convert("RGBA")
                background.paste(rgba, mask=rgba.split()[-1])
                out = background
            else:
                out = im.convert("RGB")

            new_path = img_path.with_suffix(".jpg")
            out.save(
                new_path,
                format="JPEG",
                quality=cfg.quality,
                optimize=True,
                dpi=(cfg.dpi, cfg.dpi),
            )
            # 压缩成功后删除原 PNG
            img_path.unlink()
            return new_path
        else:
            # PNG 无损格式，保留透明度，覆盖原文件
            new_path = img_path.with_suffix(".png")
            im.save(new_path, format="PNG", dpi=(cfg.dpi, cfg.dpi))
            return new_path


# ---------------- 数据库更新 ----------------

def db_update_path(conn: sqlite3.Connection, old_rel: str, new_rel: str) -> int:
    """更新 resource_versions.png_path，返回影响行数。"""
    cur = conn.execute(
        "UPDATE resource_versions SET png_path = ? WHERE png_path = ?",
        (new_rel, old_rel),
    )
    return cur.rowcount


def to_relative_db_path(abs_path: Path) -> str:
    """转换为数据库存储的相对路径（基于 PROJECT_ROOT），使用 POSIX 分隔符。"""
    rel = abs_path.resolve().relative_to(PROJECT_ROOT)
    return rel.as_posix()


# ---------------- 主流程 ----------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="SlideFlow 高清图批量压缩工具"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="仅扫描并报告将要处理的文件，不修改任何文件或数据库",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    log_step("加载配置")
    if not PROPERTIES_FILE.exists():
        log_error(f"配置文件不存在: {PROPERTIES_FILE}")
        return 1
    props = read_properties(PROPERTIES_FILE)
    cfg = HdImageConfig(props)
    log_info(f"压缩参数: {cfg.describe()}")

    if cfg.format not in ("jpeg", "png"):
        log_warn(f"image.hd.format={cfg.format}，仅支持 jpeg/png，将按 png 处理")
        cfg.format = "png"

    log_step(f"扫描预览图: {RESOURCES_DIR}")
    files = scan_preview_pngs(RESOURCES_DIR)
    total = len(files)
    log_info(f"共发现 {total} 个 preview_*.png 文件")

    if total == 0:
        log_warn("没有可处理的文件，退出")
        return 0

    if args.dry_run:
        log_warn("当前为 DRY-RUN 模式，不会修改任何文件或数据库")

    compressed = 0
    skipped = 0
    failed = 0

    # 数据库连接（dry-run 模式下不建立连接）
    conn: sqlite3.Connection | None = None
    if not args.dry_run:
        if not DB_PATH.exists():
            log_error(f"数据库文件不存在: {DB_PATH}")
            return 1
        try:
            conn = sqlite3.connect(str(DB_PATH), timeout=30.0)
        except sqlite3.Error as exc:
            log_error(f"数据库连接失败: {exc}")
            return 1

    try:
        for idx, img_path in enumerate(files, start=1):
            prefix = f"[{idx}/{total}]"
            try:
                need, w, h = needs_compress(img_path, cfg)
            except Exception as exc:
                log_error(f"{prefix} 无法读取图片 {img_path.name}: {exc}")
                failed += 1
                continue

            rel_old = to_relative_db_path(img_path)

            if not need:
                log_info(f"{prefix} 跳过（{w}x{h} 未超阈值）: {rel_old}")
                skipped += 1
                continue

            if args.dry_run:
                if cfg.format == "jpeg":
                    log_dry(
                        f"{prefix} 将压缩 {w}x{h} -> 最长边≤{cfg.max_resolution} "
                        f"JPEG q{cfg.quality}: {rel_old}"
                    )
                else:
                    log_dry(
                        f"{prefix} 将压缩 {w}x{h} -> 最长边≤{cfg.max_resolution} "
                        f"PNG 无损: {rel_old}"
                    )
                compressed += 1
                continue

            # 实际执行
            try:
                new_path = compress_one(img_path, cfg)
            except Exception as exc:
                log_error(f"{prefix} 压缩失败 {img_path.name}: {exc}")
                failed += 1
                continue

            rel_new = to_relative_db_path(new_path)

            # 仅在路径变化时（如 png -> jpg）才需同步数据库
            if rel_new != rel_old:
                try:
                    assert conn is not None
                    with conn:  # 自动事务
                        rows = db_update_path(conn, rel_old, rel_new)
                except sqlite3.Error as exc:
                    log_error(
                        f"{prefix} 数据库更新失败 {rel_old} -> {rel_new}: {exc}"
                    )
                    failed += 1
                    continue

                if rows == 0:
                    log_warn(
                        f"{prefix} 已压缩但数据库无匹配记录: {rel_old}"
                    )
                log_info(
                    f"{prefix} 已压缩 {w}x{h} -> {cfg.format.upper()}: {rel_new}（更新 {rows} 行）"
                )
            else:
                # 路径未变（PNG 覆写），无需更新数据库
                log_info(
                    f"{prefix} 已压缩 {w}x{h} -> {cfg.format.upper()}: {rel_new}"
                )
            compressed += 1
    finally:
        if conn is not None:
            conn.close()

    # ---------------- 统计输出 ----------------
    log_step("处理完成")
    log_info(f"已压缩: {compressed}")
    log_info(f"已跳过（低于阈值）: {skipped}")
    if failed > 0:
        log_error(f"失败: {failed}")
    else:
        log_info(f"失败: {failed}")
    log_info(f"总计: {total}")
    if args.dry_run:
        log_warn("以上为 DRY-RUN 预览结果，未实际修改任何文件或数据库")

    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
