import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ImageOff,
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
import { parseTags, Resource } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useManageResourceFilters } from "@/stores/manage-resource-filters";
import { BatchEditDialog } from "@/components/manage/BatchEditDialog";

/* ---------- types ---------- */

interface ResourceListResponse {
  resources: Resource[];
}

interface Option {
  value: string;
  label: string;
}

/* ---------- Main component ---------- */

export default function ResourceManagePage() {
  const { user } = useAuth();
  const filters = useManageResourceFilters();
  const queryClient = useQueryClient();

  /* ---- Data loading ---- */
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["resources", "asset"],
    queryFn: async () =>
      api<ResourceListResponse>("/api/resources", { params: { resource_type: "asset" } }),
  });

  const allResources = data?.resources ?? [];
  // Only keep resources the user can manage
  const manageableResources = React.useMemo(
    () => allResources.filter((r) => r.can_manage),
    [allResources],
  );

  /* ---- Derive subjects / tags from manageable resources ---- */
  const { subjects, tags } = React.useMemo(() => {
    const subjectSet = new Set<string>();
    const tagSet = new Set<string>();
    manageableResources.forEach((r) => {
      if (r.subject) subjectSet.add(r.subject.trim());
      parseTags(r.tags).forEach((t) => tagSet.add(t));
    });
    return {
      subjects: Array.from(subjectSet),
      tags: Array.from(tagSet).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    };
  }, [manageableResources]);

  const subjectOptions = React.useMemo<Option[]>(() => {
    const set = new Set<string>([DEFAULT_RESOURCE_SUBJECT, ...subjects.filter(Boolean)]);
    const sorted = Array.from(set).sort((a, b) => {
      if (a === DEFAULT_RESOURCE_SUBJECT) return -1;
      if (b === DEFAULT_RESOURCE_SUBJECT) return 1;
      return a.localeCompare(b, "zh-Hans-CN");
    });
    return [{ value: "all", label: "全部" }, ...sorted.map((x) => ({ value: x, label: x }))];
  }, [subjects]);

  /* ---- Filtering ---- */
  const filtered = React.useMemo(() => {
    const q = filters.query.trim().toLowerCase();
    return manageableResources.filter((r) => {
      // Tags
      const rTags = new Set(parseTags(r.tags));
      if (filters.tags.length > 0) {
        if (filters.tagsMode === "all") {
          if (!filters.tags.every((t) => rTags.has(t))) return false;
        } else {
          if (!filters.tags.some((t) => rTags.has(t))) return false;
        }
      }
      // Subject
      const subject = r.subject || DEFAULT_RESOURCE_SUBJECT;
      if (filters.subject !== "all" && subject !== filters.subject) return false;
      // Ownership
      if (filters.ownership === "created" && r.owner_id !== user?.id) return false;
      if (filters.ownership === "managed" && !r.can_manage) return false;
      // Status
      if (filters.status !== "all" && r.status !== filters.status) return false;
      // Secrecy
      if (filters.secrecy !== "all" && r.secrecy_level !== filters.secrecy) return false;

      // Search
      if (q) {
        const hay = [
          r.name,
          r.subject || "",
          r.owner?.name || "",
          r.owner?.username || "",
        ]
          .join(" ")
          .toLowerCase();
        const idStr = r.id.toString();
        // Pure number query matches exact ID; otherwise fuzzy match including ID substring
        const isNumeric = /^\d+$/.test(q);
        if (isNumeric) {
          if (idStr !== q && !hay.includes(q)) return false;
        } else {
          if (!hay.includes(q) && !idStr.includes(q)) return false;
        }
      }
      return true;
    });
  }, [manageableResources, filters, user?.id]);

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

  /* ---- Preview ---- */
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);

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
        pageItems.forEach((r) => next.add(r.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        pageItems.forEach((r) => next.delete(r.id));
        return next;
      });
    }
  };
  // Keep selection in sync with filtered results
  React.useEffect(() => {
    setSelectedIds((prev) => {
      const filteredIdSet = new Set(filtered.map((r) => r.id));
      const next = new Set<number>();
      prev.forEach((id) => {
        if (filteredIdSet.has(id)) next.add(id);
      });
      return next;
    });
  }, [filtered]);

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
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["resources", "asset"] });
      setDeleteDialogOpen(false);
    },
    onError: (err: Error) => toast.error(err.message || "删除失败"),
  });

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
      const rowH = 56; // compact row height
      const rows = Math.max(5, Math.floor((H - headerH) / rowH));
      setPageSize((prev) => (prev === rows ? prev : rows));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [page, setPage] = React.useState(1);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  React.useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);
  React.useEffect(() => {
    setPage(1);
  }, [filters.query, filters.ownership, filters.status, filters.subject, filters.secrecy, filters.tags.length]);
  const pageStart = (page - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);

  const allPageSelected =
    pageItems.length > 0 && pageItems.every((r) => selectedIds.has(r.id));
  const somePageSelected =
    pageItems.some((r) => selectedIds.has(r.id)) && !allPageSelected;

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

  return (
    <div className="flex h-full flex-col gap-4">
      {/* 页头 */}
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">资源管理</h1>
          <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground">
            {filtered.length === manageableResources.length
              ? `共 ${manageableResources.length} 条`
              : `筛选后 ${filtered.length} / ${manageableResources.length} 条`}
          </span>
        </div>
      </header>

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
              "h-8 w-full sm:w-56 rounded-full border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition",
              "placeholder:text-muted-foreground",
              "focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              filters.query.trim() !== "" && "border-primary/40 bg-primary/5",
            )}
          />
        </div>

        {/* 筛选（分组下拉） */}
        <FilterGroupChip
          groups={filterGroups}
          dirtyCount={filterDirtyCount}
          onReset={() => filters.reset()}
        />

        {/* 主体（独立 chip，可扩展） */}
        <SubjectFilterChip
          options={subjectOptions}
          value={filters.subject}
          onChange={(v) => filters.setSubject(v)}
        />

        {/* 标签（独立 chip） */}
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

        {/* 重置 */}
        {isDirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => filters.reset()}
            className="h-8 gap-1 rounded-full text-xs text-muted-foreground hover:text-primary"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            重置
          </Button>
        )}

        {/* 批量操作按钮 */}
        <div className="ml-auto flex items-center gap-2">
          {selectedIds.size > 0 && (
            <span className="text-xs text-muted-foreground">
              已选 <span className="font-medium text-primary">{selectedIds.size}</span> 项
            </span>
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

      {/* 内容区：筛选栏(顶部) → 表格(中间可滚动) → 分页(底部固定) */}
      <div className="min-h-0 flex-1 flex flex-col gap-0">
        <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
          </div>
        ) : isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            加载失败：{(error as Error)?.message || "未知错误"}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">
            {manageableResources.length === 0
              ? "暂无可管理的资源"
              : "没有匹配的资源"}
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <div className="flex items-center gap-0.5">
                      <Checkbox
                        checked={allPageSelected}
                        // @ts-expect-error indeterminate is a valid HTML attribute but not in the Checkbox component types
                        indeterminate={somePageSelected ? "true" : undefined}
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
                        <DropdownMenuContent align="start" className="w-40">
                          <DropdownMenuItem onClick={() => toggleSelectAll(true)}>
                            <Check className="mr-2 h-3.5 w-3.5" />
                            全选本页
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setSelectedIds(new Set(filtered.map((r) => r.id)))}>
                            <Check className="mr-2 h-3.5 w-3.5" />
                            选择全部 ({filtered.length})
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setSelectedIds(new Set())}>
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
                  <TableHead className="w-24">主体</TableHead>
                  <TableHead className="w-40">标签</TableHead>
                  <TableHead className="w-20">密级</TableHead>
                  <TableHead className="w-16">状态</TableHead>
                  <TableHead className="w-24">所有者</TableHead>
                  <TableHead className="w-24">更新时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((r) => {
                  const preview =
                    r.current?.preview_url || r.current?.original_preview_url || null;
                  const rTags = parseTags(r.tags);
                  const isSelected = selectedIds.has(r.id);

                  return (
                    <TableRow
                      key={r.id}
                      data-state={isSelected ? "selected" : undefined}
                      className={cn(isSelected && "bg-primary/5")}
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
                            preview && "cursor-pointer",
                          )}
                          onClick={() => {
                            if (preview) {
                              setPreviewUrl(r.current?.original_preview_url || preview);
                            }
                          }}
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
                        <div className="max-w-[200px] truncate font-medium">{r.name}</div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.subject || DEFAULT_RESOURCE_SUBJECT}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {rTags.length > 0 ? (
                            rTags.slice(0, 3).map((tag) => (
                              <span
                                key={tag}
                                className="inline-flex h-5 items-center rounded-md bg-secondary px-1.5 text-[11px] text-secondary-foreground"
                              >
                                {tag}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                          {rTags.length > 3 && (
                            <span className="inline-flex h-5 items-center text-[11px] text-muted-foreground">
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

        {/* 分页条 - 固定底部 */}
        {!isLoading && !isError && filtered.length > 0 && (
          <div className="flex shrink-0 items-center justify-between border-t pt-3 text-sm text-muted-foreground">
            <span>
              显示 {pageStart + 1}-{Math.min(pageStart + pageSize, filtered.length)}，共{" "}
              {filtered.length} 条
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
              <span className="min-w-[52px] text-center text-foreground">
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
        onSuccess={() => {
          setSelectedIds(new Set());
          queryClient.invalidateQueries({ queryKey: ["resources", "asset"] });
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

      {/* 缩略图预览 */}
      <Dialog open={!!previewUrl} onOpenChange={(open) => { if (!open) setPreviewUrl(null); }}>
        <DialogContent className="max-w-4xl p-0 overflow-hidden bg-black/90 border-none">
          {previewUrl && (
            <img
              src={previewUrl}
              alt="预览"
              className="h-auto max-h-[85vh] w-full object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------- filterGroups 配置 ---------- */
