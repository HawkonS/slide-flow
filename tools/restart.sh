#!/usr/bin/env bash
# Restart SlideFlow from a process that is independent of the API worker.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$PROJECT_ROOT/slide_flow.properties"
# shellcheck source=tools/runtime_operation.sh
source "$SCRIPT_DIR/runtime_operation.sh"
OPERATION_FINISHED=0

log_info() { printf '[SlideFlow] %s\n' "$*"; }
log_error() { printf '[SlideFlow] %s\n' "$*" >&2; }

read_prop() {
  local key="$1"
  if [ -f "$CONFIG_FILE" ]; then
    awk -F= -v k="^${key}=" '$0 ~ k {sub(/^[^=]*=/, ""); gsub(/\r/, ""); print; exit}' "$CONFIG_FILE"
  fi
}

systemd_unit_exists() {
  local load_state
  command -v systemctl >/dev/null 2>&1 || return 1
  load_state="$(systemctl show --property=LoadState --value "$SERVICE_NAME" 2>/dev/null || true)"
  [ -n "$load_state" ] && [ "$load_state" != "not-found" ]
}

run_systemctl() {
  if [ "$(id -u)" -eq 0 ]; then
    systemctl "$@"
  elif [ -n "$SUDO_PASS" ]; then
    printf '%s\n' "$SUDO_PASS" | sudo -S systemctl "$@"
  else
    sudo -n systemctl "$@"
  fi
}

on_error() {
  local exit_code=$?
  local line_no="${1:-unknown}"
  if [ "$OPERATION_FINISHED" -eq 0 ]; then
    OPERATION_FINISHED=1
    trap - ERR
    fail_operation "$exit_code" "$line_no" "服务重启" || true
  fi
  exit "$exit_code"
}

trap 'on_error $LINENO' ERR

abort_restart() {
  log_error "$1"
  OPERATION_FINISHED=1
  trap - ERR
  fail_operation 1 "${2:-$LINENO}" "服务重启" || true
  exit 1
}

START_DELAY="${SLIDEFLOW_OPERATION_START_DELAY:-${SLIDEFLOW_RESTART_DELAY:-2}}"
if ! [[ "$START_DELAY" =~ ^[0-9]+$ ]]; then
  START_DELAY=2
fi
sleep "$START_DELAY"
cd "$PROJECT_ROOT" || abort_restart "无法进入项目目录: $PROJECT_ROOT"
write_operation_state "running" "正在准备重启服务"

SERVICE_NAME="$(read_prop 'system.service_name' || true)"
SERVICE_NAME="${SERVICE_NAME:-slide-flow}"
case "$SERVICE_NAME" in
  *.service) ;;
  *) SERVICE_NAME="${SERVICE_NAME}.service" ;;
esac
SUDO_PASS="$(read_prop 'system.sudo_password' || true)"

if systemd_unit_exists; then
  log_info "正在通过 systemd 重启 ${SERVICE_NAME}"
  write_operation_state "restarting" "正在通过 systemd 重启服务"
  if run_systemctl restart "$SERVICE_NAME"; then
    OPERATION_FINISHED=1
    trap - ERR
    log_info "systemd 重启指令已提交"
    exit 0
  fi
  abort_restart "systemd 服务重启失败"
fi

STOP_SCRIPT="$PROJECT_ROOT/stop.sh"
START_SCRIPT_NAME="$(read_prop 'startup.script' || true)"
START_SCRIPT_NAME="${START_SCRIPT_NAME:-run.sh}"
case "$START_SCRIPT_NAME" in
  /*) START_SCRIPT="$START_SCRIPT_NAME" ;;
  *) START_SCRIPT="$PROJECT_ROOT/$START_SCRIPT_NAME" ;;
esac
if [ ! -f "$START_SCRIPT" ]; then
  abort_restart "启动脚本不存在: $START_SCRIPT"
fi

PORT="$(read_prop 'server.port' || true)"
PORT="${PORT:-8088}"
if ! [[ "$PORT" =~ ^[1-9][0-9]*$ ]] || [ "$PORT" -gt 65535 ]; then
  abort_restart "server.port 不是合法端口: $PORT"
fi

# Python can create a separate POSIX session on macOS and Linux, even when
# the setsid command is unavailable. Check this before stopping anything.
PYTHON_CMD="$(operation_python)" || abort_restart "未找到 Python，无法启动独立的后台服务"

if [ -f "$STOP_SCRIPT" ]; then
  log_info "正在停止旧进程"
  if ! bash "$STOP_SCRIPT"; then
    abort_restart "旧进程停止失败"
  fi
fi

sleep 2
LOG_DIR="$(read_prop 'log.dir' || true)"
LOG_DIR="${LOG_DIR:-data/logs}"
case "$LOG_DIR" in
  /*) ;;
  *) LOG_DIR="$PROJECT_ROOT/$LOG_DIR" ;;
esac
mkdir -p "$LOG_DIR"
STARTUP_LOG="$LOG_DIR/startup.log"

log_info "正在后台启动 $START_SCRIPT"
write_operation_state "restarting" "旧服务已停止，正在启动新服务"
# nohup ignores SIGHUP but keeps the caller's process group. Cleaning up
# that group can otherwise kill a server that already passed its health check.
new_pid="$("$PYTHON_CMD" - "$START_SCRIPT" "$STARTUP_LOG" <<'PY'
import subprocess
import sys

with open(sys.argv[2], "wb") as log_file:
    process = subprocess.Popen(
        ["bash", sys.argv[1]],
        stdin=subprocess.DEVNULL,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
    )
print(process.pid)
PY
)"

probe_backend() {
  if [ -n "$PYTHON_CMD" ]; then
    "$PYTHON_CMD" - "$PORT" <<'PY' >/dev/null 2>&1
import sys
import urllib.request

try:
    with urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/api/config", timeout=1) as response:
        raise SystemExit(0 if response.status == 200 else 1)
except Exception:
    raise SystemExit(1)
PY
    return
  fi
  command -v curl >/dev/null 2>&1 && curl --fail --silent --max-time 1 "http://127.0.0.1:${PORT}/api/config" >/dev/null
}

for attempt in $(seq 1 450); do
  if probe_backend; then
    OPERATION_FINISHED=1
    trap - ERR
    # The new backend normally reconciles this task first. If it has not yet
    # done so, leave the state as restarting and let its next status request
    # confirm the new boot_id.
    log_info "服务已恢复并通过 HTTP 健康检查 (PID: $new_pid)"
    exit 0
  fi
  if ! kill -0 "$new_pid" 2>/dev/null; then
    log_error "启动脚本已退出，请检查 $STARTUP_LOG"
    tail -n 40 "$STARTUP_LOG" >&2 2>/dev/null || true
    abort_restart "新服务启动进程已退出" "$LINENO"
  fi
  sleep 2
done

log_error "服务未在 900 秒内通过 HTTP 健康检查: http://127.0.0.1:${PORT}/api/config"
tail -n 40 "$STARTUP_LOG" >&2 2>/dev/null || true
abort_restart "服务 HTTP 健康检查超时" "$LINENO"
