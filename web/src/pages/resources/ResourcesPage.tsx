import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Scissors, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BatchSplitImportDialog } from "@/components/resource/BatchSplitImportDialog";
import { ResourceCard } from "@/components/resource/ResourceCard";
import { ResourceDetailDialog } from "@/components/resource/ResourceDetailDialog";
import { ResourceDownloadDialog } from "@/components/resource/ResourceDownloadDialog";
import { ResourceEditDialog } from "@/components/resource/ResourceEditDialog";
import { ResourceFilters } from "@/components/resource/ResourceFilters";
import { ResourceNewVersionDialog } from "@/components/resource/ResourceNewVersionDialog";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { DEFAULT_RESOURCE_SUBJECT } from "@/lib/constants";
import { sortListItems } from "@/lib/sort";
import { parseTags, Resource, ResourceVersion } from "@/lib/types";
import { useResourceFilters } from "@/stores/resource-filters";

interface ResourceListResponse {
  resources: Resource[];
}

interface PersonalRemarkSummaryResponse {
  resource_ids: number[];
}

export function ResourcesPage() {
  const { user } = useAuth();
  const filters = useResourceFilters();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["resources", "asset"],
    queryFn: async () =>
      api<ResourceListResponse>("/api/resources", { params: { resource_type: "asset" } }),
  });

  // 有非空个人备注的资源 id 集合（后端汇总，不依赖资源列表的 has_personal_remark 字段）
  const { data: remarkSummary } = useQuery({
    queryKey: ["me", "personal-remarks", "summary"],
    queryFn: async () => api<PersonalRemarkSummaryResponse>("/api/me/personal-remarks"),
    staleTime: 30_000,
  });
  const personalRemarkSet = React.useMemo(
    () => new Set<number>(remarkSummary?.resource_ids ?? []),
    [remarkSummary],
  );

  const resources = data?.resources ?? [];

  const { subjects, tags } = React.useMemo(() => {
    const subjectSet = new Set<string>();
    const tagSet = new Set<string>();
    resources.forEach((r) => {
      if (r.subject) subjectSet.add(r.subject.trim());
      parseTags(r.tags).forEach((t) => tagSet.add(t));
    });
    return {
      subjects: Array.from(subjectSet),
      tags: Array.from(tagSet).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    };
  }, [resources]);

  const filtered = React.useMemo(() => {
    const q = filters.query.trim().toLowerCase();
    const list = resources.filter((r) => {
      const rTags = new Set(parseTags(r.tags));

      if (filters.tags.length > 0) {
        if (filters.tagsMode === "all") {
          if (!filters.tags.every((t) => rTags.has(t))) return false;
        } else {
          if (!filters.tags.some((t) => rTags.has(t))) return false;
        }
      }

      const subject = r.subject || DEFAULT_RESOURCE_SUBJECT;
      if (filters.subject !== "all" && subject !== filters.subject) return false;

      if (filters.status !== "all" && r.status !== filters.status) return false;
      if (filters.secrecy !== "all" && r.secrecy_level !== filters.secrecy) return false;

      if (filters.permission === "created") {
        if (!user || r.owner_id !== user.id) return false;
      } else if (filters.permission === "managed") {
        if (!r.can_manage) return false;
      }

      if (filters.remarkCommon !== "all") {
        const plain = (r.current?.common_remark_html || "").replace(/<[^>]*>/g, "").trim();
        const has = plain.length > 0;
        if (filters.remarkCommon === "has" && !has) return false;
        if (filters.remarkCommon === "none" && has) return false;
      }
      if (filters.remarkPersonal !== "all") {
        const has = personalRemarkSet.has(r.id) || !!r.has_personal_remark;
        if (filters.remarkPersonal === "has" && !has) return false;
        if (filters.remarkPersonal === "none" && has) return false;
      }

      if (q) {
        const hay = [
          r.name,
          r.subject || "",
          r.owner?.name || "",
          r.owner?.username || "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return sortListItems(list, filters.sort);
  }, [resources, filters, user, personalRemarkSet]);

  // 分页：根据内容区尺寸动态计算每页行数，让卡片等比放大；能放下 4 行就显示 4 行
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [grid, setGrid] = React.useState({ cols: 5, rows: 3 });
  React.useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const compute = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (!W || !H) return;
      // 与 className 断点保持一致：sm:3 / md:4 / lg:5
      const cols = W >= 1024 ? 5 : W >= 768 ? 4 : W >= 640 ? 3 : 2;
      // 与 gap-x/gap-y 响应式保持一致：xl:gap-x-6/gap-y-7，lg:gap-x-5/gap-y-6，默认 gap-x-4/gap-y-5
      const gapX = W >= 1280 ? 24 : W >= 1024 ? 20 : 16;
      const gapY = W >= 1280 ? 28 : W >= 1024 ? 24 : 20;
      const titleH = 44; // 卡片标题区约 44px（px-3 py-2.5 + 单行 13px 文本）
      const cardW = (W - gapX * (cols - 1)) / cols;
      const cardH = (cardW * 9) / 16 + titleH;
      const rows = Math.max(2, Math.min(4, Math.floor((H + gapY) / (cardH + gapY))));
      setGrid((prev) => (prev.cols === cols && prev.rows === rows ? prev : { cols, rows }));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pageSize = Math.max(6, grid.cols * grid.rows);
  const [page, setPage] = React.useState(1);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  React.useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);
  const pageStart = (page - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);

  const [detailResource, setDetailResource] = React.useState<Resource | null>(null);
  const [editResource, setEditResource] = React.useState<Resource | null>(null);
  const [newVersionResource, setNewVersionResource] = React.useState<Resource | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [newVersionOpen, setNewVersionOpen] = React.useState(false);
  const [batchSplitOpen, setBatchSplitOpen] = React.useState(false);
  const [downloadCtx, setDownloadCtx] = React.useState<
    { resource: Resource; version: ResourceVersion } | null
  >(null);

  const handleEdit = (r: Resource) => {
    setEditResource(r);
    setEditOpen(true);
    setDetailResource(null);
  };

  const handleNewVersion = (r: Resource) => {
    setNewVersionResource(r);
    setNewVersionOpen(true);
    setDetailResource(null);
  };

  const handleDownload = (r: Resource, version: ResourceVersion) => {
    setDownloadCtx({ resource: r, version });
  };

  return (
    <div className="flex h-full flex-col gap-8">
      {/* 页头：与模板仓库一致的结构（左标题+描述，右总数徽章） */}
      <header className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">资源仓库</h1>
          <p className="text-xs text-muted-foreground">
            使用搜索与筛选快速定位资源，点击卡片查看详情与版本。
          </p>
        </div>
        <span className="inline-flex h-6 items-center rounded-full bg-muted px-2.5 text-xs text-muted-foreground">
          {filtered.length === resources.length
            ? `共 ${resources.length} 条`
            : `筛选后 ${filtered.length} / ${resources.length} 条`}
        </span>
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

      {/* 内容区：占剩余空间，内部根据可视高度动态行数；卡片等比放大 */}
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
            没有匹配的资源
          </div>
        ) : (
          <div className="grid grid-cols-2 content-start gap-x-4 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 lg:gap-x-5 lg:gap-y-6 xl:gap-x-6 xl:gap-y-7">
            {pageItems.map((r) => (
              <ResourceCard
                key={r.id}
                resource={r}
                onOpen={(x) => setDetailResource(x)}
                onEdit={handleEdit}
                onNewVersion={handleNewVersion}
                onDownload={(x) => handleDownload(x, x.current)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 分页条：粘底常驻（有数据时显示） */}
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

      <ResourceDetailDialog
        open={detailResource != null}
        onOpenChange={(open) => {
          if (!open) setDetailResource(null);
        }}
        resource={detailResource}
        onEdit={handleEdit}
        onNewVersion={handleNewVersion}
        onDownload={handleDownload}
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

      <BatchSplitImportDialog
        open={batchSplitOpen}
        onOpenChange={setBatchSplitOpen}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ["resources", "asset"] });
        }}
      />
    </div>
  );
}
