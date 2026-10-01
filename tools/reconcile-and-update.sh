#!/usr/bin/env bash
# History reconciliation wrapper.
#
# This is intentionally separate from tools/update.sh. It performs an
# explicitly requested history reconciliation, preserves
# application state, and then delegates the actual restart/build/health flow
# to the normal update entry point.
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  tools/reconcile-and-update.sh [--align-history] [--app-dir DIR]

Options:
  --align-history  Allow reset to origin/main when local history diverged.
                   The backup is created before any reset. Never runs git clean.
  --app-dir DIR    Production checkout (default: directory containing this script).
  -h, --help       Show this help.

Set SLIDEFLOW_UPGRADE_DRY_RUN=1 to run checks and create the backup without
stopping the service or changing source files.
USAGE
}

die() { echo "[SlideFlow] ERROR: $*" >&2; exit 1; }
info() { echo "[SlideFlow] $*"; }

SERVICE_STOPPED=0
UPGRADE_RESTART_SUBMITTED=0
restore_service_on_failure() {
  local code=$?
  trap - EXIT
  if (( SERVICE_STOPPED == 1 && UPGRADE_RESTART_SUBMITTED == 0 )); then
    echo "[SlideFlow] ERROR: upgrade aborted; attempting to start the previous service" >&2
    if (( SYSTEMD_AVAILABLE == 1 )); then
      if [[ "$(id -u)" -eq 0 ]]; then
        systemctl start "$SERVICE_NAME" || true
      else
        sudo systemctl start "$SERVICE_NAME" || true
      fi
    elif [[ -x tools/restart.sh ]]; then
      bash tools/restart.sh || true
    fi
  fi
  exit "$code"
}

wait_for_inactive() {
  local attempts=0 state
  while (( attempts < 60 )); do
    state="$(systemctl show --property=ActiveState --value "$SERVICE_NAME" 2>/dev/null || true)"
    case "$state" in
      inactive|failed) return 0 ;;
    esac
    sleep 1
    attempts=$((attempts + 1))
  done
  return 1
}

ALIGN_HISTORY=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SYSTEMD_AVAILABLE=0

while (($#)); do
  case "$1" in
    --align-history) ALIGN_HISTORY=1; shift ;;
    --app-dir)
      (($# >= 2)) || die "--app-dir requires a directory"
      PROJECT_ROOT="$(cd "$2" && pwd -P)"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (use --help)" ;;
  esac
done

cd "$PROJECT_ROOT"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a Git checkout: $PROJECT_ROOT"
[[ -x tools/update.sh ]] || die "tools/update.sh is missing or not executable"

read_prop() {
  local key="$1"
  awk -F= -v k="$key" '$0 ~ "^" k "=" {sub(/^[^=]*=/, ""); gsub(/\r/, ""); print; exit}' \
    slide_flow.properties 2>/dev/null || true
}

BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
[[ "$BRANCH" == "main" ]] || die "expected branch main, got ${BRANCH:-detached HEAD}"

SERVICE_NAME="$(read_prop 'system.service_name')"
SERVICE_NAME="${SERVICE_NAME:-slide-flow}"
[[ "$SERVICE_NAME" == *.service ]] || SERVICE_NAME="${SERVICE_NAME}.service"

PORT="$(read_prop 'server.port')"
PORT="${PORT:-8088}"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "invalid server.port: $PORT"

DATA_DIR="$(read_prop 'data.dir')"
DATA_DIR="${DATA_DIR:-data}"
if [[ "$DATA_DIR" = /* ]]; then
  DATA_DIR_ABS="$(cd "$DATA_DIR" 2>/dev/null && pwd -P)" || die "data.dir does not exist: $DATA_DIR"
else
  DATA_DIR_ABS="$(cd "$PROJECT_ROOT/$DATA_DIR" 2>/dev/null && pwd -P)" || die "data.dir does not exist: $DATA_DIR"
fi
case "$DATA_DIR_ABS/" in
  "$PROJECT_ROOT/"*) ;;
  *) die "data.dir is outside the checkout; back up that external path manually first" ;;
esac

command -v git >/dev/null 2>&1 || die "git is required"
command -v tar >/dev/null 2>&1 || die "tar is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"

info "checking origin and remote target"
GIT_TERMINAL_PROMPT=0 git fetch --prune origin
REMOTE="origin/main"
git show-ref --verify --quiet "refs/remotes/$REMOTE" || die "missing $REMOTE"

CURRENT_COMMIT="$(git rev-parse HEAD)"
TARGET_COMMIT="$(git rev-parse "$REMOTE")"
read -r AHEAD BEHIND < <(git rev-list --left-right --count HEAD..."$REMOTE")
info "branch=main local=$CURRENT_COMMIT target=$TARGET_COMMIT ahead=$AHEAD behind=$BEHIND"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  die "tracked working-tree changes exist; inspect and preserve them before upgrading"
fi
if (( AHEAD > 0 && ALIGN_HISTORY == 0 )); then
  die "history diverged or local commits exist; rerun with --align-history after reviewing them"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="${SLIDEFLOW_BACKUP_ROOT:-$HOME/slide-flow-backups}"
BACKUP="$BACKUP_ROOT/$STAMP"
mkdir -p "$BACKUP"
chmod 700 "$BACKUP"

info "creating backup at $BACKUP"
git rev-parse HEAD > "$BACKUP/commit.txt"
git rev-parse "$REMOTE" > "$BACKUP/target-commit.txt"
git status --porcelain > "$BACKUP/git-status.txt"
git diff --binary --output="$BACKUP/worktree.patch"
git diff --cached --binary --output="$BACKUP/index.patch"
git branch "codex/backup-before-upgrade-$STAMP" HEAD

if [[ -x .venv/bin/python ]]; then
  .venv/bin/python -m pip freeze > "$BACKUP/requirements-installed.txt"
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl cat "$SERVICE_NAME" > "$BACKUP/systemd-unit.txt" 2>/dev/null || true
fi
df -h "$PROJECT_ROOT" "$BACKUP" > "$BACKUP/disk.txt"
du -sh "$DATA_DIR_ABS" > "$BACKUP/data-size.txt"

paths=("$DATA_DIR" slide_flow.properties slide_flow.properties.bak .secrets slide_flow.env .env app/static/dist)
existing=()
for path in "${paths[@]}"; do
  if [[ -e "$PROJECT_ROOT/$path" || -L "$PROJECT_ROOT/$path" ]]; then
    existing+=("$path")
  fi
done
(( ${#existing[@]} > 0 )) || die "nothing to back up"
tar -czpf "$BACKUP/state.tar.gz" -C "$PROJECT_ROOT" "${existing[@]}"
tar -tzf "$BACKUP/state.tar.gz" > "$BACKUP/state-files.txt"
sha256sum "$BACKUP/state.tar.gz" > "$BACKUP/state.sha256"
(cd "$BACKUP" && sha256sum -c state.sha256)

if [[ "${SLIDEFLOW_UPGRADE_DRY_RUN:-0}" == 1 ]]; then
  info "dry run complete; no service or source files changed"
  info "backup=$BACKUP"
  exit 0
fi

trap restore_service_on_failure EXIT
info "stopping production service"
SYSTEMD_AVAILABLE=0
if command -v systemctl >/dev/null 2>&1 &&
   [[ "$(systemctl show --property=LoadState --value "$SERVICE_NAME" 2>/dev/null || true)" == "loaded" ]]; then
  SYSTEMD_AVAILABLE=1
  if [[ "$(id -u)" -eq 0 ]]; then
    systemctl stop "$SERVICE_NAME"
  else
    sudo systemctl stop "$SERVICE_NAME"
  fi
  SERVICE_STOPPED=1
  wait_for_inactive || die "service did not stop within 60 seconds: $SERVICE_NAME"
else
  [[ -x tools/stop.sh ]] || die "systemd service not found and tools/stop.sh is missing"
  bash tools/stop.sh
  SERVICE_STOPPED=1
fi

if [[ -f "$DATA_DIR_ABS/db/slide_flow.db" && -x .venv/bin/python ]]; then
  .venv/bin/python - "$DATA_DIR_ABS/db/slide_flow.db" <<'PY'
import sqlite3
import sys

db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    result = db.execute("PRAGMA integrity_check").fetchone()
    if result != ("ok",):
        raise SystemExit(f"database integrity check failed: {result!r}")
finally:
    db.close()
PY
fi

if [[ -n "$(git status --porcelain)" ]]; then
  git stash push -u -m "before-history-reconcile-$STAMP"
  git rev-parse refs/stash > "$BACKUP/stash-ref.txt"
fi

if (( AHEAD > 0 )); then
  (( ALIGN_HISTORY == 1 )) || die "history requires --align-history"
  info "aligning local history to $REMOTE (no git clean will run)"
  git reset --hard "$REMOTE"
elif (( BEHIND > 0 )); then
  git merge --ff-only "$REMOTE"
fi
git branch --set-upstream-to="$REMOTE" main

tar -xzpf "$BACKUP/state.tar.gz" -C "$PROJECT_ROOT"
test -f slide_flow.properties
test -f "$DATA_DIR_ABS/db/slide_flow.db"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] ||
  die "tracked files changed after restoring production state; review before continuing"

info "running formal updater"
bash tools/update.sh
UPGRADE_RESTART_SUBMITTED=1
SERVICE_STOPPED=0

info "waiting for HTTP readiness on port $PORT"
ready=0
for _ in $(seq 1 180); do
  if curl --noproxy '*' -fsS --max-time 3 "http://127.0.0.1:$PORT/api/config" >/dev/null; then
    ready=1
    break
  fi
  sleep 5
done
(( ready == 1 )) || die "API did not become ready"

if command -v systemctl >/dev/null 2>&1 && (( SYSTEMD_AVAILABLE == 1 )); then
  systemctl is-active --quiet "$SERVICE_NAME" || die "service is not active: $SERVICE_NAME"
fi

FINAL_COMMIT="$(git rev-parse HEAD)"
info "reconciled update succeeded"
info "commit=$FINAL_COMMIT"
info "backup=$BACKUP"
info "api=http://127.0.0.1:$PORT/api/config"
trap - EXIT
