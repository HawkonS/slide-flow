import { copyText } from "@/lib/clipboard";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, CalendarDays, Camera, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, CloudDownload, Copy, KeyRound, Loader2, MoreHorizontal, Pencil, Search, Shield, Tag, Trash2, Upload, User, UserCheck, UserPlus, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { USER_ROLE_LABEL, USER_ROLE_OPTIONS } from "@/lib/constants";
import { AdminUser, AdminUsersResponse, UserRole } from "@/lib/types";
import { useUrlPage } from "@/lib/use-url-page";
import { cn } from "@/lib/utils";
import { TableTags, TableText } from "@/components/common/TableContent";
import { PageHeader } from "@/components/common/PageHeader";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { TagInput } from "@/components/resource/TagInput";
import { PageMetrics } from "@/components/common/PageMetrics";
import { FilterChip, TagFilterChip } from "@/components/resource/filter-chips";
import { parseTags, serializeTags } from "@/lib/types";
import { useAuth } from "@/lib/auth";
import { UserSearchSelect } from "@/components/resource/UserSearchSelect";

const USER_PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

type PaginationItem = number | "ellipsis-start" | "ellipsis-end";

function getPaginationItems(page: number, totalPages: number): PaginationItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  if (page <= 4) {
    return [1, 2, 3, 4, 5, "ellipsis-end", totalPages];
  }
  if (page >= totalPages - 3) {
    return [1, "ellipsis-start", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, "ellipsis-start", page - 1, page, page + 1, "ellipsis-end", totalPages];
}

function UserPagination({
  page,
  totalPages,
  total,
  pageSize,
  isFetching,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  isFetching: boolean;
  onPageChange: (nextPage: number) => void;
  onPageSizeChange: (nextPageSize: number) => void;
}) {
  const [jumpValue, setJumpValue] = React.useState(String(page));
  React.useEffect(() => setJumpValue(String(page)), [page]);

  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const submitJump = () => {
    const nextPage = Number.parseInt(jumpValue, 10);
    if (!Number.isFinite(nextPage)) {
      setJumpValue(String(page));
      return;
    }
    onPageChange(Math.min(totalPages, Math.max(1, nextPage)));
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm text-muted-foreground select-none">
      <div className="flex min-w-0 items-center gap-3">
        <span className="whitespace-nowrap">
          显示 {start}-{end}，共 {total} 条
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="hidden sm:inline">每页</span>
          <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
            <SelectTrigger className="h-8 w-[72px] text-xs" aria-label="每页条数">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {USER_PAGE_SIZE_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>{option} 条</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {isFetching && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="正在更新" />}
      </div>

      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={page <= 1 || isFetching}
          onClick={() => onPageChange(1)}
          aria-label="第一页"
          title="第一页"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={page <= 1 || isFetching}
          onClick={() => onPageChange(page - 1)}
          aria-label="上一页"
          title="上一页"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>

        <div className="hidden items-center gap-1 sm:flex">
          {getPaginationItems(page, totalPages).map((item) => (
            typeof item === "number" ? (
              <Button
                key={item}
                type="button"
                variant={item === page ? "secondary" : "ghost"}
                size="icon"
                className={cn("h-8 w-8 text-xs", item === page && "pointer-events-none font-semibold")}
                disabled={isFetching}
                onClick={() => onPageChange(item)}
                aria-label={`第 ${item} 页`}
                aria-current={item === page ? "page" : undefined}
              >
                {item}
              </Button>
            ) : (
              <span key={item} className="w-6 text-center text-muted-foreground" aria-hidden="true">…</span>
            )
          ))}
        </div>

        <div className="flex items-center gap-1 sm:hidden">
          <Input
            value={jumpValue}
            onChange={(event) => setJumpValue(event.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitJump();
            }}
            inputMode="numeric"
            aria-label="跳转到页码"
            className="h-8 w-12 px-1.5 text-center text-xs"
            disabled={isFetching}
          />
          <span className="whitespace-nowrap text-xs">/ {totalPages}</span>
        </div>

        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={page >= totalPages || isFetching}
          onClick={() => onPageChange(page + 1)}
          aria-label="下一页"
          title="下一页"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={page >= totalPages || isFetching}
          onClick={() => onPageChange(totalPages)}
          aria-label="最后一页"
          title="最后一页"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </Button>
        <span className="hidden whitespace-nowrap pl-1 text-xs text-muted-foreground sm:inline">第 {page} / {totalPages} 页</span>
      </div>
    </div>
  );
}

const userDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatUserDateTime(value: string | null | undefined, emptyText = "-") {
  if (!value) return emptyText;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : userDateTimeFormatter.format(date).split("/").join("-");
}

type LoginSort = "asc" | "desc";

function LoginSortChip({ value, onChange }: { value: LoginSort; onChange: (value: LoginSort) => void }) {
  const directionLabel = value === "asc" ? "升序" : "降序";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "group inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-sm transition hover:border-foreground/30 hover:bg-accent",
            "border-foreground/25 bg-primary-weak text-foreground",
          )}
          aria-label={`排序：最后登录时间${directionLabel}`}
        >
          <span className="text-muted-foreground">排序</span>
          <span className="font-medium">最后登录时间 · {directionLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-80" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        <div className="mb-1 border-b px-1 pb-2 pt-1">
          <div className="mb-1 text-xs text-muted-foreground">排序方向</div>
          <div className="grid grid-cols-2 gap-1">
            {([
              { value: "asc", label: "升序" },
              { value: "desc", label: "降序" },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={value === option.value}
                onClick={() => onChange(option.value)}
                className={cn(
                  "h-7 rounded-md border text-xs transition",
                  value === option.value
                    ? "border-foreground/25 bg-primary-weak text-foreground"
                    : "bg-background hover:border-foreground/30 hover:bg-accent",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between rounded-sm px-2 py-1.5 text-sm">
          <span>最后登录时间</span>
          <Check className="h-3.5 w-3.5" />
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface PublicConfigResponse {
  default_filters?: {
    user_tags?: string[];
  };
}

export function AdminUsersPage() {
  const qc = useQueryClient();
  const { user: currentUser, setUser } = useAuth();
  const [tagFilters, setTagFilters] = React.useState<string[]>([]);
  const [tagFilterMode, setTagFilterMode] = React.useState<"any" | "all">("any");
  const [roleFilter, setRoleFilter] = React.useState<UserRole | "all">("all");
  const [loginSort, setLoginSort] = React.useState<LoginSort>("desc");
  const defaultUserTagsApplied = React.useRef(false);
  const userTagFiltersTouched = React.useRef(false);
  const { data: publicConfig } = useQuery({
    queryKey: ["config"],
    queryFn: () => api<PublicConfigResponse>("/api/config"),
    staleTime: 60_000,
  });
  React.useEffect(() => {
    if (!publicConfig || defaultUserTagsApplied.current) return;
    defaultUserTagsApplied.current = true;
    if (userTagFiltersTouched.current) return;
    setTagFilters(Array.from(new Set(publicConfig.default_filters?.user_tags ?? [])));
  }, [publicConfig]);

  const [editing, setEditing] = React.useState<AdminUser | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [bulkTagsOpen, setBulkTagsOpen] = React.useState(false);
  const [transferUser, setTransferUser] = React.useState<AdminUser | null>(null);
  const [resetUser, setResetUser] = React.useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = React.useState("");
  const [resettingPassword, setResettingPassword] = React.useState(false);
  const [resetConfirmUser, setResetConfirmUser] = React.useState<AdminUser | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<AdminUser | null>(null);
  const [queryInput, setQueryInput] = React.useState("");
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [filterSelectionIds, setFilterSelectionIds] = React.useState<number[] | null>(null);

  const delMut = useMutation({
    mutationFn: async (id: number) => api(`/api/admin/users/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("用户已删除");
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["users", "options"] });
    },
    onError: (err: Error) => toast.error(err.message || "删除失败"),
  });

  const importFeishuMut = useMutation({
    mutationFn: async () => api<{ total: number; created: number; updated: number; unchanged: number }>(
      "/api/admin/users/import-feishu",
      { method: "POST" },
    ),
    onSuccess: (result) => {
      toast.success(
        "飞书通讯录同步完成：新增 " + result.created
          + " 人，更新 " + result.updated
          + " 人，未变化 " + result.unchanged + " 人",
      );
      setPage(1);
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["users", "options"] });
    },
    onError: (err: Error) => toast.error(err.message || "飞书通讯录同步失败"),
  });

  const canManageUser = React.useCallback(
    (u: AdminUser) => currentUser?.role === "system_admin" || u.role !== "system_admin",
    [currentUser?.role],
  );
  const canDeleteUser = React.useCallback(
    (u: AdminUser) => canManageUser(u) && currentUser?.id !== u.id,
    [canManageUser, currentUser?.id],
  );
  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const requestPasswordReset = async (user: AdminUser) => {
    setResetConfirmUser(user);
  };

  const confirmPasswordReset = async () => {
    const user = resetConfirmUser;
    if (!user || resettingPassword) return;
    setResettingPassword(true);
    try {
      const result = await api<{ user: AdminUser; plain_password: string }>(
        `/api/admin/users/${user.id}/reset-password`,
        { method: "POST" },
      );
      setResetConfirmUser(null);
      setResetUser(result.user);
      setResetPassword(result.plain_password);
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (error) {
      toast.error((error as Error).message || "重置密码失败");
    } finally {
      setResettingPassword(false);
    }
  };


  const bulkDelMut = useMutation({
    mutationFn: async (ids: number[]) =>
      api<{ deleted: number }>("/api/admin/users/bulk-delete", {
        method: "POST",
        json: { user_ids: ids },
      }),
    onSuccess: (data) => {
      toast.success(`已删除 ${data.deleted} 个用户`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["users", "options"] });
    },
    onError: (err: Error) => toast.error(err.message || "批量删除失败"),
  });

  const selectionIdsMut = useMutation({
    mutationFn: async () => api<{ user_ids: number[]; total: number }>(
      "/api/admin/users/selection-ids",
      {
        params: {
          search: query || undefined,
          tags: tagFilters.length > 0 ? serializeTags(tagFilters) : undefined,
          tags_mode: tagFilterMode,
          role: roleFilter === "all" ? undefined : roleFilter,
        },
      },
    ),
    onSuccess: (result) => setFilterSelectionIds(result.user_ids),
    onError: (err: Error) => toast.error(err.message || "加载可选用户失败"),
  });

  const [pageSize, setPageSize] = React.useState(20);
  const [page, setPage] = useUrlPage();
  const { data, isLoading, isError, error, dataUpdatedAt, isFetching } = useQuery({
    queryKey: ["admin", "users", page, pageSize, query, tagFilters, tagFilterMode, roleFilter, loginSort],
    queryFn: () => api<AdminUsersResponse>("/api/admin/users", {
      params: {
        page,
        page_size: pageSize,
        search: query || undefined,
        tags: tagFilters.length > 0 ? serializeTags(tagFilters) : undefined,
        tags_mode: tagFilterMode,
        role: roleFilter === "all" ? undefined : roleFilter,
        login_sort: loginSort,
      },
    }),
    placeholderData: (previous) => previous,
  });
  const users = data?.users ?? [];
  const availableTags = data?.available_tags ?? [];
  const total = data?.total ?? 0;
  const stats = data?.stats ?? { total_users: total, active_week: 0, active_today: 0 };
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const hasActiveFilters = queryInput.trim() !== "" || query.trim() !== "" || tagFilters.length > 0 || roleFilter !== "all";
  const filtersKey = React.useMemo(
    () => JSON.stringify([query, tagFilters, tagFilterMode, roleFilter]),
    [query, tagFilters, tagFilterMode, roleFilter],
  );
  const previousFiltersKey = React.useRef(filtersKey);
  const handlePageSizeChange = React.useCallback((nextPageSize: number) => {
    if (!USER_PAGE_SIZE_OPTIONS.includes(nextPageSize as (typeof USER_PAGE_SIZE_OPTIONS)[number])) return;
    setPageSize(nextPageSize);
    setPage(1);
    setSelected(new Set());
  }, [setPage]);
  const handleUserSaved = React.useCallback((savedUser: AdminUser) => {
    qc.invalidateQueries({ queryKey: ["admin", "users"] });
    qc.invalidateQueries({ queryKey: ["users", "options"] });
    if (currentUser?.id === savedUser.id) {
      setUser({ ...currentUser, ...savedUser });
    }
  }, [currentUser, qc, setUser]);
  React.useEffect(() => {
    if (data && page > totalPages) setPage(totalPages);
  }, [data, page, pageSize, totalPages, setPage]);
  React.useEffect(() => {
    // useUrlPage 的 setter 可能随 URL searchParams 更新而改变引用。
    // 仅在筛选条件的实际值发生变化时回到第一页，避免翻页后该 effect
    // 因 setter 引用变化再次执行并把刚设置的页码重置为 1。
    if (previousFiltersKey.current === filtersKey) return;
    previousFiltersKey.current = filtersKey;
    setPage(1);
    setSelected(new Set());
    setFilterSelectionIds(null);
  }, [filtersKey, setPage]);
  React.useEffect(() => {
    setSelected((previous) => {
      const next = new Set(previous);
      users.forEach((user) => {
        if (!canDeleteUser(user)) next.delete(user.id);
      });
      if (next.size === previous.size && Array.from(next).every((id) => previous.has(id))) return previous;
      return next;
    });
  }, [users, canDeleteUser]);
  React.useEffect(() => {
    setFilterSelectionIds(null);
  }, [dataUpdatedAt]);
  const pageItemIds = React.useMemo(
    () => users.filter(canDeleteUser).map((u) => u.id),
    [users, canDeleteUser],
  );
  const allSelected = pageItemIds.length > 0 && pageItemIds.every((id) => selected.has(id));
  const someSelected = pageItemIds.some((id) => selected.has(id)) && !allSelected;
  const setPageSelection = (checked: boolean, ids: number[]) => {
    setSelected((current) => {
      const next = new Set(current);
      ids.forEach((id) => (checked ? next.add(id) : next.delete(id)));
      return next;
    });
  };

  return (
    <div className="page-shell">
      <PageHeader
        title="用户管理"
        description="管理系统用户、角色与用户标签，支持搜索、筛选和批量管理。"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              disabled={importFeishuMut.isPending}
              onClick={() => importFeishuMut.mutate()}
            >
              {importFeishuMut.isPending
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <CloudDownload className="h-3.5 w-3.5" />}
              {importFeishuMut.isPending ? "正在同步…" : "从飞书同步通讯录"}
            </Button>
            <Button size="sm" className="h-9 gap-1.5" onClick={() => setCreateOpen(true)}>
              <UserPlus className="h-3.5 w-3.5" />新增用户
            </Button>
          </>
        }
      />

      <PageMetrics
        ariaLabel="用户统计"
        items={[
          { label: "用户", value: stats.total_users, icon: User },
          { label: "本周活跃", value: stats.active_week, icon: CalendarDays, tone: "success" },
          { label: "今日活跃", value: stats.active_today, icon: UserCheck, tone: "success" },
        ]}
      />

      {/* 筛选行 */}
      <div className="page-toolbar">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="搜索姓名、用户名或标签"
            className={cn(
              "h-8 w-full rounded-md border bg-background pl-8 pr-3 text-sm shadow-sm outline-none transition sm:w-72",
              "placeholder:text-muted-foreground",
              "focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              queryInput.trim() !== "" && "border-primary/40 bg-primary/5",
            )}
          />
        </div>
        <FilterChip
          label="角色"
          options={[
            { value: "all", label: "全部" },
            ...USER_ROLE_OPTIONS,
          ]}
          value={roleFilter}
          baseValue="all"
          onChange={(value) => setRoleFilter(value as UserRole | "all")}
        />
        <TagFilterChip
          label="标签"
          emptyText="暂无用户标签"
          tags={availableTags}
          selected={tagFilters}
          mode={tagFilterMode}
          onToggle={(tag) => {
            userTagFiltersTouched.current = true;
            setTagFilters((previous) =>
              previous.includes(tag) ? previous.filter((item) => item !== tag) : [...previous, tag],
            );
          }}
          onClear={() => {
            userTagFiltersTouched.current = true;
            setTagFilters([]);
          }}
          onChangeMode={setTagFilterMode}
        />
        <LoginSortChip
          value={loginSort}
          onChange={(value) => {
            setLoginSort(value);
            setPage(1);
          }}
        />
        {(tagFilters.length > 0 || roleFilter !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs text-muted-foreground"
            onClick={() => {
              userTagFiltersTouched.current = true;
              setTagFilters([]);
              setRoleFilter("all");
            }}
          >
            <X className="mr-1 h-3.5 w-3.5" />
            清除筛选
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <span className="text-xs text-muted-foreground">
              已选 <span className="font-medium text-primary">{selected.size}</span> 项
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            disabled={selected.size === 0}
            onClick={() => setBulkTagsOpen(true)}
          >
            <Tag className="h-3.5 w-3.5" />
            批量设置标签
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            disabled={selected.size === 0 || bulkDelMut.isPending}
            onClick={() => {
              setBulkDeleteOpen(true);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            批量删除
          </Button>
        </div>
      </div>

      {/* 内容区 */}
      <div className={cn("min-h-0 flex-1 overflow-auto transition-opacity", isFetching && "opacity-70")} aria-busy={isFetching}>
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
          </div>
        ) : isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            加载失败：{(error as Error)?.message || "未知错误"}
          </div>
        ) : users.length === 0 ? (
          <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">
            {hasActiveFilters ? "没有匹配的用户" : "暂无用户"}
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border bg-card">
            <Table className="min-w-[1120px]">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-12">
                    <div className="flex items-center gap-0.5">
                      <Checkbox
                        checked={allSelected ? true : someSelected ? "indeterminate" : false}
                        aria-label="选择当前页用户"
                        onCheckedChange={(checked) => setPageSelection(Boolean(checked), pageItemIds)}
                      />
                      <DropdownMenu
                        onOpenChange={(open) => {
                          if (open && filterSelectionIds === null && !selectionIdsMut.isPending) {
                            selectionIdsMut.mutate();
                          }
                        }}
                      >
                        <DropdownMenuTrigger asChild>
                          <button type="button" className="rounded p-0.5 hover:bg-accent" aria-label="选择更多用户">
                            <ChevronDown className="h-3 w-3 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-44">
                          <DropdownMenuItem
                            disabled={pageItemIds.length === 0}
                            onClick={() => setSelected(new Set(pageItemIds))}
                          >
                            <Check className="mr-2 h-3.5 w-3.5" />全选本页
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={selectionIdsMut.isPending || filterSelectionIds === null || filterSelectionIds.length === 0}
                            onClick={() => setSelected(new Set(filterSelectionIds ?? []))}
                          >
                            {selectionIdsMut.isPending
                              ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                              : <Check className="mr-2 h-3.5 w-3.5" />}
                            {selectionIdsMut.isPending
                              ? "加载筛选结果…"
                              : "选择筛选结果" + (filterSelectionIds === null ? "" : " (" + filterSelectionIds.length + ")")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setSelected(new Set())}>
                            <X className="mr-2 h-3.5 w-3.5" />取消选择
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableHead>
                  <TableHead>姓名</TableHead>
                  <TableHead>用户名</TableHead>
                  <TableHead className="w-28">角色</TableHead>
                  <TableHead>用户标签</TableHead>
                  <TableHead className="w-40">创建时间</TableHead>
                  <TableHead className="w-40">最后登录时间</TableHead>
                  <TableHead className="w-36 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => {
                  const canManageTarget = canManageUser(u);
                  const canDeleteTarget = canDeleteUser(u);
                  return (
                  <TableRow key={u.id}>
                    <TableCell className="py-3">
                      <Checkbox
                        checked={selected.has(u.id)}
                        aria-label={`选择用户 ${u.username}`}
                        onCheckedChange={() => toggleOne(u.id)}
                        disabled={!canDeleteTarget}
                      />
                    </TableCell>
                    <TableCell>
                      <span className="flex min-w-0 items-center gap-2">
                        <UserAvatar name={u.name} username={u.username} url={u.avatar_url} size="sm" />
                        <TableText text={u.name || "-"} />
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <TableText text={u.username} />
                        {u.must_change_pwd && (
                          <Badge variant="outline" className="shrink-0 whitespace-nowrap border-amber-400 text-amber-600 text-[10px] px-1 py-0">
                            需改密
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className="whitespace-nowrap"
                        variant={
                          u.role === "system_admin"
                            ? "default"
                            : u.role === "admin"
                              ? "default"
                              : "secondary"
                        }
                      >
                        {USER_ROLE_LABEL[u.role] || u.role}
                      </Badge>
                    </TableCell>
                    <TableCell><TableTags tags={parseTags(u.tags)} /></TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground" title={u.created_at}>
                      <TableText text={formatUserDateTime(u.created_at)} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground" title={u.last_login_at || "从未登录"}>
                      <TableText text={formatUserDateTime(u.last_login_at, "从未登录")} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={"编辑用户 " + u.username}
                          disabled={!canManageTarget}
                          title={!canManageTarget ? "系统管理员账号仅可由系统管理员管理" : "编辑用户"}
                          onClick={() => setEditing(u)}
                        >
                          <Pencil className="mr-1 h-3.5 w-3.5" />编辑
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              aria-label={"更多用户操作 " + u.username}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem
                              disabled={resettingPassword || currentUser?.id === u.id || !canManageTarget}
                              onClick={() => requestPasswordReset(u)}
                            >
                              <KeyRound className="mr-2 h-3.5 w-3.5" />重置密码
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!canDeleteTarget || delMut.isPending}
                              onClick={() => setTransferUser(u)}
                            >
                              <ArrowRightLeft className="mr-2 h-3.5 w-3.5" />转移并删除
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              disabled={!canDeleteTarget || delMut.isPending}
                              onClick={() => setDeleteTarget(u)}
                            >
                              <Trash2 className="mr-2 h-3.5 w-3.5" />删除用户
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* 分页条 */}
      {!isLoading && !isError && total > 0 && (
        <UserPagination
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={pageSize}
          isFetching={isFetching}
          onPageChange={setPage}
          onPageSizeChange={handlePageSizeChange}
        />
      )}

      <UserFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        user={null}
        canManageSystemAdmin={currentUser?.role === "system_admin"}
        onSuccess={handleUserSaved}
      />
      <BulkUserTagsDialog
        open={bulkTagsOpen}
        onOpenChange={setBulkTagsOpen}
        userIds={Array.from(selected)}
      />
      <Dialog open={!!resetPassword} onOpenChange={(open) => { if (!open) { setResetPassword(""); setResetUser(null); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>临时密码已重置</DialogTitle>
            <DialogDescription>
              {resetUser?.username} 的旧会话已失效。此密码 24 小时内有效且只展示一次。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all rounded-md border bg-muted/30 px-3 py-2.5 font-mono text-sm font-semibold">
              {resetPassword}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyText(resetPassword)}
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              复制
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => { setResetPassword(""); setResetUser(null); }}>完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={resetConfirmUser !== null}
        onOpenChange={(open) => { if (!open && !resettingPassword) setResetConfirmUser(null); }}
        title="重置用户密码"
        description={resetConfirmUser ? `确定为 ${resetConfirmUser.username} 生成新的临时密码吗？该用户现有登录会话会立即失效。` : ""}
        confirmLabel="生成临时密码"
        destructive
        loading={resettingPassword}
        onConfirm={() => void confirmPasswordReset()}
      />
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title="批量删除用户"
        description={`确定删除选中的 ${selected.size} 个用户吗？删除后无法恢复，相关权限和会话也会失效。`}
        confirmLabel="删除用户"
        destructive
        loading={bulkDelMut.isPending}
        onConfirm={() => {
          bulkDelMut.mutate(Array.from(selected), { onSuccess: () => setBulkDeleteOpen(false) });
        }}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="删除用户"
        description={deleteTarget ? `确定删除用户「${deleteTarget.username}」吗？删除后无法恢复。` : ""}
        confirmLabel="删除用户"
        destructive
        loading={delMut.isPending}
        onConfirm={() => {
          const target = deleteTarget;
          if (target) delMut.mutate(target.id, { onSuccess: () => setDeleteTarget(null) });
        }}
      />
      <UserFormDialog
        open={editing != null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        user={editing}
        canManageSystemAdmin={currentUser?.role === "system_admin"}
        onSuccess={handleUserSaved}
      />
      <TransferDeleteDialog
        open={transferUser != null}
        onOpenChange={(o) => {
          if (!o) setTransferUser(null);
        }}
        sourceUser={transferUser}
        onSuccess={() => {
          qc.invalidateQueries({ queryKey: ["admin", "users"] });
          qc.invalidateQueries({ queryKey: ["users", "options"] });
        }}
      />
    </div>
  );
}

function BulkUserTagsDialog({
  open,
  onOpenChange,
  userIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userIds: number[];
}) {
  const qc = useQueryClient();
  const [mode, setMode] = React.useState<"add" | "remove" | "replace">("add");
  const [tags, setTags] = React.useState<string[]>([]);
  const [clearConfirmOpen, setClearConfirmOpen] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setMode("add");
      setTags([]);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => api<{ matched: number; updated: number }>("/api/admin/users/bulk-tags", {
      method: "POST",
      json: { user_ids: userIds, tags: serializeTags(tags), mode },
    }),
    onSuccess: (result) => {
      toast.success(result.updated > 0
        ? "已更新 " + result.updated + " 个用户的标签"
        : "所选用户的标签无需变更");
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["users", "options"] });
      qc.invalidateQueries({ queryKey: ["admin", "user-tags"] });
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || "批量设置标签失败"),
  });

  const submit = () => {
    if (userIds.length === 0) return;
    if (mode !== "replace" && tags.length === 0) {
      toast.error("请至少选择一个用户标签");
      return;
    }
    if (
      mode === "replace"
      && tags.length === 0
    ) {
      setClearConfirmOpen(true);
      return;
    }
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>批量设置用户标签</DialogTitle>
          <DialogDescription>
            将对已选的 {userIds.length} 个用户生效。标签定义在“标签管理 → 用户标签”维护，这里负责批量分配。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="grid gap-1.5">
            <Label htmlFor="bulk-user-tag-mode">设置方式</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as "add" | "remove" | "replace")}>
              <SelectTrigger id="bulk-user-tag-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="add">追加标签（保留已有标签）</SelectItem>
                <SelectItem value="remove">移除标签</SelectItem>
                <SelectItem value="replace">替换全部标签</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>用户标签</Label>
            <TagInput
              domain="user"
              value={tags}
              onChange={setTags}
              placeholder={mode === "remove" ? "选择要移除的标签" : "搜索或选择用户标签"}
              disabled={mutation.isPending}
            />
            <p className="text-xs leading-5 text-muted-foreground">
              {mode === "add" && "仅追加所选标签，不会删除用户现有标签。"}
              {mode === "remove" && "仅移除所选标签，其他标签保持不变。"}
              {mode === "replace" && "用户现有标签将被所选标签完全替换；不选标签则清空。"}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>取消</Button>
          <Button onClick={submit} disabled={mutation.isPending || userIds.length === 0}>
            {mutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            应用到 {userIds.length} 个用户
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={clearConfirmOpen}
        onOpenChange={setClearConfirmOpen}
        title="清空用户标签"
        description={`确定清空所选 ${userIds.length} 个用户的全部标签吗？此操作会立即影响按标签控制的访问权限。`}
        confirmLabel="清空标签"
        destructive
        loading={mutation.isPending}
        onConfirm={() => {
          mutation.mutate(undefined, { onSuccess: () => setClearConfirmOpen(false) });
        }}
      />
    </Dialog>
  );
}

function TransferDeleteDialog({
  open,
  onOpenChange,
  sourceUser,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sourceUser: AdminUser | null;
  onSuccess: () => void;
}) {
  const [targetId, setTargetId] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setTargetId(null);
      setLoading(false);
    }
  }, [open]);

  const submit = async () => {
    if (!targetId) {
      toast.error("请选择接收数据的用户");
      return;
    }
    setLoading(true);
    try {
      await api(`/api/admin/users/${sourceUser!.id}/transfer-and-delete`, {
        method: "POST",
        json: { target_user_id: targetId },
      });
      toast.success(`已将 ${sourceUser!.username} 的数据转移并删除用户`);
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || "操作失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
              <ArrowRightLeft className="h-4 w-4" />
            </span>
            转移数据并删除用户
          </DialogTitle>
          <DialogDescription>
            将该用户的关联数据转移给另一位用户后删除账号。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-amber-300/60 bg-amber-50 p-4 dark:border-amber-800/50 dark:bg-amber-950/30">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200/70 text-amber-700 dark:bg-amber-800/50 dark:text-amber-300">
              <X className="h-3 w-3" />
            </span>
            <p className="text-sm leading-relaxed text-amber-800 dark:text-amber-300">
              用户 <strong>{sourceUser?.name || sourceUser?.username}</strong> 的所有关联数据（资源、放映、模板、任务等）将转移给接收者，然后删除该账号。下载记录将保留但不再关联。
            </p>
          </div>
          <div className="rounded-lg border bg-muted/20 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <User className="h-4 w-4 text-muted-foreground" />
              接收数据的用户
            </div>
            <UserSearchSelect
              value={targetId}
              onChange={setTargetId}
              excludeIds={sourceUser ? [sourceUser.id] : []}
              placeholder="搜索并选择接收用户"
              disabled={loading}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            取消
          </Button>
          <Button variant="destructive" onClick={submit} disabled={loading || !targetId}>
            {loading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            确认转移并删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserFormDialog({
  open,
  onOpenChange,
  user,
  canManageSystemAdmin,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  user: AdminUser | null;
  canManageSystemAdmin: boolean;
  onSuccess: (user: AdminUser) => void;
}) {
  const editing = !!user;
  const roleOptions = USER_ROLE_OPTIONS.filter((option) => canManageSystemAdmin || option.value !== "system_admin");
  const [name, setName] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [feishu, setFeishu] = React.useState("");
  const [avatarUrl, setAvatarUrl] = React.useState("");
  const [avatarFile, setAvatarFile] = React.useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = React.useState("");
  const [removeAvatar, setRemoveAvatar] = React.useState(false);
  const [tags, setTags] = React.useState<string[]>([]);
  const [role, setRole] = React.useState<UserRole>("user");
  const [loading, setLoading] = React.useState(false);
  const [generatedPwd, setGeneratedPwd] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setName(user?.name || "");
      setUsername(user?.username || "");
      setPassword("");
      setFeishu(user?.feishu_id || "");
      setAvatarUrl(user?.avatar_url || "");
      setAvatarFile(null);
      setAvatarPreview("");
      setRemoveAvatar(false);
      setTags(parseTags(user?.tags));
      setRole((user?.role as UserRole) || "user");
      setLoading(false);
      setGeneratedPwd("");
    }
  }, [open, user]);

  React.useEffect(() => {
    if (!avatarFile) {
      setAvatarPreview("");
      return;
    }
    const objectUrl = URL.createObjectURL(avatarFile);
    setAvatarPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [avatarFile]);

  const chooseAvatar = (file: File | null) => {
    if (!file) return;
    const suffix = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type)
      && ![".png", ".jpg", ".jpeg", ".webp"].includes(suffix)
    ) {
      toast.error("头像仅支持 PNG、JPG 或 WebP 图片");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("头像文件不能超过 2 MB");
      return;
    }
    setAvatarFile(file);
    setRemoveAvatar(false);
  };

  const submit = async () => {
    if (!name.trim() || !username.trim()) {
      toast.error("姓名和用户名必填");
      return;
    }
    setLoading(true);
    try {
      const res = await api<{ user: AdminUser; plain_password?: string }>(
        editing ? `/api/admin/users/${user!.id}` : "/api/admin/users",
        {
          method: editing ? "PUT" : "POST",
          json: {
            name: name.trim(),
            username: username.trim(),
            password: editing ? null : password || null,
            feishu_id: feishu.trim(),
            avatar_url: editing ? avatarUrl.trim() : "",
            tags: serializeTags(tags),
            role,
            need_change_pwd: true,
          },
        },
      );

      let savedUser = res.user;
      let avatarError: Error | null = null;
      try {
        if (avatarFile) {
          const body = new FormData();
          body.set("avatar", avatarFile);
          const avatarResult = await api<{ user: AdminUser }>(
            `/api/admin/users/${res.user.id}/avatar`,
            { method: "POST", body },
          );
          savedUser = avatarResult.user;
        } else if (editing && removeAvatar && avatarUrl) {
          const avatarResult = await api<{ user: AdminUser }>(
            `/api/admin/users/${res.user.id}/avatar`,
            { method: "DELETE" },
          );
          savedUser = avatarResult.user;
        }
      } catch (error) {
        avatarError = error as Error;
      }

      setAvatarUrl(savedUser.avatar_url || "");
      setAvatarFile(null);
      setRemoveAvatar(false);

      if (!editing && res.plain_password) {
        // 未手工指定密码时，后端生成只展示一次的临时密码。
        setGeneratedPwd(res.plain_password);
      } else {
        toast.success(editing ? "用户资料已保存" : "用户已创建");
      }
      if (avatarError) {
        toast.error(`用户资料已保存，但头像处理失败：${avatarError.message || "未知错误"}`);
      }
      onSuccess(savedUser);
      if (!res.plain_password) {
        onOpenChange(false);
      }
    } catch (err) {
      toast.error((err as Error).message || "保存失败");
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => { void copyText(text); };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setGeneratedPwd("");
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[92vh] max-w-2xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <div className="flex items-center gap-3">
            <UserAvatar name={name} username={username} url={avatarPreview || (removeAvatar ? "" : avatarUrl)} size="lg" />
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2">
                {editing ? "编辑用户" : "新增用户"}
              </DialogTitle>
              <DialogDescription className="mt-1">
                {editing ? `${user?.name || user?.username} · 修改账号资料与标签` : "创建账号并设置角色与用户标签"}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {generatedPwd ? (
          /* 随机密码展示视图 */
          <div className="space-y-4 px-6 py-5">
            <div className="rounded-lg border border-emerald-300/60 bg-emerald-50 p-5 dark:border-emerald-800/50 dark:bg-emerald-950/30">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-emerald-800 dark:text-emerald-300">
                <KeyRound className="h-4 w-4" />
                临时密码已生成
              </div>
              <p className="mb-3 text-xs leading-relaxed text-emerald-700 dark:text-emerald-400">
                请妥善保存以下密码并告知用户，用户首次登录时将被强制要求修改。
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md border border-emerald-200 bg-white px-3 py-2.5 text-sm font-mono font-semibold tracking-wide select-all dark:border-emerald-800 dark:bg-gray-900">
                  {generatedPwd}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => copyToClipboard(generatedPwd)}
                >
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  复制
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  setGeneratedPwd("");
                  onOpenChange(false);
                }}
              >
                完成
              </Button>
            </DialogFooter>
          </div>
        ) : (
          /* 表单视图 */
          <>
            <div className="max-h-[calc(92vh-145px)] overflow-y-auto px-6 py-5">
              <div className="grid gap-6">
                <section className="space-y-3">
                  <div className="flex items-center gap-2 border-b pb-2 text-sm font-semibold">
                    <User className="h-4 w-4 text-muted-foreground" />
                    账号信息
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="user-name">姓名 <span className="text-destructive">*</span></Label>
                      <Input id="user-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：张三" />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="user-username">用户名 <span className="text-destructive">*</span></Label>
                      <Input id="user-username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="用于登录" />
                    </div>
                  </div>
                </section>

                {!editing && <section className="space-y-3">
                  <div className="flex items-center gap-2 border-b pb-2 text-sm font-semibold">
                    <KeyRound className="h-4 w-4 text-muted-foreground" />
                    初始密码
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="user-password">临时密码 <span className="text-xs font-normal text-muted-foreground">（留空自动生成）</span></Label>
                    <Input id="user-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="可手工指定临时密码" />
                    <p className="text-xs leading-5 text-muted-foreground">临时密码 24 小时内有效，首次登录必须修改。</p>
                  </div>
                </section>}

                <section className="space-y-3">
                  <div className="flex items-center gap-2 border-b pb-2 text-sm font-semibold">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    角色与联系方式
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="user-role">角色</Label>
                      <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
                        <SelectTrigger id="user-role"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {roleOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="user-feishu">飞书 ID <span className="text-xs font-normal text-muted-foreground">（可选）</span></Label>
                      <Input id="user-feishu" value={feishu} onChange={(e) => setFeishu(e.target.value)} placeholder="关联飞书账号" />
                    </div>
                  </div>
                </section>

                <section className="space-y-3">
                  <div className="flex items-center gap-2 border-b pb-2 text-sm font-semibold">
                    <Tag className="h-4 w-4 text-muted-foreground" />
                    用户标签
                  </div>
                  <TagInput domain="user" value={tags} onChange={setTags} placeholder="搜索或选择用户标签" />
                  <p className="text-xs leading-5 text-muted-foreground">用户标签用于人员分类和用户列表筛选；请在“标签管理 → 用户标签”中维护。</p>
                </section>

                <section className="space-y-3">
                  <div className="flex items-center gap-2 border-b pb-2 text-sm font-semibold">
                    <Camera className="h-4 w-4 text-muted-foreground" />
                    头像
                  </div>
                  <div className="flex flex-col gap-4 rounded-lg border bg-muted/20 p-4 sm:flex-row sm:items-center">
                    <UserAvatar name={name} username={username} url={avatarPreview || (removeAvatar ? "" : avatarUrl)} size="lg" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="text-sm font-medium">上传头像图片</div>
                      <p className="text-xs leading-5 text-muted-foreground">
                        支持 PNG、JPG、WebP，文件不超过 2 MB；系统会自动缩放并转换为 PNG。
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="outline" size="sm" asChild disabled={loading}>
                          <label htmlFor={`user-avatar-${user?.id || "new"}`} className="cursor-pointer">
                            <Upload className="mr-1.5 h-3.5 w-3.5" />
                            {avatarFile ? "重新选择" : "选择图片"}
                          </label>
                        </Button>
                        {(avatarFile || (!removeAvatar && avatarUrl)) && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={loading}
                            onClick={() => {
                              setAvatarFile(null);
                              setRemoveAvatar(Boolean(avatarUrl));
                            }}
                          >
                            移除头像
                          </Button>
                        )}
                      </div>
                      <input
                        id={`user-avatar-${user?.id || "new"}`}
                        type="file"
                        className="sr-only"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(event) => {
                          chooseAvatar(event.target.files?.[0] ?? null);
                          event.currentTarget.value = "";
                        }}
                      />
                    </div>
                  </div>
                  {avatarFile && <p className="text-xs text-muted-foreground">已选择：{avatarFile.name}</p>}
                  {removeAvatar && <p className="text-xs text-amber-600">保存后将移除当前头像。</p>}
                </section>
              </div>
            </div>
            <DialogFooter className="border-t bg-muted/15 px-6 py-4">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                取消
              </Button>
              <Button onClick={submit} disabled={loading}>
                {loading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {editing ? "保存修改" : "创建用户"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UserAvatar({
  name,
  username,
  url,
  size = "sm",
}: {
  name?: string | null;
  username: string;
  url?: string | null;
  size?: "sm" | "lg";
}) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [url]);
  const label = (name || username || "用户").trim();
  const dimensions = size === "lg" ? "h-16 w-16 text-xl" : "h-7 w-7 text-xs";

  if (url && !failed) {
    return (
      <img
        src={url}
        alt={`${label}头像`}
        className={cn("shrink-0 rounded-full object-cover ring-1 ring-border", dimensions)}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary ring-1 ring-primary/10", dimensions)}>
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}
