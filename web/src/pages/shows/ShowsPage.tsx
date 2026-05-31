import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ShowCard } from "@/components/show/ShowCard";
import { ShowFilters } from "@/components/show/ShowFilters";
import { ShowEditDialog } from "@/components/show/ShowEditDialog";
import { ShowDetailDialog } from "@/components/show/ShowDetailDialog";
import { ShowUpgradeDialog } from "@/components/show/ShowUpgradeDialog";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { serializeTags, Show } from "@/lib/types";
import { useResponsiveGrid } from "@/lib/use-grid-layout";
import { useShowFilters } from "@/stores/show-filters";
import { usePaginatedQuery } from "@/lib/use-paginated-query";

export function ShowsPage() {
  const { user } = useAuth();
  const filters = useShowFilters();
  const queryClient = useQueryClient();

  // 分页
  const contentRef = React.useRef<HTMLDivElement>(null);
  const { pageSize, gridStyle } = useResponsiveGrid(contentRef);
  const [page, setPage] = React.useState(1);

  // 构建后端查询参数
  const apiParams = React.useMemo(
    () => ({
      search: filters.query.trim() || undefined,
      subject: filters.subject !== "all" ? filters.subject : undefined,
      status: filters.status !== "all" ? filters.status : undefined,
      secrecy: filters.secrecy !== "all" ? filters.secrecy : undefined,
      permission: filters.permission !== "all" ? filters.permission : undefined,
      tags: filters.tags.length > 0 ? serializeTags(filters.tags) : undefined,
      tags_mode: filters.tagsMode,
      sort: filters.sort,
    }),
    [filters],
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

  // 筛选变化时重置页码
  React.useEffect(() => {
    setPage(1);
  }, [apiParams]);

  React.useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);

  // 详情按需加载（完整数据含所有资源）
  const [detailShowId, setDetailShowId] = React.useState<number | null>(null);
  const [editShow, setEditShow] = React.useState<Show | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [iterateShow, setIterateShow] = React.useState<Show | null>(null);

  const { data: fullShowData } = useQuery({
    queryKey: ["shows", detailShowId],
    queryFn: async () => {
      const res = await api<{ show: Show }>(`/api/shows/${detailShowId}`);
      return res.show;
    },
    enabled: detailShowId != null,
  });
  const detailShow = detailShowId != null ? fullShowData ?? null : null;

  const fetchFullShow = React.useCallback(async (s: Show): Promise<Show> => {
    if (s.resources?.length && s.visible_user_ids) return s;
    const res = await api<{ show: Show }>(`/api/shows/${s.id}`);
    return res.show;
  }, []);

  const handleOpenDetail = (s: Show) => {
    setDetailShowId(s.id);
  };

  const handleEdit = async (s: Show) => {
    const full = await fetchFullShow(s);
    setEditShow(full);
    setEditOpen(true);
    setDetailShowId(null);
  };

  const handleDelete = async (show: Show) => {
    if (!window.confirm(`确定要删除放映「${show.name}」吗？此操作不可撤销。`)) return;
    try {
      await api(`/api/shows/${show.id}`, { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: ["shows"] });
    } catch (err) {
      alert("删除失败：" + ((err as Error)?.message || "未知错误"));
    }
  };

  const pageStart = (page - 1) * pageSize;

  return (
    <div className="flex h-full flex-col gap-4">
      {/* 页头 */}
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">放映仓库</h1>
          <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground">
            {total > 0 ? `共 ${total} 条` : "共 0 条"}
          </span>
        </div>
      </header>

      <ShowFilters
        subjects={subjects}
        tags={tags}
        actions={
          user ? (
            <Button
              size="sm"
              onClick={() => setCreateOpen(true)}
              className="h-8 gap-1.5 rounded-full px-3 text-sm"
            >
              <Plus className="h-3.5 w-3.5" />
              创建放映
            </Button>
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
        ) : shows.length === 0 ? (
          <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">
            没有匹配的放映
          </div>
        ) : (
          <div className="grid content-start" style={gridStyle}>
            {shows.map((s) => (
              <ShowCard
                key={s.id}
                show={s}
                onOpen={handleOpenDetail}
                onEdit={handleEdit}
                onDuplicate={(s) => {
                  const newName = window.prompt("请输入副本名称", `${s.name} - 副本`);
                  if (newName?.trim()) {
                    api(`/api/shows/${s.id}/duplicate`, { method: "POST", json: { name: newName.trim() } })
                      .then(() => {
                        toast.success("副本已创建");
                        queryClient.invalidateQueries({ queryKey: ["shows"] });
                      })
                      .catch((err: Error) => toast.error(err.message || "创建副本失败"));
                  }
                }}
                onIterate={() => setIterateShow(s)}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* 分页条 */}
      {!isLoading && !isError && shows.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t pt-3 text-sm text-muted-foreground">
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

      <ShowEditDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        show={null}
        tagSuggestions={tags}
        subjectSuggestions={subjects}
      />

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

      <ShowDetailDialog
        open={detailShowId != null}
        onOpenChange={(open) => {
          if (!open) setDetailShowId(null);
        }}
        show={detailShow}
        onEdit={(s) => {
          setEditShow(s);
          setEditOpen(true);
          setDetailShowId(null);
        }}
        onDuplicate={(s) => {
          const newName = window.prompt("请输入副本名称", `${s.name} - 副本`);
          if (newName?.trim()) {
            api(`/api/shows/${s.id}/duplicate`, { method: "POST", json: { name: newName.trim() } })
              .then(() => {
                toast.success("副本已创建");
                queryClient.invalidateQueries({ queryKey: ["shows"] });
                setDetailShowId(null);
              })
              .catch((err: Error) => toast.error(err.message || "创建副本失败"));
          }
        }}
        onIterate={(s) => {
          setIterateShow(s);
          setDetailShowId(null);
        }}
        onSwitchVersion={async (showId: number) => {
          try {
            const res = await api<{ show: Show }>(`/api/shows/${showId}`);
            setDetailShowId(null);
            // 使用 setTimeout 确保先关闭当前详情再打开新的
            setTimeout(() => setDetailShowId(showId), 0);
          } catch {
            toast.error("加载版本详情失败");
          }
        }}
      />

      {iterateShow && (
        <ShowUpgradeDialog
          open={iterateShow != null}
          onOpenChange={(open) => {
            if (!open) setIterateShow(null);
          }}
          show={iterateShow}
          onSuccess={() => {
            setIterateShow(null);
          }}
        />
      )}
    </div>
  );
}
