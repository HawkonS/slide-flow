"""Resolve Office aliases to concrete Windows font faces, never display names."""
from dataclasses import dataclass
import hashlib

from .errors import RenderError


def normalized(value):
    # Keep this equivalent to the application's alias matching. An @ prefix
    # selects vertical text in Office and is preserved separately on rewrite.
    return "".join(value.lstrip("@").casefold().replace("-", "").replace("_", "").split())


@dataclass(frozen=True)
class FontFace:
    index: int
    names: frozenset
    full_names: frozenset
    families: frozenset
    family: str
    full_name: str
    weight: int
    italic: bool
    fingerprints: tuple
    localized_families: tuple = ()


def describe_face(font, index):
    records = []
    for record in font["name"].names:
        if record.nameID not in {1, 4, 6, 16}:
            continue
        name = record.toUnicode().strip()
        if name and len(name) <= 256:
            records.append((record, name))

    def preferred(name_id):
        candidates = [(record, name) for record, name in records if record.nameID == name_id]
        candidates.sort(key=lambda item: (
            item[0].platformID != 3,
            item[0].langID != 0x409,
            item[0].langID, item[1],
        ))
        return candidates[0][1] if candidates else ""

    family = preferred(1)
    full_name = preferred(4) or family
    if not family or not full_name:
        raise ValueError("Font has no Windows family/full name")
    return FontFace(
        index=index,
        names=frozenset(normalized(name) for _, name in records),
        full_names=frozenset(normalized(name) for record, name in records if record.nameID in {4, 6}),
        families=frozenset(normalized(name) for record, name in records if record.nameID == 1 and record.platformID == 3),
        family=family,
        full_name=full_name,
        weight=int(font["OS/2"].usWeightClass) if "OS/2" in font else 400,
        italic=bool(font["head"].macStyle & 2),
        # Windows can find an unrelated fallback while CreateFont succeeds.
        # Compare raw tables, including head.checkSumAdjustment, to the exact
        # face in the SHA-bound file instead of trusting its returned name.
        # getTableData recompiles tables already accessed above; fontTools may
        # reorder name records or repair timestamps while doing so. GDI returns
        # the original SFNT bytes, so fingerprint the reader's raw tables.
        fingerprints=tuple((tag, hashlib.sha256(font.reader[tag]).hexdigest()) for tag in ("name", "head")),
        localized_families=tuple(dict.fromkeys(name for record, name in records
                                               if record.nameID == 1 and record.platformID == 3)),
    )


def resolve_faces(required, bindings, profiles):
    """Select only the faces owned by each hash-bound alias.

    Family bindings may contain Regular/Bold/Italic faces with the same
    Windows family. A shared typographic family spanning distinct Windows
    families (e.g. PuHuiTi 55/105) needs an explicit face name instead.
    """
    result = {}
    for name in required:
        key = normalized(name)
        bound = {entry["sha256"] for entry in bindings if entry["name"] == name}
        candidates = [(sha, face) for sha, faces in profiles.items() for face in faces
                      if (sha in bound if bound else key in face.names)]
        matching = [(sha, face) for sha, face in candidates if key in face.names]
        if matching:
            exact = [(sha, face) for sha, face in matching if key in face.full_names]
            windows = [(sha, face) for sha, face in matching if key in face.families]
            candidates = exact or windows or matching
        elif not bound:
            candidates = []
        if not candidates:
            raise RenderError("fonts_missing", "Required font face is unavailable: " + name)
        families = {normalized(face.family) for _, face in candidates}
        styles = [(face.weight, face.italic) for _, face in candidates]
        if len(families) != 1 or len(styles) != len(set(styles)):
            raise RenderError("font_conflict", "Font alias does not identify an unambiguous face/family: " + name)
        result[name] = candidates
    return result


def canonical_typefaces(resolved, verify):
    """Resolve aliases through GDI to the installed native Win32 name.

    Both candidates must actually select the expected file in the rendering
    session. For a style-linked family keep its family name so b/i continue
    to select Regular/Bold/Italic instead of freezing everything to Regular.
    """
    replacements = {}
    for requested, faces in resolved.items():
        first = faces[0][1]
        names = [first.full_name, first.family] if len(faces) == 1 else [first.family]
        names.extend(first.localized_families)
        target = None
        for name in dict.fromkeys(names):
            # LOGFONTW has 32 WCHARs including the terminator. Never allow
            # Windows to truncate a long name and silently pick another face.
            if len(name.encode("utf-16-le")) // 2 >= 32:
                continue
            selected = [verify(name, face) for _, face in faces]
            if all(selected):
                native_names = {value if isinstance(value, str) else name for value in selected}
                if len(native_names) != 1:
                    continue
                target = native_names.pop()
                break
        if target is None:
            raise RenderError("font_unavailable", "Windows cannot select the required font face: " + requested)
        replacements[requested] = target
    return replacements
