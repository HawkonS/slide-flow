import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { apiWithTimeout } from "@/lib/api";

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  all_tags?: string[];
  all_subjects?: string[];
  all_series?: string[];
}

export interface PaginatedQueryOptions<T> {
  /** API 路径，如 "/api/resources" */
  url: string;
  /** 查询键前缀，如 "resources" */
  queryKeyPrefix: string;
  /** 额外的 API 参数（筛选、排序等） */
  params?: Record<string, string | number | boolean | undefined>;
  /** 当前页码 */
  page: number;
  /** 每页大小 */
  pageSize: number;
  /** 是否启用查询 */
  enabled?: boolean;
  /** 弱网下避免请求无限期占用页面和连接。 */
  timeoutMs?: number;
}

export interface PaginatedQueryResult<T> {
  items: T[];
  total: number;
  totalPages: number;
  allTags: string[];
  allSubjects: string[];
  allSeries: string[];
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

export function usePaginatedQuery<T>(
  options: PaginatedQueryOptions<T>,
): PaginatedQueryResult<T> {
  const { url, queryKeyPrefix, params, page, pageSize, enabled = true, timeoutMs = 12_000 } = options;

  // 将 params 序列化为稳定字符串用于 queryKey
  const paramsKey = React.useMemo(() => {
    const entries = Object.entries(params || {})
      .filter(([, v]) => v !== undefined && v !== "")
      .sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify(entries);
  }, [params]);

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: [queryKeyPrefix, paramsKey, page, pageSize],
    queryFn: ({ signal }) => apiWithTimeout<PaginatedResponse<T>>(url, {
      signal,
      params: { ...params, page, page_size: pageSize },
    }, timeoutMs),
    enabled,
    placeholderData: (prev) => prev, // 切换页面时保留旧数据，避免闪烁
  });

  const total = data?.total ?? 0;
  const totalPages = data ? Math.max(1, Math.ceil(total / pageSize)) : 0;

  return {
    items: data?.items ?? [],
    total,
    totalPages,
    allTags: data?.all_tags ?? [],
    allSubjects: data?.all_subjects ?? [],
    allSeries: data?.all_series ?? [],
    isLoading,
    isFetching,
    isError,
    error: error as Error | null,
    refetch,
  };
}
