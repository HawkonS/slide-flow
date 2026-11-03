"""Check actual GDI font selection in the same session that launches WPS."""
import ctypes
from ctypes import wintypes
import hashlib
import logging

from .errors import RenderError

LOG = logging.getLogger(__name__)


def verify_font(name, face):
    """Return the verified native family name, or False for a fallback.

    WPS may reject an English alias which GDI accepts. GetTextFaceW exposes
    the installed native name that WPS's font catalog actually uses.
    """
    gdi = ctypes.WinDLL("gdi32", use_last_error=True)
    gdi.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi.CreateCompatibleDC.restype = wintypes.HDC
    gdi.DeleteDC.argtypes = [wintypes.HDC]
    gdi.DeleteDC.restype = wintypes.BOOL
    gdi.CreateFontW.argtypes = [ctypes.c_int] * 5 + [wintypes.DWORD] * 8 + [wintypes.LPCWSTR]
    gdi.CreateFontW.restype = wintypes.HANDLE
    gdi.SelectObject.argtypes = [wintypes.HDC, wintypes.HANDLE]
    gdi.SelectObject.restype = wintypes.HANDLE
    gdi.DeleteObject.argtypes = [wintypes.HANDLE]
    gdi.DeleteObject.restype = wintypes.BOOL
    gdi.GetFontData.argtypes = [wintypes.HDC, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
    gdi.GetFontData.restype = wintypes.DWORD
    gdi.GetTextFaceW.argtypes = [wintypes.HDC, ctypes.c_int, wintypes.LPWSTR]
    gdi.GetTextFaceW.restype = ctypes.c_int
    dc = gdi.CreateCompatibleDC(None)
    font = previous = None
    try:
        if not dc:
            raise RenderError("font_unavailable", "Windows could not create a font verification context")
        font = gdi.CreateFontW(-32, 0, 0, 0, face.weight, int(face.italic), 0, 0, 1, 0, 0, 0, 0, name)
        if not font:
            return False
        previous = gdi.SelectObject(dc, font)
        if not previous or previous == ctypes.c_void_p(-1).value:
            previous = None
            return False
        actual = ctypes.create_unicode_buffer(256)
        gdi.GetTextFaceW(dc, len(actual), actual)
        for tag, expected in face.fingerprints:
            table = int.from_bytes(tag.encode("ascii"), "little")
            size = gdi.GetFontData(dc, table, 0, None, 0)
            if size == 0xFFFFFFFF or not 0 < size <= 2 * 1024 * 1024:
                LOG.warning("Font selection cannot read table requested=%r actual=%r table=%s", name, actual.value, tag)
                return False
            data = ctypes.create_string_buffer(size)
            if gdi.GetFontData(dc, table, 0, data, size) != size or hashlib.sha256(data.raw).hexdigest() != expected:
                LOG.warning("Font selection fell back requested=%r actual=%r face=%s table=%s", name, actual.value, face.index, tag)
                return False
        return actual.value or name
    finally:
        if previous:
            gdi.SelectObject(dc, previous)
        if font:
            gdi.DeleteObject(font)
        if dc:
            gdi.DeleteDC(dc)
