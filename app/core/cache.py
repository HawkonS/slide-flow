"""
SlideFlow 进程内 TTL 缓存
用于减少高频数据库查询（用户信息、配置等），提升并发性能。
注意：这是进程级缓存，多 worker 进程间不共享。
"""
from __future__ import annotations

import threading
import time
from typing import Any


class TTLCache:
    """线程安全的 TTL 缓存，支持 LRU 淘汰"""

    def __init__(self, ttl_seconds: float = 30, max_size: int = 200):
        self._store: dict[str, tuple[Any, float]] = {}
        self._lock = threading.Lock()
        self._ttl = ttl_seconds
        self._max_size = max_size

    def get(self, key: str) -> Any | None:
        """获取缓存值，过期返回 None"""
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            value, ts = entry
            if time.time() - ts >= self._ttl:
                del self._store[key]
                return None
            return value

    def set(self, key: str, value: Any) -> None:
        """设置缓存值"""
        with self._lock:
            if len(self._store) >= self._max_size and key not in self._store:
                self._evict()
            self._store[key] = (value, time.time())

    def invalidate(self, key: str | None = None) -> None:
        """清除指定 key 或全部缓存"""
        with self._lock:
            if key is None:
                self._store.clear()
            else:
                self._store.pop(key, None)

    def _evict(self) -> None:
        """淘汰最旧的 20% 条目"""
        if not self._store:
            return
        items = sorted(self._store.items(), key=lambda x: x[1][1])
        evict_count = max(1, len(items) // 5)
        for k, _ in items[:evict_count]:
            del self._store[k]

    @property
    def size(self) -> int:
        return len(self._store)


# ── 全局缓存实例 ──
user_cache = TTLCache(ttl_seconds=60, max_size=200)      # 用户信息缓存
config_cache = TTLCache(ttl_seconds=300, max_size=50)    # 配置缓存
nav_cache = TTLCache(ttl_seconds=600, max_size=10)       # 导航配置缓存


def invalidate_user(user_id: int | None = None) -> None:
    """清除用户缓存（单个或全部）"""
    if user_id is None:
        user_cache.invalidate()
    else:
        user_cache.invalidate(f"user:{user_id}")
        user_cache.invalidate(f"session_user:{user_id}")


def invalidate_config() -> None:
    """清除配置缓存"""
    config_cache.invalidate()


def invalidate_nav() -> None:
    """清除导航缓存"""
    nav_cache.invalidate()
