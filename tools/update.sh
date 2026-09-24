#!/usr/bin/env bash
# ============================================================
# SlideFlow system upgrade
# 1) fetch and fast-forward to the configured branch on origin
# 2) hand off to the newly fetched script when the commit changes
# 3) restart through systemd or the detached direct-run helper
# ============================================================
set -Eeuo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
PREFIX='[SlideFlow]'
log_info() { echo -e "${GREEN}${PREFIX}${NC} $*"; }
log_warn() { echo -e "${YELLOW}${PREFIX}${NC} $*"; }
log_error() { echo -e "${RED}${PREFIX}${NC} $*" >&2; }

RESUME_COMMIT="${SLIDEFLOW_UPDATE_RESUME_COMMIT:-}"
unset SLIDEFLOW_UPDATE_RESUME_COMMIT
UPGRADE_FINISHED=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$PROJECT_ROOT/slide_flow.properties"
# shellcheck source=tools/runtime_operation.sh
source "$SCRIPT_DIR/runtime_operation.sh"
UPGRADE_START_DELAY="${SLIDEFLOW_OPERATION_START_DELAY:-${SLIDEFLOW_UPGRADE_START_DELAY:-0}}"
cd "$PROJECT_ROOT" || exit 1

read_prop() {
  local key="$1"
  if [ -f "$CONFIG_FILE" ]; then
    awk -F= -v k="^${key}=" '$0 ~ k {sub(/^[^=]*=/, ""); gsub(/\r/, ""); print; exit}' "$CONFIG_FILE"
  fi
}

write_upgrade_state() {
  write_operation_state "$1" "$2"
}

release_upgrade_lock() {
  release_operation_lock
}

fail_upgrade() {
  local exit_code=$?
  local line_no="${1:-unknown}"
  if [ "$UPGRADE_FINISHED" -eq 0 ]; then
    UPGRADE_FINISHED=1
    trap - ERR
    set +e
    write_upgrade_state "failed" "升级失败（步骤行 ${line_no}，退出码 ${exit_code}），请检查 upgrade.log"
    release_upgrade_lock
    log_error "升级失败（步骤行 ${line_no}，退出码 ${exit_code}）"
  fi
  exit "$exit_code"
}

trap 'fail_upgrade $LINENO' ERR

if ! [[ "$UPGRADE_START_DELAY" =~ ^[0-9]+$ ]]; then
  UPGRADE_START_DELAY=0
fi
if [ "$UPGRADE_START_DELAY" -gt 0 ]; then
  sleep "$UPGRADE_START_DELAY"
fi

echo "=========================================="
echo "   正在更新 SlideFlow..."
echo "=========================================="
echo "项目目录: $PROJECT_ROOT"
write_upgrade_state "running" "正在检查远程版本"

if ! command -v git >/dev/null 2>&1; then
  log_error "未检测到 git，请先安装 Git"
  false
fi
git rev-parse --is-inside-work-tree >/dev/null

CURRENT_COMMIT="$(git rev-parse HEAD)"
if [ -n "$RESUME_COMMIT" ] && [ "$CURRENT_COMMIT" = "$RESUME_COMMIT" ]; then
  log_info "[1/3] 已载入更新后的脚本，继续完成更新"
else
  log_info "[1/3] 正在拉取远程代码"
  git fetch --prune origin

  CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  REMOTE_BRANCH=""
  if [ -n "$CURRENT_BRANCH" ] && git show-ref --verify --quiet "refs/remotes/origin/${CURRENT_BRANCH}"; then
    REMOTE_BRANCH="origin/${CURRENT_BRANCH}"
  else
    REMOTE_BRANCH="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/@@' || true)"
  fi
  if [ -z "$REMOTE_BRANCH" ]; then
    log_error "无法识别远程跟踪分支，请检查 origin 配置"
    false
  fi

  log_info "目标分支: $REMOTE_BRANCH"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    log_error "检测到未提交的受版本控制文件，已停止升级以避免覆盖本地修改"
    false
  fi
  if ! git merge-base --is-ancestor "$CURRENT_COMMIT" "$REMOTE_BRANCH"; then
    log_error "本地分支包含远端没有的提交或已发生分叉，已停止自动升级"
    false
  fi
  git merge --ff-only "$REMOTE_BRANCH"
  UPDATED_COMMIT="$(git rev-parse HEAD)"
  log_info "代码已更新到 ${UPDATED_COMMIT:0:12}"

  if [ "$CURRENT_COMMIT" != "$UPDATED_COMMIT" ]; then
    log_info "检测到脚本版本变化，切换到更新后的实现"
    exec env \
      SLIDEFLOW_UPDATE_RESUME_COMMIT="$UPDATED_COMMIT" \
      SLIDEFLOW_OPERATION_JOB_ID="$OPERATION_JOB_ID" \
      SLIDEFLOW_OPERATION_TYPE="$OPERATION_TYPE" \
      SLIDEFLOW_OPERATION_STATE_FILE="$OPERATION_STATE_FILE" \
      SLIDEFLOW_OPERATION_LOCK_FILE="$OPERATION_LOCK_FILE" \
      SLIDEFLOW_OPERATION_SOURCE_BOOT_ID="$OPERATION_SOURCE_BOOT_ID" \
      SLIDEFLOW_OPERATION_START_DELAY=0 \
      SLIDEFLOW_UPGRADE_JOB_ID="$OPERATION_JOB_ID" \
      SLIDEFLOW_UPGRADE_STATE_FILE="$OPERATION_STATE_FILE" \
      SLIDEFLOW_UPGRADE_LOCK_FILE="$OPERATION_LOCK_FILE" \
      SLIDEFLOW_UPGRADE_SOURCE_BOOT_ID="$OPERATION_SOURCE_BOOT_ID" \
      SLIDEFLOW_UPGRADE_START_DELAY=0 \
      bash "$SCRIPT_DIR/update.sh" "$@"
  fi
fi

VERSION_FILE="$PROJECT_ROOT/data/.version_info"
COMMIT_HASH="$(git rev-parse --short HEAD)"
UPDATE_TIME="$(date '+%Y-%m-%d %H:%M:%S')"
mkdir -p "$PROJECT_ROOT/data"
printf '{"commit":"%s","updated_at":"%s"}\n' "$COMMIT_HASH" "$UPDATE_TIME" > "$VERSION_FILE"
log_info "版本信息: $COMMIT_HASH ($UPDATE_TIME)"

log_info "[2/3] 正在准备重启服务"
SERVICE_NAME="$(read_prop 'system.service_name' || true)"
SERVICE_NAME="${SERVICE_NAME:-slide-flow}"
case "$SERVICE_NAME" in
  *.service) ;;
  *) SERVICE_NAME="${SERVICE_NAME}.service" ;;
esac
SUDO_PASS="$(read_prop 'system.sudo_password' || true)"

systemd_unit_exists() {
  local load_state
  command -v systemctl >/dev/null 2>&1 || return 1
  load_state="$(systemctl show --property=LoadState --value "$SERVICE_NAME" 2>/dev/null || true)"
  [ -n "$load_state" ] && [ "$load_state" != "not-found" ]
}

log_info "[3/3] 正在重启服务"
write_upgrade_state "restarting" "代码更新完成，正在重启服务"

if systemd_unit_exists; then
  log_info "检测到 systemd 服务: ${SERVICE_NAME}"
  # systemd may terminate this shell with the old service cgroup.  The new
  # backend reconciles the persisted restarting state using its new boot_id.
  if [ "$(id -u)" -eq 0 ]; then
    systemctl restart "$SERVICE_NAME"
  elif [ -n "$SUDO_PASS" ]; then
    printf '%s\n' "$SUDO_PASS" | sudo -S systemctl restart "$SERVICE_NAME"
  else
    sudo -n systemctl restart "$SERVICE_NAME"
  fi
  exit 0
fi

RESTART_SCRIPT="$PROJECT_ROOT/tools/restart.sh"
if [ ! -f "$RESTART_SCRIPT" ]; then
  log_error "未找到 $RESTART_SCRIPT"
  false
fi

SLIDEFLOW_OPERATION_START_DELAY=0 bash "$RESTART_SCRIPT"
# Keep the state as restarting.  The first healthy backend with a new boot_id
# will atomically mark the upgrade successful and release the lock.
UPGRADE_FINISHED=1
trap - ERR
log_info "重启任务已提交，等待新服务确认升级完成"
