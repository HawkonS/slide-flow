"""Format/font helpers. WPS is the only renderer; no geometry rewrites."""
from pathlib import Path
import shutil
import uuid
from app.core.resource_import_fonts import replace_ppt_fonts

# The split output is part of the immutable render attempt. Bump this when
# package-level cleanup changes so old sessions cannot commit stale page files.
RESOURCE_IMPORT_RENDERER_VERSION = "wps-pull-v4-batched"
IMPORT_EXTENSIONS = {".pptx", ".potx", ".ppsx"}


def _normalize_import_ppt(source_path: Path, temp_dir: Path) -> Path:
    if source_path.suffix.lower() not in IMPORT_EXTENSIONS:
        raise RuntimeError("请在 PowerPoint/WPS 中将旧版 PPT/POT/PPS 另存为 PPTX；不再使用 LibreOffice 转换")
    if source_path.suffix.lower() == ".pptx":
        return source_path
    target = temp_dir / f"normalized_{uuid.uuid4().hex}.pptx"
    shutil.copyfile(source_path, target)
    return target


def _replace_ppt_fonts(source: Path, replacements: dict[str, str], target: Path) -> None:
    replace_ppt_fonts(source, replacements, target)
