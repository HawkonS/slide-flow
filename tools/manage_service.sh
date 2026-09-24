#!/bin/bash
# ============================================================
# SlideFlow systemd 服务管理脚本
# 一键注册 / 启动 / 停止 / 重启 / 开机自启 / 日志查看
# 仅适用于使用 systemd 的 Linux 系统
# ============================================================

SERVICE_NAME="slide-flow"
SERVICE_FILE=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RUN_SCRIPT="${PROJECT_ROOT}/run.sh"
STOP_SCRIPT="${PROJECT_ROOT}/stop.sh"
CURRENT_USER="${SUDO_USER:-$USER}"

CONFIG_FILE="${PROJECT_ROOT}/slide_flow.properties"
SUDO_PASS=""

# 安全的 sudo 执行函数：通过管道传递密码，避免 ps 泄露与 shell 展开
# - 以 root 身份运行时直接执行命令
# - 配置了 SUDO_PASS 时通过 stdin 管道传递（避免命令行明文）
# - 否则交互式 sudo
run_sudo() {
    if [ "$EUID" -eq 0 ]; then
        "$@"
    elif [ -n "$SUDO_PASS" ]; then
        echo "$SUDO_PASS" | sudo -S "$@" 2>/dev/null
    else
        sudo "$@"
    fi
}

# 将 stdin 内容以 sudo 权限写入目标文件
# 避免 echo 内容与 sudo 密码共享 stdin 引发冲突
run_sudo_write() {
    local target="$1"
    if [ "$EUID" -eq 0 ]; then
        tee "$target" >/dev/null
    elif [ -n "$SUDO_PASS" ]; then
        local tmp
        tmp=$(mktemp)
        cat > "$tmp"
        echo "$SUDO_PASS" | sudo -S cp "$tmp" "$target" 2>/dev/null
        local rc=$?
        rm -f "$tmp"
        return $rc
    else
        sudo tee "$target" >/dev/null
    fi
}

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

check_systemd() {
    if ! command -v systemctl &> /dev/null; then
        echo -e "${RED}错误: 未找到 systemctl 命令。${NC}"
        echo "此脚本专为使用 systemd 的 Linux 系统设计。"
        return 1
    fi
    return 0
}

check_run_script() {
    if [ ! -f "$RUN_SCRIPT" ]; then
        echo -e "${RED}错误: 未找到启动脚本 $RUN_SCRIPT${NC}"
        return 1
    fi
    return 0
}

check_config() {
    local python_cmd=""
    if [ -x "${PROJECT_ROOT}/.venv/bin/python" ]; then
        python_cmd="${PROJECT_ROOT}/.venv/bin/python"
    elif command -v python3 >/dev/null 2>&1; then
        python_cmd="$(command -v python3)"
    else
        echo -e "${RED}错误: 未检测到 Python，无法生成配置文件。${NC}"
        return 1
    fi

    if [ ! -f "$CONFIG_FILE" ]; then
        echo -e "${YELLOW}未找到 $CONFIG_FILE，正在生成默认配置...${NC}"
    fi
    if ! (cd "$PROJECT_ROOT" && "$python_cmd" -c 'from app.config import ensure_properties_file; ensure_properties_file()'); then
        echo -e "${RED}错误: 生成或检查配置文件失败。${NC}"
        return 1
    fi
}

load_operation_config() {
    if [ -f "$CONFIG_FILE" ]; then
        SUDO_PASS=$(grep "^system.sudo_password=" "$CONFIG_FILE" | cut -d'=' -f2- | tr -d '\r')
        local configured_service
        configured_service=$(grep "^system.service_name=" "$CONFIG_FILE" | cut -d'=' -f2- | tr -d '\r')
        if [ -n "$configured_service" ]; then
            if ! [[ "$configured_service" =~ ^[A-Za-z0-9_.@][A-Za-z0-9_.@:-]*$ ]]; then
                echo -e "${RED}错误: system.service_name 不是合法的 systemd 服务名。${NC}"
                return 1
            fi
            SERVICE_NAME="$configured_service"
        fi
        case "$SERVICE_NAME" in
            *.service) ;;
            *) SERVICE_NAME="${SERVICE_NAME}.service" ;;
        esac
        local configured_startup
        configured_startup=$(grep "^startup.script=" "$CONFIG_FILE" | cut -d'=' -f2- | tr -d '\r')
        configured_startup="${configured_startup:-run.sh}"
        case "$configured_startup" in
            /*) RUN_SCRIPT="$configured_startup" ;;
            *) RUN_SCRIPT="${PROJECT_ROOT}/${configured_startup}" ;;
        esac
    fi
    SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}"
}

systemd_quote() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//%/%%}"
    printf '"%s"' "$value"
}

is_installed() {
    local load_state
    load_state="$(systemctl show --property=LoadState --value "$SERVICE_NAME" 2>/dev/null || true)"
    [ -n "$load_state" ] && [ "$load_state" != "not-found" ]
}

is_locally_managed() {
    [ -f "$SERVICE_FILE" ]
}

install_service() {
    echo -e "${BLUE}正在配置 systemd 服务...${NC}"

    if [ "$EUID" -ne 0 ]; then
        echo -e "${YELLOW}安装服务需要管理员权限。${NC}"

        # 优先使用配置中的 sudo 密码
        if [ -n "$SUDO_PASS" ]; then
            echo "$SUDO_PASS" | sudo -S -v >/dev/null 2>&1
            if [ $? -ne 0 ]; then
                echo -e "${RED}配置的 sudo 密码验证失败。${NC}"
                if ! sudo -v; then
                    echo -e "${RED}认证失败，操作已中止。${NC}"
                    exit 1
                fi
            fi
        else
            if ! sudo -v; then
                echo -e "${RED}认证失败，操作已中止。${NC}"
                exit 1
            fi
        fi
    fi

    local quoted_root quoted_run quoted_stop
    quoted_root="$(systemd_quote "$PROJECT_ROOT")"
    quoted_run="$(systemd_quote "$RUN_SCRIPT")"
    quoted_stop="$(systemd_quote "$STOP_SCRIPT")"
    SERVICE_CONTENT="[Unit]
Description=SlideFlow Service (Backend + Frontend)
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$quoted_root
ExecStart=/bin/bash $quoted_run
ExecStop=/bin/bash $quoted_stop
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=15
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target"

    echo "$SERVICE_CONTENT" | run_sudo_write "$SERVICE_FILE"

    # 修复脚本权限和换行符
    for s in "$RUN_SCRIPT" "$STOP_SCRIPT"; do
        if [ -f "$s" ]; then
            run_sudo chmod +x "$s"
            run_sudo sed -i 's/\r$//' "$s" 2>/dev/null || true
        fi
    done

    run_sudo systemctl daemon-reload
    run_sudo systemctl enable "$SERVICE_NAME"
    run_sudo systemctl start "$SERVICE_NAME"

    sleep 2
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        echo -e "${GREEN}服务已成功安装并启动！${NC}"
    else
        echo -e "${RED}服务安装成功，但启动失败。${NC}"
        echo -e "${YELLOW}以下是最近的错误日志：${NC}"
        journalctl -u "$SERVICE_NAME" -n 20 --no-pager
    fi
}

uninstall_service() {
    echo -e "${BLUE}正在卸载 systemd 服务...${NC}"

    if ! is_locally_managed; then
        echo -e "${RED}拒绝卸载：${SERVICE_NAME} 不是由本脚本安装在 ${SERVICE_FILE} 的服务。${NC}"
        return 1
    fi

    if [ "$EUID" -ne 0 ]; then
        if [ -n "$SUDO_PASS" ]; then
            echo "$SUDO_PASS" | sudo -S -v >/dev/null 2>&1 || sudo -v || { echo -e "${RED}认证失败${NC}"; return 1; }
        else
            sudo -v || { echo -e "${RED}认证失败${NC}"; return 1; }
        fi
    fi

    run_sudo systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    run_sudo systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    run_sudo rm -f "$SERVICE_FILE"
    run_sudo systemctl daemon-reload
    echo -e "${GREEN}服务已卸载。${NC}"
}

get_status_text() {
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        echo "running"
    else
        echo "stopped"
    fi
}

get_enable_status() {
    if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
        echo "enabled"
    else
        echo "disabled"
    fi
}

show_status() {
    echo -e "${BLUE}=== 服务状态 ===${NC}"
    systemctl status "$SERVICE_NAME" --no-pager
    echo -e "${BLUE}================${NC}"
}

# ============ 主流程 ============

check_systemd || exit 1
check_config || exit 1
load_operation_config || exit 1
check_run_script || exit 1

# 支持命令行参数模式（供 API 调用）
if [ -n "${1:-}" ]; then
    case "$1" in
        start)
            if is_installed; then
                if systemctl is-active --quiet "$SERVICE_NAME"; then
                    echo "服务已经在运行中"
                    exit 0
                fi
                run_sudo systemctl start "$SERVICE_NAME"
                sleep 2
                if systemctl is-active --quiet "$SERVICE_NAME"; then
                    echo "服务已成功启动"
                    exit 0
                else
                    echo "启动失败" >&2
                    journalctl -u "$SERVICE_NAME" -n 10 --no-pager >&2
                    exit 1
                fi
            else
                echo "服务未安装，正在自动安装..."
                install_service
                exit $?
            fi
            ;;
        stop)
            if is_installed; then
                if ! systemctl is-active --quiet "$SERVICE_NAME"; then
                    echo "服务已经是停止状态"
                    exit 0
                fi
                run_sudo systemctl stop "$SERVICE_NAME"
                echo "服务已停止"
                exit 0
            else
                echo "服务未安装，尝试直接停止进程..."
                if [ -f "$STOP_SCRIPT" ]; then
                    bash "$STOP_SCRIPT"
                    exit $?
                else
                    echo "停止脚本不存在" >&2
                    exit 1
                fi
            fi
            ;;
        restart)
            if is_installed; then
                run_sudo systemctl restart "$SERVICE_NAME"
                echo "服务已重启"
                exit 0
            else
                echo "服务未安装，使用直接运行脚本重启..."
                if [ -f "${PROJECT_ROOT}/tools/restart.sh" ]; then
                    SLIDEFLOW_OPERATION_START_DELAY=0 bash "${PROJECT_ROOT}/tools/restart.sh"
                    exit $?
                else
                    echo "重启脚本不存在" >&2
                    exit 1
                fi
            fi
            ;;
        status)
            if is_installed; then
                systemctl status "$SERVICE_NAME" --no-pager 2>/dev/null || run_sudo systemctl status "$SERVICE_NAME" --no-pager
            else
                echo "服务未安装"
                exit 1
            fi
            ;;
        install)
            install_service
            exit $?
            ;;
        uninstall)
            if is_locally_managed; then
                uninstall_service
                exit $?
            else
                echo "服务不是由本脚本安装，拒绝卸载"
                exit 1
            fi
            ;;
        *)
            echo "未知命令: $1" >&2
            echo "用法: $0 {start|stop|restart|status|install|uninstall}" >&2
            exit 1
            ;;
    esac
fi

# 交互式模式

if ! is_installed; then
    echo -e "${YELLOW}服务 '$SERVICE_NAME' 尚未在 systemd 中配置。${NC}"
    read -e -p "是否立即自动配置？(yes/no): " choice
    case "$choice" in
        y|Y|yes|YES)
            install_service
            ;;
        *)
            echo "退出。"
            exit 0
            ;;
    esac
fi

while true; do
    CURRENT_STATUS=$(get_status_text)
    ENABLE_STATUS=$(get_enable_status)

    if [ "$CURRENT_STATUS" == "running" ]; then
        STATUS_DISPLAY="${GREEN}运行中${NC}"
    else
        STATUS_DISPLAY="${RED}已停止${NC}"
    fi

    if [ "$ENABLE_STATUS" == "enabled" ]; then
        ENABLE_DISPLAY="${GREEN}已开启${NC}"
    else
        ENABLE_DISPLAY="${RED}已关闭${NC}"
    fi

    echo
    echo -e "服务: ${BLUE}$SERVICE_NAME${NC}  |  当前状态: $STATUS_DISPLAY  |  开机自启: $ENABLE_DISPLAY"
    echo "请选择操作 (输入数字):"

    options=(
        "启动 (Start)"
        "停止 (Stop)"
        "重启 (Restart)"
        "开机自启 (Enable)"
        "取消自启 (Disable)"
        "状态 (Status)"
        "日志 (Logs)"
        "卸载服务 (Uninstall)"
        "退出 (Exit)"
    )

    for i in "${!options[@]}"; do
        printf "%d) %s\n" "$((i+1))" "${options[$i]}"
    done

    read -e -p "> " choice

    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#options[@]}" ]; then
        opt="${options[$((choice-1))]}"
    else
        opt=""
    fi

    case $opt in
        "启动 (Start)")
            if [ "$CURRENT_STATUS" == "running" ]; then
                echo -e "${YELLOW}服务已经在运行中。${NC}"
            else
                if [ -f "$RUN_SCRIPT" ] && [ ! -x "$RUN_SCRIPT" ]; then
                    echo -e "${YELLOW}正在修复脚本权限...${NC}"
                    run_sudo chmod +x "$RUN_SCRIPT"
                    run_sudo sed -i 's/\r$//' "$RUN_SCRIPT" 2>/dev/null || true
                fi
                run_sudo systemctl start "$SERVICE_NAME"
                echo -e "${BLUE}正在启动...${NC}"
                sleep 2
                if systemctl is-active --quiet "$SERVICE_NAME"; then
                    echo -e "${GREEN}服务已成功启动。${NC}"
                else
                    echo -e "${RED}启动失败。${NC}"
                    echo -e "${YELLOW}查看最后 20 行日志：${NC}"
                    journalctl -u "$SERVICE_NAME" -n 20 --no-pager
                fi
            fi
            break
            ;;
        "停止 (Stop)")
            if [ "$CURRENT_STATUS" == "stopped" ]; then
                echo -e "${YELLOW}服务已经是停止状态。${NC}"
            else
                run_sudo systemctl stop "$SERVICE_NAME"
                echo -e "${RED}服务已停止。${NC}"
            fi
            break
            ;;
        "重启 (Restart)")
            run_sudo systemctl restart "$SERVICE_NAME"
            echo -e "${GREEN}服务已重启。${NC}"
            break
            ;;
        "开机自启 (Enable)")
            if [ "$ENABLE_STATUS" == "enabled" ]; then
                echo -e "${YELLOW}开机自启已经是开启状态。${NC}"
            else
                run_sudo systemctl enable "$SERVICE_NAME"
                echo -e "${GREEN}开机自启已开启。${NC}"
            fi
            break
            ;;
        "取消自启 (Disable)")
            if [ "$ENABLE_STATUS" == "disabled" ]; then
                echo -e "${YELLOW}开机自启已经是关闭状态。${NC}"
            else
                run_sudo systemctl disable "$SERVICE_NAME"
                echo -e "${RED}开机自启已关闭。${NC}"
            fi
            break
            ;;
        "状态 (Status)")
            show_status
            break
            ;;
        "日志 (Logs)")
            echo -e "${BLUE}正在显示日志 (按 Ctrl+C 退出)...${NC}"
            journalctl -u "$SERVICE_NAME" -f
            break
            ;;
        "卸载服务 (Uninstall)")
            if ! is_locally_managed; then
                echo -e "${RED}该服务不属于本脚本管理，拒绝卸载。${NC}"
            else
                read -e -p "确认卸载服务 '$SERVICE_NAME'？(yes/no): " confirm
                case "$confirm" in
                    y|Y|yes|YES) uninstall_service ;;
                    *) echo "已取消。" ;;
                esac
            fi
            break
            ;;
        "退出 (Exit)")
            echo "再见。"
            exit 0
            ;;
        *)
            echo -e "${YELLOW}无效选项${NC}"
            ;;
    esac
done
