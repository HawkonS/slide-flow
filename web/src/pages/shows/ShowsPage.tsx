import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, ChevronDown, ClipboardList, ListChecks, Loader2, Plus, Star, Trash2, X } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ShowCard } from "@/components/show/ShowCard";
import { ShowListView } from "@/components/show/ShowListView";
import { ShowFilters } from "@/components/show/ShowFilters";
import { ShowEditDialog } from "@/components/show/ShowEditDialog";
import {
  DeleteScopeDialog,
  type DeleteScope,
} from "@/components/common/DeleteScopeDialog";
import { ConfirmDialog, PromptDialog } from "@/components/common/ConfirmDialog";
import { PageHeader } from "@/components/common/PageHeader";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { serializeTags, Show } from "@/lib/types";
import { useResponsiveGrid } from "@/lib/use-grid-layout";
import { useEncodedUrlState } from "@/lib/use-encoded-url-state";
import { useShowFilters } from "@/stores/show-filters";
import { DEFAULT_SORT_KEY, type SortKey } from "@/lib/constants";
import { usePaginatedQuery } from "@/lib/use-paginated-query";
import { readShowCreateDraft, showCreateDraftKey, type ShowCreateDraft } from "@/lib/show-create-draft";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ViewModeSwitch } from "@/components/common/ViewModeSwitch";

/* ---- URL 持久化状态类型与默认值 ---- */
interface ShowUrlState {
  q: string;
  sub: string;
  sta: string;
  perm: string;
  tags: string[];
  tm: string;
  sort: string;
  p: number;
  view: "card" | "list";
}

const URL_DEFAULTS: ShowUrlState = {
  q: "", sub: "all", sta: "all", perm: "all",
  tags: [], tm: "all", sort: DEFAULT_SORT_KEY, p: 1, view: "card",
};

export interface ShowsPageProps {
  standardOnly?: boolean;
}

export function ShowsPage({ standardOnly = false }: ShowsPageProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const filters = useShowFilters();
  const queryClient = useQueryClient();

  // 分页
  const contentRef = React.useRef<HTMLDivElement>(null);
  const { pageSize: cardPageSize, gridStyle } = useResponsiveGrid(contentRef, {
    columnStep: standardOnly ? 360 : 300,
    maxCols: standardOnly ? 3 : 4,
    titleHeight: 48,
  });
  const [listPageSize, setListPageSize] = React.useState(12);
  React.useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const compute = () => {
      if (el.clientHeight) setListPageSize(Math.max(5, Math.floor((el.clientHeight - 42) / 48)));
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 筛选 + 页码统一编码到 URL ?s=…
  const [urlState, setUrlState] = useEncodedUrlState({ defaults: URL_DEFAULTS });
  const viewMode = standardOnly ? "card" : urlState.view === "list" ? "list" : "card";
  const pageSize = viewMode === "list" ? listPageSize : cardPageSize;
  const setViewMode = (view: "card" | "list") => {
    if (standardOnly) return;
    setUrlState((prev) => ({ ...prev, view, p: 1 }));
  };

  // URL → zustand store（仅首次挂载时同步）
  // 注意：必须在 useEffect 中执行而非渲染期间，否则 StrictMode 下
  // 组件卸载重挂载时 ref 会重置，导致重复同步并可能覆盖用户操作。
  const initialized = React.useRef(false);
  React.useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const s = urlState;
    filters.setQuery(s.q);
    filters.setSubject(s.sub);
    filters.setStatus(s.sta);
    filters.setPermission(s.perm as "all" | "created" | "managed" | "visible");
    filters.setTags(s.tags);
    filters.setTagsMode(s.tm as "any" | "all");
    filters.setSort(s.sort as SortKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // zustand → URL（筛选变化时重置页码）
  const prevFiltersKey = React.useRef("");
  React.useEffect(() => {
    const key = JSON.stringify({
      q: filters.query, sub: filters.subject,
      sta: filters.status, perm: filters.permission,
      tags: filters.tags, tm: filters.tagsMode, sort: filters.sort,
    });
    if (key === prevFiltersKey.current) return;
    const filtersChanged = prevFiltersKey.current !== "";
    prevFiltersKey.current = key;
    setUrlState((prev) => ({
      ...prev,
      q: filters.query, sub: filters.subject,
      sta: filters.status, perm: filters.permission,
      tags: filters.tags, tm: filters.tagsMode, sort: filters.sort,
      p: filtersChanged ? 1 : prev.p,
    }));
  }, [
    filters.query, filters.subject, filters.status,
    filters.permission, filters.tags, filters.tagsMode, filters.sort, setUrlState,
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

  // 构建后端查询参数
  const apiParams = React.useMemo(
    () => ({
      search: filters.query.trim() || undefined,
      subject: filters.subject !== "all" ? filters.subject : undefined,
      status: filters.status !== "all" ? filters.status : undefined,
      permission: standardOnly ? undefined : filters.permission !== "all" ? filters.permission : undefined,
      tags: filters.tags.length > 0 ? serializeTags(filters.tags) : undefined,
      tags_mode: filters.tagsMode,
      sort: filters.sort,
      standard_only: standardOnly || undefined,
    }),
    [filters, standardOnly],
  );

  const {
    items: shows,
    total,
    totalPages,
    allTags: tags,
    allSubjects: subjects,
    isLoading,
    isError,
    error,
  } = usePaginatedQuery<Show>({
    url: "/api/shows",
    queryKeyPrefix: "shows",
    params: apiParams,
    page,
    pageSize,
  });

  // 页码越界检查
  // 增加 page !== 1 守卫，避免与其他 setPage 调用产生竞态、
  // 也避免页码已为 1 时仍然触发一次不必要的 setState。
  React.useEffect(() => {
    if (totalPages > 0 && page > totalPages && page !== 1) {
      setPage(1);
    }
  }, [page, totalPages, setPage]);

  // 详情按需加载（完整数据含所有资源）
  const [editShow, setEditShow] = React.useState<Show | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<Show | null>(null);
  const [singleDeleteTarget, setSingleDeleteTarget] = React.useState<Show | null>(null);
  const [duplicateTarget, setDuplicateTarget] = React.useState<Show | null>(null);
  const [duplicateName, setDuplicateName] = React.useState("");
  const [duplicatePending, setDuplicatePending] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<number>>(new Set());
  const [manageableIds, setManageableIds] = React.useState<Set<number>>(new Set());
  const showCacheRef = React.useRef<Map<number, Show>>(new Map());
  const [selectingAll, setSelectingAll] = React.useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = React.useState(false);
  const [batchDeleting, setBatchDeleting] = React.useState(false);
  const [draft, setDraft] = React.useState<ShowCreateDraft | null>(() =>
    readShowCreateDraft(user?.id),
  );
  const [draftOpen, setDraftOpen] = React.useState(false);

  const refreshDraft = React.useCallback(() => {
    setDraft(readShowCreateDraft(user?.id));
  }, [user?.id]);

  React.useEffect(() => {
    refreshDraft();
    window.addEventListener("focus", refreshDraft);
    return () => window.removeEventListener("focus", refreshDraft);
  }, [refreshDraft]);

  const clearDraft = () => {
    if (!user?.id) return;
    localStorage.removeItem(showCreateDraftKey(user.id));
    setDraft(null);
    setDraftOpen(false);
    toast.success("放映草稿已删除");
  };

  const standardMutation = useMutation({
    mutationFn: (show: Show) =>
      api<{ ok: boolean; standard: boolean }>(`/api/admin/shows/${show.id}/standard`, {
        method: "PATCH",
        json: { standard: !show.is_standard },
      }),
    onSuccess: (data) => {
      toast.success(data.standard ? "已设为标准放映" : "已取消标准放映");
      queryClient.invalidateQueries({ queryKey: ["shows"] });
    },
    onError: (err: Error) => toast.error(err.message || "标准放映设置失败"),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, scope }: { id: number; scope: DeleteScope }) =>
      api<{ ok: boolean }>(`/api/shows/${id}?scope=${scope}`, {
        method: "DELETE",
      }),
    onSuccess: (_data, { scope }) => {
      toast.success(scope === "all" ? "放映及全部版本已删除" : "放映已删除");
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["shows"] });
      // 首页置顶卡片与统计也依赖放映数据，删除后需同步失效，
      // 否则 30s staleTime 内回到首页仍会看到已删除的放映
      queryClient.invalidateQueries({ queryKey: ["home", "pins"] });
      queryClient.invalidateQueries({ queryKey: ["home", "stats"] });
    },
    onError: (err: Error) => toast.error(err.message || "删除失败"),
  });

  const fetchFullShow = React.useCallback(async (s: Show): Promise<Show> => {
    if (s.resources?.length && s.visible_user_ids) return s;
    const res = await api<{ show: Show }>(`/api/shows/${s.id}`);
    return res.show;
  }, []);

  const handleOpenDetail = (s: Show) => {
    navigate(`/shows/${s.id}`);
  };

  const handleEdit = async (s: Show) => {
    const full = await fetchFullShow(s);
    setEditShow(full);
    setEditOpen(true);
  };

  const handleDelete = (show: Show) => {
    // 多版本放映：弹窗让用户选择删除范围
    if (show.has_other_versions) {
      setDeleteTarget(show);
      return;
    }
    setSingleDeleteTarget(show);
  };

  const handleDuplicate = (show: Show) => {
    setDuplicateTarget(show);
    setDuplicateName(`${show.name} - 副本`);
  };

  const submitDuplicate = async () => {
    if (!duplicateTarget || !duplicateName.trim()) return;
    setDuplicatePending(true);
    try {
      await api(`/api/shows/${duplicateTarget.id}/duplicate`, {
        method: "POST",
        json: { name: duplicateName.trim() },
      });
      toast.success("副本已创建");
      setDuplicateTarget(null);
      queryClient.invalidateQueries({ queryKey: ["shows"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建副本失败");
    } finally {
      setDuplicatePending(false);
    }
  };

  const clearSelection = React.useCallback(() => {
    setSelectedIds(new Set());
    setManageableIds(new Set());
    showCacheRef.current.clear();
  }, []);

  const selectionKey = JSON.stringify(apiParams);
  const previousSelectionKey = React.useRef(selectionKey);
  React.useEffect(() => {
    if (previousSelectionKey.current !== selectionKey) {
      previousSelectionKey.current = selectionKey;
      clearSelection();
    }
  }, [selectionKey, clearSelection]);

  React.useEffect(() => {
    if (viewMode === "card") clearSelection();
  }, [viewMode, clearSelection]);

  React.useEffect(() => {
    shows.forEach((show) => showCacheRef.current.set(show.id, show));
    setManageableIds((previous) => {
      const next = new Set(previous);
      shows.forEach((show) => {
        if (show.can_manage) next.add(show.id);
        else next.delete(show.id);
      });
      return next;
    });
  }, [shows]);

  const toggleSelect = (id: number) => setSelectedIds((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const togglePage = (checked: boolean) => setSelectedIds((previous) => {
    const next = new Set(previous);
    shows.forEach((show) => {
      if (checked) next.add(show.id);
      else next.delete(show.id);
    });
    return next;
  });

  const allPageSelected = shows.length > 0 && shows.every((show) => selectedIds.has(show.id));
  const somePageSelected = shows.some((show) => selectedIds.has(show.id)) && !allPageSelected;
  const allManageable = selectedIds.size > 0 && [...selectedIds].every((id) => manageableIds.has(id));

  const selectAll = async () => {
    setSelectingAll(true);
    try {
      const pageSizeForSelection = 200;
      const first = await api<{ items: Show[]; total: number }>("/api/shows", {
        params: { ...apiParams, page: 1, page_size: pageSizeForSelection },
      });
      const pages = Math.ceil(first.total / pageSizeForSelection);
      const rest = pages > 1
        ? await Promise.all(Array.from({ length: pages - 1 }, (_, index) => api<{ items: Show[] }>("/api/shows", {
          params: { ...apiParams, page: index + 2, page_size: pageSizeForSelection },
        })))
        : [];
      const allShows = [first, ...rest].flatMap((result) => result.items);
      const allIds = allShows.map((show) => show.id);
      allShows.forEach((show) => showCacheRef.current.set(show.id, show));
      setSelectedIds(new Set(allIds));
      setManageableIds(new Set(allShows.filter((show) => show.can_manage).map((show) => show.id)));
      toast.success(`已选中当前筛选的 ${allIds.length} 个放映`);
    } catch (err) {
      toast.error((err as Error).message || "全选失败");
    } finally {
      setSelectingAll(false);
    }
  };

  const deleteSelected = async (scope: DeleteScope) => {
    if (!allManageable || batchDeleting) return;
    setBatchDeleting(true);
    const ids = [...selectedIds];
    const succeeded: number[] = [];
    let failed = 0;
    try {
      for (let i = 0; i < ids.length; i += 8) {
        const results = await Promise.allSettled(ids.slice(i, i + 8).map((id) =>
          api(`/api/shows/${id}?scope=${scope}`, { method: "DELETE" }),
        ));
        results.forEach((result, index) => {
          if (result.status === "fulfilled") succeeded.push(ids[i + index]);
          else failed++;
        });
      }
      setSelectedIds((previous) => {
        const next = new Set(previous);
        succeeded.forEach((id) => next.delete(id));
        return next;
      });
      if (failed) toast.error(`${failed} 个放映删除失败，请重试`);
      else toast.success(`已删除 ${succeeded.length} 个放映${scope === "all" ? "及其全部版本" : "当前版本"}`);
      setBatchDeleteOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["shows"] });
      queryClient.invalidateQueries({ queryKey: ["home", "pins"] });
      queryClient.invalidateQueries({ queryKey: ["home", "stats"] });
    } finally {
      setBatchDeleting(false);
    }
  };

  const pageStart = (page - 1) * pageSize;

  return (
    <div className="page-shell">
      <PageHeader
        title={standardOnly ? "标准放映" : "放映素材"}
        description={standardOnly ? "按主体、标签和状态浏览标准放映。" : "按主体、标签和状态快速查找并管理放映素材。"}
        count={total > 0 ? `共 ${total} 条` : "共 0 条"}
        actions={!standardOnly && <ViewModeSwitch value={viewMode} onChange={setViewMode} label="放映视图" />}
      />

      {standardOnly && (
        <section className="flex flex-col gap-3 border-l-4 border-amber-400 bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"><Star className="h-4 w-4 fill-current" /></div>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">由组织精选的标准放映</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">由组织确认的对外标准版本。</p>
              </div>
            </div>
            <Link to="/manage/shows" className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-md border bg-background px-3 py-2 text-xs font-medium transition hover:bg-accent sm:self-auto">查看全部放映<ArrowRight className="h-3.5 w-3.5" /></Link>
        </section>
      )}

      <ShowFilters
        subjects={subjects}
        tags={tags}
        hidePermission={standardOnly}
        actions={
          user && !standardOnly ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDraftOpen(true)}
                className="h-8 gap-1.5 px-3 text-sm"
              >
                <ClipboardList className="h-3.5 w-3.5" />
                草稿箱
                {draft && <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground">1</span>}
              </Button>
              <Button
                size="sm"
                onClick={() => navigate("/manage/shows/new")}
                className="h-8 gap-1.5 px-3 text-sm"
              >
                <Plus className="h-3.5 w-3.5" />
                创建放映
              </Button>
            </>
          ) : null
        }
      />

      {viewMode === "list" && !standardOnly && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Checkbox checked={allPageSelected ? true : somePageSelected ? "indeterminate" : false} onCheckedChange={(checked) => togglePage(checked === true)} aria-label="选择本页放映" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="h-7 gap-1 px-1">选择 <ChevronDown className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => togglePage(true)}><Check className="mr-2 h-4 w-4" />全选本页</DropdownMenuItem>
              <DropdownMenuItem onSelect={selectAll} disabled={total === 0 || selectingAll}><ListChecks className="mr-2 h-4 w-4" />全选所有筛选结果 ({total})</DropdownMenuItem>
              <DropdownMenuItem onSelect={clearSelection}><X className="mr-2 h-4 w-4" />清空选择</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {selectedIds.size > 0 && <>
            <span className="text-muted-foreground">已选 <span className="font-medium text-primary">{selectedIds.size}</span> 个</span>
            <Button variant="ghost" size="sm" className="h-7 px-1" onClick={clearSelection}>清空</Button>
          </>}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 gap-1 text-destructive hover:text-destructive" disabled={!allManageable} title={selectedIds.size && !allManageable ? "批量删除仅支持所选放映全部可管理时使用" : undefined} onClick={() => setBatchDeleteOpen(true)}>
              <Trash2 className="h-3.5 w-3.5" />批量删除
            </Button>
          </div>
        </div>
      )}

      {/* 内容区 */}
      <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
          </div>
        ) : isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            加载失败：{error?.message || "未知错误"}
          </div>
        ) : shows.length === 0 ? (
          <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">
            {standardOnly ? "暂无标准放映" : "没有匹配的放映素材"}
          </div>
        ) : (
          viewMode === "list" ? (
            <ShowListView
              shows={shows}
              onOpen={handleOpenDetail}
              onEdit={standardOnly ? undefined : handleEdit}
              onDuplicate={standardOnly ? undefined : handleDuplicate}
              onIterate={standardOnly ? undefined : (s) => navigate(`/shows/${s.id}/iterate`)}
              onDelete={standardOnly ? undefined : handleDelete}
              onToggleStandard={standardOnly ? undefined : (show) => standardMutation.mutate(show)}
              selectedIds={standardOnly ? undefined : selectedIds}
              allPageSelected={standardOnly ? undefined : allPageSelected}
              somePageSelected={standardOnly ? undefined : somePageSelected}
              onToggle={standardOnly ? undefined : toggleSelect}
              onTogglePage={standardOnly ? undefined : togglePage}
            />
          ) : (
            <div className="grid content-start" style={gridStyle}>
              {shows.map((s) => (
                <ShowCard
                  key={s.id}
                  show={s}
                  onOpen={handleOpenDetail}
                  onEdit={standardOnly ? undefined : handleEdit}
                  onDuplicate={standardOnly ? undefined : handleDuplicate}
                  onIterate={standardOnly ? undefined : () => navigate(`/shows/${s.id}/iterate`)}
                  onDelete={standardOnly ? undefined : handleDelete}
                  onToggleStandard={standardOnly ? undefined : (show) => standardMutation.mutate(show)}
                />
              ))}
            </div>
          ))}
      </div>

      {/* 分页条 */}
      {!isLoading && !isError && shows.length > 0 && (
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

      <ShowEditDialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) setEditShow(null);
        }}
        show={editShow}
        tagSuggestions={tags}
        subjectSuggestions={subjects}
      />

      <Dialog open={draftOpen} onOpenChange={setDraftOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>放映草稿箱</DialogTitle>
            <DialogDescription>继续编辑上次暂存的创建流程，或删除不再需要的草稿。</DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="rounded-md border bg-muted/20 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{draft.form.name?.trim() || "未命名放映"}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    第 {draft.step + 1} 步：{["填写信息", "选择素材", "排序确认"][draft.step]} · 已选 {draft.resourceIds.length} 页
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {draft.savedAt ? `最近暂存：${new Date(draft.savedAt).toLocaleString("zh-CN")}` : "尚未记录暂存时间"}
                  </p>
                </div>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive hover:text-destructive" onClick={clearDraft} aria-label="删除放映草稿" title="删除草稿">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
              暂无放映草稿
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDraftOpen(false)}>关闭</Button>
            {draft && (
              <Button type="button" onClick={() => navigate("/manage/shows/new")}>继续编辑</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={batchDeleteOpen} onOpenChange={(open) => { if (!batchDeleting) setBatchDeleteOpen(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>批量删除放映</DialogTitle>
            <DialogDescription>
              已选择 {selectedIds.size} 个放映。多版本放映请选择删除当前版本或全部版本，此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch">
            <Button type="button" variant="outline" className="text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={batchDeleting} onClick={() => void deleteSelected("latest")}>
              仅删除当前版本
            </Button>
            <Button type="button" variant="destructive" disabled={batchDeleting} onClick={() => void deleteSelected("all")}>
              {batchDeleting ? "删除中…" : "删除全部版本"}
            </Button>
            <Button type="button" variant="ghost" disabled={batchDeleting} onClick={() => setBatchDeleteOpen(false)}>取消</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {singleDeleteTarget && (
        <ConfirmDialog
          open={singleDeleteTarget !== null}
          onOpenChange={(open) => { if (!open) setSingleDeleteTarget(null); }}
          title="删除放映"
          description={`确定要删除放映「${singleDeleteTarget.name}」吗？此操作不可恢复。`}
          confirmLabel="删除放映"
          destructive
          loading={deleteMutation.isPending}
          onConfirm={() => {
            const target = singleDeleteTarget;
            deleteMutation.mutate({ id: target.id, scope: "latest" }, { onSuccess: () => setSingleDeleteTarget(null) });
          }}
        />
      )}

      <PromptDialog
        open={duplicateTarget !== null}
        onOpenChange={(open) => { if (!open && !duplicatePending) setDuplicateTarget(null); }}
        title="创建放映副本"
        description="副本会复制当前放映的页面顺序和版本配置，创建后可继续编辑。"
        label="副本名称"
        value={duplicateName}
        onValueChange={setDuplicateName}
        confirmLabel="创建副本"
        loading={duplicatePending}
        onConfirm={() => void submitDuplicate()}
      />

      <DeleteScopeDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        entityLabel="放映"
        name={deleteTarget?.name ?? ""}
        versionCount={deleteTarget?.version_count ?? deleteTarget?.version_no ?? 1}
        latestVersionNo={deleteTarget?.latest_version_no ?? deleteTarget?.version_no}
        loading={deleteMutation.isPending}
        onDelete={(scope) => {
          if (deleteTarget) {
            deleteMutation.mutate({ id: deleteTarget.id, scope });
          }
        }}
      />
    </div>
  );
}
