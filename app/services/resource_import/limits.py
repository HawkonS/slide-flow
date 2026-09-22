"""Services / resource import / limits."""

from __future__ import annotations




RESOURCE_IMPORT_TTL = 30 * 60


RESOURCE_IMPORT_MAX_PPT_BYTES = 256 * 1024 * 1024


RESOURCE_IMPORT_MAX_IMAGE_BYTES = 64 * 1024 * 1024


RESOURCE_IMPORT_MAX_TOTAL_BYTES = 512 * 1024 * 1024


RESOURCE_IMPORT_MAX_IMAGES = 200


RESOURCE_IMPORT_MAX_SLIDES = 500


RESOURCE_IMPORT_MAX_IMAGE_PIXELS = 50_000_000


RESOURCE_IMPORT_MAX_PPT_UNCOMPRESSED_BYTES = 512 * 1024 * 1024


RESOURCE_IMPORT_MAX_PPT_ENTRIES = 10_000


RESOURCE_IMPORT_MAX_NAME_LENGTH = 120


RESOURCE_IMPORT_MAX_TAGS_LENGTH = 2_000


RESOURCE_IMPORT_MAX_SCOPE_USERS = 500

# Admission limits protect the host before a request has created a session
# directory. Rendering has its own worker slots; uploads still need a global
# cap so many users cannot reserve the entire assets volume concurrently.
RESOURCE_IMPORT_MAX_ACTIVE_SESSIONS = 64
RESOURCE_IMPORT_MIN_FREE_BYTES = 1024 * 1024 * 1024
