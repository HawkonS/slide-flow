#!/usr/bin/env bash
# ============================================================
# SlideFlow 一键更新脚本
# 1) 强制拉取远程最新代码
# 2) 自动重启服务（兼容 systemd 与 start.sh/stop.sh 两种模式）
# 适用于 Mac / Linux
# ============================================================
set -uo pipefail

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

PREFIX="[SlideFlow]"
log_info()  { echo -e "${GREEN}${PREFIX}${NC} $*"; }
log_warn()  { echo -e "${YELLOW}${PREFIX}${NC} $*"; }
log_error() { echo -e "${RED}${PREFIX}${NC} $*"; }

# 路径定位：本脚本位于 <project_root>/tools/，项目根是上一级
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT" || exit 1

echo "=========================================="
echo "   正在更新 SlideFlow..."
echo "=========================================="
echo "项目目录: $PROJECT_ROOT"

# ============================================================
# Step 1 - 拉取远程代码
# ============================================================
log_info "[1/3] 正在拉取远程代码..."

if ! command -v git &>/dev/null; then
  log_error "未检测到 git，请先安装 Git"
  exit 1
fi

# 自动识别远程默认分支：优先 main，其次 master，最后回退 origin/HEAD
REMOTE_BRANCH=""
git fetch --all --prune
if git show-ref --verify --quiet refs/remotes/origin/main; then
  REMOTE_BRANCH="origin/main"
elif git show-ref --verify --quiet refs/remotes/origin/master; then
  REMOTE_BRANCH="origin/master"
else
  REMOTE_BRANCH="$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/@@' || true)"
fi

if [ -z "$REMOTE_BRANCH" ]; then
  log_error "无法识别远程分支，请检查 Git 仓库配置"
  exit 1
fi

log_info "目标分支: $REMOTE_BRANCH"
if ! git reset --hard "$REMOTE_BRANCH"; then
  log_error "代码更新失败，请检查网络或 Git 配置"
  exit 1
fi
log_info "代码已更新到最新版本"

# 写入版本信息文件（commit hash + 更新时间）
VERSION_FILE="$PROJECT_ROOT/data/.version_info"
COMMIT_HASH="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
UPDATE_TIME="$(date '+%Y-%m-%d %H:%M:%S')"
mkdir -p "$PROJECT_ROOT/data"
cat > "$VERSION_FILE" <<EOF
{"commit": "$COMMIT_HASH", "updated_at": "$UPDATE_TIME"}
EOF
log_info "版本信息: $COMMIT_HASH ($UPDATE_TIME)"

# ============================================================
# Step 2 - 读取配置（用于重启方式选择和 sudo 密码）
# ============================================================
log_info "[2/3] 正在准备重启服务..."

CONFIG_FILE="$PROJECT_ROOT/slide_flow.properties"

read_prop() {
  local key="$1"
  if [ -f "$CONFIG_FILE" ]; then
    awk -F= -v k="^${key}=" '$0 ~ k {sub(/^[^=]*=/, ""); gsub(/\r/, ""); print; exit}' "$CONFIG_FILE"
  fi
}

SUDO_PASS="$(read_prop 'system.sudo_password' || true)"
SERVICE_NAME="$(read_prop 'system.service_name' || true)"
SERVICE_NAME="${SERVICE_NAME:-slide-flow}"

# ============================================================
# Step 3 - 重启服务
# ============================================================
log_info "[3/3] 正在尝试重启服务..."

# 优先：systemd 服务
SERVICE_OK=0
if command -v systemctl &>/dev/null && systemctl list-unit-files 2>/dev/null | grep -qE "^${SERVICE_NAME}\.service"; then
  log_info "检测到 systemd 服务: ${SERVICE_NAME}"

  if [ -z "$SUDO_PASS" ]; then
    # 未配置 sudo 密码：本脚本可能在无终端环境（API 触发的后台升级）运行，
    # 不能交互式 read 等待输入（会永久阻塞），改用 sudo -n 免密尝试
    log_warn "未配置 system.sudo_password，尝试免密 sudo（sudo -n）重启服务"
    sudo -n systemctl restart "$SERVICE_NAME"
    RESTART_RC=$?
  else
    echo "$SUDO_PASS" | sudo -S systemctl restart "$SERVICE_NAME"
    RESTART_RC=$?
  fi

  if [ "$RESTART_RC" -eq 0 ]; then
    log_info "服务重启成功！"
    echo "------------------------------------------"
    systemctl status "$SERVICE_NAME" --no-pager || true
    echo "------------------------------------------"
    SERVICE_OK=1
  else
    log_error "systemd 服务重启失败，将回退到 start.sh/stop.sh 模式"
  fi
fi

# 回退：使用项目自带的 stop.sh + start.sh
if [ "$SERVICE_OK" -ne 1 ]; then
  START_SCRIPT="$PROJECT_ROOT/start.sh"
  STOP_SCRIPT="$PROJECT_ROOT/stop.sh"

  if [ ! -f "$START_SCRIPT" ]; then
    log_error "未找到 $START_SCRIPT，请手动重启服务"
    exit 1
  fi

  # 停止现有进程
  if [ -f "$STOP_SCRIPT" ]; then
    log_info "执行 stop.sh 停止旧进程..."
    bash "$STOP_SCRIPT" || log_warn "stop.sh 返回非零，继续尝试启动"
  else
    log_warn "未找到 stop.sh，跳过停止步骤"
  fi

  # 启动日志路径（与 start.sh 中 log.dir 保持一致）
  LOG_DIR="$(read_prop 'log.dir' || true)"
  LOG_DIR="${LOG_DIR:-data/logs}"
  case "$LOG_DIR" in
    /*) ;;
    *)  LOG_DIR="$PROJECT_ROOT/$LOG_DIR" ;;
  esac
  mkdir -p "$LOG_DIR"
  STARTUP_LOG="$LOG_DIR/startup.log"

  log_info "以后台方式启动 start.sh (日志: $STARTUP_LOG)"
  # macOS 上 setsid 不可用且行为与 Linux 不一致，采用平台区分策略
  RESTART_OS="$(uname -s)"
  if [ "$RESTART_OS" = "Darwin" ]; then
    nohup bash "$START_SCRIPT" >"$STARTUP_LOG" 2>&1 < /dev/null &
  elif command -v setsid &>/dev/null; then
    setsid bash "$START_SCRIPT" >"$STARTUP_LOG" 2>&1 < /dev/null &
  else
    nohup bash "$START_SCRIPT" >"$STARTUP_LOG" 2>&1 < /dev/null &
  fi
  NEW_PID=$!
  disown "$NEW_PID" 2>/dev/null || true

  # 简单等待并检查进程是否仍存活
  sleep 2
  if kill -0 "$NEW_PID" 2>/dev/null; then
    log_info "start.sh 已在后台启动 (PID: $NEW_PID)"
    log_info "如需查看启动过程，请执行: tail -f $STARTUP_LOG"
  else
    log_error "start.sh 启动后立即退出，请检查日志: $STARTUP_LOG"
    exit 1
  fi
fi

echo "=========================================="
echo "   更新流程结束"
echo "=========================================="
