"""Services / resource import / limits."""

from __future__ import annotations




# A wizard can sit on the confirmation step while the operator compares page
# images, walks through duplicate choices, or leaves the tab open. The old
# 30-minute window turned that pause into a 404 at commit time and threw the
# rendered pages away, so the deadline now spans a working day. Every step that
# holds the session lease renews it, and the wizard heartbeats while it is open.
RESOURCE_IMPORT_TTL = 24 * 60 * 60

# Uploads that died before writing session.json cannot be renewed or resumed,
# so they must not inherit the long TTL and count against the active-session
# quota for a day.
RESOURCE_IMPORT_ORPHAN_TTL = 60 * 60

# Threshold for reclaiming abandoned sessions when the disk guard would
# otherwise reject a new upload. Heartbeats keep a live wizard's directory
# mtime fresh, so anything idle this long is not mid-conversation with anyone.
RESOURCE_IMPORT_IDLE_RECLAIM_SECONDS = 2 * 60 * 60


RESOURCE_IMPORT_MAX_PPT_BYTES = 10 * 1024 * 1024 * 1024


RESOURCE_IMPORT_MAX_IMAGE_BYTES = 64 * 1024 * 1024


RESOURCE_IMPORT_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024


RESOURCE_IMPORT_MAX_IMAGES = 200


RESOURCE_IMPORT_MAX_SLIDES = 500


RESOURCE_IMPORT_MAX_IMAGE_PIXELS = 50_000_000


# Keep a separate expansion ceiling so legitimate media-heavy presentations
# can use the 10 GiB upload allowance without making package validation
# unbounded.
RESOURCE_IMPORT_MAX_PPT_UNCOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024


RESOURCE_IMPORT_MAX_PPT_ENTRIES = 10_000


RESOURCE_IMPORT_MAX_NAME_LENGTH = 120


RESOURCE_IMPORT_MAX_TAGS_LENGTH = 2_000


RESOURCE_IMPORT_MAX_SCOPE_USERS = 500

# Admission limits protect the host before a request has created a session
# directory. Rendering has its own worker slots; uploads still need a global
# cap so many users cannot reserve the entire assets volume concurrently.
RESOURCE_IMPORT_MAX_ACTIVE_SESSIONS = 64
RESOURCE_IMPORT_MIN_FREE_BYTES = 1024 * 1024 * 1024
