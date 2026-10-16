# Application contract baseline

`application_routes.json` and `application_openapi.json` were last reviewed and
updated on 2026-09-28 from `app.main.app`. The capture imported the application
but did not enter its startup/lifespan or initialize the live database.

The baseline contains 183 registered routes (181 HTTP, one WebSocket and one
static mount) and 149 OpenAPI paths. It includes the reviewed setup,
password-reset, paginated user management, bounded user search, managed user
avatar, resource-share, renderer-font-task, renderer batch-source and bounded log-tail contracts,
plus persistent system-upgrade status.

`tests/test_application_architecture.py` checks endpoint paths, methods, names,
parameters, request/response models and ordering-sensitive routes against these
fixtures. Application branding is configurable and is excluded from the
contract comparison. Only update these fixtures for an intentional, reviewed
public API change; do not regenerate them just to make a refactor pass.

The PWA contract review adds authenticated offline manifests and version-pinned binary assets, plus the root service-worker and web-manifest routes. The legacy offline-package route retains its public signature and returns 410; its password-hash export has been retired.

The incremental-rendering review adds the authenticated progress receipt route,
the optional `include_source` URL request flag, and the optional `worker_attempt`
preview query parameter. These three OpenAPI additions were checked individually;
no existing route was removed.

`schema_v23.sql` freezes the legacy business-table schema used by isolated
database-upgrade tests. It contains schema definitions, not production data,
and the upgrade tests do not require Git or access to a running deployment.

The scene-defaults review adds GET/PATCH `/api/admin/tag-defaults` and the
`TagDefaultChange` / `TagDefaultsPayload` request models. Legacy default-filter
routes remain compatible; database schema 28 migrates their settings only to
the resource list, resource management, and user list scenes.

The show-detail version review adds the optional `version` parameter to GET
`/api/shows/{show_id}`: `latest` resolves the newest record in the same series,
and a positive version number resolves that version. Omitting the parameter
retains the exact-record behavior used by playback and iteration callers.
Permission checks apply to the resolved record. Only this operation's OpenAPI
parameters were updated; no route or schema was added.

The resource-detail navigation review adds GET `/api/resources/{resource_id}/neighbors`.
It accepts the resource list's filters and sort order and returns only adjacent
visible, non-deleted resources, plus the current position in that filtered list.
Only this route and its OpenAPI operation were added to the fixtures.
