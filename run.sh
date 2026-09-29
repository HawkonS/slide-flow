#!/usr/bin/env bash
# ============================================================
# SlideFlow 一键启动脚本
# 适用于 Mac / Linux 环境，自动检测依赖并启动前后端服务
#
# 运行模式：
#   生产模式（默认）：构建前端产物并优先使用 Gunicorn + Uvicorn Worker；
#                     生产服务器安装或启动失败时回退原生 Uvicorn。
#   开发模式：设置 SLIDEFLOW_DEV=1 或传入 --dev 参数，使用 Uvicorn + Vite。
#
# 环境变量：
#   SLIDEFLOW_FORCE_BUILD=1：强制重新执行前端构建（忽略产物版本比对）。
#
# 生产构建策略（产物优先 + 更新感知）：
#   1. dist/index.html 不存在 → 自动构建（首次部署/产物被清理）；
#   2. dist 存在时比对 dist/.build_version（构建时写入的前端源码内容指纹）
#      与当前源码：不一致说明前端代码已更新（包含尚未提交的本地修改）
#      → 重建并刷新标记；一致 → 直接复用；
#   3. 无法获取版本信息时退化为 "dist 存在即复用"；
#   4. 重建失败但旧 dist 可用时降级继续启动，避免重启死循环。
# ============================================================
set -euo pipefail

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 统一前缀
PREFIX="[SlideFlow]"

log_info()  { echo -e "${GREEN}${PREFIX}${NC} $*"; }
log_warn()  { echo -e "${YELLOW}${PREFIX}${NC} $*"; }
log_error() { echo -e "${RED}${PREFIX}${NC} $*"; }

# 切换到脚本所在目录
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# ===========================================================
# 运行模式解析：默认生产模式，--dev 或 SLIDEFLOW_DEV=1 进入开发模式
# ===========================================================
DEV_MODE="false"
for arg in "$@"; do
  case "$arg" in
    --dev) DEV_MODE="true" ;;
    *) ;;
  esac
done
if [ "${SLIDEFLOW_DEV:-0}" = "1" ]; then
  DEV_MODE="true"
fi

# ===========================================================
# Step 1 - 环境检测（全新机器友好）
# ===========================================================
log_info "正在检测运行环境..."

# 检测操作系统
OS="$(uname -s)"
case "$OS" in
  Darwin) OS_NAME="macOS" ;;
  Linux)  OS_NAME="Linux" ;;
  *)      OS_NAME="$OS" ;;
esac
log_info "操作系统: $OS_NAME ($OS)"

# 检查 python3
PYTHON_CMD=""
if command -v python3.12 &>/dev/null; then
  PYTHON_CMD="python3.12"
elif command -v python3.11 &>/dev/null; then
  PYTHON_CMD="python3.11"
elif command -v python3.10 &>/dev/null; then
  PYTHON_CMD="python3.10"
elif command -v python3 &>/dev/null; then
  PYTHON_CMD="python3"
else
  log_error "未检测到 python3，请先安装："
  if [ "$OS" = "Darwin" ]; then
    log_error "  brew install python3"
  else
    log_error "  sudo apt install python3 python3-venv python3-pip"
  fi
  exit 1
fi

# 检查 Python 版本是否 >= 3.10
PYTHON_VERSION=$($PYTHON_CMD -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PYTHON_MAJOR=$($PYTHON_CMD -c 'import sys; print(sys.version_info.major)')
PYTHON_MINOR=$($PYTHON_CMD -c 'import sys; print(sys.version_info.minor)')

if [ "$PYTHON_MAJOR" -lt 3 ] || ([ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -lt 10 ]); then
  log_error "Python 版本过低 ($PYTHON_VERSION)，需要 Python 3.10 或更高版本"
  log_error "代码使用了 Python 3.10+ 的语法特性（如 str | None）"
  if [ "$OS" = "Darwin" ]; then
    log_error "请安装: brew install python@3.10"
  else
    log_error "请升级到 Python 3.10+"
  fi
  exit 1
fi

log_info "Python: $PYTHON_CMD ($PYTHON_VERSION)"

# React Router 7 的构建工具链要求 Node.js 20+。systemd 不会加载 nvm 等
# 交互式 shell 配置，因此 Linux 上不能只依赖用户登录环境里的 node。
# 若系统 Node.js 缺失或版本过低，自动下载一份固定版本到项目目录，保证
# 重启和开机自启时使用同一套运行时。可通过 SLIDEFLOW_NODE_VERSION 覆盖。
NODE_BIN=""
NPM_BIN=""
NODE_RUNTIME_VERSION="${SLIDEFLOW_NODE_VERSION:-20.20.2}"
NODE_RUNTIME_ROOT="$ROOT_DIR/.runtime"
if ! [[ "$NODE_RUNTIME_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  log_error "SLIDEFLOW_NODE_VERSION 必须是完整版本号（例如 20.20.2）"
  exit 1
fi
NODE_RUNTIME_MAJOR="${NODE_RUNTIME_VERSION%%.*}"
if [ "$NODE_RUNTIME_MAJOR" -lt 20 ]; then
  log_error "SLIDEFLOW_NODE_VERSION 必须是 Node.js 20 或更高版本"
  exit 1
fi

node_major_for() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

node_arch_for() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64\n' ;;
    aarch64|arm64) printf 'arm64\n' ;;
    armv7l|armv7) printf 'armv7l\n' ;;
    *) return 1 ;;
  esac
}

download_file() {
  local url="$1"
  local target="$2"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 -o "$target" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --tries=3 --timeout=15 -O "$target" "$url"
  else
    "$PYTHON_CMD" - "$url" "$target" <<'PY'
import sys
import urllib.request

urllib.request.urlretrieve(sys.argv[1], sys.argv[2])
PY
  fi
}

verify_sha256() {
  local file="$1"
  local expected="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "$expected" "$file" | sha256sum -c - >/dev/null 2>&1
  elif command -v shasum >/dev/null 2>&1; then
    [ "$(shasum -a 256 "$file" | awk '{print $1}')" = "$expected" ]
  else
    "$PYTHON_CMD" - "$file" "$expected" <<'PY'
import hashlib
import sys

digest = hashlib.sha256()
with open(sys.argv[1], "rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
raise SystemExit(0 if digest.hexdigest() == sys.argv[2] else 1)
PY
  fi
}

install_project_node() {
  local arch package base_url checksum_file expected_checksum
  local archive temp_dir extracted_dir install_dir

  if [ "$OS" != "Linux" ]; then
    return 1
  fi
  if ! arch="$(node_arch_for)"; then
    log_error "无法识别 Linux 架构 ($(uname -m))，无法自动安装 Node.js"
    return 1
  fi

  package="node-v${NODE_RUNTIME_VERSION}-linux-${arch}.tar.gz"
  base_url="https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}"
  install_dir="$NODE_RUNTIME_ROOT/node-v${NODE_RUNTIME_VERSION}-linux-${arch}"
  if [ -x "$install_dir/bin/node" ] && [ -x "$install_dir/bin/npm" ]; then
    NODE_BIN="$install_dir/bin/node"
    NPM_BIN="$install_dir/bin/npm"
    export PATH="$install_dir/bin:$PATH"
    return 0
  fi

  if ! mkdir -p "$NODE_RUNTIME_ROOT"; then
    log_error "无法创建 Node.js 运行时目录: $NODE_RUNTIME_ROOT"
    return 1
  fi
  if ! temp_dir="$(mktemp -d "$NODE_RUNTIME_ROOT/node-install.XXXXXX")"; then
    log_error "无法创建 Node.js 临时安装目录: $NODE_RUNTIME_ROOT"
    return 1
  fi
  archive="$temp_dir/$package"
  checksum_file="$temp_dir/SHASUMS256.txt"
  install_dir="$NODE_RUNTIME_ROOT/${package%.tar.gz}"

  log_warn "正在自动安装 Node.js ${NODE_RUNTIME_VERSION} (${arch}) 到 ${NODE_RUNTIME_ROOT}"
  if ! download_file "$base_url/$package" "$archive" \
      || ! download_file "$base_url/SHASUMS256.txt" "$checksum_file"; then
    log_error "Node.js 下载失败，请检查服务器网络或设置 SLIDEFLOW_NODE_VERSION"
    rm -rf "$temp_dir"
    return 1
  fi

  expected_checksum="$(awk -v package="$package" '$2 == "*" package || $2 == package {print $1; exit}' "$checksum_file")"
  if [ -z "$expected_checksum" ] || ! verify_sha256 "$archive" "$expected_checksum"; then
    log_error "Node.js 安装包校验失败，已删除临时文件"
    rm -rf "$temp_dir"
    return 1
  fi

  rm -rf "$install_dir"
  if ! tar -xzf "$archive" -C "$temp_dir"; then
    log_error "Node.js 安装包解压失败"
    rm -rf "$temp_dir"
    return 1
  fi
  extracted_dir="$temp_dir/node-v${NODE_RUNTIME_VERSION}-linux-${arch}"
  if [ ! -x "$extracted_dir/bin/node" ] || [ ! -x "$extracted_dir/bin/npm" ]; then
    log_error "Node.js 安装包内容不完整"
    rm -rf "$temp_dir"
    return 1
  fi
  if ! mv "$extracted_dir" "$install_dir"; then
    log_error "无法写入 Node.js 运行时目录: $install_dir"
    rm -rf "$temp_dir"
    return 1
  fi
  rm -rf "$temp_dir"

  NODE_BIN="$install_dir/bin/node"
  NPM_BIN="$install_dir/bin/npm"
  export PATH="$install_dir/bin:$PATH"
  log_info "Node.js 自动安装完成: $($NODE_BIN --version 2>&1)"
}

SYSTEM_NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -n "$SYSTEM_NODE_BIN" ] && [ "$(node_major_for "$SYSTEM_NODE_BIN")" -ge 20 ] 2>/dev/null \
    && [ -x "$(dirname "$SYSTEM_NODE_BIN")/npm" ]; then
  NODE_BIN="$SYSTEM_NODE_BIN"
  NPM_BIN="$(dirname "$SYSTEM_NODE_BIN")/npm"
  # npm 的 shebang 通过 PATH 查找 node，确保它与选中的 Node.js 配套。
  export PATH="$(dirname "$SYSTEM_NODE_BIN"):$PATH"
else
  if [ -n "$SYSTEM_NODE_BIN" ]; then
    log_warn "检测到系统 Node.js $($SYSTEM_NODE_BIN --version 2>&1)，低于要求的 20；准备自动安装兼容版本"
  else
    log_warn "未检测到 Node.js，准备自动安装兼容版本"
  fi
  if ! install_project_node; then
    log_error "Node.js 20+ 不可用，启动中止"
    if [ "$OS" = "Darwin" ]; then
      log_error "请安装: brew install node@20"
    else
      log_error "请检查服务器网络，或手动安装 Node.js 20 LTS"
    fi
    exit 1
  fi
fi

# 输出版本信息
log_info "Python : $($PYTHON_CMD --version 2>&1)"
log_info "Node.js: $($NODE_BIN --version 2>&1)"
log_info "npm    : $($NPM_BIN --version 2>&1)"

# ===========================================================
# Step 2 - 配置文件处理
# ===========================================================
log_info "正在读取配置..."

PROPS="slide_flow.properties"

# 配置定义与默认值由 app/config.py 统一维护，缺失时直接生成真实配置文件
CONFIG_WAS_MISSING="false"
if [ ! -f "$PROPS" ]; then
  CONFIG_WAS_MISSING="true"
  log_warn "未找到 ${PROPS}，正在生成默认配置"
fi
if ! "$PYTHON_CMD" -c 'from app.config import ensure_properties_file; ensure_properties_file()'; then
  log_error "生成或检查 ${PROPS} 失败"
  exit 1
fi
if [ "$CONFIG_WAS_MISSING" = "true" ]; then
  log_info "配置文件已生成: $ROOT_DIR/$PROPS"
fi

# 从 properties 文件解析配置
PORT="$(awk -F= '/^server\.port=/{gsub(/[[:space:]]/, "", $2); print $2}' "$PROPS" 2>/dev/null || true)"

WEB_PORT="$(awk -F= '/^server\.web_port=/{gsub(/[[:space:]]/, "", $2); print $2}' "$PROPS" 2>/dev/null || true)"

WORKERS="$(awk -F= '/^server\.workers=/{gsub(/[[:space:]]/, "", $2); print $2}' "$PROPS" 2>/dev/null || true)"
if ! [[ "$PORT" =~ ^[1-9][0-9]*$ ]] || ! [[ "$WEB_PORT" =~ ^[1-9][0-9]*$ ]] || ! [[ "$WORKERS" =~ ^[1-9][0-9]*$ ]]; then
  log_error "server.port、server.web_port 和 server.workers 必须是正整数"
  exit 1
fi

LOG_DIR="$(awk -F= '/^log\.dir=/{gsub(/[[:space:]]/, "", $2); print $2}' "$PROPS" 2>/dev/null || true)"
if [ -z "$LOG_DIR" ]; then
  log_error "log.dir 不能为空"
  exit 1
fi
# 相对路径基于 ROOT_DIR 解析
case "$LOG_DIR" in
  /*) ;; # 绝对路径，不处理
  *)  LOG_DIR="$ROOT_DIR/$LOG_DIR" ;;
esac

# 读取 web.https 配置
WEB_HTTPS_RAW="$(awk -F= '/^web\.https=/{gsub(/[[:space:]]/, "", $2); print tolower($2)}' "$PROPS" 2>/dev/null || true)"
case "$WEB_HTTPS_RAW" in
  true)  WEB_HTTPS="true" ;;
  false) WEB_HTTPS="false" ;;
  *)
    log_error "web.https 只能填写 true 或 false"
    exit 1
    ;;
esac
export SLIDE_FLOW_HTTPS="$WEB_HTTPS"

# 读取允许的访问域名配置
ALLOWED_HOST="$(awk -F= '/^server\.allowed_host=/{gsub(/[[:space:]]/, "", $2); print $2}' "$PROPS" 2>/dev/null || true)"
export SLIDE_FLOW_ALLOWED_HOST="$ALLOWED_HOST"

# 读取 sudo 密码（用于自动安装系统依赖）
SUDO_PASSWORD="$(awk -F= '/^system\.sudo_password=/{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2}' "$PROPS" 2>/dev/null || true)"

# 辅助函数：带密码的 sudo
sudo_with_password() {
  if [ -n "$SUDO_PASSWORD" ]; then
    echo "$SUDO_PASSWORD" | sudo -S "$@" 2>/dev/null
  else
    sudo "$@"
  fi
}

if [ "$DEV_MODE" = "true" ]; then
  log_info "后端端口: $PORT | 前端端口: $WEB_PORT (Vite 开发服务器) | Workers: $WORKERS"
else
  # 生产模式：前端由后端托管静态产物，不再打印前端端口噪音
  log_info "后端端口: $PORT | Workers: $WORKERS (前端由后端托管)"
fi
if [ -n "$ALLOWED_HOST" ]; then
  log_info "允许的访问域名: $ALLOWED_HOST"
fi
if [ "$DEV_MODE" = "true" ]; then
  log_warn "开发模式：前端将由 Vite 开发服务器托管 (--dev / SLIDEFLOW_DEV=1)"
else
  log_info "生产模式：前端将构建后由 FastAPI 托管静态产物"
fi

# 启动前先检查端口，避免第二次运行脚本覆盖日志后才报
# "Address already in use"，同时避免健康检查误把旧进程当成新进程。
REUSE_BACKEND="false"
port_is_listening() {
  if command -v lsof &>/dev/null; then
    local pids
    # Only a LISTEN socket owns the local server port. lsof -iTCP without a
    # state filter also returns stale TIME_WAIT connections after stop.sh has
    # terminated the server, causing run.sh to report a false port conflict
    # until the kernel reaps those connections.
    pids="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
    [ -n "$pids" ]
    return
  fi
  "$PYTHON_CMD" - "$PORT" <<'PY' >/dev/null 2>&1
import socket
import sys

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.settimeout(0.5)
    raise SystemExit(0 if sock.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
PY
}

probe_backend() {
  "$PYTHON_CMD" - "$PORT" <<'PY' >/dev/null 2>&1
import sys
import urllib.request

try:
    with urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/api/config", timeout=1) as response:
        raise SystemExit(0 if response.status == 200 else 1)
except Exception:
    raise SystemExit(1)
PY
}

if port_is_listening; then
  if probe_backend; then
    if [ "$DEV_MODE" = "true" ]; then
      REUSE_BACKEND="true"
      log_warn "检测到后端已在运行 (端口 $PORT)，开发模式将复用该后端并仅启动 Vite"
    else
      log_warn "后端已在运行并可访问: http://127.0.0.1:$PORT"
      log_info "如需加载最新代码，请先执行 ./stop.sh，再重新执行 ./run.sh"
      exit 0
    fi
  else
    log_error "端口 $PORT 已被其他进程占用，后端无法启动"
    if command -v lsof &>/dev/null; then
      lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
    fi
    log_error "请停止占用该端口的进程，或修改 slide_flow.properties 中的 server.port"
    exit 1
  fi
fi

# ===========================================================
# Step 3 - Python 虚拟环境
# ===========================================================
log_info "正在配置 Python 虚拟环境..."

PYTHON_BIN="$PYTHON_CMD"
PIP_INSTALL=("$PYTHON_BIN" -m pip install --user)

# 已存在的虚拟环境可能由系统 Python 3.9 创建；这种环境会在 Pydantic
# 解析 `str | None` 时才失败，提前检测并重建可直接给出正确启动路径。
if [ -x ".venv/bin/python" ] && [ -f ".venv/bin/activate" ]; then
  VENV_PYTHON_OK="$(.venv/bin/python -c 'import sys; print(int(sys.version_info >= (3, 10)))' 2>/dev/null || echo 0)"
  if [ "$VENV_PYTHON_OK" != "1" ]; then
    VENV_PYTHON_VERSION="$(.venv/bin/python --version 2>&1 || echo unknown)"
    log_warn "现有 .venv 使用 $VENV_PYTHON_VERSION，低于 Python 3.10，正在重建虚拟环境"
    rm -rf .venv
  fi
fi

# 检查 .venv 是否已存在且可用
if [ ! -x ".venv/bin/python" ] || [ ! -f ".venv/bin/activate" ]; then
  rm -rf .venv
  if "$PYTHON_BIN" -m venv .venv >/tmp/slide_flow_venv.log 2>&1; then
    log_info "虚拟环境创建成功"
  else
    rm -rf .venv
    # Linux 下尝试自动安装 python3-venv 和 python3-full 后重试
    if [ "$OS" = "Linux" ]; then
      log_warn "python venv 不可用，正在自动安装 python3-venv..."
      if sudo_with_password apt-get update -qq && sudo_with_password apt-get install -y -qq python3-venv python3-full; then
        log_info "python3-venv 安装成功，重新创建虚拟环境..."
        if "$PYTHON_BIN" -m venv .venv >/tmp/slide_flow_venv.log 2>&1; then
          log_info "虚拟环境创建成功"
        else
          rm -rf .venv
          log_error "安装 python3-venv 后仍无法创建虚拟环境，请手动排查"
          log_error "  日志: /tmp/slide_flow_venv.log"
          exit 1
        fi
      else
        log_warn "自动安装 python3-venv 失败，回退到 --break-system-packages 模式"
        log_warn "  建议手动执行: sudo apt install python3-venv python3-full"
      fi
    else
      log_warn "python venv 不可用，回退到 user-site 安装模式"
    fi
  fi
fi

# 激活虚拟环境（如果存在）
if [ -x ".venv/bin/python" ] && [ -f ".venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
  PYTHON_BIN="python"
  PIP_INSTALL=(python -m pip install)
  log_info "已激活虚拟环境 (.venv)"
else
  # 无虚拟环境时，检测 PEP 668 受限环境并添加 --break-system-packages
  PEP668_MARKER="$($PYTHON_BIN -c "import sysconfig, os; print(os.path.join(sysconfig.get_path('stdlib'), 'EXTERNALLY-MANAGED'))" 2>/dev/null || true)"
  if [ -n "$PEP668_MARKER" ] && [ -f "$PEP668_MARKER" ]; then
    PIP_INSTALL=("$PYTHON_BIN" -m pip install --break-system-packages)
    log_warn "使用系统 Python (PEP 668 受限，已添加 --break-system-packages)"
  else
    PIP_INSTALL=("$PYTHON_BIN" -m pip install --user)
    log_warn "使用系统 Python (user-site 模式)"
  fi
fi

# 同一次启动的所有 ASGI worker 共享该标识。每次重新执行 run.sh 都必须生成
# 新值；否则升级脚本从旧后端进程继承环境变量时，前端会误以为服务没有重启。
export SLIDEFLOW_BOOT_ID="$($PYTHON_BIN -c 'import uuid; print(uuid.uuid4().hex)')"
export SLIDEFLOW_START_TIME="$($PYTHON_BIN -c 'import time; print(time.time())')"
if [ "$DEV_MODE" = "true" ]; then
  export SLIDEFLOW_RUNTIME_MODE="dev"
else
  export SLIDEFLOW_RUNTIME_MODE="static"
fi

# ===========================================================
# Step 4 - Python 依赖安装
# ===========================================================
log_info "正在检查 Python 依赖..."

if "$PYTHON_BIN" "$ROOT_DIR/tools/check_python_dependencies.py" requirements.txt; then
  log_info "Python 依赖已就绪"
else
  DEPENDENCY_CHECK_STATUS=$?
  if [ "$DEPENDENCY_CHECK_STATUS" -ne 1 ]; then
    log_error "无法验证 Python 依赖声明，请检查上方错误；未执行自动安装"
    exit 1
  fi
  log_warn "Python 依赖缺失或版本不符合 requirements.txt，正在安装..."
  if ! "${PIP_INSTALL[@]}" -r requirements.txt; then
    log_error "依赖安装失败，请检查网络和权限"
    exit 1
  fi
  if ! "$PYTHON_BIN" "$ROOT_DIR/tools/check_python_dependencies.py" requirements.txt; then
    log_error "安装后 Python 依赖仍未满足要求，停止启动"
    exit 1
  fi
  log_info "Python 依赖安装完成"
fi

# 生产模式优先使用 Gunicorn 管理 worker 进程，Uvicorn Worker 原生承载
# FastAPI、WebSocket 和 lifespan；安装失败时保留原生 Uvicorn 兜底。
BACKEND_SERVER="uvicorn"
if [ "$DEV_MODE" = "false" ]; then
  if "$PYTHON_BIN" "$ROOT_DIR/tools/check_python_dependencies.py" requirements.txt requirements-production.txt \
    && "$PYTHON_BIN" -c 'import gunicorn, uvicorn_worker' >/dev/null 2>&1
  then
    BACKEND_SERVER="gunicorn"
    log_info "Gunicorn 生产运行环境已就绪"
  else
    PRODUCTION_CHECK_STATUS=$?
    log_warn "Gunicorn 生产依赖未就绪，正在检查自动安装条件..."
    # 同时约束基础依赖，避免可选生产包的解析把基础运行环境降级。
    if [ "$PRODUCTION_CHECK_STATUS" -eq 1 ] \
      && "${PIP_INSTALL[@]}" -r requirements.txt -r requirements-production.txt \
      && "$PYTHON_BIN" "$ROOT_DIR/tools/check_python_dependencies.py" requirements.txt requirements-production.txt \
      && "$PYTHON_BIN" -c 'import gunicorn, uvicorn_worker' >/dev/null 2>&1
    then
      BACKEND_SERVER="gunicorn"
      log_info "Gunicorn 生产运行环境安装完成"
    else
      log_warn "Gunicorn 自动安装失败，将使用 Uvicorn 作为兜底"
    fi
    if ! "$PYTHON_BIN" "$ROOT_DIR/tools/check_python_dependencies.py" requirements.txt; then
      log_error "可选生产依赖安装后基础 Python 依赖不完整，停止启动"
      exit 1
    fi
  fi
fi

# ===========================================================
# Step 5 - 前端依赖安装
# ===========================================================
log_info "正在检查前端依赖..."

if [ -f "web/package.json" ]; then
  if "$NODE_BIN" "$ROOT_DIR/tools/check_frontend_dependencies.mjs" web "$NPM_BIN"; then
    log_info "前端依赖已就绪"
  else
    DEPENDENCY_CHECK_STATUS=$?
    if [ "$DEPENDENCY_CHECK_STATUS" -ne 1 ]; then
      log_error "无法验证前端依赖声明，请检查上方错误；未执行自动安装"
      exit 1
    fi
    FRONTEND_INSTALL_COMMAND="install"
    if [ -f "web/package-lock.json" ]; then
      FRONTEND_INSTALL_COMMAND="ci"
    fi
    log_warn "前端依赖缺失、损坏或锁文件已更新，正在同步 (npm $FRONTEND_INSTALL_COMMAND)..."
    # 生产构建仍需要 Vite/TypeScript 等 devDependencies，即使 NODE_ENV=production。
    if ! (cd web && "$NPM_BIN" "$FRONTEND_INSTALL_COMMAND" --include=dev --include=optional --no-audit --no-fund); then
      log_error "前端依赖安装失败，停止启动"
      exit 1
    fi
    if ! "$NODE_BIN" "$ROOT_DIR/tools/check_frontend_dependencies.mjs" web "$NPM_BIN" --record; then
      log_error "安装后前端依赖仍未满足锁文件或依赖声明，停止启动"
      exit 1
    fi
    log_info "前端依赖安装完成"
  fi
else
  log_error "未找到 web/package.json，前端将无法启动"
fi

# ===========================================================
# Step 5.5 - 前端生产构建（仅生产模式）
# 构建产物输出到 app/static/dist（vite.config.ts 已配置），
# 由 FastAPI 托管，避免对外暴露未压缩的开发模块。
#
# 判定逻辑（产物优先 + 更新感知）：
#   SLIDEFLOW_FORCE_BUILD=1 → 强制重建；
#   dist/index.html 缺失 → 构建；
#   dist/.build_version 与当前前端源码内容指纹不一致 → 重建；
#   其余情况 → 复用现有产物，普通重启不再重复构建。
#   产物过期/缺失时自动重建；构建失败且已有产物时继续使用现有产物。
# ===========================================================
if [ "$DEV_MODE" = "false" ] && [ -f "web/package.json" ]; then
  DIST_INDEX="app/static/dist/index.html"
  BUILD_VERSION_FILE="app/static/dist/.build_version"

  # 对前端源码路径和文件内容计算稳定指纹。不能只使用 git HEAD：开发环境中
  # 未提交的修改不会改变 commit hash，会导致重启后继续复用旧的 dist。
  # 排除依赖、缓存和 TypeScript 增量构建文件，避免构建本身改变指纹。
  CURRENT_VERSION="$("$PYTHON_CMD" - <<'PY' 2>/dev/null || true
import hashlib
import os

digest = hashlib.sha256()
excluded_dirs = {'node_modules', 'dist', '.vite', '.vite-temp'}

for root, dirs, files in os.walk('web'):
    dirs[:] = sorted(name for name in dirs if name not in excluded_dirs)
    for name in sorted(files):
        if name == '.DS_Store' or name.endswith('.tsbuildinfo'):
            continue
        path = os.path.join(root, name)
        relative = os.path.relpath(path, 'web').replace(os.sep, '/')
        digest.update(relative.encode('utf-8'))
        digest.update(b'\0')
        with open(path, 'rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                digest.update(chunk)
        digest.update(b'\0')

print(digest.hexdigest())
PY
)"

  NEED_BUILD="false"
  BUILD_REASON=""
  if [ "${SLIDEFLOW_FORCE_BUILD:-0}" = "1" ]; then
    log_info "SLIDEFLOW_FORCE_BUILD=1，强制重新构建前端产物"
    NEED_BUILD="true"
  elif [ ! -f "$DIST_INDEX" ]; then
    log_info "未检测到前端产物 (app/static/dist)，将自动构建"
    BUILD_REASON="产物缺失"
    NEED_BUILD="true"
  else
    OLD_VERSION="$(cat "$BUILD_VERSION_FILE" 2>/dev/null | tr -d '[:space:]' || true)"
    if [ -z "$CURRENT_VERSION" ]; then
      log_warn "无法获取当前版本信息，复用现有前端产物 (app/static/dist)"
    elif [ -z "$OLD_VERSION" ]; then
      log_info "产物缺少版本标记 (.build_version)，将重新构建"
      BUILD_REASON="产物缺少版本标记 (.build_version)"
      NEED_BUILD="true"
    elif [ "$OLD_VERSION" != "$CURRENT_VERSION" ]; then
      log_info "检测到代码已更新 (${OLD_VERSION:0:8} → ${CURRENT_VERSION:0:8})，将重新构建前端产物"
      BUILD_REASON="产物已过期"
      NEED_BUILD="true"
    else
      log_info "前端产物与当前版本一致 (${CURRENT_VERSION:0:8})，跳过构建直接复用"
    fi
  fi

  if [ "$NEED_BUILD" = "true" ]; then
    log_info "正在构建前端生产产物 (npm run build)..."
    if (cd web && "$NPM_BIN" run build); then
      log_info "前端构建完成，产物目录: app/static/dist"
      # 构建成功后写入版本标记，供下次启动比对
      if [ -n "$CURRENT_VERSION" ]; then
        if ! echo "$CURRENT_VERSION" > "$BUILD_VERSION_FILE" 2>/dev/null; then
          log_warn "写入版本标记失败 (.build_version)，下次启动可能触发重复构建"
        fi
      fi
    else
      # 构建失败时降级：若已有历史构建产物则继续启动后端，
      # 避免配合 systemd Restart=always 形成重启死循环导致整站不可用
      if [ -f "$DIST_INDEX" ]; then
        log_warn "构建失败，降级使用现有前端产物 (app/static/dist)"
      else
        log_error "前端构建失败且无现有产物可降级！请检查上方错误输出"
        log_error "  常见原因：TypeScript 类型错误、依赖版本冲突"
        exit 1
      fi
    fi
    if [ ! -f "$DIST_INDEX" ]; then
      log_error "构建完成但未找到 app/static/dist/index.html，请检查 vite 构建配置"
      exit 1
    fi
  fi
fi

# ===========================================================
# Step 6 - 创建日志目录
# ===========================================================
mkdir -p "$LOG_DIR" || {
  log_error "无法创建日志目录: $LOG_DIR"
  exit 1
}
if [ ! -w "$LOG_DIR" ]; then
  log_error "日志目录不可写: $LOG_DIR"
  exit 1
fi
BACKEND_LOG="$LOG_DIR/server.log"
FRONTEND_LOG="$LOG_DIR/web.log"

# ===========================================================
# Step 6.5 - 版本信息初始化（首次启动时写入）
# ===========================================================
VERSION_FILE="$ROOT_DIR/data/.version_info"
if [ ! -f "$VERSION_FILE" ]; then
  COMMIT_HASH="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  STARTUP_TIME="$(date '+%Y-%m-%d %H:%M:%S')"
  cat > "$VERSION_FILE" <<EOF
{"commit": "$COMMIT_HASH", "updated_at": "$STARTUP_TIME"}
EOF
  log_info "首次启动，已写入版本信息: $COMMIT_HASH ($STARTUP_TIME)"
fi

# ===========================================================
# Step 7 - 启动服务
# ===========================================================
BACKEND_PID=""
FRONTEND_PID=""

# 清理函数：捕获退出信号时停止子进程
# 注意：kill 之后必须紧跟 wait "$PID" 2>/dev/null，bash 会静默回收该后台
#       作业的退出状态，从而不再打印 "Terminated: 15" 这样的提示信息。
cleanup() {
  trap - INT TERM EXIT
  echo ""
  log_warn "正在停止服务..."
  if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
    # 静默等待前端子进程退出，吞掉 bash 的 "Terminated: 15" 输出
    wait "$FRONTEND_PID" 2>/dev/null || true
  fi
  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    # 静默等待后端子进程退出
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  # 兜底：回收任何尚未收割的后台作业
  wait 2>/dev/null || true
  log_info "服务已停止"
}
trap cleanup INT TERM EXIT

# 启动后端。Gunicorn 安装或启动失败时自动回退到 Uvicorn。
start_uvicorn_backend() {
  local log_mode="${1:-truncate}"
  if [ "$log_mode" = "append" ]; then
    "$PYTHON_BIN" -m uvicorn app.main:app --host 0.0.0.0 --port "$PORT" --workers "$WORKERS" --no-access-log \
      >>"$BACKEND_LOG" 2>&1 &
  else
    "$PYTHON_BIN" -m uvicorn app.main:app --host 0.0.0.0 --port "$PORT" --workers "$WORKERS" --no-access-log \
      >"$BACKEND_LOG" 2>&1 &
  fi
  BACKEND_PID=$!
  ACTIVE_BACKEND_SERVER="uvicorn"
}

start_gunicorn_backend() {
  "$PYTHON_BIN" -m gunicorn app.main:app \
    --bind "0.0.0.0:$PORT" \
    --workers "$WORKERS" \
    --worker-class uvicorn_worker.UvicornWorker \
    --timeout 0 \
    --graceful-timeout 30 \
    --error-logfile - \
    --capture-output \
    >"$BACKEND_LOG" 2>&1 &
  BACKEND_PID=$!
  ACTIVE_BACKEND_SERVER="gunicorn"
}

backend_is_ready() {
  "$PYTHON_BIN" -c '
import sys
import urllib.request

try:
    with urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/api/config", timeout=1) as response:
        raise SystemExit(0 if response.status == 200 else 1)
except Exception:
    raise SystemExit(1)
' "$PORT" >/dev/null 2>&1
}

wait_for_backend() {
  local attempt
  for attempt in $(seq 1 12); do
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
      return 1
    fi
    if backend_is_ready; then
      return 0
    fi
    sleep 1
  done
  return 1
}

log_info "正在启动后端服务..."
ACTIVE_BACKEND_SERVER=""
if [ "$REUSE_BACKEND" = "true" ]; then
  ACTIVE_BACKEND_SERVER="existing"
  log_info "复用已运行的后端服务 (端口: $PORT)"
elif [ "$BACKEND_SERVER" = "gunicorn" ]; then
  log_info "生产服务器: Gunicorn + Uvicorn Worker (workers: $WORKERS)"
  start_gunicorn_backend
else
  if [ "$DEV_MODE" = "true" ]; then
    log_info "开发服务器: Uvicorn (workers: $WORKERS)"
  else
    log_warn "生产服务器: Uvicorn 兜底模式 (workers: $WORKERS)"
  fi
  start_uvicorn_backend
fi

# 等待真实 HTTP 健康检查通过。Gunicorn 未就绪时终止残留进程并回退。
if [ "$REUSE_BACKEND" != "true" ] && ! wait_for_backend; then
  if [ "$ACTIVE_BACKEND_SERVER" = "gunicorn" ]; then
    log_warn "Gunicorn 启动或健康检查失败，正在回退到 Uvicorn..."
    tail -n 20 "$BACKEND_LOG" | sed 's/^/  /' || true
    if kill -0 "$BACKEND_PID" 2>/dev/null; then
      kill "$BACKEND_PID" 2>/dev/null || true
      wait "$BACKEND_PID" 2>/dev/null || true
    fi
    echo "" >>"$BACKEND_LOG"
    echo "[SlideFlow] Gunicorn failed; falling back to Uvicorn" >>"$BACKEND_LOG"
    start_uvicorn_backend append
  fi
fi
if [ "$REUSE_BACKEND" != "true" ] && ! wait_for_backend; then
  log_error "后端启动失败！请查看错误日志："
  log_error "  $BACKEND_LOG"
  echo ""
  log_error "最后 20 行错误信息："
  tail -n 20 "$BACKEND_LOG" | sed 's/^/  /'
  echo ""
  log_error "常见原因："
  log_error "  1. Python 版本过低（需要 3.10+）"
  log_error "  2. 端口 $PORT 被占用"
  log_error "  3. 依赖安装不完整"
  exit 1
fi
log_info "后端服务启动成功 ($ACTIVE_BACKEND_SERVER, PID: $BACKEND_PID)"
if [ -f ".secrets/initial-admin-setup.json" ]; then
  log_warn "系统管理员尚未完成安全初始化"
  log_warn "请在服务器本机访问 http://127.0.0.1:${PORT}/setup，直接设置管理员账号和密码"
fi

# 启动前端
if [ "$DEV_MODE" = "true" ]; then
  # 开发模式：启动 Vite 开发服务器（支持热更新），仅用于本地开发调试
  if [ -d "web" ] && [ -f "web/package.json" ]; then
    log_info "正在启动前端开发服务器 (npm run dev)..."
    # 通过环境变量打通 properties → run.sh → vite.config.ts 配置链路：
    #   SLIDE_FLOW_WEB_PORT  → dev server 监听端口
    #   SLIDE_FLOW_BACKEND   → 代理目标后端地址
    #   SLIDE_FLOW_HTTPS     → HTTPS 开关（上方已解析 web.https）
    export SLIDE_FLOW_WEB_PORT="$WEB_PORT"
    export SLIDE_FLOW_BACKEND="http://127.0.0.1:$PORT"
    export SLIDE_FLOW_HTTPS="$WEB_HTTPS"
    log_info "前端配置: 端口 $SLIDE_FLOW_WEB_PORT | 后端 $SLIDE_FLOW_BACKEND | HTTPS $SLIDE_FLOW_HTTPS"
    # 端口/监听地址均由 vite.config.ts 读取上述环境变量，不再用 CLI 参数覆盖
    (cd web && "$NPM_BIN" run dev) \
      >"$FRONTEND_LOG" 2>&1 &
    FRONTEND_PID=$!

    # 等待前端启动并检查是否成功
    sleep 3
    if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
      log_error "前端启动失败！请查看错误日志："
      log_error "  $FRONTEND_LOG"
      echo ""
      log_error "最后 20 行错误信息："
      tail -n 20 "$FRONTEND_LOG" | sed 's/^/  /'
      echo ""
      log_error "常见原因："
      log_error "  1. 端口 $WEB_PORT 被占用"
      log_error "  2. 前端依赖未安装（运行: cd web && npm install）"
      # 停止后端
      kill "$BACKEND_PID" 2>/dev/null || true
      exit 1
    fi
    log_info "前端开发服务器启动成功 (PID: $FRONTEND_PID)"
  fi
else
  # 生产模式：前端静态产物已构建至 app/static/dist，
  # 全部前端流量（含 SPA fallback）由上方 FastAPI 后端直接托管，
  # 不再启动独立的前端进程，无需监听 $WEB_PORT。
  log_info "生产模式：前端由 FastAPI 托管 app/static/dist，无需启动独立前端进程"
fi

# ===========================================================
# Step 8 - 状态显示
# ===========================================================
echo ""
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  SlideFlow 服务已启动${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo ""
log_info "后端地址: http://127.0.0.1:$PORT"
if [ -n "$FRONTEND_PID" ]; then
  # 开发模式：前端由 Vite 开发服务器独立提供服务
  if [ "$WEB_HTTPS" = "true" ]; then
    log_info "前端地址: https://127.0.0.1:$WEB_PORT  (HTTPS 已启用)"
  else
    log_info "前端地址: http://127.0.0.1:$WEB_PORT"
  fi
else
  # 生产模式：前端构建产物由 FastAPI 统一托管，直接访问后端端口
  if [ "$WEB_HTTPS" = "true" ]; then
    # 应用服务器未配置 SSL，本服务实际仅提供 HTTP，
    # HTTPS 需由反向代理终结，此处不能再打印误导性的 https:// 地址
    log_warn "HTTPS 需由 Nginx 等反向代理终结，本服务仅提供 HTTP"
  fi
  log_info "前端地址: http://127.0.0.1:$PORT  (静态产物由 FastAPI 托管)"
fi
echo ""
log_info "后端日志: $BACKEND_LOG"
if [ -n "$FRONTEND_PID" ]; then
  log_info "前端日志: $FRONTEND_LOG"
fi
echo ""
log_info "按 Ctrl+C 停止所有服务"
echo ""

# ===========================================================
# Step 9 - 进程监控
# ===========================================================
while :; do
  if [ -n "$BACKEND_PID" ] && ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    log_error "后端进程已退出，请检查日志: $BACKEND_LOG"
    break
  fi
  if [ -n "$FRONTEND_PID" ] && ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    log_error "前端进程已退出，请检查日志: $FRONTEND_LOG"
    break
  fi
  sleep 2
done
