#!/usr/bin/env bash
# Stop SlideFlow from a process that is independent of the API worker.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$PROJECT_ROOT/slide_flow.properties"
# shellcheck source=tools/runtime_operation.sh
source "$SCRIPT_DIR/runtime_operation.sh"
OPERATION_FINISHED=0

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
    fail_operation "$exit_code" "$line_no" "系统关闭" || true
  fi
  exit "$exit_code"
}

trap 'on_error $LINENO' ERR

abort_shutdown() {
  printf '[SlideFlow] %s\n' "$1" >&2
  OPERATION_FINISHED=1
  trap - ERR
  fail_operation 1 "${2:-$LINENO}" "系统关闭" || true
  exit 1
}

START_DELAY="${SLIDEFLOW_OPERATION_START_DELAY:-${SLIDEFLOW_SHUTDOWN_DELAY:-2}}"
if ! [[ "$START_DELAY" =~ ^[0-9]+$ ]]; then
  START_DELAY=2
fi
sleep "$START_DELAY"
cd "$PROJECT_ROOT" || abort_shutdown "无法进入项目目录: $PROJECT_ROOT"
write_operation_state "running" "正在准备关闭系统"
SERVICE_NAME="$(read_prop 'system.service_name' || true)"
SERVICE_NAME="${SERVICE_NAME:-slide-flow}"
case "$SERVICE_NAME" in
  *.service) ;;
  *) SERVICE_NAME="${SERVICE_NAME}.service" ;;
esac
SUDO_PASS="$(read_prop 'system.sudo_password' || true)"

if systemd_unit_exists; then
  write_operation_state "stopping" "正在通过 systemd 停止服务"
  run_systemctl stop "$SERVICE_NAME"
  OPERATION_FINISHED=1
  trap - ERR
  exit $?
fi

if [ ! -f "$PROJECT_ROOT/stop.sh" ]; then
  abort_shutdown "停止脚本不存在"
fi
write_operation_state "stopping" "正在停止服务进程"
bash "$PROJECT_ROOT/stop.sh"
write_operation_state "succeeded" "系统服务已停止"
release_operation_lock
OPERATION_FINISHED=1
trap - ERR
