#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

if [ -x "${PROJECT_ROOT}/.venv/bin/python" ]; then
    PYTHON_CMD="${PROJECT_ROOT}/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
    PYTHON_CMD="$(command -v python3)"
else
    echo "错误：未检测到 Python 3。" >&2
    exit 1
fi

usage() {
    echo "用法: $0 [--yes] [系统管理员用户名]"
    echo "默认仅在系统中恰好有一个系统管理员时重置该账号。"
}

confirm="true"
username=""
for arg in "$@"; do
    case "$arg" in
        -h|--help)
            usage
            exit 0
            ;;
        -y|--yes)
            confirm="false"
            ;;
        *)
            if [ -n "$username" ]; then
                usage >&2
                exit 2
            fi
            username="$arg"
            ;;
    esac
done

if [ "$confirm" = "true" ]; then
    read -r -p "将重置 ${username:-唯一的系统管理员} 的密码并注销其现有会话，继续？[y/N] " answer || answer=""
    answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
    case "$answer" in
        y|yes) ;;
        *) echo "已取消，密码未更改。"; exit 0 ;;
    esac
fi

cd "$PROJECT_ROOT"
"$PYTHON_CMD" - "$username" <<'PY'
import os
import secrets
import sqlite3
import sys
from datetime import datetime, timedelta

from app.config import settings
from app.core.security import hash_password, password_policy_error
from app.core.user_profiles import username_lookup_key


requested_username = (sys.argv[1] or "").strip()
db_path = settings.db_path
if not db_path.exists():
    raise SystemExit(f"错误：数据库不存在：{db_path}")

# If invoked through sudo, drop back to the database owner before opening it,
# so SQLite sidecar files remain writable by the service account.
if os.geteuid() == 0:
    db_stat = db_path.stat()
    if db_stat.st_uid != 0:
        os.setgid(db_stat.st_gid)
        os.setuid(db_stat.st_uid)

try:
    connection = sqlite3.connect(str(db_path), timeout=30)
except (OSError, sqlite3.Error) as exc:
    raise SystemExit(
        f"错误：无法打开数据库：{exc}\n"
        "请以运行 SlideFlow 服务的系统用户执行此脚本。"
    ) from None

connection.row_factory = sqlite3.Row
connection.execute("PRAGMA busy_timeout = 30000")
connection.execute("PRAGMA foreign_keys = ON")

try:
    admins = connection.execute(
        "SELECT id, username FROM users WHERE role = 'system_admin' ORDER BY id"
    ).fetchall()

    if requested_username:
        try:
            username_key = username_lookup_key(requested_username)
        except ValueError as exc:
            raise SystemExit(f"错误：用户名无效：{exc}") from None
        user = connection.execute(
            "SELECT id, username, role FROM users WHERE username_key = ?",
            (username_key,),
        ).fetchone()
        if user is None:
            raise SystemExit(f"错误：未找到用户名为 {requested_username} 的账号。")
        if user["role"] != "system_admin":
            raise SystemExit(f"错误：{user['username']} 不是系统管理员，拒绝重置。")
    else:
        if not admins:
            raise SystemExit("错误：数据库中没有系统管理员账号。")
        if len(admins) > 1:
            names = "、".join(row["username"] for row in admins)
            raise SystemExit(f"检测到多个系统管理员（{names}），请指定要重置的用户名。")
        user = connection.execute(
            "SELECT id, username, role FROM users WHERE id = ?",
            (int(admins[0]["id"]),),
        ).fetchone()

    temporary_password = secrets.token_urlsafe(16)
    policy_error = password_policy_error(temporary_password, username=user["username"])
    if policy_error:
        raise SystemExit(f"错误：生成的临时密码不符合策略：{policy_error}")

    now = datetime.utcnow()
    now_iso = now.isoformat(timespec="seconds") + "Z"
    expires_iso = (now + timedelta(hours=24)).isoformat(timespec="seconds") + "Z"

    connection.execute("BEGIN IMMEDIATE")
    connection.execute(
        """
        UPDATE users
        SET password_hash = ?,
            must_change_pwd = 1,
            temporary_password_expires_at = ?,
            session_version = session_version + 1,
            updated_at = ?
        WHERE id = ? AND role = 'system_admin'
        """,
        (hash_password(temporary_password), expires_iso, now_iso, int(user["id"])),
    )
    if connection.execute("SELECT changes()").fetchone()[0] != 1:
        raise SystemExit("错误：管理员账号未更新。")

    audit_table = connection.execute(
        """
        SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'admin_audit_events'
        """
    ).fetchone()
    if audit_table is not None:
        connection.execute(
            """
            INSERT INTO admin_audit_events
                (actor_user_id, subject_user_id, action, details, created_at)
            VALUES (NULL, ?, 'user.password_reset.recovery', ?, ?)
            """,
            (
                int(user["id"]),
                '{"source":"tools/reset_admin_password.sh","reason":"local_recovery"}',
                now_iso,
            ),
        )
    connection.commit()
except Exception:
    connection.rollback()
    raise
finally:
    connection.close()

print(f"管理员账号: {user['username']}")
print(f"临时密码: {temporary_password}")
print(f"有效期至: {expires_iso}")
print("请立即登录并修改密码；临时密码只显示这一次。")
PY
