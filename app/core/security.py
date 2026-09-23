from __future__ import annotations

import base64
import hashlib
import hmac
import os
import time


from app.config import settings


PASSWORD_ITERATIONS = 220_000
MIN_PASSWORD_LENGTH = 10
_COMMON_PASSWORDS = {
    "123456",
    "12345678",
    "123456789",
    "password",
    "password123",
    "qwerty123",
    "admin123",
    "slideflow",
}


def password_policy_error(password: str, *, username: str = "") -> str | None:
    if len(password.strip()) < MIN_PASSWORD_LENGTH:
        return f"密码长度不能少于 {MIN_PASSWORD_LENGTH} 位"
    normalized = password.strip().casefold()
    if normalized in _COMMON_PASSWORDS:
        return "密码过于常见，请使用更难猜测的密码"
    if username and normalized == username.strip().casefold():
        return "密码不能与用户名相同"
    return None


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PASSWORD_ITERATIONS,
    )
    return "pbkdf2_sha256${}${}${}".format(
        PASSWORD_ITERATIONS,
        base64.urlsafe_b64encode(salt).decode("ascii"),
        base64.urlsafe_b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        scheme, iterations, salt_b64, digest_b64 = stored_hash.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        salt = base64.urlsafe_b64decode(salt_b64.encode("ascii"))
        expected = base64.urlsafe_b64decode(digest_b64.encode("ascii"))
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt,
            int(iterations),
        )
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def create_session_token(
    user_id: int,
    secret_key: str,
    ttl_seconds: int | None = None,
    *,
    session_version: int = 1,
) -> str:
    if ttl_seconds is None:
        ttl_seconds = settings.session_ttl_hours * 3600
    expires = int(time.time()) + ttl_seconds
    payload = f"{user_id}:{session_version}:{expires}".encode("utf-8")
    payload_b64 = _b64(payload)
    signature = hmac.new(secret_key.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    return f"{payload_b64}.{_b64(signature)}"


def create_present_token(show_id: int, user_id: int, secret_key: str) -> str:
    """创建放映会话 token，使用当前配置中的有效期。"""
    expires = int(time.time()) + int(settings.show_token_ttl_seconds)
    payload = f"{show_id}:{user_id}:{expires}"
    signature = hmac.new(secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}:{signature}"


def verify_present_token(token: str, secret_key: str) -> dict | None:
    """验证放映会话token，返回 {show_id, user_id} 或 None"""
    try:
        parts = token.rsplit(":", 1)
        if len(parts) != 2:
            return None
        payload, signature = parts
        expected = hmac.new(secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        show_id_str, user_id_str, expires_str = payload.split(":")
        if int(expires_str) < int(time.time()):
            return None
        return {"show_id": int(show_id_str), "user_id": int(user_id_str)}
    except Exception:
        return None


def read_session_claims(token: str | None, secret_key: str) -> tuple[int, int] | None:
    if not token or "." not in token:
        return None
    payload_b64, signature_b64 = token.split(".", 1)
    expected = hmac.new(secret_key.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    try:
        actual = _unb64(signature_b64)
        if not hmac.compare_digest(actual, expected):
            return None
        payload = _unb64(payload_b64).decode("utf-8")
        parts = payload.split(":")
        if len(parts) == 2:
            # Pre-session-version tokens remain valid for unchanged accounts.
            # Password reset/legacy-password remediation increments the stored
            # version, so those older sessions are still revoked immediately.
            user_id_raw, expires_raw = parts
            session_version_raw = "1"
        elif len(parts) == 3:
            user_id_raw, session_version_raw, expires_raw = parts
        else:
            return None
        if int(expires_raw) < int(time.time()):
            return None
        return int(user_id_raw), int(session_version_raw)
    except Exception:
        return None


def read_session_token(token: str | None, secret_key: str) -> int | None:
    claims = read_session_claims(token, secret_key)
    return claims[0] if claims else None
