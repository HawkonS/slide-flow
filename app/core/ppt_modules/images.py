"""Image canvas sizing and image-based PPTX construction."""

from __future__ import annotations

import struct
import zipfile
from pathlib import Path

from PIL import Image

from .package import _PRECOMPRESSED_EXTS


# ---------------------------------------------------------------------------
# Build a PPTX from a list of images (one image per slide)
# ---------------------------------------------------------------------------

# 16:9 宽屏主流幻灯片尺寸（13.333" x 7.5"，单位 EMU）
_IMG_SLIDE_W_EMU = 12192000


_IMG_SLIDE_H_EMU = 6858000


# PDF 页面默认尺寸（16:9 宽屏），作为无法预扫描时的回退值
_PDF_TARGET_W = 1920


_PDF_TARGET_H = 1080


def _png_dimensions(path: Path) -> tuple[int, int] | None:
    """快速读取 PNG 尺寸，仅读文件头 24 字节，避免 PIL 开销。"""
    try:
        with path.open("rb") as f:
            header = f.read(24)
        if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
            return None
        # IHDR chunk: offset 16 = width(4) + height(4)  big-endian uint32
        w, h = struct.unpack(">II", header[16:24])
        return w, h
    except Exception:
        return None


def determine_pdf_canvas_size(png_paths: list[Path]) -> tuple[int, int]:
    """根据图片集合动态确定 PDF 统一画布尺寸。

    策略：取所有图片的最大宽度和最大高度作为画布尺寸，
    确保每张图片都能等比缩放后完整放入画布。
    - 若全部图片都是 16:9，画布即为 16:9
    - 若全部图片都是 4:3，画布即为 4:3
    - 若混合比例，画布取最大宽×最大高，少数比例不同的图片两侧留白
    """
    max_w, max_h = 0, 0
    for p in png_paths:
        if not p.exists():
            continue
        dim = _png_dimensions(p)
        if dim:
            max_w = max(max_w, dim[0])
            max_h = max(max_h, dim[1])
            continue
        # 非 PNG 或读头失败时回退到 PIL
        try:
            with Image.open(p) as img:
                max_w = max(max_w, img.width)
                max_h = max(max_h, img.height)
        except Exception:
            continue
    if max_w == 0 or max_h == 0:
        return _PDF_TARGET_W, _PDF_TARGET_H  # 回退到默认 16:9
    # 限制最大分辨率不超过 4K，避免内存与处理时间过高
    if max_w > 3840 or max_h > 2160:
        ratio = min(3840 / max_w, 2160 / max_h)
        max_w = int(max_w * ratio)
        max_h = int(max_h * ratio)
    # 确保偶数（部分编码器要求）
    max_w += max_w % 2
    max_h += max_h % 2
    return max_w, max_h


def fit_image_to_canvas(
    img: Image.Image,
    target_w: int = _PDF_TARGET_W,
    target_h: int = _PDF_TARGET_H,
) -> Image.Image:
    """将图片等比缩放并居中放置到统一尺寸的白色画布上。

    保证输出图片尺寸一致，从而使 PDF 各页面大小统一。
    不同宽高比的图片会保留完整内容，两侧/上下留白。
    """
    if img.width == target_w and img.height == target_h:
        return img
    ratio = min(target_w / img.width, target_h / img.height)
    new_w = max(1, int(img.width * ratio))
    new_h = max(1, int(img.height * ratio))
    # 放大用 BILINEAR（快），缩小用 LANCZOS（高质量）
    resample = Image.BILINEAR if ratio > 1 else Image.LANCZOS
    resized = img.resize((new_w, new_h), resample)
    canvas = Image.new("RGB", (target_w, target_h), (255, 255, 255))
    offset_x = (target_w - new_w) // 2
    offset_y = (target_h - new_h) // 2
    canvas.paste(resized, (offset_x, offset_y))
    resized.close()
    return canvas


_IMG_EXT_TO_CT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}


_IMG_PPTX_ROOT_RELS = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>"""


_IMG_PPTX_THEME = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">
<a:themeElements>
<a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2>
<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1>
<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
<a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
<a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink>
<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="Office">
<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="Office">
<a:fillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:fillStyleLst>
<a:lnStyleLst>
<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
</a:lnStyleLst>
<a:effectStyleLst>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
</a:effectStyleLst>
<a:bgFillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>"""


_IMG_PPTX_MASTER = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld>
<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree>
</p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>"""


_IMG_PPTX_MASTER_RELS = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>"""


_IMG_PPTX_LAYOUT = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="\xe7\xa9\xba\xe7\x99\xbd">
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>"""


_IMG_PPTX_LAYOUT_RELS = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>"""


def _build_image_slide_xml() -> bytes:
    """生成幻灯片 XML：不插入图片，改为在幻灯片背景中以图片填充全页。"""
    return (
        b"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
        b"<p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\""
        b" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\""
        b" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">"
        b"<p:cSld>"
        b"<p:bg><p:bgPr>"
        b"<a:blipFill dpi=\"0\" rotWithShape=\"1\">"
        b"<a:blip r:embed=\"rId2\"/>"
        b"<a:srcRect/>"
        b"<a:stretch><a:fillRect/></a:stretch>"
        b"</a:blipFill>"
        b"<a:effectLst/>"
        b"</p:bgPr></p:bg>"
        b"<p:spTree>"
        b"<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>"
        b"<p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/>"
        b"<a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>"
        b"</p:spTree></p:cSld>"
        b"<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>"
        b"</p:sld>"
    )


def _build_image_slide_rels(image_target: str) -> bytes:
    return (
        b"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
        b"<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
        b"<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>"
        + f"<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"{image_target}\"/>".encode("utf-8")
        + b"</Relationships>"
    )


def _read_image_size(path: Path) -> tuple[int, int]:
    """读取图片像素尺寸，失败时返回 16:9 占位尺寸。保留为其他调用点备用。"""
    try:
        from PIL import Image as _PILImage  # 延迟导入，避免循环依赖
        with _PILImage.open(path) as img:
            return int(img.width), int(img.height)
    except Exception:
        return 1600, 900


def build_image_pptx(image_paths: list[Path], output_path: Path) -> None:
    """以一组图片构建一个纯图 PPTX，每张图作为一页。

    每页以“图片填充”的形式将图片作为幻灯片背景填满全页，不插入独立的图片对象；
    幻灯片尺寸采用 16:9 宽屏，母版为纯白背景。
    仅依赖 zipfile 与字符串，不引入 python-pptx 等额外依赖。
    """
    if not image_paths:
        raise ValueError("image_paths must not be empty")
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    paths = [Path(p) for p in image_paths]

    files: dict[str, bytes] = {}
    files["_rels/.rels"] = _IMG_PPTX_ROOT_RELS
    files["ppt/theme/theme1.xml"] = _IMG_PPTX_THEME
    files["ppt/slideMasters/slideMaster1.xml"] = _IMG_PPTX_MASTER
    files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = _IMG_PPTX_MASTER_RELS
    files["ppt/slideLayouts/slideLayout1.xml"] = _IMG_PPTX_LAYOUT
    files["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = _IMG_PPTX_LAYOUT_RELS

    slide_id_lst: list[str] = []
    pres_rels: list[str] = []
    ct_overrides: list[str] = []
    used_exts: set[str] = set()

    pres_rels.append(
        '<Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
    )
    pres_rels.append(
        '<Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>'
    )

    slide_w = _IMG_SLIDE_W_EMU
    slide_h = _IMG_SLIDE_H_EMU

    for index, img_path in enumerate(paths, start=1):
        ext = img_path.suffix.lower() or ".png"
        if ext not in _IMG_EXT_TO_CT:
            ext = ".png"
        used_exts.add(ext)
        media_name = f"image{index}{ext}"
        try:
            img_bytes = img_path.read_bytes()
        except OSError as exc:
            raise ValueError(f"无法读取图片: {img_path}") from exc
        files[f"ppt/media/{media_name}"] = img_bytes

        slide_xml = _build_image_slide_xml()
        slide_rels_xml = _build_image_slide_rels(f"../media/{media_name}")
        files[f"ppt/slides/slide{index}.xml"] = slide_xml
        files[f"ppt/slides/_rels/slide{index}.xml.rels"] = slide_rels_xml

        slide_rid = f"rIdSlide{index}"
        slide_id_lst.append(
            f'<p:sldId id="{255 + index + 1}" r:id="{slide_rid}"/>'
        )
        pres_rels.append(
            f'<Relationship Id="{slide_rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{index}.xml"/>'
        )
        ct_overrides.append(
            f'<Override PartName="/ppt/slides/slide{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        )

    presentation_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
        ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">'
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster1"/></p:sldMasterIdLst>'
        f'<p:sldIdLst>{"".join(slide_id_lst)}</p:sldIdLst>'
        f'<p:sldSz cx="{slide_w}" cy="{slide_h}"/>'
        '<p:notesSz cx="6858000" cy="9144000"/>'
        '</p:presentation>'
    ).encode("utf-8")
    files["ppt/presentation.xml"] = presentation_xml

    pres_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(pres_rels)
        + '</Relationships>'
    ).encode("utf-8")
    files["ppt/_rels/presentation.xml.rels"] = pres_rels_xml

    default_exts = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
                    '<Default Extension="xml" ContentType="application/xml"/>']
    for ext in sorted(used_exts):
        ct = _IMG_EXT_TO_CT.get(ext)
        if not ct:
            continue
        default_exts.append(f'<Default Extension="{ext.lstrip(".")}" ContentType="{ct}"/>')

    content_types_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + "".join(default_exts)
        + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
        + "".join(ct_overrides)
        + '</Types>'
    ).encode("utf-8")
    files["[Content_Types].xml"] = content_types_xml

    with zipfile.ZipFile(output_path, "w") as zf:
        for name, data in files.items():
            ext = Path(name).suffix.lower()
            compress_type = zipfile.ZIP_STORED if ext in _PRECOMPRESSED_EXTS else zipfile.ZIP_DEFLATED
            zf.writestr(zipfile.ZipInfo(name), data, compress_type=compress_type)


__all__ = ['build_image_pptx', 'determine_pdf_canvas_size', 'fit_image_to_canvas']
