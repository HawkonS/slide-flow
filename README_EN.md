# SlideFlow

<p align="center">
  <img src="./app/static/img/logo.svg" height="112" alt="SlideFlow logo" />
</p>

<p align="center">
  Break presentations into single-slide assets, then catalogue, authorize, assemble and present them again
</p>

<p align="center">
  <a href="./README.md">中文</a> ·
  English
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
</p>

## Introduction

Presentation material is usually managed one whole deck at a time, but what actually gets reused is a handful of slides. Reuse at the deck level leads to version chaos, permissions that are far too broad, and the same slides being rebuilt over and over.

SlideFlow makes the single slide the smallest unit of management: each slide is catalogued, authorized and versioned on its own, and the show library reassembles slides into a presentation that can be played fullscreen or offline. An uploaded deck first goes through font detection and high-resolution rendering and is only committed after confirmation, with images generated on demand on the object storage side.

It ships as one web service (asset, template, font and show libraries in the frontend, plus management pages and a system admin dashboard), with a FastAPI + SQLite backend and a React + Vite + TypeScript frontend.

## Features

- Single-slide asset library: font detection and image rendering run asynchronously after upload, and the task can be resumed after closing the page.
- Show library: assemble slides into a show with editing, version iteration, downloads and watermarking.
- Templates and fonts: templates are grouped by subject or series and filterable on several dimensions; the font library supports upload, preview, embedding and missing-font detection.
- Access control: roles combined with scopes, where visible, downloadable and manageable are three separate boundaries.
- Controlled sharing: assets have their own detail URL, and share links carry an expiry, are revocable, and never grant download rights.
- PWA offline playback: download an authorized cache within the same browser and account, then present fullscreen or on dual screens with no network.
- Feishu SSO: can run alongside the local account system.
- Windows WPS rendering: image rendering is handled by a standalone component whose Windows workers pull tasks themselves.
- Tasks and operations: the full task lifecycle is visible, the dashboard covers configuration, logs and system operations, and one-command start/stop plus systemd hosting are provided.

## Quick start

Requirements: Python 3.10+, Node.js 20+, macOS or Linux.

1. Run `./run.sh` for production mode (the frontend is built automatically), `./run.sh --dev` for development mode, and `./stop.sh` to stop.
2. The first start generates the configuration file and creates a system administrator pending initialization, with a one-time token written to `.secrets/`. Open `/setup` from the local machine to finish initialization; no account or password is preset.
3. Open `http://127.0.0.1:8088` to upload decks and maintain assets and shows. The system admin dashboard lives under pages such as `/admin/config`.

Decks and images are persisted in Alibaba Cloud OSS, so the bucket and endpoints must be configured first, and the AccessKey is injected through environment variables.

## Configuration

All configuration lives in `slide_flow.properties` at the project root. It is generated on first start, missing keys are filled in automatically, and defaults are declared in `app/config.py`. For day-to-day changes prefer the configuration page in the system admin dashboard, which documents every key together with its default and whether it hot-reloads. The file holds sensitive credentials and must not be committed to Git.

Object storage, the Windows render node, and reverse proxy upload limits need a few extra keys adjusted for deployment; the configuration page is the reference for those as well. For Nginx see [`deploy/nginx/slide-flow.conf`](deploy/nginx/slide-flow.conf), and for the render node see [`services/wps-renderer`](services/wps-renderer/README.md).

## FAQ

- **Startup failure**: check for port conflicts, Python and Node versions, and the format of the configuration file; `run.sh` reports the environment problems it finds.
- **Cannot see an asset, or cannot download it**: visible, downloadable and manageable are separate boundaries, so check the role and the asset's visibility scope.
- **Missing fonts, or a render task stuck**: the asset detail page lists missing fonts to upload, and the task page shows status and logs. Rendering depends on a Windows worker being online to pull the task.

## Development

```bash
python3.10 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8088 --reload

cd web && npm install && npm run dev
```

Backend tests run with `pytest tests`; frontend tests and type checks are in the scripts of `web/package.json`. Backend route changes require a restart.

## Security notes

- Never commit `slide_flow.properties`, `.secrets/`, `data/`, logs or private templates.
- Object storage AccessKeys are injected through the runtime environment only, never written into configuration files, the frontend or logs. Rotate a credential immediately once it has been exposed.
- The system does not configure, generate or reuse a global default password. A new user without an explicit password receives a temporary one that is shown once and expires, and it must be changed at first login.
- The render node listens on the loopback address only. Do not expose the conversion port publicly, and the Windows side never holds object storage credentials.
- The system admin dashboard exposes configuration, logs, users and system operations. Before deploying publicly, complete secure initialization and keep it behind a trusted network or an authenticating reverse proxy.
- WPS itself is not part of this project; you are responsible for its license and terms of use. SlideFlow is intended for internal asset management and archiving.

## License

Released under the [Apache License 2.0](./LICENSE).
