"""Validation helpers for administrator-managed user profiles."""

from __future__ import annotations

import ipaddress
import logging
import unicodedata
from urllib.parse import urlparse

from app.config import settings
from app.core.oss import is_oss_ref


logger = logging.getLogger(__name__)


_TRUSTED_AVATAR_DOMAIN_SUFFIXES = (
    ".feishucdn.com",
    ".larksuitecdn.com",
    ".byteimg.com",
)


def normalise_username(value: str) -> str:
    """Return the canonical stored username without changing display case."""
    username = (value or "").strip()
    if len(username) < 2:
        raise ValueError("用户名至少需要 2 个字符")
    if len(username) > 50:
        raise ValueError("用户名不能超过 50 个字符")
    if any(char.isspace() for char in username):
        raise ValueError("用户名不能包含空白字符")
    if _contains_control_characters(username):
        raise ValueError("用户名不能包含控制字符")
    return username


def username_lookup_key(value: str) -> str:
    """Return a Unicode-aware key used for uniqueness and login lookup."""
    return unicodedata.normalize("NFKC", normalise_username(value)).casefold()


def normalise_display_name(value: str) -> str:
    """Validate a human-readable user name used throughout the UI."""
    name = (value or "").strip()
    if not name:
        raise ValueError("姓名不能为空")
    if len(name) > 100:
        raise ValueError("姓名不能超过 100 个字符")
    if _contains_control_characters(name):
        raise ValueError("姓名不能包含控制字符")
    return name


def normalise_feishu_id(value: str) -> str:
    """Validate an optional Feishu open_id before persisting it."""
    feishu_id = (value or "").strip()
    if not feishu_id:
        return ""
    if len(feishu_id) > 100:
        raise ValueError("飞书 ID 不能超过 100 个字符")
    if any(char.isspace() for char in feishu_id) or _contains_control_characters(feishu_id):
        raise ValueError("飞书 ID 不能包含空白或控制字符")
    return feishu_id


def _contains_control_characters(value: str) -> bool:
    return any(unicodedata.category(char).startswith("C") for char in value)


def _configured_avatar_hosts() -> set[str]:
    hosts: set[str] = set()
    for raw in (
        settings.oss_public_endpoint,
        settings.oss_endpoint,
    ):
        for value in (raw or "").split(","):
            value = value.strip()
            if not value:
                continue
            parsed = urlparse(value if "://" in value else f"https://{value}")
            if parsed.hostname:
                host = parsed.hostname.casefold().rstrip(".")
                hosts.add(host)
                if settings.oss_bucket and (host == "aliyuncs.com" or host.endswith(".aliyuncs.com")):
                    hosts.add(f"{settings.oss_bucket}.{host}".casefold())
    return hosts


def validate_avatar_url(value: str) -> str:
    """Allow only HTTPS images from configured storage or trusted SSO CDNs.

    User-controlled arbitrary image URLs are rendered by administrators'
    browsers and can otherwise be used for tracking or private-network probes.
    """
    value = (value or "").strip()
    if not value:
        return ""
    if any(char.isspace() for char in value) or _contains_control_characters(value):
        raise ValueError("头像链接必须是受信任域名的 HTTPS 地址")
    try:
        parsed = urlparse(value)
        hostname = (parsed.hostname or "").casefold().rstrip(".")
        if parsed.scheme.casefold() != "https" or not hostname:
            raise ValueError
        if parsed.username or parsed.password or parsed.port not in {None, 443}:
            raise ValueError
        try:
            ipaddress.ip_address(hostname)
        except ValueError:
            pass
        else:
            raise ValueError
    except (ValueError, TypeError):
        raise ValueError("头像链接必须是受信任域名的 HTTPS 地址") from None

    configured_hosts = _configured_avatar_hosts()
    trusted = hostname in configured_hosts or any(
        hostname == suffix[1:] or hostname.endswith(suffix)
        for suffix in _TRUSTED_AVATAR_DOMAIN_SUFFIXES
    )
    if not trusted:
        raise ValueError("头像链接仅支持飞书头像或系统配置的图片域名")

    return value


def is_managed_avatar_ref(avatar_ref: str, *, user_id: int | None = None) -> bool:
    """Return whether a stored avatar reference belongs to managed storage."""
    if not avatar_ref:
        return False
    if is_oss_ref(avatar_ref):
        try:
            from app.core.oss import oss_key

            key_parts = [part for part in oss_key(avatar_ref).replace("\\", "/").split("/") if part]
            prefix_parts = [
                part
                for part in (settings.oss_prefix or "").replace("\\", "/").split("/")
                if part
            ]
            if prefix_parts:
                if key_parts[:len(prefix_parts)] != prefix_parts:
                    return False
                key_parts = key_parts[len(prefix_parts):]
            if len(key_parts) < 3 or key_parts[0] != "avatars":
                return False
            try:
                owner_id = int(key_parts[1])
            except ValueError:
                return False
            if owner_id <= 0:
                return False
            return user_id is None or owner_id == int(user_id)
        except ValueError:
            return False
    path = settings.abs_path(avatar_ref)
    if path is None:
        return False
    try:
        relative = path.resolve().relative_to(settings.assets_dir.resolve())
    except (ValueError, OSError, RuntimeError):
        return False
    return len(relative.parts) >= 2 and relative.parts[0] == "avatars"


def delete_managed_avatar(avatar_ref: str, *, user_id: int | None = None) -> None:
    """Best-effort cleanup after the database no longer references an avatar.

    Cleanup happens after a successful database commit. Storage failures must
    therefore never turn an already-completed user mutation into a false 500.
    """
    if not is_managed_avatar_ref(avatar_ref, user_id=user_id):
        return
    try:
        if is_oss_ref(avatar_ref):
            from app.core.oss import storage as oss_storage

            oss_storage.delete(avatar_ref)
            return
        path = settings.abs_path(avatar_ref)
        if path is not None:
            path.unlink(missing_ok=True)
    except Exception:
        logger.warning("清理用户头像失败: %s", avatar_ref, exc_info=True)
