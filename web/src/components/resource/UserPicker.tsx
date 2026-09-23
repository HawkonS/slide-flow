import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";

import { api } from "@/lib/api";
import { UserOption } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface UserPickerProps {
  value: number[];
  onChange: (ids: number[]) => void;
  /** 是否展示"选择全部/清空"快捷按钮 */
  showBulk?: boolean;
  className?: string;
  /** 可选：排除某些用户 id（例如资源所有者，已隐式具有权限） */
  excludeIds?: number[];
}

interface UserOptionsResponse {
  users: UserOption[];
}

/** Partial 范围用户多选组件：从 /api/users/options 拉取全部用户并以可点选行呈现。
 *  为避免 button-in-button 嵌套导致的 React 报错，可视 checkbox 仅用纯 CSS 标记。 */
export function UserPicker({ value, onChange, showBulk = true, className, excludeIds }: UserPickerProps) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["users", "options"],
    queryFn: async () => api<UserOptionsResponse>("/api/users/options"),
    staleTime: 60_000,
  });

  const users = React.useMemo(() => {
    const all = data?.users ?? [];
    if (!excludeIds?.length) return all;
    const set = new Set(excludeIds);
    return all.filter((u) => !set.has(u.id));
  }, [data, excludeIds]);

  const valueSet = React.useMemo(() => new Set(value), [value]);

  const toggle = (id: number) => {
    if (valueSet.has(id)) {
      onChange(value.filter((x) => x !== id));
    } else {
      onChange([...value, id]);
    }
  };

  const allIds = users.map((u) => u.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => valueSet.has(id));

  return (
    <div className={cn("rounded-md border bg-background", className)}>
      {showBulk && (
        <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
          <span>
            已选 <span className="font-medium text-foreground">{value.length}</span> / {users.length}
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="hover:text-primary disabled:opacity-40"
              onClick={() => onChange(allSelected ? [] : allIds)}
              disabled={users.length === 0}
            >
              {allSelected ? "清空" : "全选"}
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> 加载用户…
        </div>
      ) : isError ? (
        <div className="px-3 py-6 text-center text-sm text-destructive">
          加载失败：{(error as Error)?.message || "未知错误"}
        </div>
      ) : users.length === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">暂无可选用户</div>
      ) : (
        <div className="max-h-56 overflow-auto p-2">
          <div className="grid gap-1 sm:grid-cols-2">
            {users.map((u) => {
              const checked = valueSet.has(u.id);
              const label = u.name || u.username;
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => toggle(u.id)}
                  className={cn(
                    "flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition",
                    "hover:bg-accent",
                    checked && "bg-primary/5 text-primary",
                  )}
                >
                  {u.avatar_url ? (
                    <img src={u.avatar_url} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                      {label.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span
                    aria-hidden
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
                      checked
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input bg-background",
                    )}
                  >
                    {checked && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                  <span className="flex-1 truncate">
                    {label}
                    {label !== u.username && (
                      <span className="ml-1 text-xs text-muted-foreground">@{u.username}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
