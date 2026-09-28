"""Temporary session-visible fonts; never overwrite or uninstall system fonts."""
import ctypes
import os
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from fontTools.ttLib import TTCollection, TTFont

from .errors import RenderError
from .font_validation import preflight_font
from .validation import digest


def normalized(value):
    return " ".join(value.lstrip("@").split()).casefold()


def font_metadata(path):
    fonts = []
    try:
        preflight_font(path)
        if path.suffix.lower() in {".ttc", ".otc"}:
            collection = TTCollection(str(path), lazy=True)
            fonts = collection.fonts
        else:
            fonts = [TTFont(str(path), lazy=True)]
        if not 1 <= len(fonts) <= 64:
            raise ValueError("Invalid collection size")
        names, faces = set(), set()
        for font in fonts:
            # Require genuine scalable fonts, not a filename pretending to be one.
            if "name" not in font or "head" not in font or "maxp" not in font:
                raise ValueError("Missing mandatory font tables")
            for record in font["name"].names:
                if record.nameID in {1, 4, 6, 16}:
                    name = record.toUnicode().strip()
                    if name and len(name) <= 256:
                        names.add(normalized(name))
                        if record.nameID in {4, 6}:
                            faces.add(normalized(name))
        if not names:
            raise ValueError("Font has no names")
        if not faces:
            raise ValueError("Font has no unambiguous full/PostScript face name")
        return names, faces
    except Exception as exc:
        raise RenderError("invalid_font", "Invalid TTF/OTF font or font collection") from exc
    finally:
        for font in fonts:
            font.close()


def font_names(path):
    return font_metadata(path)[0]


class FontManager:
    def __init__(self):
        self._lock = threading.RLock()
        self._cache = {}
        self._faces = {}
        self._paths = {}
        self._inventory = {}
        self._scanned_at = 0.0
        self._healthy = True

    def installed(self, force=False):
        """Only trust real font metadata, never request-provided aliases."""
        with self._lock:
            if not force and self._scanned_at and time.monotonic() - self._scanned_at < 10:
                return self._inventory
            return self._scan_installed()

    def _scan_installed(self):
        candidates = set()
        if os.name == "nt":
            import winreg
            system = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
            user = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Windows" / "Fonts"
            for base in (system, user):
                if base.is_dir():
                    candidates.update(p for p in base.iterdir() if p.suffix.lower() in {".ttf", ".otf", ".ttc", ".otc"})
            for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
                try:
                    with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts") as key:
                        for index in range(winreg.QueryInfoKey(key)[1]):
                            _, value, _ = winreg.EnumValue(key, index)
                            if isinstance(value, str):
                                path = Path(value)
                                if not path.is_absolute():
                                    path = system / path
                                candidates.add(path)
                except OSError:
                    pass
        result, face_result, paths, current_keys = {}, {}, {}, set()
        with self._lock:
            for path in candidates:
                try:
                    raw = str(path)
                    if raw.startswith("\\\\"):
                        continue  # Never follow a registry font entry to a network share.
                    if getattr(path.lstat(), "st_file_attributes", 0) & 0x400 or path.is_symlink():
                        continue  # Avoid reparse-point font files and junctions.
                    info = path.stat()
                    if not path.is_file() or info.st_size > 64 * 1024 * 1024:
                        continue
                    key = (str(path), info.st_mtime_ns, info.st_ctime_ns, info.st_size)
                    current_keys.add(key)
                    if key not in self._cache:
                        self._cache[key] = (*font_metadata(path), digest(path))
                    names, faces, sha = self._cache[key]
                    paths[sha] = path
                    for name in names:
                        result.setdefault(name, set()).add(sha)
                    for face in faces:
                        face_result.setdefault(face, set()).add(sha)
                except (OSError, RenderError):
                    continue
            self._cache = {k: v for k, v in self._cache.items() if k in current_keys}
            self._faces = face_result
            self._paths = paths
            self._inventory = result
            self._scanned_at = time.monotonic()
        return result

    def check(self, names, fonts):
        with self._lock:
            installed = self.installed()
            faces = self._faces
        supplied = []
        for font in fonts:
            known = set().union(*(installed.get(normalized(n), set()) for n in font["names"]))
            # `faces` may be supplied by the client. It is only an early hint;
            # uploaded font bytes are parsed and checked authoritatively below.
            face_hashes = set().union(*(faces.get(normalized(n), set()) for n in font.get("faces", [])))
            supplied.append({"sha256": font["sha256"], "installed": font["sha256"] in known,
                             "conflict": bool(face_hashes - {font["sha256"]})})
        return {"fonts": supplied, "installed": [n for n in names if normalized(n) in installed],
                "missing": [n for n in names if normalized(n) not in installed]}

    @contextmanager
    def activate(self, directory, manifest):
        if os.name != "nt":
            raise RenderError("unsupported_platform", "WPS renderer must run on Windows")
        if not self._healthy:
            raise RenderError("font_cleanup_failed", "Previous temporary font unload failed; restart the renderer session", 503)
        with self._lock:
            installed = self.installed(force=True)
            installed_faces, installed_paths = self._faces, self._paths
        available = set(installed)
        supplied = {}
        # HKCU font files can exist without being loaded in the scheduled/SSH
        # logon session. Explicitly register matching installed files here too;
        # flags=0 makes them visible to the WPS child in this session only.
        pending = {sha: installed_paths[sha] for name in manifest.get("required_fonts", [])
                   for sha in installed.get(normalized(name), set()) if sha in installed_paths}
        if manifest.get("font_hashes") is not None:
            wanted = set(manifest["font_hashes"])
            supplied_hashes = {f["sha256"] for f in manifest.get("fonts", [])}
            if wanted - installed_paths.keys() - supplied_hashes:
                raise RenderError("fonts_missing", "A checked font disappeared or changed while queueing")
            pending = {sha:path for sha,path in installed_paths.items() if sha in wanted}
            available = {name for name, hashes in installed.items() if hashes & wanted}
            # The main service owns user-facing aliases and freezes each alias
            # to an exact synchronized file hash when it queues the task. The
            # Windows inventory only knows names embedded in the font binary,
            # so accept a custom/display alias only through that explicit,
            # hash-bound handoff. Unbound names still fail below.
            for binding in manifest.get("font_bindings", []):
                if binding["sha256"] in wanted:
                    available.add(normalized(binding["name"]))
        for entry in manifest.get("fonts", []):
            path = directory / entry["file"]
            names, faces = font_metadata(path)
            sha = entry["sha256"]
            for face in faces:
                previous = supplied.get(face)
                if previous and previous != sha:
                    raise RenderError("font_conflict", "Uploaded fonts contain different bytes for the same full font face")
                supplied[face] = sha
                if installed_faces.get(face, set()) - {sha}:
                    raise RenderError("font_conflict", "Windows has a different font with the same name; align the font versions explicitly")
            available.update(names)
            if not any(sha in hashes for hashes in installed.values()):
                pending[sha] = path
        missing = [name for name in manifest.get("required_fonts", []) if normalized(name) not in available]
        if missing:
            raise RenderError("fonts_missing", "Required fonts are missing: " + ", ".join(missing[:12]))
        for hashes in installed_faces.values():
            if hashes & pending.keys() and len(hashes) > 1:
                raise RenderError("font_conflict", "Windows contains ambiguous versions of a requested full font face")
        gdi = ctypes.WinDLL("gdi32", use_last_error=True)
        gdi.AddFontResourceExW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint, ctypes.c_void_p]
        gdi.AddFontResourceExW.restype = ctypes.c_int
        gdi.RemoveFontResourceExW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint, ctypes.c_void_p]
        gdi.RemoveFontResourceExW.restype = ctypes.c_int
        active = []
        try:
            for path in pending.values():
                if not gdi.AddFontResourceExW(str(path), 0, None):
                    raise RenderError("font_install_failed", "Windows refused a temporary font")
                active.append(path)
            self._broadcast()
            yield
        finally:
            failed = False
            for path in reversed(active):
                if not gdi.RemoveFontResourceExW(str(path), 0, None):
                    failed = True
            if active:
                self._broadcast()
            if failed:
                self._healthy = False
                raise RenderError("font_cleanup_failed", "Windows could not unload a temporary font; restart the renderer session", 503)

    @staticmethod
    def recover(directory):
        """Release only our UUID-scoped uploaded fonts after an interrupted run.

        Never decrement registration counts for system/HKCU font paths: without
        a live invocation there is no safe proof of ownership of those counts.
        """
        if os.name != "nt" or not directory.is_dir() or directory.is_symlink():
            return
        gdi = ctypes.WinDLL("gdi32", use_last_error=True)
        gdi.RemoveFontResourceExW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint, ctypes.c_void_p]
        gdi.RemoveFontResourceExW.restype = ctypes.c_int
        changed = False
        for path in directory.iterdir():
            if path.is_file() and not path.is_symlink() and path.suffix.lower() in {".ttf", ".otf", ".ttc", ".otc"}:
                # This component registers a given staged path at most once.
                changed = bool(gdi.RemoveFontResourceExW(str(path), 0, None)) or changed
        if changed:
            FontManager._broadcast()

    @staticmethod
    def _broadcast():
        user = ctypes.WinDLL("user32", use_last_error=True)
        user.SendMessageTimeoutW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t,
                                            ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p]
        user.SendMessageTimeoutW(ctypes.c_void_p(0xFFFF), 0x001D, 0, 0, 0x0002, 1000, None)
