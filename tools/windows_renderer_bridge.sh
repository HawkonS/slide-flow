#!/usr/bin/env bash
# Manage the development-only reverse SSH bridge used by Windows pull workers.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$ROOT_DIR/data/run"
STATE_FILE="$STATE_DIR/windows-renderer-bridge.json"
CONTROL_SOCKET="${TMPDIR:-/tmp}/slideflow-wps-bridge-${UID}.sock"

usage() {
  cat <<'EOF'
Usage:
  tools/windows_renderer_bridge.sh start --host HOST [options]
  tools/windows_renderer_bridge.sh status
  tools/windows_renderer_bridge.sh check
  tools/windows_renderer_bridge.sh stop

Start options:
  --host HOST             Windows public IP, DNS name, or SSH config alias
  --user USER             Dedicated Windows SSH user
  --ssh-port PORT         Windows SSH port (default: 22)
  --identity FILE         Private key file; otherwise use ssh-agent/config
  --known-hosts FILE      Verified known_hosts file (default: ~/.ssh/known_hosts)
  --windows-main-port N   Windows loopback port for Mac API (default: 18088)
  --local-main-port N     Mac SlideFlow port (default: slide_flow.properties)

The bridge creates:
  Windows 127.0.0.1:18088 -> Mac 127.0.0.1:8088
EOF
}

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535))
}

local_main_port() {
  local value
  value="$(awk -F= '/^server\.port=/{gsub(/[[:space:]]/, "", $2); print $2}' "$ROOT_DIR/slide_flow.properties" 2>/dev/null || true)"
  printf '%s' "${value:-8088}"
}

port_is_listening() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    python3 - "$port" <<'PY' >/dev/null 2>&1
import socket, sys
with socket.socket() as sock:
    sock.settimeout(0.5)
    raise SystemExit(0 if sock.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
PY
  fi
}

read_state() {
  [ -f "$STATE_FILE" ] || return 1
  python3 - "$STATE_FILE" "$1" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
value = data.get(sys.argv[2], "")
if not isinstance(value, (str, int)):
    raise SystemExit(1)
print(value)
PY
}

control() {
  local operation="$1" target port
  target="$(read_state target)" || return 1
  port="$(read_state ssh_port)" || return 1
  ssh -S "$CONTROL_SOCKET" -p "$port" -O "$operation" "$target"
}

start_bridge() {
  local host="" user="" ssh_port="22" identity=""
  local known_hosts="$HOME/.ssh/known_hosts"
  local windows_main_port="18088" main_port
  main_port="$(local_main_port)"

  while (($#)); do
    case "$1" in
      --host) host="${2:-}"; shift 2 ;;
      --user) user="${2:-}"; shift 2 ;;
      --ssh-port) ssh_port="${2:-}"; shift 2 ;;
      --identity) identity="${2:-}"; shift 2 ;;
      --known-hosts) known_hosts="${2:-}"; shift 2 ;;
      --windows-main-port) windows_main_port="${2:-}"; shift 2 ;;
      --local-main-port) main_port="${2:-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
  done

  [ -n "$host" ] || die "--host is required"
  [[ "$host" != *[[:space:]]* && "$host" != -* ]] || die "invalid SSH host"
  if [ -n "$user" ]; then
    [[ "$user" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid SSH user"
  fi
  for value in "$ssh_port" "$windows_main_port" "$main_port"; do
    valid_port "$value" || die "invalid port: $value"
  done
  [ -f "$known_hosts" ] || die "known_hosts not found: $known_hosts"
  if [ -n "$identity" ]; then
    [ -f "$identity" ] || die "identity file not found: $identity"
    identity="$(cd "$(dirname "$identity")" && pwd)/$(basename "$identity")"
  fi
  port_is_listening "$main_port" || die "SlideFlow is not listening on 127.0.0.1:$main_port"

  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  if [ -f "$STATE_FILE" ] && control check >/dev/null 2>&1; then
    die "bridge is already running; use status or stop"
  fi
  rm -f "$CONTROL_SOCKET" "$STATE_FILE"
  local target="$host"
  [ -z "$user" ] || target="$user@$host"
  local -a command=(
    ssh -M -S "$CONTROL_SOCKET" -fNT
    -p "$ssh_port"
    -o BatchMode=yes
    -o ExitOnForwardFailure=yes
    -o StrictHostKeyChecking=yes
    -o "UserKnownHostsFile=$known_hosts"
    -o ServerAliveInterval=15
    -o ServerAliveCountMax=3
    -o TCPKeepAlive=yes
    -R "127.0.0.1:${windows_main_port}:127.0.0.1:${main_port}"
  )
  if [ -n "$identity" ]; then
    command+=( -o IdentitiesOnly=yes -i "$identity" )
  fi
  command+=( "$target" )
  "${command[@]}"

  python3 - "$STATE_FILE" "$target" "$ssh_port" "$windows_main_port" "$main_port" <<'PY'
import json, os, sys
path, target, ssh_port, windows_main_port, main_port = sys.argv[1:]
with open(path, "w", encoding="utf-8") as handle:
    json.dump({
        "target": target,
        "ssh_port": int(ssh_port),
        "windows_main_port": int(windows_main_port),
        "local_main_port": int(main_port),
    }, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
os.chmod(path, 0o600)
PY

  control check >/dev/null 2>&1 || die "SSH bridge started but control check failed"
  printf 'Bridge started.\n'
  printf '  Windows main API:   http://127.0.0.1:%s\n' "$windows_main_port"
  printf 'Run: tools/windows_renderer_bridge.sh check\n'
}

status_bridge() {
  if control check >/dev/null 2>&1; then
    printf 'Bridge is running.\n'
    local windows_main_port local_main_port
    windows_main_port="$(read_state windows_main_port)"
    local_main_port="$(read_state local_main_port)"
    printf '  Windows main API:   http://127.0.0.1:%s -> Mac 127.0.0.1:%s\n' "$windows_main_port" "$local_main_port"
  else
    printf 'Bridge is not running.\n'
    exit 1
  fi
}

stop_bridge() {
  if control exit >/dev/null 2>&1; then
    printf 'Bridge stopped.\n'
  else
    printf 'Bridge was not running.\n'
  fi
  rm -f "$CONTROL_SOCKET" "$STATE_FILE"
}

check_bridge() {
  status_bridge >/dev/null
  cd "$ROOT_DIR"
  local main_port
  main_port="$(read_state local_main_port)"
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${main_port}/api/config" >/dev/null
  printf 'Local SlideFlow API is reachable; run Test-SlideFlowBridge.ps1 on Windows.\n'
}

command="${1:-}"
shift || true
case "$command" in
  start) start_bridge "$@" ;;
  status) status_bridge ;;
  check) check_bridge ;;
  stop) stop_bridge ;;
  -h|--help|help|"") usage ;;
  *) usage >&2; die "unknown command: $command" ;;
esac
