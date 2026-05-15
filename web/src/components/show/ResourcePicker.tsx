import * as React from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  GripVertical,
  Loader2,
  Rows3,
  RotateCcw,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";

import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_SORT_KEY,
  RESOURCE_PERMISSION_OPTIONS,
  RESOURCE_SECRECY_OPTIONS,
  RESOURCE_STATUS_OPTIONS,
  type SortKey,
} from "@/lib/constants";
import { cn } from "@/lib/utils";
import {
  FilterChip,
  RemarkFilterChip,
  SortFilterChip,
  TagFilterChip,
  type ChipOption,
} from "@/components/resource/filter-chips";

/** 单条资源的轻量结构（与后端 /api/resources/pick items 对齐） */
export interface PickerResource {
  id: number;
  name: string;
  tags: string;
  subject?: string;
  updated_at?: string;
  created_at?: string;
  preview_url: string | null;
}

interface PickResponse {
  items: PickerResource[];
  total: number;
  page: number;
  page_size: number;
  all_tags: string[];
  all_subjects: string[];
}

interface AllIdsResponse {
  ids: number[];
}

export interface ResourcePickerProps {
  value: number[];
  onChange: (ids: number[]) => void;
  className?: string;
  /** 当资源数据加载后回调，供父组件缓存资源信息 */
  onResourcesLoaded?: (resources: PickerResource[]) => void;
  /** 是否在右侧渲染"已选清单"侧栏（默认 true；版本迭代场景外层已有清单可关闭） */
  showSelectedSidebar?: boolean;
}

/* ───────────────────── 默认筛选状态 ───────────────────── */
type RemarkState = "all" | "has" | "none";
type StatusState = "all" | "active" | "disabled";
type SecrecyState = "all" | "public" | "confidential" | "secret";
type PermissionState = "all" | "created" | "managed" | "visible";

const DEFAULT_PAGE_SIZE = 30;
const DEFAULT_STATUS: StatusState = "active";
const DEFAULT_SUBJECT = "all";
const DEFAULT_SECRECY: SecrecyState = "all";
const DEFAULT_PERMISSION: PermissionState = "all";
const DEFAULT_REMARK: RemarkState = "all";

export function ResourcePicker({
  value,
  onChange,
  className,
  onResourcesLoaded,
  showSelectedSidebar = true,
}: ResourcePickerProps) {
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [status, setStatus] = React.useState<StatusState>(DEFAULT_STATUS);
  const [subject, setSubject] = React.useState<string>(DEFAULT_SUBJECT);
  const [secrecy, setSecrecy] = React.useState<SecrecyState>(DEFAULT_SECRECY);
  const [permission, setPermission] = React.useState<PermissionState>(DEFAULT_PERMISSION);
  const [remarkCommon, setRemarkCommon] = React.useState<RemarkState>(DEFAULT_REMARK);
  const [remarkPersonal, setRemarkPersonal] = React.useState<RemarkState>(DEFAULT_REMARK);
  const [tags, setTags] = React.useState<string[]>([]);
  const [tagsMode, setTagsMode] = React.useState<"any" | "all">("any");
  const [sort, setSort] = React.useState<SortKey>(DEFAULT_SORT_KEY);
  const [density, setDensity] = React.useState<"compact" | "standard">("standard");
  const [page, setPage] = React.useState(1);

  // 防抖搜索
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // 任一筛选条件变更时回到第 1 页
  React.useEffect(() => {
    setPage(1);
  }, [status, subject, secrecy, permission, remarkCommon, remarkPersonal, tags, tagsMode, sort]);

  // 共享筛选参数
  const filterParams = React.useMemo(
    () => ({
      search: debouncedSearch || undefined,
      tags: tags.length > 0 ? tags.join(",") : undefined,
      tags_mode: tags.length > 0 ? tagsMode : undefined,
      subject: subject !== "all" ? subject : undefined,
      status: status !== "all" ? status : undefined,
      secrecy: secrecy !== "all" ? secrecy : undefined,
      permission: permission !== "all" ? permission : undefined,
      remark_common: remarkCommon !== "all" ? remarkCommon : undefined,
      remark_personal: remarkPersonal !== "all" ? remarkPersonal : undefined,
      sort,
    }),
    [debouncedSearch, tags, tagsMode, subject, status, secrecy, permission, remarkCommon, remarkPersonal, sort],
  );

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["resources-pick", filterParams, page],
    queryFn: async () =>
      api<PickResponse>("/api/resources/pick", {
        params: { page, page_size: DEFAULT_PAGE_SIZE, ...filterParams },
      }),
    placeholderData: keepPreviousData,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const allTags = data?.all_tags ?? [];
  const allSubjects = data?.all_subjects ?? [];
  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE));

  // 通知父组件加载了新的资源数据，供其缓存
  React.useEffect(() => {
    if (items.length > 0 && onResourcesLoaded) {
      onResourcesLoaded(items);
    }
  }, [items, onResourcesLoaded]);

  // 已选资源的元数据缓存（用于侧栏展示，跨页/跨筛选保留）
  const [resourceCache, setResourceCache] = React.useState<Map<number, PickerResource>>(new Map());
  React.useEffect(() => {
    if (items.length === 0) return;
    setResourceCache((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const it of items) {
        const old = next.get(it.id);
        if (!old || old.preview_url !== it.preview_url || old.name !== it.name) {
          next.set(it.id, it);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [items]);

  const valueSet = React.useMemo(() => new Set(value), [value]);
  const orderMap = React.useMemo(() => {
    const map = new Map<number, number>();
    value.forEach((id, idx) => map.set(id, idx + 1));
    return map;
  }, [value]);

  // ── 单项切换 ──
  const toggle = (id: number) => {
    if (valueSet.has(id)) onChange(value.filter((x) => x !== id));
    else onChange([...value, id]);
  };

  // ── 本页全选/取消 ──
  const pageIds = items.map((r) => r.id);
  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => valueSet.has(id));
  const pageSomeSelected = pageIds.some((id) => valueSet.has(id));

  const togglePageAll = () => {
    if (pageAllSelected) {
      const pageSet = new Set(pageIds);
      onChange(value.filter((id) => !pageSet.has(id)));
    } else {
      const merged = [...value];
      for (const id of pageIds) if (!valueSet.has(id)) merged.push(id);
      onChange(merged);
    }
  };

  // ── 全部全选 / 取消 ──
  const [selectingAll, setSelectingAll] = React.useState(false);
  const fetchAllIds = async () =>
    api<AllIdsResponse>("/api/resources/pick-ids", { params: filterParams });

  const selectAll = async () => {
    setSelectingAll(true);
    try {
      const res = await fetchAllIds();
      const allNewIds = new Set(res.ids);
      const existing = value.filter((id) => !allNewIds.has(id));
      onChange([...existing, ...res.ids]);
    } finally {
      setSelectingAll(false);
    }
  };

  const deselectAll = async () => {
    setSelectingAll(true);
    try {
      const res = await fetchAllIds();
      const removeSet = new Set(res.ids);
      onChange(value.filter((id) => !removeSet.has(id)));
    } finally {
      setSelectingAll(false);
    }
  };

  // ── 重置筛选 ──
  const isDirty =
    debouncedSearch !== "" ||
    status !== DEFAULT_STATUS ||
    subject !== DEFAULT_SUBJECT ||
    secrecy !== DEFAULT_SECRECY ||
    permission !== DEFAULT_PERMISSION ||
    remarkCommon !== DEFAULT_REMARK ||
    remarkPersonal !== DEFAULT_REMARK ||
    tags.length > 0 ||
    sort !== DEFAULT_SORT_KEY;

  const resetFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setStatus(DEFAULT_STATUS);
    setSubject(DEFAULT_SUBJECT);
    setSecrecy(DEFAULT_SECRECY);
    setPermission(DEFAULT_PERMISSION);
    setRemarkCommon(DEFAULT_REMARK);
    setRemarkPersonal(DEFAULT_REMARK);
    setTags([]);
    setTagsMode("any");
    setSort(DEFAULT_SORT_KEY);
  };

  // ── 主体下拉选项 ──
  const subjectOptions = React.useMemo<ChipOption[]>(() => {
    const opts: ChipOption[] = [{ value: "all", label: "全部" }];
    allSubjects.forEach((s) => opts.push({ value: s, label: s }));
    return opts;
  }, [allSubjects]);

  // ── 已选清单（用 cache 还原元数据）──
  const selectedItems: PickerResource[] = React.useMemo(
    () =>
      value.map(
        (id) =>
          resourceCache.get(id) ?? {
            id,
            name: `#${id}`,
            tags: "",
            preview_url: null,
          },
      ),
    [value, resourceCache],
  );

  // ── 已选清单拖拽排序（HTML5 原生）──
  const [draggingId, setDraggingId] = React.useState<number | null>(null);
  const handleDragStart = (id: number) => (e: React.DragEvent) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = "move";
  };
  const handleDragOver = (overId: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (draggingId == null || draggingId === overId) return;
    const fromIdx = value.indexOf(draggingId);
    const toIdx = value.indexOf(overId);
    if (fromIdx === -1 || toIdx === -1) return;
    const next = [...value];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, draggingId);
    onChange(next);
  };
  const handleDragEnd = () => setDraggingId(null);

  /* ───────────────────── 渲染 ───────────────────── */

  const gridColsClass =
    density === "compact"
      ? "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6"
      : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";

  return (
    <div className={cn("flex min-h-0 flex-col rounded-md border bg-background", className)}>
      {/* 顶部筛选 chips（紧凑模式） */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-2.5 py-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索名称或主体"
            className={cn(
              "h-7 w-48 rounded-full pl-7 text-xs",
              search.trim() !== "" && "border-primary/40 bg-primary/5",
            )}
          />
        </div>
        <FilterChip
          label="状态"
          options={RESOURCE_STATUS_OPTIONS}
          value={status}
          onChange={(v) => setStatus(v as StatusState)}
          baseValue={DEFAULT_STATUS}
          compact
        />
        <FilterChip
          label="主体"
          options={subjectOptions}
          value={subject}
          onChange={(v) => setSubject(v)}
          baseValue={DEFAULT_SUBJECT}
          compact
        />
        <FilterChip
          label="密级"
          options={RESOURCE_SECRECY_OPTIONS}
          value={secrecy}
          onChange={(v) => setSecrecy(v as SecrecyState)}
          baseValue={DEFAULT_SECRECY}
          compact
        />
        <FilterChip
          label="权限"
          options={RESOURCE_PERMISSION_OPTIONS}
          value={permission}
          onChange={(v) => setPermission(v as PermissionState)}
          baseValue={DEFAULT_PERMISSION}
          compact
        />
        <RemarkFilterChip
          common={remarkCommon}
          personal={remarkPersonal}
          onChangeCommon={setRemarkCommon}
          onChangePersonal={setRemarkPersonal}
          compact
        />
        <TagFilterChip
          label="标签"
          emptyText="暂无标签"
          tags={allTags}
          selected={tags}
          mode={tagsMode}
          onToggle={(t) =>
            setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
          }
          onClear={() => setTags([])}
          onChangeMode={setTagsMode}
          compact
        />
        <SortFilterChip value={sort} onChange={setSort} baseValue={DEFAULT_SORT_KEY} compact />
        {isDirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={resetFilters}
            className="h-7 gap-1 rounded-full px-2 text-xs text-muted-foreground hover:text-primary"
          >
            <RotateCcw className="h-3 w-3" />
            重置
          </Button>
        )}
      </div>

      {/* 多选操作 + 密度切换 */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2.5 py-1 text-xs">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted transition"
            onClick={togglePageAll}
            title={pageAllSelected ? "取消本页全选" : "本页全选"}
          >
            {pageAllSelected ? (
              <CheckSquare className="h-3.5 w-3.5 text-primary" />
            ) : pageSomeSelected ? (
              <CheckSquare className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <Square className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span>本页全选</span>
          </button>
          <span className="text-muted-foreground">|</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted transition"
            onClick={selectAll}
            disabled={selectingAll || total === 0}
          >
            {selectingAll ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <ChevronsRight className="h-3 w-3" />
            )}
            <span>全部全选 ({total})</span>
          </button>
          {value.length > 0 && (
            <>
              <span className="text-muted-foreground">|</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-destructive hover:bg-destructive/10 transition"
                onClick={deselectAll}
                disabled={selectingAll}
              >
                <span>取消当前筛选</span>
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">密度</span>
          <div className="inline-flex overflow-hidden rounded-md border">
            <button
              type="button"
              onClick={() => setDensity("standard")}
              className={cn(
                "px-2 py-0.5 text-[11px] transition",
                density === "standard"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-muted",
              )}
            >
              标准
            </button>
            <button
              type="button"
              onClick={() => setDensity("compact")}
              className={cn(
                "inline-flex items-center gap-0.5 px-2 py-0.5 text-[11px] transition",
                density === "compact"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-muted",
              )}
            >
              <Rows3 className="h-3 w-3" />
              紧凑
            </button>
          </div>
        </div>
      </div>

      {/* 主体：左网格 + 可选右侧栏 */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 左：网格区 */}
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {isLoading && !data ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 加载资源…
            </div>
          ) : isError ? (
            <div className="py-10 text-center text-sm text-destructive">
              加载失败：{(error as Error)?.message || "未知错误"}
            </div>
          ) : items.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {total === 0 ? "暂无可选资源" : "没有匹配的资源"}
            </div>
          ) : (
            <div className={cn("grid gap-2", gridColsClass)}>
              {items.map((r) => {
                const selected = valueSet.has(r.id);
                const order = orderMap.get(r.id);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => toggle(r.id)}
                    className={cn(
                      "group relative flex flex-col overflow-hidden rounded-md border bg-background text-left transition",
                      selected
                        ? "border-primary ring-1 ring-primary"
                        : "border-border hover:border-primary/50 hover:shadow-sm",
                    )}
                    title={r.name}
                  >
                    {selected && order != null && (
                      <span className="absolute left-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground shadow">
                        {order}
                      </span>
                    )}
                    {selected && (
                      <span className="absolute right-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
                        <Check className="h-3 w-3" strokeWidth={3} />
                      </span>
                    )}
                    <div className="aspect-[16/9] w-full overflow-hidden bg-muted">
                      {r.preview_url ? (
                        <img
                          src={r.preview_url}
                          alt={r.name}
                          className="h-full w-full object-cover transition group-hover:scale-105"
                          loading="lazy"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
                          无预览
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-0.5 px-1.5 py-1">
                      <div className="truncate text-xs text-foreground">{r.name}</div>
                      {density === "standard" && r.subject && (
                        <div className="truncate text-[10px] text-muted-foreground">
                          {r.subject}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 右：已选清单侧栏 */}
        {showSelectedSidebar && (
          <div className="flex w-56 shrink-0 flex-col border-l bg-muted/30">
            <div className="flex items-center justify-between border-b px-3 py-2 text-xs">
              <span>
                已选 <span className="font-medium text-foreground">{value.length}</span>
              </span>
              {value.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-destructive transition hover:bg-destructive/10"
                  title="清空全部已选"
                >
                  <Trash2 className="h-3 w-3" />
                  清空
                </button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {selectedItems.length === 0 ? (
                <div className="flex h-full items-center justify-center px-2 py-6 text-center text-xs text-muted-foreground">
                  从左侧选择资源后会出现在这里，可拖拽排序
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {selectedItems.map((r, idx) => {
                    const isDragging = r.id === draggingId;
                    return (
                      <li
                        key={r.id}
                        draggable
                        onDragStart={handleDragStart(r.id)}
                        onDragOver={handleDragOver(r.id)}
                        onDragEnd={handleDragEnd}
                        className={cn(
                          "group flex cursor-grab items-center gap-1.5 rounded-md border bg-background p-1.5 transition active:cursor-grabbing",
                          isDragging && "opacity-40",
                        )}
                      >
                        <GripVertical className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-medium text-primary">
                          {idx + 1}
                        </span>
                        <div className="aspect-[16/9] h-7 shrink-0 overflow-hidden rounded bg-muted">
                          {r.preview_url ? (
                            <img
                              src={r.preview_url}
                              alt={r.name}
                              className="h-full w-full object-cover"
                              loading="lazy"
                            />
                          ) : null}
                        </div>
                        <span className="flex-1 truncate text-[11px]" title={r.name}>
                          {r.name}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onChange(value.filter((id) => id !== r.id));
                          }}
                          className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive group-hover:flex"
                          title="移除"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 底部：分页 + （非侧栏模式下）选中状态 */}
      <div className="flex shrink-0 items-center justify-between border-t px-3 py-1.5 text-xs text-muted-foreground">
        {!showSelectedSidebar ? (
          <span>
            已选 <span className="font-medium text-foreground">{value.length}</span> 项
            {value.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="ml-2 inline-flex items-center gap-0.5 rounded-sm px-1 py-0.5 text-destructive transition hover:bg-destructive/10"
              >
                <Trash2 className="h-3 w-3" />
                清空
              </button>
            )}
          </span>
        ) : (
          <span>{isFetching ? "加载中…" : "\u00A0"}</span>
        )}

        <div className="flex items-center gap-1">
          <span className="mr-1">
            {page}/{totalPages} 页 (共 {total})
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            disabled={page <= 1}
            onClick={() => setPage(1)}
          >
            <ChevronsLeft className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            <ChevronRight className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            disabled={page >= totalPages}
            onClick={() => setPage(totalPages)}
          >
            <ChevronsRight className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
