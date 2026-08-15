import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ShowCard } from "@/components/show/ShowCard";
import { ShowFilters } from "@/components/show/ShowFilters";
import { ShowEditDialog } from "@/components/show/ShowEditDialog";
import { ShowDetailDialog } from "@/components/show/ShowDetailDialog";
import { ShowUpgradeDialog } from "@/components/show/ShowUpgradeDialog";
import {
  DeleteScopeDialog,
  type DeleteScope,
} from "@/components/common/DeleteScopeDialog";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { serializeTags, Show } from "@/lib/types";
import { useResponsiveGrid } from "@/lib/use-grid-layout";
import { useEncodedUrlState } from "@/lib/use-encoded-url-state";
import { useNavLabel } from "@/lib/nav-config";
import { useShowFilters } from "@/stores/show-filters";
import { DEFAULT_SORT_KEY, type SortKey } from "@/lib/constants";
import { usePaginatedQuery } from "@/lib/use-paginated-query";

/* ---- URL 持久化状态类型与默认值 ---- */
interface ShowUrlState {
  q: string;
  sub: string;
  sec: string;
  sta: string;
  perm: string;
  tags: string[];
  tm: string;
  sort: string;
  p: number;
}

const URL_DEFAULTS: ShowUrlState = {
  q: "", sub: "all", sec: "all", sta: "active", perm: "all",
  tags: [], tm: "all", sort: DEFAULT_SORT_KEY, p: 1,
};

export function ShowsPage() {
  const { user } = useAuth();
  const filters = useShowFilters();
  const queryClient = useQueryClient();

  // 分页
  const contentRef = React.useRef<HTMLDivElement>(null);
  const { pageSize, gridStyle } = useResponsiveGrid(contentRef);

  // 筛选 + 页码统一编码到 URL ?s=…
  const [urlState, setUrlState] = useEncodedUrlState({ defaults: URL_DEFAULTS });

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
    filters.setSecrecy(s.sec as "all" | "public" | "confidential" | "secret");
    filters.setStatus(s.sta as "all" | "active" | "disabled");
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
      q: filters.query, sub: filters.subject, sec: filters.secrecy,
      sta: filters.status, perm: filters.permission,
      tags: filters.tags, tm: filters.tagsMode, sort: filters.sort,
    });
    if (key === prevFiltersKey.current) return;
    const filtersChanged = prevFiltersKey.current !== "";
    prevFiltersKey.current = key;
    setUrlState((prev) => ({
      q: filters.query, sub: filters.subject, sec: filters.secrecy,
      sta: filters.status, perm: filters.permission,
      tags: filters.tags, tm: filters.tagsMode, sort: filters.sort,
      p: filtersChanged ? 1 : prev.p,
    }));
  }, [
    filters.query, filters.subject, filters.secrecy, filters.status,
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

  // 页码越界检查
  // 增加 page !== 1 守卫，避免与其他 setPage 调用产生竞态、
  // 也避免页码已为 1 时仍然触发一次不必要的 setState。
  React.useEffect(() => {
    if (totalPages > 0 && page > totalPages && page !== 1) {
      setPage(1);
    }
  }, [page, totalPages, setPage]);

  // 详情按需加载（完整数据含所有资源）
  const [detailShowId, setDetailShowId] = React.useState<number | null>(null);
  const [editShow, setEditShow] = React.useState<Show | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [iterateShow, setIterateShow] = React.useState<Show | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<Show | null>(null);

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

  const handleDelete = (show: Show) => {
    // 多版本放映：弹窗让用户选择删除范围
    if (show.has_other_versions) {
      setDeleteTarget(show);
      return;
    }
    if (!window.confirm(`确定要删除放映「${show.name}」吗？此操作不可撤销。`)) return;
    deleteMutation.mutate({ id: show.id, scope: "latest" });
  };

  const pageStart = (page - 1) * pageSize;

  return (
    <div className="flex h-full flex-col gap-4">
      {/* 页头 */}
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">{useNavLabel("shows", "放映仓库")}</h1>
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
        onIterate={(newShow) => {
          // 创建新版本成功后，切换详情卡片到最新版本
          setDetailShowId(null);
          setTimeout(() => setDetailShowId(newShow.id), 0);
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
          onSuccess={(newShow) => {
            setIterateShow(null);
            // 创建成功后打开新版本的详情卡片
            setTimeout(() => setDetailShowId(newShow.id), 0);
          }}
        />
      )}

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
