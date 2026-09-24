import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, Search, Tags } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { UserOption } from "@/lib/types";
import { cn } from "@/lib/utils";

const MAX_SCOPE_USERS = 500;

export interface UserPickerProps {
  value: number[];
  onChange: (ids: number[]) => void;
  /** 是否展示"选择全部/清空"快捷按钮 */
  showBulk?: boolean;
  className?: string;
  /** 可选：排除某些用户 id（例如资源所有者，已隐式具有权限） */
  excludeIds?: number[];
  /** 是否允许通过用户标签批量加入匹配用户 */
  allowTagSelection?: boolean;
}

interface UserOptionsResponse {
  users: UserOption[];
  total?: number;
}

interface PresetUserTag {
  id: number;
  name: string;
  label: string;
}

interface PresetUserTagGroup {
  category: string;
  tags: PresetUserTag[];
}

interface PresetUserTagsResponse {
  groups: PresetUserTagGroup[];
}

/** Partial 范围用户多选组件：按搜索词读取有上限的用户选项并以可点选行呈现。
 *  为避免 button-in-button 嵌套导致的 React 报错，可视 checkbox 仅用纯 CSS 标记。 */
export function UserPicker({ value, onChange, showBulk = true, className, excludeIds, allowTagSelection = false }: UserPickerProps) {
  const [searchInput, setSearchInput] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [selectedTag, setSelectedTag] = React.useState("");
  React.useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["users", "options", search, value],
    queryFn: async () => {
      const selectedChunks: number[][] = [];
      for (let index = 0; index < value.length; index += 100) {
        selectedChunks.push(value.slice(index, index + 100));
      }
      const responses = await Promise.all([
        api<UserOptionsResponse>("/api/users/options", {
          params: { search: search || undefined, limit: 100 },
        }),
        ...selectedChunks.map((ids) => api<UserOptionsResponse>("/api/users/options", {
          params: { ids: ids.join(","), limit: 0 },
        })),
      ]);
      const searchUsers = responses[0]?.users ?? [];
      const byId = new Map<number, UserOption>();
      responses.forEach((response) => response.users.forEach((user) => byId.set(user.id, user)));
      return { users: Array.from(byId.values()), searchUsers };
    },
    staleTime: 60_000,
  });

  const {
    data: userTagsData,
    isLoading: userTagsLoading,
    isError: userTagsError,
  } = useQuery({
    queryKey: ["preset-tags", "user"],
    queryFn: () => api<PresetUserTagsResponse>("/api/user-tags"),
    enabled: allowTagSelection,
    staleTime: 30_000,
  });

  const {
    data: taggedUsersData,
    isFetching: taggedUsersLoading,
    isError: taggedUsersError,
  } = useQuery({
    queryKey: ["users", "options", "tag", selectedTag],
    queryFn: () => api<UserOptionsResponse>("/api/users/options", {
      params: { tag: selectedTag, limit: MAX_SCOPE_USERS },
    }),
    enabled: allowTagSelection && Boolean(selectedTag),
    staleTime: 30_000,
  });

  const users = React.useMemo(() => {
    const all = data?.users ?? [];
    if (!excludeIds?.length) return all;
    const set = new Set(excludeIds);
    return all.filter((u) => !set.has(u.id));
  }, [data, excludeIds]);

  const valueSet = React.useMemo(() => new Set(value), [value]);
  const excludedSet = React.useMemo(() => new Set(excludeIds ?? []), [excludeIds]);
  const currentResultIds = React.useMemo(() => {
    return (data?.searchUsers ?? []).map((user) => user.id).filter((id) => !excludedSet.has(id));
  }, [data?.searchUsers, excludedSet]);

  const userTagGroups = userTagsData?.groups ?? [];
  const selectedTagDetails = userTagGroups
    .flatMap((group) => group.tags.map((tag) => ({ ...tag, category: group.category })))
    .find((tag) => tag.name === selectedTag);
  const taggedUserIds = (taggedUsersData?.users ?? [])
    .map((user) => user.id)
    .filter((id) => !excludedSet.has(id));
  const taggedUserTotal = taggedUsersData?.total ?? taggedUserIds.length;
  const tagSelectionTooLarge = taggedUserTotal > MAX_SCOPE_USERS;

  const toggle = (id: number) => {
    if (valueSet.has(id)) {
      onChange(value.filter((x) => x !== id));
    } else {
      onChange([...value, id]);
    }
  };

  const allCurrentSelected = currentResultIds.length > 0 && currentResultIds.every((id) => valueSet.has(id));

  const toggleCurrentResults = () => {
    const currentIds = new Set(currentResultIds);
    if (allCurrentSelected) {
      onChange(value.filter((id) => !currentIds.has(id)));
      return;
    }
    onChange(Array.from(new Set([...value, ...currentResultIds])));
  };

  const addTaggedUsers = () => {
    if (!selectedTag || taggedUsersLoading || taggedUsersError || tagSelectionTooLarge) return;
    const next = Array.from(new Set([...value, ...taggedUserIds]));
    if (next.length > MAX_SCOPE_USERS) {
      toast.error(`单个范围最多选择 ${MAX_SCOPE_USERS} 位用户`);
      return;
    }
    const added = next.length - value.length;
    if (!added) {
      toast.info("该标签内的用户已全部选中");
      return;
    }
    onChange(next);
    toast.success(`已从「${selectedTagDetails?.label || selectedTag}」添加 ${added} 位用户`);
  };

  return (
    <div className={cn("rounded-md border bg-background", className)}>
      {allowTagSelection && (
        <div className="space-y-2 border-b bg-muted/20 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Tags className="h-3.5 w-3.5 text-muted-foreground" />
            按用户标签批量添加
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Select value={selectedTag} onValueChange={setSelectedTag} disabled={userTagsLoading || userTagsError || userTagGroups.length === 0}>
              <SelectTrigger aria-label="选择用户标签">
                <SelectValue placeholder={userTagsLoading ? "正在加载用户标签…" : userTagsError ? "用户标签加载失败" : "请选择用户标签"} />
              </SelectTrigger>
              <SelectContent>
                {userTagGroups.map((group) => (
                  <SelectGroup key={group.category}>
                    <SelectLabel>{group.category}</SelectLabel>
                    {group.tags.map((tag) => <SelectItem key={tag.id} value={tag.name}>{tag.label}</SelectItem>)}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              onClick={addTaggedUsers}
              disabled={!selectedTag || taggedUsersLoading || taggedUsersError || taggedUserIds.length === 0 || tagSelectionTooLarge}
            >
              {taggedUsersLoading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              添加标签内用户
            </Button>
          </div>
          {selectedTag && !taggedUsersLoading && !taggedUsersError && (
            <p className={cn("text-xs", tagSelectionTooLarge ? "text-destructive" : "text-muted-foreground")}>
              {tagSelectionTooLarge
                ? `该标签匹配 ${taggedUserTotal} 人，超过单个范围 ${MAX_SCOPE_USERS} 人上限`
                : `该标签匹配 ${taggedUserTotal} 人；添加后仍可逐人取消`}
            </p>
          )}
          {selectedTag && taggedUsersError && <p className="text-xs text-destructive">标签用户加载失败，请重试</p>}
          {!userTagsLoading && !userTagsError && userTagGroups.length === 0 && <p className="text-xs text-muted-foreground">暂无可用用户标签</p>}
        </div>
      )}
      <div className="relative border-b">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="搜索用户"
          className="h-9 w-full bg-transparent pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      {showBulk && (
        <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
          <span>
            已选 <span className="font-medium text-foreground">{value.length}</span>，当前结果 {currentResultIds.length} 人
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="hover:text-primary disabled:opacity-40"
              onClick={toggleCurrentResults}
              disabled={currentResultIds.length === 0}
            >
              {allCurrentSelected ? "取消当前结果" : "选择当前结果"}
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
