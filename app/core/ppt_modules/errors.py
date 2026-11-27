"""User-facing PPT structure failures.

Messages raised with :class:`PptStructureError` are written by this codebase
for end users: they never contain vendor errors, local paths or SDK details, so
API responses and task records may show them verbatim. Everything else that a
PPT pipeline raises is reported through the generic catalogue in
``app.core.errors``.
"""

from __future__ import annotations


class PptStructureError(ValueError):
    """A deck cannot be split or validated safely; the message is user-facing."""
