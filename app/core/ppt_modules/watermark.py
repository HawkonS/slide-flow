"""Image and PPTX watermark generation."""

from __future__ import annotations

import logging
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image, ImageDraw, ImageFont

from .svg import _BLIP_REPAIR_DIRS, _repair_blip_in_xml
from .xml import _serialize_xml_with_ns_preservation


_logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 水印工具函数
# ---------------------------------------------------------------------------


def _build_watermark_tile(w: int, h: int, text: str) -> Image.Image:
    """预渲染旋转水印 tile 层，可复用于多张相同尺寸的图片。"""
    font_size = max(28, min(w, h) // 18)
    font = _get_cjk_font(font_size)

    dummy = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    bbox = dummy.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]

    diag = int((w ** 2 + h ** 2) ** 0.5)
    canvas_size = int(diag * 1.5)
    gap_x = max(int(w / 2.5), tw + 40)
    gap_y = max(int(h / 2.2), th + 40)

    tile_layer = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    tile_draw = ImageDraw.Draw(tile_layer)

    y = 0
    while y < canvas_size:
        x = 0
        while x < canvas_size:
            tile_draw.text((x, y), text, font=font, fill=(216, 216, 216, 55))
            x += gap_x
        y += gap_y

    rotated = tile_layer.rotate(30, resample=Image.BICUBIC, expand=False)
    tile_layer.close()
    return rotated


def add_watermark_to_image(img: Image.Image, text: str, tile: Image.Image | None = None) -> Image.Image:
    """在图片上叠加半透明斜向水印文字，返回新的 RGBA 图片。

    可选传入预渲染的 *tile*（由 ``_build_watermark_tile`` 生成），
    多张相同尺寸的图片共享同一 tile 可大幅提速。
    """
    if not text:
        return img
    base = img.convert("RGBA")
    w, h = base.size

    if tile is None:
        tile = _build_watermark_tile(w, h, text)
        tile_owned = True
    else:
        tile_owned = False

    try:
        cx, cy = tile.size[0] // 2, tile.size[1] // 2
        crop_box = (cx - w // 2, cy - h // 2, cx - w // 2 + w, cy - h // 2 + h)
        watermark_layer = tile.crop(crop_box)
        return Image.alpha_composite(base, watermark_layer)
    finally:
        if tile_owned:
            tile.close()


# 水印字体搜索顺序：项目字体仓库 > 系统字体（macOS/Linux/Windows）
_CJK_FONT_PATHS: list[str] = []


# 系统字体回退列表
_SYSTEM_FONT_PATHS = [
    # macOS
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    # Windows
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc",
    # Linux
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def _init_font_paths() -> None:
    """初始化字体搜索路径：优先使用项目字体仓库中的字体。"""
    from app.config import settings
    fonts_dir = settings.fonts_dir
    # 优先搜索项目字体仓库（支持 .ttf/.otf/.ttc）
    if fonts_dir.exists():
        # 优先匹配“Alibaba PuHuiTi”或“PuHuiTi”关键词的字体
        preferred: list[str] = []
        others: list[str] = []
        for f in sorted(fonts_dir.iterdir()):
            if f.suffix.lower() in (".ttf", ".otf", ".ttc"):
                if "puhuiti" in f.name.lower() or "alibaba" in f.name.lower():
                    preferred.append(str(f))
                else:
                    others.append(str(f))
        _CJK_FONT_PATHS.extend(preferred)
        _CJK_FONT_PATHS.extend(others)
    # 再追加系统字体回退
    _CJK_FONT_PATHS.extend(_SYSTEM_FONT_PATHS)


_cjk_font_loaded_path: str | None = None


def _get_cjk_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """尝试加载支持 CJK 字符的字体，逐级回退。"""
    global _cjk_font_loaded_path
    # 首次调用时初始化字体路径
    if not _CJK_FONT_PATHS:
        _init_font_paths()
    for path in _CJK_FONT_PATHS:
        try:
            font = ImageFont.truetype(path, size)
            if _cjk_font_loaded_path is None:
                _cjk_font_loaded_path = path
                _logger.info("水印字体加载成功: %s", path)
            return font
        except OSError:
            continue
    if _cjk_font_loaded_path is None:
        _cjk_font_loaded_path = "__default__"
        _logger.warning("未找到可用的 CJK 字体，回退到系统默认字体（中文可能无法正确显示）")
    return ImageFont.load_default()


def _watermark_shape_xml(
    shape_id: int,
    text: str,
    box_x: int,
    box_y: int,
    box_w: int,
    box_h: int,
    font_size: int = 2800,
) -> str:
    """生成一个文本框 shape 的 XML 片段，用于 PPTX 水印。"""
    # 旋转 -30 度（单位: 1/60000 度）
    rotation = -30 * 60000
    escaped_text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return (
        f'<p:sp>'
        f'<p:nvSpPr>'
        f'<p:cNvPr id="{shape_id}" name="Watermark {shape_id}"/>'
        f'<p:cNvSpPr txBox="1"/>'
        f'<p:nvPr/>'
        f'</p:nvSpPr>'
        f'<p:spPr>'
        f'<a:xfrm rot="{rotation}">'
        f'<a:off x="{box_x}" y="{box_y}"/>'
        f'<a:ext cx="{box_w}" cy="{box_h}"/>'
        f'</a:xfrm>'
        f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
        f'<a:noFill/>'
        f'<a:ln><a:noFill/></a:ln>'
        f'</p:spPr>'
        f'<p:txBody>'
        f'<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr" anchorCtr="1"/>'
        f'<a:lstStyle/>'
        f'<a:p><a:pPr algn="ctr"/>'
        f'<a:r>'
        f'<a:rPr lang="zh-CN" sz="{font_size}" b="0" i="0" u="none" strike="noStrike" dirty="0">'
        f'<a:solidFill><a:srgbClr val="D8D8D8"><a:alpha val="35000"/></a:srgbClr></a:solidFill>'
        f'<a:latin typeface="Microsoft YaHei"/>'
        f'<a:ea typeface="Microsoft YaHei"/>'
        f'</a:rPr>'
        f'<a:t>{escaped_text}</a:t>'
        f'</a:r>'
        f'</a:p>'
        f'</p:txBody>'
        f'</p:sp>'
    )


def add_watermark_to_pptx(pptx_path: Path, text: str) -> None:
    """就地修改 PPTX 文件，在幻灯片母版中添加水印文本框，所有幻灯片自动继承。

    性能优化：只读取需要修改的母版 XML，其余 ZIP 条目直接拷贝原始压缩数据，
    避免解压/重压缩大量媒体文件（PPTX 中的图片通常为 ZIP_STORED，直拷极快）。
    """
    if not text:
        return

    A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
    P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"

    # ── Pass 1: 只读取必要的 XML 文件 ──
    with zipfile.ZipFile(pptx_path, "r") as zf:
        all_names = zf.namelist()

        master_pattern = re.compile(r"^ppt/slideMasters/slideMaster\d+\.xml$")
        master_names = [n for n in all_names if master_pattern.match(n)]
        if not master_names:
            layout_pattern = re.compile(r"^ppt/slideLayouts/slideLayout\d+\.xml$")
            master_names = [n for n in all_names if layout_pattern.match(n)]
        if not master_names:
            return

        # 仅读取 presentation.xml + 母版 XML（通常 < 500KB）
        pres_data = zf.read("ppt/presentation.xml")
        master_data: dict[str, bytes] = {}
        for n in master_names:
            master_data[n] = zf.read(n)

    # ── 修改母版 XML（纯内存操作） ──
    pres_xml = ET.fromstring(pres_data)
    sld_sz = pres_xml.find(f"{{{P_NS}}}sldSz")
    slide_w = int(sld_sz.get("cx", "12192000")) if sld_sz is not None else 12192000
    slide_h = int(sld_sz.get("cy", "6858000")) if sld_sz is not None else 6858000

    wm_w = int(slide_w * 0.35)
    wm_h = int(slide_h * 0.12)
    cols, rows = 3, 2
    positions = []
    for row in range(rows):
        for col in range(cols):
            px = int(slide_w * (col + 0.5) / cols) - wm_w // 2
            py = int(slide_h * (row + 0.5) / rows) - wm_h // 2
            positions.append((px, py))

    modified_masters: dict[str, bytes] = {}
    for master_name in master_names:
        root = ET.fromstring(master_data[master_name])
        sp_tree = root.find(f".//{{{P_NS}}}spTree")
        if sp_tree is None:
            continue

        max_id = 1
        for cNvPr in sp_tree.iter(f"{{{P_NS}}}cNvPr"):
            try:
                max_id = max(max_id, int(cNvPr.get("id", "1")))
            except ValueError:
                pass
        for cNvPr in sp_tree.iter(f"{{{A_NS}}}cNvPr"):
            try:
                max_id = max(max_id, int(cNvPr.get("id", "1")))
            except ValueError:
                pass

        for i, (bx, by) in enumerate(positions):
            wm_xml = _watermark_shape_xml(
                max_id + 100 + i, text, bx, by, wm_w, wm_h, font_size=2800,
            )
            wrapped = (
                f'<__wrap xmlns:p="{P_NS}" xmlns:a="{A_NS}" '
                f'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                f'{wm_xml}</__wrap>'
            )
            wrapper = ET.fromstring(wrapped)
            wm_elem = wrapper[0]
            sp_tree.append(wm_elem)

        modified_masters[master_name] = _serialize_xml_with_ns_preservation(
            root, master_data[master_name]
        )

    # ── Pass 2: 重写 ZIP —— 未修改的条目直接拷贝原始压缩数据 ──
    master_set = set(modified_masters.keys())
    tmp_path = pptx_path.with_suffix(".tmp")
    with zipfile.ZipFile(pptx_path, "r") as zf_in, \
         zipfile.ZipFile(tmp_path, "w") as zf_out:
        for item in zf_in.infolist():
            if item.filename in master_set:
                # 仅对修改的母版 XML 重新压缩（通常 < 500KB）
                # 同时对母版应用 SVG blip 修补
                data = modified_masters[item.filename]
                repaired, _n = _repair_blip_in_xml(data)
                zf_out.writestr(item, repaired,
                                compress_type=zipfile.ZIP_DEFLATED)
            elif item.filename.endswith(".xml") and any(
                d in item.filename for d in _BLIP_REPAIR_DIRS
            ):
                # 兜底防御：对 slide/slideLayout/notesSlide 等可能含 <a:blip>
                # 的 XML 做 schema 修补（PowerPoint 另存导致的 SVG blip 缺主
                # r:embed 问题）。仅当需要修补时才重新压缩，否则直拷原压缩数据。
                raw = zf_in.read(item.filename)
                repaired, n = _repair_blip_in_xml(raw)
                if n > 0:
                    zf_out.writestr(item, repaired,
                                    compress_type=zipfile.ZIP_DEFLATED)
                else:
                    zf_out.writestr(item, raw, compress_type=item.compress_type)
            else:
                # 直拷原始压缩字节：ZIP_STORED(图片/媒体)跳过压缩，
                # ZIP_DEFLATED(XML)跳过解压+重压缩，极大提速
                raw = zf_in.read(item.filename)
                zf_out.writestr(item, raw, compress_type=item.compress_type)
    tmp_path.replace(pptx_path)


__all__ = ['_build_watermark_tile', 'add_watermark_to_image', 'add_watermark_to_pptx']
