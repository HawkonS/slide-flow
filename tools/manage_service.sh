#!/bin/bash
# ============================================================
# SlideFlow systemd 服务管理脚本
# 一键注册 / 启动 / 停止 / 重启 / 开机自启 / 日志查看
# 仅适用于使用 systemd 的 Linux 系统
# ============================================================

SERVICE_NAME="slide-flow"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RUN_SCRIPT="${PROJECT_ROOT}/start.sh"
STOP_SCRIPT="${PROJECT_ROOT}/stop.sh"
CURRENT_USER="${SUDO_USER:-$USER}"

CONFIG_FILE="${PROJECT_ROOT}/slide_flow.properties"
CONFIG_TEMPLATE="${PROJECT_ROOT}/slide_flow.properties.example"
SUDO_PASS=""

# 读取 sudo 密码（如果在 properties 中配置了 system.sudo_password）
if [ -f "$CONFIG_FILE" ]; then
    SUDO_PASS=$(grep "^system.sudo_password=" "$CONFIG_FILE" | cut -d'=' -f2 | tr -d '\r')
fi

SUDO_CMD="sudo"
if [ -n "$SUDO_PASS" ]; then
    SUDO_CMD="echo \"$SUDO_PASS\" | sudo -S"
fi

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
    # SlideFlow 没有强制必填的运行时配置，缺失时从模板复制即可
    if [ ! -f "$CONFIG_FILE" ]; then
        if [ -f "$CONFIG_TEMPLATE" ]; then
            echo -e "${YELLOW}未找到 $CONFIG_FILE，正在从模板复制...${NC}"
            cp "$CONFIG_TEMPLATE" "$CONFIG_FILE"
            echo -e "${GREEN}配置文件已生成，可按需编辑：${NC}${BLUE}$CONFIG_FILE${NC}"
        else
            echo -e "${YELLOW}未找到配置文件和模板，将使用默认值运行。${NC}"
        fi
    fi
}

is_installed() {
    if [ -f "$SERVICE_FILE" ]; then
        return 0
    else
        return 1
    fi
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
        SUDO="$SUDO_CMD"
    else
        SUDO=""
    fi

    SERVICE_CONTENT="[Unit]
Description=SlideFlow Service (Backend + Frontend)
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$PROJECT_ROOT
ExecStart=/bin/bash $RUN_SCRIPT
ExecStop=/bin/bash $STOP_SCRIPT
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=15
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target"

    echo "$SERVICE_CONTENT" | eval "$SUDO tee \"$SERVICE_FILE\"" > /dev/null

    # 修复脚本权限和换行符
    for s in "$RUN_SCRIPT" "$STOP_SCRIPT"; do
        if [ -f "$s" ]; then
            eval "$SUDO chmod +x \"$s\""
            eval "$SUDO sed -i 's/\r\$//' \"$s\"" 2>/dev/null || true
        fi
    done

    eval "$SUDO systemctl daemon-reload"
    eval "$SUDO systemctl enable \"$SERVICE_NAME\""
    eval "$SUDO systemctl start \"$SERVICE_NAME\""

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

    if [ "$EUID" -ne 0 ]; then
        if [ -n "$SUDO_PASS" ]; then
            echo "$SUDO_PASS" | sudo -S -v >/dev/null 2>&1 || sudo -v || { echo -e "${RED}认证失败${NC}"; return 1; }
        else
            sudo -v || { echo -e "${RED}认证失败${NC}"; return 1; }
        fi
        SUDO="$SUDO_CMD"
    else
        SUDO=""
    fi

    eval "$SUDO systemctl stop \"$SERVICE_NAME\"" 2>/dev/null || true
    eval "$SUDO systemctl disable \"$SERVICE_NAME\"" 2>/dev/null || true
    eval "$SUDO rm -f \"$SERVICE_FILE\""
    eval "$SUDO systemctl daemon-reload"
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
check_run_script || exit 1
check_config

# 支持命令行参数模式（供 API 调用）
if [ -n "${1:-}" ]; then
    case "$1" in
        start)
            if is_installed; then
                if systemctl is-active --quiet "$SERVICE_NAME"; then
                    echo "服务已经在运行中"
                    exit 0
                fi
                systemctl start "$SERVICE_NAME"
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
                systemctl stop "$SERVICE_NAME"
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
                systemctl restart "$SERVICE_NAME"
                echo "服务已重启"
                exit 0
            else
                echo "服务未安装，使用 stop.sh + start.sh 重启..."
                if [ -f "$STOP_SCRIPT" ] && [ -f "$RUN_SCRIPT" ]; then
                    bash "$STOP_SCRIPT"
                    sleep 2
                    bash "$RUN_SCRIPT" &
                    echo "服务已重启"
                    exit 0
                else
                    echo "启动或停止脚本不存在" >&2
                    exit 1
                fi
            fi
            ;;
        status)
            if is_installed; then
                systemctl status "$SERVICE_NAME" --no-pager
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
            if is_installed; then
                uninstall_service
                exit $?
            else
                echo "服务未安装"
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
                    eval "$SUDO_CMD chmod +x \"$RUN_SCRIPT\""
                    eval "$SUDO_CMD sed -i 's/\r\$//' \"$RUN_SCRIPT\" 2>/dev/null || true"
                fi
                eval "$SUDO_CMD systemctl start \"$SERVICE_NAME\""
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
                eval "$SUDO_CMD systemctl stop \"$SERVICE_NAME\""
                echo -e "${RED}服务已停止。${NC}"
            fi
            break
            ;;
        "重启 (Restart)")
            eval "$SUDO_CMD systemctl restart \"$SERVICE_NAME\""
            echo -e "${GREEN}服务已重启。${NC}"
            break
            ;;
        "开机自启 (Enable)")
            if [ "$ENABLE_STATUS" == "enabled" ]; then
                echo -e "${YELLOW}开机自启已经是开启状态。${NC}"
            else
                eval "$SUDO_CMD systemctl enable \"$SERVICE_NAME\""
                echo -e "${GREEN}开机自启已开启。${NC}"
            fi
            break
            ;;
        "取消自启 (Disable)")
            if [ "$ENABLE_STATUS" == "disabled" ]; then
                echo -e "${YELLOW}开机自启已经是关闭状态。${NC}"
            else
                eval "$SUDO_CMD systemctl disable \"$SERVICE_NAME\""
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
            read -e -p "确认卸载服务 '$SERVICE_NAME'？(yes/no): " confirm
            case "$confirm" in
                y|Y|yes|YES) uninstall_service ;;
                *) echo "已取消。" ;;
            esac
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
