import * as React from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, LayoutGrid, LayoutList, ListChecks, Loader2, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BatchEditDialog } from "@/components/manage/BatchEditDialog";
import { ResourceCard } from "@/components/resource/ResourceCard";
import { ResourceListView } from "@/components/resource/ResourceListView";
import { ResourceDetailDialog } from "@/components/resource/ResourceDetailDialog";
import { ResourceDownloadDialog } from "@/components/resource/ResourceDownloadDialog";
import { ResourceEditDialog } from "@/components/resource/ResourceEditDialog";
import { ResourcePreviewDialog } from "@/components/resource/ResourcePreviewDialog";
import { ResourceFilters } from "@/components/resource/ResourceFilters";
import { ResourceNewVersionDialog } from "@/components/resource/ResourceNewVersionDialog";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { serializeTags } from "@/lib/types";
import { Resource, ResourceVersion, Show } from "@/lib/types";
import { useResponsiveGrid } from "@/lib/use-grid-layout";
import { useEncodedUrlState } from "@/lib/use-encoded-url-state";
import { useResourceFilters, markResourceFiltersUrlRestored } from "@/stores/resource-filters";
import { DEFAULT_SORT_KEY, type SortKey } from "@/lib/constants";
import { usePaginatedQuery } from "@/lib/use-paginated-query";

/* ---- URL 持久化状态类型与默认值 ---- */
interface ResourceUrlState {
  q: string;
  sub: string;
  sec: string;
  sta: string;
  perm: string;
  rc: string;
  rp: string;
  tags: string[];
  tm: string;
  sort: string;
  p: number;
  view: "card" | "list";
}

const URL_DEFAULTS: ResourceUrlState = {
  q: "", sub: "all", sec: "all", sta: "all", perm: "all",
  rc: "all", rp: "all", tags: [], tm: "all",
  sort: DEFAULT_SORT_KEY, p: 1, view: "card",
};

export function ResourcesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const filters = useResourceFilters();

  // 列数与每页大小由共享 hook 按容器宽度连续计算
  const contentRef = React.useRef<HTMLDivElement>(null);
  const { pageSize: cardPageSize, gridStyle } = useResponsiveGrid(contentRef);
  const [listPageSize, setListPageSize] = React.useState(12);
  React.useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const compute = () => {
      if (el.clientHeight) setListPageSize(Math.max(5, Math.floor((el.clientHeight - 42) / 60)));
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 筛选 + 页码统一编码到 URL ?s=…
  const [urlState, setUrlState] = useEncodedUrlState({ defaults: URL_DEFAULTS });
  const viewMode = urlState.view === "list" ? "list" : "card";
  const pageSize = viewMode === "list" ? listPageSize : cardPageSize;
  const setViewMode = (view: "card" | "list") => {
    setUrlState((prev) => ({ ...prev, view, p: 1 }));
  };

  // URL → zustand store（仅首次挂载时同步）
  const initialized = React.useRef(false);
  if (!initialized.current) {
    initialized.current = true;
    const s = urlState;
    filters.setQuery(s.q);
    filters.setSubject(s.sub);
    filters.setSecrecy(s.sec as "all" | "public" | "confidential" | "secret");
    filters.setStatus(s.sta as "all" | "active" | "disabled");
    filters.setPermission(s.perm as "all" | "created" | "managed" | "visible");
    filters.setRemarkCommon(s.rc as "all" | "has" | "none");
    filters.setRemarkPersonal(s.rp as "all" | "has" | "none");
    filters.setTags(s.tags);
    filters.setTagsMode(s.tm as "any" | "all");
    filters.setSort(s.sort as SortKey);
    // URL 中有状态时告诉 store 跳过 initDefaults 覆写
    if (new URLSearchParams(window.location.search).has("s")) {
      markResourceFiltersUrlRestored();
    }
  }

  // zustand → URL（筛选变化时重置页码）
  const prevFiltersKey = React.useRef("");
  React.useEffect(() => {
    const key = JSON.stringify({
      q: filters.query, sub: filters.subject, sec: filters.secrecy,
      sta: filters.status, perm: filters.permission,
      rc: filters.remarkCommon, rp: filters.remarkPersonal,
      tags: filters.tags, tm: filters.tagsMode, sort: filters.sort,
    });
    if (key === prevFiltersKey.current) return;
    const filtersChanged = prevFiltersKey.current !== "";
    prevFiltersKey.current = key;
    setUrlState((prev) => ({
      ...prev,
      q: filters.query, sub: filters.subject, sec: filters.secrecy,
      sta: filters.status, perm: filters.permission,
      rc: filters.remarkCommon, rp: filters.remarkPersonal,
      tags: filters.tags, tm: filters.tagsMode, sort: filters.sort,
      p: filtersChanged ? 1 : prev.p,
    }));
  }, [
    filters.query, filters.subject, filters.secrecy, filters.status,
    filters.permission, filters.remarkCommon, filters.remarkPersonal,
    filters.tags, filters.tagsMode, filters.sort, setUrlState,
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
      secrecy: filters.secrecy !== "all" ? filters.secrecy : undefined,
      permission: filters.permission !== "all" ? filters.permission : undefined,
      remark_common: filters.remarkCommon !== "all" ? filters.remarkCommon : undefined,
      remark_personal: filters.remarkPersonal !== "all" ? filters.remarkPersonal : undefined,
      tags: filters.tags.length > 0 ? serializeTags(filters.tags) : undefined,
      tags_mode: filters.tagsMode,
      sort: filters.sort,
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
    queryKeyPrefix: "resources",
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

  // 详情按需加载
  const [detailResourceId, setDetailResourceId] = React.useState<number | null>(null);
  const [editResource, setEditResource] = React.useState<Resource | null>(null);
  const [newVersionResource, setNewVersionResource] = React.useState<Resource | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);
  const [newVersionOpen, setNewVersionOpen] = React.useState(false);
  const [downloadCtx, setDownloadCtx] = React.useState<
    { resource: Resource; version: ResourceVersion } | null
  >(null);
  const [previewResource, setPreviewResource] = React.useState<Resource | null>(null);

  // 按需加载完整资源数据（用于详情/编辑/新版本弹窗）
  const { data: fullResourceData } = useQuery({
    queryKey: ["resources", detailResourceId],
    queryFn: async () => {
      const res = await api<{ resource: Resource }>(`/api/resources/${detailResourceId}`);
      return res.resource;
    },
    enabled: detailResourceId != null,
  });
  const detailResource = detailResourceId != null ? fullResourceData ?? null : null;

  const fetchFullResource = React.useCallback(async (r: Resource): Promise<Resource> => {
    // 如果已有完整数据（含 versions），直接返回
    if (r.versions) return r;
    const res = await api<{ resource: Resource }>(`/api/resources/${r.id}`);
    return res.resource;
  }, []);

  const handleOpenDetail = (r: Resource) => {
    setDetailResourceId(r.id);
  };

  const handleEdit = async (r: Resource) => {
    const full = await fetchFullResource(r);
    setEditResource(full);
    setEditOpen(true);
    setDetailResourceId(null);
  };

  const handleNewVersion = async (r: Resource) => {
    const full = await fetchFullResource(r);
    setNewVersionResource(full);
    setNewVersionOpen(true);
    setDetailResourceId(null);
  };

  const handleDownload = (r: Resource, version: ResourceVersion) => {
    setDownloadCtx({ resource: r, version });
  };

  const handlePreview = React.useCallback((r: Resource) => {
    setPreviewResource(r);
  }, []);

  // 列表选择可跨页；筛选条件变化时清空，避免批量操作作用到隐藏的旧结果。
  const [selectedIds, setSelectedIds] = React.useState<Set<number>>(new Set());
  const [manageableIds, setManageableIds] = React.useState<Set<number>>(new Set());
  const resourceCacheRef = React.useRef<Map<number, Resource>>(new Map());
  const clearSelection = React.useCallback(() => {
    setSelectedIds(new Set());
    setManageableIds(new Set());
    resourceCacheRef.current.clear();
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
    resources.forEach((r) => resourceCacheRef.current.set(r.id, r));
    setManageableIds((prev) => {
      const next = new Set(prev);
      resources.forEach((r) => { if (r.can_manage) next.add(r.id); else next.delete(r.id); });
      return next;
    });
  }, [resources]);

  const toggleSelect = (id: number) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const togglePage = (checked: boolean) => setSelectedIds((prev) => {
    const next = new Set(prev);
    resources.forEach((r) => { if (checked) next.add(r.id); else next.delete(r.id); });
    return next;
  });
  const allPageSelected = resources.length > 0 && resources.every((r) => selectedIds.has(r.id));
  const somePageSelected = resources.some((r) => selectedIds.has(r.id)) && !allPageSelected;
  const allManageable = selectedIds.size > 0 && [...selectedIds].every((id) => manageableIds.has(id));
  const [selectingAll, setSelectingAll] = React.useState(false);
  const selectAll = async () => {
    setSelectingAll(true);
    try {
      const [all, managed] = await Promise.all([
        api<{ ids: number[] }>("/api/resources/ids", { params: apiParams }),
        api<{ ids: number[] }>("/api/resources/ids", { params: { ...apiParams, manageable_only: true } }),
      ]);
      setSelectedIds(new Set(all.ids));
      setManageableIds(new Set(managed.ids));
      toast.success(`已选中当前筛选的 ${all.ids.length} 项素材`);
    } catch (err) {
      toast.error((err as Error).message || "全选失败");
    } finally {
      setSelectingAll(false);
    }
  };

  const [batchEditOpen, setBatchEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const deleteSelected = async () => {
    if (!allManageable) return;
    setDeleting(true);
    try {
      await api("/api/resources/batch", { method: "DELETE", json: { resource_ids: [...selectedIds] } });
      toast.success(`已删除 ${selectedIds.size} 项素材`);
      clearSelection();
      setDeleteOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["resources"] });
    } catch (err) {
      toast.error((err as Error).message || "批量删除失败");
    } finally {
      setDeleting(false);
    }
  };

  const [addOpen, setAddOpen] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const { data: showsData, isLoading: showsLoading } = useQuery({
    queryKey: ["shows"],
    queryFn: () => api<{ items: Show[] }>("/api/shows"),
    enabled: addOpen && !!user,
    staleTime: 60_000,
  });
  const addSelectedToShow = async (show: Show) => {
    setAddOpen(false);
    setAdding(true);
    const ids = [...selectedIds];
    const succeeded: number[] = [];
    let added = 0;
    try {
      // 限制并发，避免跨页全选后瞬间发送大量请求。
      for (let i = 0; i < ids.length; i += 8) {
        const results = await Promise.allSettled(ids.slice(i, i + 8).map((id) =>
          api<{ added: boolean }>(`/api/shows/${show.id}/resources/append`, { method: "POST", json: { resource_id: id } }),
        ));
        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            succeeded.push(ids[i + index]);
            if (result.value.added) added++;
          }
        });
      }
      if (succeeded.length < ids.length) toast.error(`${ids.length - succeeded.length} 项添加失败，可重试剩余选择`);
      else toast.success(`已添加 ${added} 项到「${show.name}」${ids.length > added ? `，${ids.length - added} 项原已存在` : ""}`);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        succeeded.forEach((id) => next.delete(id));
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ["shows"] });
    } catch (err) {
      toast.error((err as Error).message || "添加到放映失败");
    } finally {
      setAdding(false);
    }
  };

  const pageStart = (page - 1) * pageSize;

  return (
    <div className="flex h-full flex-col gap-4">
      {/* 页头 */}
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">单页素材</h1>
          <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground">
            {total > 0 ? `共 ${total} 条` : "共 0 条"}
          </span>
        </div>
        <div className="flex shrink-0 items-center rounded-md border p-0.5" aria-label="素材视图">
          <button type="button" aria-label="卡片视图" aria-pressed={viewMode === "card"} onClick={() => setViewMode("card")} className={`rounded p-1.5 ${viewMode === "card" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}><LayoutGrid className="h-4 w-4" /></button>
          <button type="button" aria-label="列表视图" aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")} className={`rounded p-1.5 ${viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}><LayoutList className="h-4 w-4" /></button>
        </div>
      </header>

      <ResourceFilters
        subjects={subjects}
        tags={tags}
        actions={
          user ? (
            <>
              <Button
                size="sm"
                onClick={() => navigate("/resources/import")}
                className="h-8 gap-1.5 rounded-full px-3 text-sm"
              >
                <Upload className="h-3.5 w-3.5" />
                导入素材
              </Button>
            </>
          ) : null
        }
      />

      {viewMode === "list" && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Checkbox checked={allPageSelected ? true : somePageSelected ? "indeterminate" : false} onCheckedChange={(checked) => togglePage(checked === true)} aria-label="选择本页素材" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="h-7 gap-1 px-1">选择 <ChevronDown className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => togglePage(true)}><Check className="mr-2 h-4 w-4" />全选本页</DropdownMenuItem>
              <DropdownMenuItem onSelect={selectAll} disabled={total === 0 || selectingAll}><ListChecks className="mr-2 h-4 w-4" />全选所有筛选结果 ({total})</DropdownMenuItem>
              <DropdownMenuItem onSelect={clearSelection}><X className="mr-2 h-4 w-4" />清空选择</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {selectedIds.size > 0 && <>
            <span className="text-muted-foreground">已选 <span className="font-medium text-primary">{selectedIds.size}</span> 项</span>
            <Button variant="ghost" size="sm" className="h-7 px-1" onClick={clearSelection}>清空</Button>
          </>}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {user && <DropdownMenu open={addOpen} onOpenChange={setAddOpen}>
              <DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="h-8 gap-1" disabled={!selectedIds.size || adding}><Plus className="h-3.5 w-3.5" />添加到放映</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {showsLoading ? <DropdownMenuItem disabled>加载中…</DropdownMenuItem> : (showsData?.items.filter((s) => s.can_manage) ?? []).length === 0 ? <DropdownMenuItem disabled>没有可管理的放映</DropdownMenuItem> : showsData?.items.filter((s) => s.can_manage).map((s) => <DropdownMenuItem key={s.id} onSelect={() => { void addSelectedToShow(s); }}>{s.name}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>}
            <Button variant="outline" size="sm" className="h-8 gap-1" disabled={!allManageable} title={selectedIds.size && !allManageable ? "批量编辑仅支持所选素材全部可管理时使用" : undefined} onClick={() => setBatchEditOpen(true)}><Pencil className="h-3.5 w-3.5" />批量编辑</Button>
            <Button variant="outline" size="sm" className="h-8 gap-1 text-destructive hover:text-destructive" disabled={!allManageable} title={selectedIds.size && !allManageable ? "批量删除仅支持所选素材全部可管理时使用" : undefined} onClick={() => setDeleteOpen(true)}><Trash2 className="h-3.5 w-3.5" />批量删除</Button>
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
        ) : resources.length === 0 ? (
          <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">
            没有匹配的资源
          </div>
        ) : (
          viewMode === "list" ? <ResourceListView
            resources={resources}
            selectedIds={selectedIds}
            allPageSelected={allPageSelected}
            somePageSelected={somePageSelected}
            onToggle={toggleSelect}
            onTogglePage={togglePage}
            onOpen={handleOpenDetail}
            onPreview={handlePreview}
            onDownload={(r) => handleDownload(r, r.current)}
            onEdit={handleEdit}
            onNewVersion={handleNewVersion}
          /> : <div className="grid content-start" style={gridStyle}>
            {resources.map((r) => (
              <ResourceCard
                key={r.id}
                resource={r}
                onOpen={handleOpenDetail}
                onEdit={handleEdit}
                onNewVersion={handleNewVersion}
                onDownload={(x) => handleDownload(x, x.current)}
                onFullscreen={handlePreview}
              />
            ))}
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

      <ResourceDetailDialog
        open={detailResourceId != null}
        onOpenChange={(open) => {
          if (!open) setDetailResourceId(null);
        }}
        resource={detailResource}
        onEdit={handleEdit}
        onNewVersion={handleNewVersion}
        onDownload={handleDownload}
        onFullscreen={handlePreview}
      />

      <ResourceEditDialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) setEditResource(null);
        }}
        resource={editResource}
        tagSuggestions={tags}
        subjectSuggestions={subjects}
      />

      <ResourceNewVersionDialog
        open={newVersionOpen}
        onOpenChange={(open) => {
          setNewVersionOpen(open);
          if (!open) setNewVersionResource(null);
        }}
        resource={newVersionResource}
      />

      <ResourceDownloadDialog
        open={downloadCtx != null}
        onOpenChange={(open) => {
          if (!open) setDownloadCtx(null);
        }}
        resource={downloadCtx?.resource ?? null}
        version={downloadCtx?.version ?? null}
      />

      <ResourcePreviewDialog
        open={previewResource != null}
        onOpenChange={(open) => {
          if (!open) setPreviewResource(null);
        }}
        resource={previewResource}
      />

      <BatchEditDialog
        open={batchEditOpen}
        onOpenChange={setBatchEditOpen}
        resourceIds={[...selectedIds]}
        resources={[...selectedIds].map((id) => resourceCacheRef.current.get(id)).filter((r): r is Resource => !!r)}
        onSuccess={() => {
          clearSelection();
          queryClient.invalidateQueries({ queryKey: ["resources"] });
        }}
      />
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>确认批量删除</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">确定删除选中的 {selectedIds.size} 项素材吗？此操作不可撤销。</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>取消</Button>
            <Button variant="destructive" onClick={deleteSelected} disabled={deleting || !allManageable}>{deleting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
