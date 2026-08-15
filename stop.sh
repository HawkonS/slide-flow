#!/usr/bin/env bash
# ============================================================
# SlideFlow 服务停止脚本
# 通过端口号查找并优雅地停止后端（uvicorn）和前端（vite）进程
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

# 依赖检查：本脚本需要 lsof 查找端口占用进程
if ! command -v lsof &>/dev/null; then
    echo "错误: 未找到 lsof 命令"
    echo "请安装: apt install lsof (Linux) 或 brew install lsof (macOS)"
    exit 1
fi

PROPS="slide_flow.properties"

# 读取后端端口：与 start.sh 保持一致，解析 server.port
PORT="$(awk -F= '/^server\.port=/{gsub(/[[:space:]]/, "", $2); print $2}' "$PROPS" 2>/dev/null || true)"
PORT="${PORT:-8088}"

# 前端端口：优先从 properties 读取，默认 5173
# 注意：生产模式下前端由 FastAPI 托管静态产物，不会监听该端口，
#       此时 stop_by_port 会提示"未发现运行中的进程"，属正常现象。
WEB_PORT="$(awk -F= '/^server\.web_port=/{gsub(/[[:space:]]/, "", $2); print $2}' "$PROPS" 2>/dev/null || true)"
WEB_PORT="${WEB_PORT:-5173}"

# ------------------------------------------------------------------
# 根据端口号停止相关进程
#   $1 - 端口号
#   $2 - 服务名称（用于日志显示）
# ------------------------------------------------------------------
stop_by_port() {
    local port=$1
    local name=$2
    local pids

    # 通过 lsof 查找占用该端口的所有进程
    pids=$(lsof -ti "tcp:$port" 2>/dev/null || true)

    if [ -z "$pids" ]; then
        echo "[$name] 未发现运行中的进程 (端口 $port)"
        return
    fi

    # 去重并展示即将停止的 PID 列表
    pids=$(echo "$pids" | sort -u)
    echo "[$name] 正在停止进程 (端口 $port, PID: $(echo $pids | tr '\n' ' '))..."

    # 第一步：发送 SIGTERM 请求优雅退出
    echo "$pids" | xargs kill 2>/dev/null || true

    # 第二步：最多等待 5 秒让进程自行退出
    for i in $(seq 1 5); do
        if ! lsof -ti "tcp:$port" &>/dev/null; then
            echo "[$name] 已停止"
            return
        fi
        sleep 1
    done

    # 第三步：超时后发送 SIGKILL 强制终止
    echo "[$name] 进程未在 5 秒内退出，正在强制终止..."
    lsof -ti "tcp:$port" 2>/dev/null | xargs kill -9 2>/dev/null || true
    # 给内核足够时间回收进程与端口，避免竞态误报
    sleep 2

    if ! lsof -ti "tcp:$port" &>/dev/null; then
        echo "[$name] 已强制终止"
    else
        echo "[$name] 警告：端口 $port 仍被占用，请手动排查"
        lsof -i "tcp:$port" 2>/dev/null || true
    fi
}

echo "=== SlideFlow 服务停止 ==="
stop_by_port "$PORT" "后端"
stop_by_port "$WEB_PORT" "前端"
echo "=== 完成 ==="
