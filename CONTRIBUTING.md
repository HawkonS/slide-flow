# Contributing

Thanks for helping improve SlideFlow. Bug reports, focused fixes, tests, documentation and feature proposals are welcome.

## Development

The development environment requires macOS or Linux, Python 3.10+, Node.js 20+ and npm. Create a virtual environment and install the backend dependencies from the repository root:

```bash
python3.10 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt python-pptx
```

Run the backend with auto-reload:

```bash
python -m uvicorn app.main:app --host 0.0.0.0 --port 8088 --reload
```

In a second terminal, install and run the frontend:

```bash
cd web
npm ci
npm run dev
```

Some application workflows require local configuration and object storage credentials. Never include credentials or runtime data in a contribution.

## Checks

Run the checks relevant to your changes before opening a pull request. The GitHub Actions workflow runs the backend, renderer and frontend checks on pull requests.

Backend tests:

```bash
python -m compileall -q app tests
python -m unittest discover -s tests -p 'test_*.py' -v
```

Renderer tests:

```bash
cd services/wps-renderer
python -m pip install -r requirements-dev.txt
python -m compileall -q wps_renderer tests
python -m unittest discover -s tests -p 'test_*.py' -v
```

Frontend checks:

```bash
cd web
npm ci
npm run typecheck
npm run build
npm run test:pwa:unit
npx playwright install chromium
npm run test:pwa:browser
```

## Changes and pull requests

- Keep each change focused and explain the problem it solves.
- Add or update tests when behavior changes, and update user-facing documentation when behavior or configuration changes.
- For visible UI changes, include a screenshot or short recording in the pull request.
- Do not include credentials, `slide_flow.properties`, `.secrets/`, databases, logs, backups, generated build output or private templates.
- Do not open public issues with exploit details. Report security-sensitive issues privately to the repository owner through GitHub.

## Commit messages

Commit messages and pull request titles must use this format:

```text
type(scope): description
```

- Write the entire title in English. The description must be a concise imperative phrase starting with a lowercase verb, such as `add`, `fix`, `update` or `document`.
- A scope is required. Use a short, lowercase name for the affected area.
- Use exactly one title line. Do not add a commit body or a second `-m` argument.
- Keep the title lowercase, do not end it with a period or add emoji, and aim for 72 characters or fewer.
- Keep each commit focused on one logical change.
- For an incompatible change, put `!` before the colon, for example `feat(api)!: change the resource payload`.

Preferred scopes:

| Scope | Area |
| --- | --- |
| `app` | FastAPI backend in `app/` |
| `web` | React frontend in `web/` |
| `ppt` | Presentation rendering, export and playback/download flows |
| `tools` | Local and operations scripts in `tools/` |
| `deploy` | Deployment configuration in `deploy/` |
| `build` | Dependencies, packaging and build configuration |
| `docs` | README files and documentation in `docs/` |
| `repo` | Repository-level configuration and contribution conventions |

Use a new, concise scope only when the change belongs to a distinct area not covered above, and keep that scope consistent. Tests should normally use the scope of the code they cover.

Common types:

| Type | Use |
| --- | --- |
| `feat` | Add a user-facing capability |
| `fix` | Fix a defect or compatibility issue |
| `refactor` | Restructure code without changing behavior |
| `perf` | Improve performance |
| `docs` | Change documentation |
| `test` | Add or update tests |
| `build` | Change dependencies or build configuration |
| `chore` | Perform maintenance that does not fit another type |

Examples:

```text
feat(web): add offline playback status
fix(app): preserve resource remarks in show details
docs(repo): document the contribution workflow
```

## License

By submitting a contribution, you agree that it is licensed under the terms of the [Apache License 2.0](./LICENSE).
