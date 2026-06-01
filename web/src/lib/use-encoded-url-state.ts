import * as React from "react";
import { useSearchParams } from "react-router-dom";

/* ---- Encoding helpers ---- */

function encode(obj: unknown): string {
  const json = JSON.stringify(obj);
  // URL-safe base64
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decode<T>(str: string): T | null {
  try {
    let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const json = decodeURIComponent(escape(atob(b64)));
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/* ---- Types ---- */

export interface UrlStateConfig<T> {
  /** URL 参数名，推荐 "s" */
  key?: string;
  /** 默认状态（当 URL 无参数时使用） */
  defaults: T;
  /** 去抖延迟（ms），默认 300 */
  debounce?: number;
}
/**
 * 将筛选条件 + 页码等任意状态序列化为一个 URL-safe base64 字符串，
 * 存放在 URL 的单个 query 参数中（默认 `?s=…`）。
 *
 * - 刷新页面自动恢复完整状态
 * - 状态与 defaults 一致时清除 URL 参数，保持 URL 整洁
 * - 写入去抖，避免频繁修改历史记录
 */
export function useEncodedUrlState<T>(
  config: UrlStateConfig<T>,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const { key = "s", defaults, debounce = 300 } = config;

  const [searchParams, setSearchParams] = useSearchParams();

  /* ---- 初始值：URL 有就用 URL 的，否则用 defaults ---- */
  const [state, setState] = React.useState<T>(() => {
    const raw = searchParams.get(key);
    if (!raw) return defaults;
    const parsed = decode<T>(raw);
    return parsed ? { ...defaults, ...parsed } : defaults;
  });

  /* ---- state → URL（去抖） ---- */
  const stateRef = React.useRef(state);
  stateRef.current = state;

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const encoded = encode(stateRef.current);
          const defaultEncoded = encode(defaults);
          if (encoded === defaultEncoded) {
            next.delete(key);
          } else {
            next.set(key, encoded);
          }
          return next;
        },
        { replace: true },
      );
    }, debounce);
    return () => clearTimeout(timer);
  }, [state, key, defaults, debounce, setSearchParams]);

  /* ---- URL → state（浏览器前进/后退时同步） ---- */
  React.useEffect(() => {
    const raw = searchParams.get(key);
    const fromUrl = raw ? decode<T>(raw) : null;
    const next = fromUrl ? { ...defaults, ...fromUrl } : defaults;
    setState((prev) => {
      // 只有实际值变化时才更新，避免无意义的 re-render
      if (encode(prev) === encode(next)) return prev;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return [state, setState];
}
