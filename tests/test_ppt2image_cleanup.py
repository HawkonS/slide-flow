"""Guard against reintroducing the retired PPT2Image conversion path.

The current import flow intentionally keeps the WPS remote renderer
in ``app.services.resource_import.rendering`` and the generic PPTX helpers in
``app.core.ppt_modules``.  This test only checks repository metadata and file
names for the old, ambiguous PPT2Image implementation/dependency names; it
does not forbid generic PPTX/image functionality or the current renderer.
"""

from __future__ import annotations

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]

# Keep this deliberately narrow.  In particular, ``python-pptx`` is not a
# rendering engine and remains useful to local smoke-fixture generation, while
# WPSCLI is the supported server-side rendering engine.
_RETIRED_TERMS = re.compile(
    r"(?:\bppt2image\b|\bppt2img\b|\bpptx2image\b|"
    r"\bppt[-_ ]to[-_ ]image\b|\bpptx[-_ ]to[-_ ]image\b)",
    re.IGNORECASE,
)
_MANIFEST_NAMES = {
    "requirements.txt",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "Pipfile",
    "Pipfile.lock",
    "package.json",
    "package-lock.json",
}
_SKIP_DIRS = {
    ".git",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".resource_imports",
}


def _iter_repo_files():
    """Yield small text files outside generated/runtime directories."""
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.name == Path(__file__).name:
            continue
        if any(part in _SKIP_DIRS for part in path.relative_to(ROOT).parts):
            continue
        # The guard is intended for source/config/docs and should not inspect
        # arbitrary binary assets or user-uploaded PPTX files.
        if path.suffix.lower() in {
            ".ppt", ".pptx", ".pdf", ".png", ".jpg", ".jpeg", ".gif",
            ".webp", ".zip", ".woff", ".woff2", ".ttf", ".otf", ".sqlite",
            ".db", ".pyc",
        }:
            continue
        yield path


class Ppt2ImageCleanupTests(unittest.TestCase):
    def test_no_retired_ppt2image_modules_or_dependency_names(self):
        violations: list[str] = []
        for path in _iter_repo_files():
            # File names are checked separately so a dead module cannot hide
            # behind an otherwise empty file.
            if _RETIRED_TERMS.search(path.name):
                violations.append(f"filename: {path.relative_to(ROOT)}")
                continue
            if path.name not in _MANIFEST_NAMES and path.suffix.lower() not in {
                ".py", ".md", ".rst", ".txt", ".toml", ".json", ".yaml", ".yml",
                ".js", ".jsx", ".ts", ".tsx", ".sh",
            }:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            for match in _RETIRED_TERMS.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                violations.append(f"{path.relative_to(ROOT)}:{line}: {match.group(0)}")
        self.assertEqual(
            violations,
            [],
            "The retired PPT2Image path must not return; use the supported "
            "Windows pull renderer and generic PPTX utilities instead.",
        )

    def test_current_renderer_and_generic_ppt_modules_remain_present(self):
        # This catches over-eager cleanup that accidentally removes the
        # supported implementation while deleting an obsolete conversion path.
        for relative in (
            "app/services/resource_import/rendering.py",
            "app/core/ppt.py",
            "app/core/ppt_modules/images.py",
        ):
            with self.subTest(path=relative):
                self.assertTrue((ROOT / relative).is_file())


if __name__ == "__main__":
    unittest.main()
