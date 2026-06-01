import * as React from "react";
import { useSearchParams } from "react-router-dom";

/**
 * 将页码同步到 URL searchParams（?page=N）。
 * 刷新页面时自动恢复页码，避免回到第 1 页。
 *
 * @param key  URL 参数名，默认 "page"
 * @returns [page, setPage] — 与 useState 用法一致
 */
export function useUrlPage(key = "page"): [number, React.Dispatch<React.SetStateAction<number>>] {
  const [searchParams, setSearchParams] = useSearchParams();

  const page = React.useMemo(() => {
    const v = searchParams.get(key);
    const n = v ? parseInt(v, 10) : 1;
    return Number.isFinite(n) && n >= 1 ? n : 1;
  }, [searchParams, key]);

  const setPage = React.useCallback<React.Dispatch<React.SetStateAction<number>>>(
    (action) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const prevVal = next.get(key);
          let newPage: number;
          if (typeof action === "function") {
            const cur = prevVal ? parseInt(prevVal, 10) || 1 : 1;
            newPage = action(cur);
          } else {
            newPage = action;
          }
          if (newPage <= 1) {
            next.delete(key);
          } else {
            next.set(key, String(newPage));
          }
          return next;
        },
        { replace: true },
      );
    },
    [key, setSearchParams],
  );

  return [page, setPage];
}
