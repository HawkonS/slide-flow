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

Use [Conventional Commits](https://www.conventionalcommits.org/) for every commit message and pull request title:

```text
type(scope): summary
```

- **English is required** for the entire title, including the scope and summary.
- **A scope is required**. Start it with a lowercase English letter and use only lowercase English letters, digits, and hyphens.
- **The entire commit message must be a single title line**. Do not add a body, footers, trailers, or a second `-m` argument.
- **The complete title must be 72 characters or fewer**, including the type, scope, spaces, and punctuation.
- Keep the type and scope lowercase. Start the summary with a lowercase imperative verb, such as `add`, `fix`, `remove`, `update`, or `document`.
- Proper names and technical identifiers in the summary may retain their original capitalization, such as `Android`, `GitHub`, `SDK`, and `JAVA_HOME`.
- Do not end the title with a period or whitespace, and do not use emoji.
- Keep each commit focused on one logical change. Describe the actual change; avoid vague summaries such as `update code` or `fix bug`.
- For an incompatible change, put `!` after the scope and before the colon: `type(scope)!: summary`.
- Put context, issue references, validation details, and migration notes in the pull request description.
- Apply the same rules to pull request titles and final squash-merge commit messages. When squash-merging, keep only the title and remove any automatically generated body or trailers.

Use one of these types:

| Type | Use for |
| --- | --- |
| `feat` | New user-visible functionality |
| `fix` | Bug, regression, or compatibility fixes |
| `refactor` | Code restructuring without behavior changes |
| `ui` | Visual styling or interaction adjustments |
| `perf` | Performance improvements |
| `docs` | Documentation changes |
| `test` | Test additions or updates |
| `build` | Build configuration, dependencies, tooling, or packaging |
| `ci` | CI workflows and automation |
| `chore` | Maintenance that fits no other type |
| `revert` | Reverting an earlier commit |

Use `feat` for new functionality and `fix` for defects, including changes to the UI. Use `ui` for other visual or interaction adjustments.

Preferred scopes:

| Scope | Area |
| --- | --- |
| `app` | FastAPI backend in `app/` |
| `web` | React frontend in `web/` |
| `ppt` | Presentation rendering, export, playback, and download flows |
| `tools` | Local and operations scripts in `tools/` |
| `deploy` | Deployment configuration in `deploy/` |
| `build` | Build configuration, dependencies, tooling, and packaging |
| `ci` | CI workflows and automation |
| `docs` | README files and project documentation |
| `repo` | Repository-level configuration and contribution guidelines |

Prefer the scopes listed above. Use another concise scope only for a distinct area not covered by them, and keep it consistent. Tests should normally use the scope of the code they cover.

Examples:

```text
feat(web): add offline playback status
fix(app): preserve resource remarks in show details
docs(repo): document the contribution workflow
feat(app)!: change the resource payload
```

## License

By submitting a contribution, you agree that it is licensed under the terms of the [Apache License 2.0](./LICENSE).
