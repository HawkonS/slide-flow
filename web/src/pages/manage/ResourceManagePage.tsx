import * as React from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ImageOff,
  ListChecks,
  Loader2,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FilterGroupChip, SubjectFilterChip, TagFilterChip, type ChipOption, type FilterGroup } from "@/components/resource/filter-chips";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  DEFAULT_RESOURCE_SUBJECT,
  RESOURCE_SECRECY_LABEL,
  RESOURCE_SECRECY_OPTIONS,
  RESOURCE_STATUS_LABEL,
  RESOURCE_STATUS_OPTIONS,
  SECRECY_BADGE_TONE,
} from "@/lib/constants";
import { parseTags, Resource, serializeTags } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useManageResourceFilters, markManageResourceFiltersUrlRestored } from "@/stores/manage-resource-filters";
import { BatchEditDialog } from "@/components/manage/BatchEditDialog";
import { usePaginatedQuery } from "@/lib/use-paginated-query";
import { useEncodedUrlState } from "@/lib/use-encoded-url-state";
import { PageHeader } from "@/components/common/PageHeader";

/* ---------- types ---------- */

interface Option {
  value: string;
  label: string;
}

/* ---- URL 持久化状态类型与默认值 ---- */
interface ManageUrlState {
  q: string;
  sub: string;
  sec: string;
  sta: string;
  own: string;
  rc: string;
  rp: string;
  tags: string[];
  tm: string;
  p: number;
}

const URL_DEFAULTS: ManageUrlState = {
  q: "", sub: "all", sec: "all", sta: "all", own: "all",
  rc: "all", rp: "all", tags: [], tm: "all", p: 1,
};

/* ---------- Main component ---------- */

export default function ResourceManagePage() {
  const { user } = useAuth();
  const filters = useManageResourceFilters();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  /* ---- Pagination ---- */
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = React.useState(20);
  React.useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const compute = () => {
      const H = el.clientHeight;
      if (!H) return;
      const headerH = 45;
      const rowH = 56;
      const rows = Math.max(5, Math.floor((H - headerH) / rowH));
      setPageSize((prev) => (prev === rows ? prev : rows));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 筛选 + 页码统一编码到 URL ?s=…
  const [urlState, setUrlState] = useEncodedUrlState({ defaults: URL_DEFAULTS });

  // URL → zustand store（仅首次挂载时同步）
  const initialized = React.useRef(false);
  if (!initialized.current) {
    initialized.current = true;
    const s = urlState;
    filters.setQuery(s.q);
    filters.setSubject(s.sub);
    filters.setSecrecy(s.sec as "all" | "public" | "confidential" | "secret");
    filters.setStatus(s.sta as "all" | "active" | "disabled");
    filters.setOwnership(s.own as "all" | "created" | "managed");
    filters.setRemarkCommon(s.rc as "all" | "has" | "none");
    filters.setRemarkPersonal(s.rp as "all" | "has" | "none");
    filters.setTags(s.tags);
    filters.setTagsMode(s.tm as "any" | "all");
    if (new URLSearchParams(window.location.search).has("s")) {
      markManageResourceFiltersUrlRestored();
    }
  }

  // zustand → URL（筛选变化时重置页码）
  const prevFiltersKey = React.useRef("");
  React.useEffect(() => {
    const key = JSON.stringify({
      q: filters.query, sub: filters.subject, sec: filters.secrecy,
      sta: filters.status, own: filters.ownership,
      rc: filters.remarkCommon, rp: filters.remarkPersonal,
      tags: filters.tags, tm: filters.tagsMode,
    });
    if (key === prevFiltersKey.current) return;
    const filtersChanged = prevFiltersKey.current !== "";
    prevFiltersKey.current = key;
    setUrlState((prev) => ({
      q: filters.query, sub: filters.subject, sec: filters.secrecy,
      sta: filters.status, own: filters.ownership,
      rc: filters.remarkCommon, rp: filters.remarkPersonal,
      tags: filters.tags, tm: filters.tagsMode,
      p: filtersChanged ? 1 : prev.p,
    }));
  }, [
    filters.query, filters.subject, filters.secrecy, filters.status,
    filters.ownership, filters.remarkCommon, filters.remarkPersonal,
    filters.tags, filters.tagsMode, setUrlState,
  ]);

  const page = urlState.p;
  const setPage = React.useCallback(
    (action: React.SetStateAction<number>) => {
      setUrlState((prev) => ({
        ...prev,
        p: typeof action === "function" ? action(prev.p) : action,
      }));
    },
    [setUrlState],
  );

  /* ---- Build API params ---- */
  const apiParams = React.useMemo(
    () => ({
      manageable_only: true,
      search: filters.query.trim() || undefined,
      subject: filters.subject !== "all" ? filters.subject : undefined,
      status: filters.status !== "all" ? filters.status : undefined,
      secrecy: filters.secrecy !== "all" ? filters.secrecy : undefined,
      permission: filters.ownership !== "all" ? filters.ownership : undefined,
      tags: filters.tags.length > 0 ? serializeTags(filters.tags) : undefined,
      tags_mode: filters.tagsMode,
    }),
    [filters],
  );

  const {
    items: resources,
    total,
    totalPages,
    allTags: tags,
    allSubjects: subjects,
    isLoading,
    isError,
    error,
  } = usePaginatedQuery<Resource>({
    url: "/api/resources",
    queryKeyPrefix: "manage-resources",
    params: apiParams,
    page,
    pageSize,
  });

  // 页码越界检查
  React.useEffect(() => {
    if (totalPages > 0 && page > totalPages) setPage(1);
  }, [page, totalPages, setPage]);

  const subjectOptions = React.useMemo<Option[]>(() => {
    const set = new Set<string>([DEFAULT_RESOURCE_SUBJECT, ...subjects.filter(Boolean)]);
    const sorted = Array.from(set).sort((a, b) => {
      if (a === DEFAULT_RESOURCE_SUBJECT) return -1;
      if (b === DEFAULT_RESOURCE_SUBJECT) return 1;
      return a.localeCompare(b, "zh-Hans-CN");
    });
    return [{ value: "all", label: "全部" }, ...sorted.map((x) => ({ value: x, label: x }))];
  }, [subjects]);

  const filterDirtyCount = [
    filters.status !== "all",
    filters.secrecy !== "all",
    filters.ownership !== "all",
  ].filter(Boolean).length;

  const isDirty =
    filters.query.trim() !== "" ||
    filterDirtyCount > 0 ||
    filters.subject !== "all" ||
    filters.tags.length > 0;

  /* ---- Ownership options ---- */
  const OWNERSHIP_OPTIONS: readonly Option[] = React.useMemo(
    () => [
      { value: "all", label: "全部" },
      { value: "created", label: "我创建的" },
      { value: "managed", label: "我管理的" },
    ],
    [],
  );

  const filterGroups = React.useMemo<FilterGroup[]>(
    () => [
      {
        key: "status",
        label: "状态",
        options: RESOURCE_STATUS_OPTIONS,
        value: filters.status,
        onChange: (v) => filters.setStatus(v as typeof filters.status),
      },
      {
        key: "secrecy",
        label: "密级",
        options: RESOURCE_SECRECY_OPTIONS,
        value: filters.secrecy,
        onChange: (v) => filters.setSecrecy(v as typeof filters.secrecy),
      },
      {
        key: "ownership",
        label: "权限",
        options: OWNERSHIP_OPTIONS,
        value: filters.ownership,
        onChange: (v) => filters.setOwnership(v as typeof filters.ownership),
      },
    ],
    [filters.status, filters.secrecy, filters.ownership, OWNERSHIP_OPTIONS, filters],
  );

  /* ---- Selection ---- */
  const [selectedIds, setSelectedIds] = React.useState<Set<number>>(new Set());
  // 跨页选择缓存：保存浏览过的资源对象，用于 BatchEditDialog 摘要计算
  const resourceCacheRef = React.useRef<Map<number, Resource>>(new Map());
  React.useEffect(() => {
    resources.forEach((r) => {
      resourceCacheRef.current.set(r.id, r);
    });
  }, [resources]);
  const clearSelection = React.useCallback(() => {
    setSelectedIds(new Set());
    resourceCacheRef.current.clear();
  }, []);
  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        resources.forEach((r) => next.add(r.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        resources.forEach((r) => next.delete(r.id));
        return next;
      });
    }
  };

  /* ---- 全选所有（跨页，基于当前筛选条件） ---- */
  const handleSelectAll = async () => {
    try {
      const params = new URLSearchParams();
      params.set("manageable_only", "true");
      if (apiParams.search) params.set("search", apiParams.search);
      if (apiParams.subject) params.set("subject", apiParams.subject);
      if (apiParams.status) params.set("status", apiParams.status);
      if (apiParams.secrecy) params.set("secrecy", apiParams.secrecy);
      if (apiParams.permission) params.set("permission", apiParams.permission);
      if (apiParams.tags) params.set("tags", apiParams.tags);
      if (apiParams.tags_mode) params.set("tags_mode", apiParams.tags_mode);

      const data = await api<{ ids: number[] }>(
        `/api/resources/ids?${params.toString()}`,
      );
      setSelectedIds(new Set(data.ids));
      toast.success(`已选中全部 ${data.ids.length} 项资源`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "全选失败";
      toast.error(message);
    }
  };

  /* ---- Batch edit ---- */
  const [batchEditOpen, setBatchEditOpen] = React.useState(false);

  /* ---- Batch delete ---- */
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);
  const deleteMutation = useMutation({
    mutationFn: async (ids: number[]) =>
      api("/api/resources/batch", {
        method: "DELETE",
        json: { resource_ids: ids },
      }),
    onSuccess: () => {
      toast.success("批量删除成功");
      clearSelection();
      queryClient.invalidateQueries({ queryKey: ["manage-resources"] });
      setDeleteDialogOpen(false);
    },
    onError: (err: Error) => toast.error(err.message || "删除失败"),
  });

  const allPageSelected =
    resources.length > 0 && resources.every((r) => selectedIds.has(r.id));
  const somePageSelected =
    resources.some((r) => selectedIds.has(r.id)) && !allPageSelected;

  /* ---- Helper: format date ---- */
  function formatDate(d: string) {
    try {
      return new Date(d).toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      return d;
    }
  }

  const pageStart = (page - 1) * pageSize;

  return (
    <div className="page-shell">
      <PageHeader title="单页素材管理" count={total > 0 ? `共 ${total} 条` : "共 0 条"} />

      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 搜索 */}
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filters.query}
            onChange={(e) => filters.setQuery(e.target.value)}
            placeholder="搜索名称、主体、所有者、ID"
            className={cn(
              "h-8 w-full rounded-md border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition sm:w-56",
              "placeholder:text-muted-foreground",
              "focus:border-foreground/40 focus:ring-2 focus:ring-ring/20",
              filters.query.trim() !== "" && "border-foreground/25 bg-primary-weak",
            )}
          />
        </div>

        <FilterGroupChip
          groups={filterGroups}
          dirtyCount={filterDirtyCount}
          onReset={() => filters.reset()}
        />

        <SubjectFilterChip
          options={subjectOptions}
          value={filters.subject}
          onChange={(v) => filters.setSubject(v)}
        />

        <TagFilterChip
          label="标签"
          emptyText="暂无标签"
          tags={tags}
          selected={filters.tags}
          mode={filters.tagsMode}
          onToggle={(t) => filters.toggleTag(t)}
          onClear={() => filters.setTags([])}
          onChangeMode={(v) => filters.setTagsMode(v)}
        />

        {isDirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => filters.reset()}
              className="h-8 gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            重置
          </Button>
        )}

        {/* 批量操作按钮 */}
        <div className="ml-auto flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <span className="text-xs text-muted-foreground">
                已选 <span className="font-medium text-primary">{selectedIds.size}</span> 项
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={clearSelection}
              >
                清空
              </Button>
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            disabled={selectedIds.size === 0}
            onClick={() => setBatchEditOpen(true)}
          >
            <Pencil className="h-3.5 w-3.5" />
            批量编辑
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            disabled={selectedIds.size === 0}
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            批量删除
          </Button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="min-h-0 flex-1 flex flex-col gap-0">
        <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
          </div>
        ) : isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            加载失败：{error?.message || "未知错误"}
          </div>
        ) : resources.length === 0 ? (
          <div className="surface border-dashed py-16 text-center text-sm text-muted-foreground">
            没有匹配的资源
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <div className="flex items-center gap-0.5">
                      <Checkbox
                        checked={
                          allPageSelected
                            ? true
                            : somePageSelected
                              ? "indeterminate"
                              : false
                        }
                        onCheckedChange={(checked) => toggleSelectAll(!!checked)}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="ml-0.5 rounded p-0.5 hover:bg-accent"
                          >
                            <ChevronDown className="h-3 w-3 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-44">
                          <DropdownMenuItem onClick={() => toggleSelectAll(true)}>
                            <Check className="mr-2 h-3.5 w-3.5" />
                            全选本页
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={handleSelectAll}
                            disabled={total === 0}
                          >
                            <ListChecks className="mr-2 h-3.5 w-3.5" />
                            全选所有{total > 0 ? ` (${total})` : ""}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={clearSelection}>
                            <X className="mr-2 h-3.5 w-3.5" />
                            取消选择
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableHead>
                  <TableHead className="w-16">ID</TableHead>
                  <TableHead className="w-20">缩略图</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead className="w-28">主体</TableHead>
                  <TableHead className="w-52">标签</TableHead>
                  <TableHead className="w-20">密级</TableHead>
                  <TableHead className="w-16">状态</TableHead>
                  <TableHead className="w-24">所有者</TableHead>
                  <TableHead className="w-24">更新时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resources.map((r) => {
                  const preview =
                    r.current?.preview_url || r.current?.original_preview_url || null;
                  const rTags = parseTags(r.tags);
                  const isSelected = selectedIds.has(r.id);

                  return (
                    <TableRow
                      key={r.id}
                      data-state={isSelected ? "selected" : undefined}
                      className={cn(isSelected && "bg-[hsl(var(--selection))]")}
                    >
                      <TableCell>
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleSelect(r.id)}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {r.id}
                      </TableCell>
                      <TableCell>
                        <div
                          className={cn(
                            "flex h-9 w-16 items-center justify-center overflow-hidden rounded border bg-muted",
                            "cursor-pointer",
                          )}
                          onClick={() => navigate(`/resources/${r.id}`)}
                        >
                          {preview ? (
                            <img
                              src={preview}
                              alt={r.name}
                              loading="lazy"
                              decoding="async"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <ImageOff className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <button type="button" className="max-w-[200px] truncate text-left font-medium hover:text-foreground hover:underline" onClick={() => navigate(`/resources/${r.id}`)} title={r.name}>{r.name}</button>
                      </TableCell>
                      <TableCell className="max-w-[120px] truncate text-sm text-muted-foreground">
                        {r.subject || DEFAULT_RESOURCE_SUBJECT}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 overflow-hidden">
                          {rTags.length > 0 ? (
                            rTags.slice(0, 3).map((tag) => (
                              <span
                                key={tag}
                                className="inline-flex h-5 shrink-0 items-center rounded-md bg-secondary px-1.5 text-[11px] text-secondary-foreground"
                              >
                                {tag}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                          {rTags.length > 3 && (
                            <span className="inline-flex h-5 shrink-0 items-center text-[11px] text-muted-foreground">
                              +{rTags.length - 3}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={SECRECY_BADGE_TONE[r.secrecy_level] || "outline"}
                          className="text-[11px]"
                        >
                          {RESOURCE_SECRECY_LABEL[r.secrecy_level] || r.secrecy_level}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={r.status === "active" ? "secondary" : "outline"}
                          className="text-[11px]"
                        >
                          {RESOURCE_STATUS_LABEL[r.status] || r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.owner?.name || r.owner?.username || "-"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {formatDate(r.updated_at)}
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
        {!isLoading && !isError && resources.length > 0 && (
          <div className="flex shrink-0 items-center justify-between border-t pt-3 text-sm text-muted-foreground select-none">
            <span>
              显示 {pageStart + 1}-{Math.min(pageStart + pageSize, total)}，共{" "}
              {total} 条
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </Button>
              <span className="min-w-[52px] text-center text-foreground select-none">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                下一页
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* 批量编辑对话框 */}
      <BatchEditDialog
        open={batchEditOpen}
        onOpenChange={setBatchEditOpen}
        resourceIds={Array.from(selectedIds)}
        resources={Array.from(selectedIds)
          .map((id) => resourceCacheRef.current.get(id))
          .filter((r): r is Resource => r !== undefined)}
        onSuccess={() => {
          clearSelection();
          queryClient.invalidateQueries({ queryKey: ["manage-resources"] });
        }}
      />

      {/* 批量删除确认对话框 */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>确认批量删除</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确定要删除选中的 <span className="font-semibold text-foreground">{selectedIds.size}</span> 项资源吗？此操作不可撤销。
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleteMutation.isPending}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate(Array.from(selectedIds))}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              )}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
