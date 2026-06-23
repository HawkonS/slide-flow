import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Scissors, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BatchSplitImportDialog } from "@/components/resource/BatchSplitImportDialog";
import { ResourceCard } from "@/components/resource/ResourceCard";
import { ResourceDetailDialog } from "@/components/resource/ResourceDetailDialog";
import { ResourceDownloadDialog } from "@/components/resource/ResourceDownloadDialog";
import { ResourceEditDialog } from "@/components/resource/ResourceEditDialog";
import { ResourcePreviewDialog } from "@/components/resource/ResourcePreviewDialog";
import { ResourceFilters } from "@/components/resource/ResourceFilters";
import { ResourceNewVersionDialog } from "@/components/resource/ResourceNewVersionDialog";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { serializeTags } from "@/lib/types";
import { Resource, ResourceVersion } from "@/lib/types";
import { useNavLabel } from "@/lib/nav-config";
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
}

const URL_DEFAULTS: ResourceUrlState = {
  q: "", sub: "all", sec: "all", sta: "all", perm: "all",
  rc: "all", rp: "all", tags: [], tm: "all",
  sort: DEFAULT_SORT_KEY, p: 1,
};

export function ResourcesPage() {
  const { user } = useAuth();
  const filters = useResourceFilters();
  const queryClient = useQueryClient();

  // 列数与每页大小由共享 hook 按容器宽度连续计算
  const contentRef = React.useRef<HTMLDivElement>(null);
  const { pageSize, gridStyle } = useResponsiveGrid(contentRef);

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
      resource_type: "asset" as const,
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
  React.useEffect(() => {
    if (totalPages > 0 && page > totalPages) setPage(1);
  }, [page, totalPages, setPage]);

  // 详情按需加载
  const [detailResourceId, setDetailResourceId] = React.useState<number | null>(null);
  const [editResource, setEditResource] = React.useState<Resource | null>(null);
  const [newVersionResource, setNewVersionResource] = React.useState<Resource | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [newVersionOpen, setNewVersionOpen] = React.useState(false);
  const [batchSplitOpen, setBatchSplitOpen] = React.useState(false);
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

  const pageStart = (page - 1) * pageSize;

  return (
    <div className="flex h-full flex-col gap-4">
      {/* 页头 */}
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">{useNavLabel("resources", "资源仓库")}</h1>
          <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground">
            {total > 0 ? `共 ${total} 条` : "共 0 条"}
          </span>
        </div>
      </header>

      <ResourceFilters
        subjects={subjects}
        tags={tags}
        actions={
          user ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setBatchSplitOpen(true)}
                className="h-8 gap-1.5 rounded-full px-3 text-sm"
              >
                <Scissors className="h-3.5 w-3.5" />
                拆分导入
              </Button>
              <Button
                size="sm"
                onClick={() => setCreateOpen(true)}
                className="h-8 gap-1.5 rounded-full px-3 text-sm"
              >
                <Upload className="h-3.5 w-3.5" />
                资源导入
              </Button>
            </>
          ) : null
        }
      />

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
          <div className="grid content-start" style={gridStyle}>
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
        open={createOpen}
        onOpenChange={setCreateOpen}
        resource={null}
        tagSuggestions={tags}
        subjectSuggestions={subjects}
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

      <BatchSplitImportDialog
        open={batchSplitOpen}
        onOpenChange={setBatchSplitOpen}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ["resources"] });
        }}
      />
    </div>
  );
}
