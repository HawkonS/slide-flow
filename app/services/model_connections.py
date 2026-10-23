"""Encrypted OpenAI-compatible model connection storage and HTTP helpers."""

from __future__ import annotations

import base64
import hashlib
import logging
import re
import sqlite3
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from cryptography.fernet import Fernet, InvalidToken

from app.config import settings
from app.db import now_iso

logger = logging.getLogger(__name__)

API_KEY_MASK = "********"
_MODEL_NAME_RE = re.compile(r"^[^\x00\r\n]{1,200}$")


class ModelConnectionError(RuntimeError):
    """A safe, user-facing model connection failure."""


def _cipher() -> Fernet:
    digest = hashlib.sha256(
        f"slide-flow-model-connection:{settings.secret_key}".encode("utf-8")
    ).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_api_key(value: str) -> str:
    return _cipher().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_api_key(value: str) -> str:
    try:
        return _cipher().decrypt(value.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeDecodeError, ValueError) as exc:
        raise ModelConnectionError("模型连接密钥无法解密，请重新保存该连接") from exc


def normalize_base_url(value: str) -> str:
    raw = value.strip().rstrip("/")
    parts = urlsplit(raw)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ModelConnectionError("模型地址必须是完整的 http 或 https 地址")
    if parts.username or parts.password:
        raise ModelConnectionError("模型地址不能包含用户名或密码")
    path = parts.path.rstrip("/")
    if path.endswith("/chat/completions"):
        path = path[: -len("/chat/completions")].rstrip("/")
    elif path.endswith("/models"):
        path = path[: -len("/models")].rstrip("/")
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def _endpoint(base_url: str, suffix: str) -> str:
    return f"{normalize_base_url(base_url)}{suffix}"


def _headers(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}


def list_remote_models(base_url: str, api_key: str) -> list[dict[str, Any]]:
    try:
        response = httpx.get(
            _endpoint(base_url, "/models"),
            headers=_headers(api_key),
            timeout=httpx.Timeout(15.0, connect=5.0),
            follow_redirects=False,
        )
    except httpx.TimeoutException as exc:
        raise ModelConnectionError("连接模型服务超时") from exc
    except httpx.HTTPError as exc:
        raise ModelConnectionError("无法连接模型服务") from exc
    if response.status_code in {401, 403}:
        raise ModelConnectionError("模型服务鉴权失败，请检查 API Key")
    if response.status_code >= 400:
        raise ModelConnectionError(f"模型服务返回错误（HTTP {response.status_code}）")
    try:
        payload = response.json()
    except ValueError as exc:
        raise ModelConnectionError("模型服务返回的数据格式不正确") from exc
    if isinstance(payload, list):
        raw_models = payload
    elif isinstance(payload, dict):
        raw_models = payload.get("data")
        if raw_models is None:
            raw_models = payload.get("models")
        if isinstance(raw_models, dict):
            raw_models = raw_models.get("data") or raw_models.get("models")
    else:
        raw_models = None
    if not isinstance(raw_models, list):
        raise ModelConnectionError("模型服务返回中缺少模型列表")
    models: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_models:
        if isinstance(item, str):
            model_id = item.strip()
            record = {"id": model_id, "owned_by": ""}
        elif isinstance(item, dict):
            model_id = str(item.get("id") or item.get("model") or "").strip()
            record = {"id": model_id, "owned_by": str(item.get("owned_by") or "")}
        else:
            continue
        if model_id and model_id not in seen and _MODEL_NAME_RE.fullmatch(model_id):
            seen.add(model_id)
            models.append(record)
    return models


def call_chat_completion(
    base_url: str,
    api_key: str,
    model: str,
    image_data_url: str,
    prompt: str,
) -> str:
    body = {
        "model": model,
        "temperature": 0,
        "max_tokens": 500,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        }],
    }
    try:
        response = httpx.post(
            _endpoint(base_url, "/chat/completions"),
            headers={**_headers(api_key), "Content-Type": "application/json"},
            json=body,
            timeout=httpx.Timeout(120.0, connect=8.0),
            follow_redirects=False,
        )
    except httpx.TimeoutException as exc:
        raise ModelConnectionError("模型标注请求超时") from exc
    except httpx.HTTPError as exc:
        raise ModelConnectionError("无法连接模型服务") from exc
    if response.status_code in {401, 403}:
        raise ModelConnectionError("模型服务鉴权失败，请检查 API Key")
    if response.status_code == 404:
        raise ModelConnectionError("模型服务不支持视觉对话接口或模型不存在")
    if response.status_code >= 400:
        raise ModelConnectionError(f"模型标注请求失败（HTTP {response.status_code}）")
    try:
        payload = response.json()
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise ModelConnectionError("模型服务返回中缺少有效结果") from exc
    if isinstance(content, list):
        content = "".join(
            str(item.get("text") or "") for item in content if isinstance(item, dict)
        )
    if not isinstance(content, str) or not content.strip():
        raise ModelConnectionError("模型服务返回了空结果")
    return content.strip()


def connection_row(db: sqlite3.Connection, connection_id: int) -> sqlite3.Row:
    row = db.execute(
        "SELECT * FROM model_connections WHERE id = ?", (connection_id,)
    ).fetchone()
    if row is None:
        raise ModelConnectionError("模型连接不存在")
    return row


def default_connection_row(db: sqlite3.Connection) -> sqlite3.Row:
    row = db.execute(
        "SELECT * FROM model_connections ORDER BY is_default DESC, id LIMIT 1"
    ).fetchone()
    if row is None:
        raise ModelConnectionError("尚未配置可用的模型连接")
    if not row["model"]:
        raise ModelConnectionError("默认模型连接尚未选择模型")
    return row


def serialize_connection(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "name": str(row["name"]),
        "base_url": str(row["base_url"]),
        "model": str(row["model"] or ""),
        "is_default": bool(row["is_default"]),
        "api_key_set": bool(row["api_key_ciphertext"]),
        "api_key": API_KEY_MASK if row["api_key_ciphertext"] else "",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def set_default_connection(db: sqlite3.Connection, connection_id: int) -> None:
    db.execute("UPDATE model_connections SET is_default = 0")
    db.execute(
        "UPDATE model_connections SET is_default = 1 WHERE id = ?", (connection_id,)
    )


def upsert_connection(
    db: sqlite3.Connection,
    *,
    name: str,
    base_url: str,
    api_key: str | None,
    model: str,
    created_by: int,
    connection_id: int | None = None,
    is_default: bool = False,
) -> sqlite3.Row:
    clean_name = name.strip()
    if not clean_name or len(clean_name) > 100:
        raise ModelConnectionError("连接名称不能为空且不能超过 100 个字符")
    normalized_url = normalize_base_url(base_url)
    clean_model = model.strip()
    if len(clean_model) > 200 or (clean_model and not _MODEL_NAME_RE.fullmatch(clean_model)):
        raise ModelConnectionError("模型名称不合法")
    encrypted: str | None = None
    if api_key is not None and api_key.strip():
        if len(api_key) > 4000:
            raise ModelConnectionError("API Key 过长")
        encrypted = encrypt_api_key(api_key.strip())
    now = now_iso()
    if connection_id is None:
        if encrypted is None:
            raise ModelConnectionError("新连接必须填写 API Key")
        try:
            cursor = db.execute(
                "INSERT INTO model_connections (name, base_url, api_key_ciphertext, model, is_default, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (clean_name, normalized_url, encrypted, clean_model, int(is_default), created_by, now, now),
            )
        except sqlite3.IntegrityError as exc:
            raise ModelConnectionError("连接名称已存在") from exc
        connection_id = int(cursor.lastrowid)
    else:
        existing = connection_row(db, connection_id)
        try:
            db.execute(
                "UPDATE model_connections SET name=?, base_url=?, api_key_ciphertext=?, model=?, is_default=?, updated_at=? WHERE id=?",
                (
                    clean_name,
                    normalized_url,
                    encrypted or existing["api_key_ciphertext"],
                    clean_model,
                    int(is_default),
                    now,
                    connection_id,
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise ModelConnectionError("连接名称已存在") from exc
    if is_default:
        set_default_connection(db, connection_id)
    elif connection_id is not None and db.execute(
        "SELECT COUNT(*) FROM model_connections WHERE is_default = 1"
    ).fetchone()[0] == 0:
        set_default_connection(db, connection_id)
    return connection_row(db, connection_id)


def connection_credentials(row: sqlite3.Row) -> tuple[str, str, str]:
    return str(row["base_url"]), decrypt_api_key(str(row["api_key_ciphertext"])), str(row["model"] or "")
