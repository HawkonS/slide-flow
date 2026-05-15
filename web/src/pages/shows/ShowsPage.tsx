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
import { DEFAULT_RESOURCE_SUBJECT } from "@/lib/constants";
import { sortListItems } from "@/lib/sort";
import { parseTags, Show } from "@/lib/types";
import { useShowFilters } from "@/stores/show-filters";

interface ShowListResponse {
  shows: Show[];
}

export function ShowsPage() {
  const { user } = useAuth();
  const filters = useShowFilters();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["shows"],
    queryFn: async () => api<ShowListResponse>("/api/shows"),
  });

  const shows = data?.shows ?? [];

  const { subjects, tags } = React.useMemo(() => {
    const subjectSet = new Set<string>();
    const tagSet = new Set<string>();
    shows.forEach((s) => {
      if (s.subject) subjectSet.add(s.subject.trim());
      parseTags(s.tags).forEach((t) => tagSet.add(t));
    });
    return {
      subjects: Array.from(subjectSet),
      tags: Array.from(tagSet).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    };
  }, [shows]);

  const filtered = React.useMemo(() => {
    const q = filters.query.trim().toLowerCase();
    const list = shows.filter((s) => {
      const sTags = new Set(parseTags(s.tags));

      if (filters.tags.length > 0) {
        if (filters.tagsMode === "all") {
          if (!filters.tags.every((t) => sTags.has(t))) return false;
        } else {
          if (!filters.tags.some((t) => sTags.has(t))) return false;
        }
      }

      const subject = s.subject || DEFAULT_RESOURCE_SUBJECT;
      if (filters.subject !== "all" && subject !== filters.subject) return false;

      if (filters.status !== "all" && s.status !== filters.status) return false;
      if (filters.secrecy !== "all" && s.secrecy_level !== filters.secrecy) return false;

      if (filters.permission === "created") {
        if (!user || s.owner_id !== user.id) return false;
      } else if (filters.permission === "managed") {
        if (!s.can_manage) return false;
      }

      if (q) {
        const hay = [
          s.name,
          s.subject || "",
          s.owner?.name || "",
          s.owner?.username || "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return sortListItems(list, filters.sort);
  }, [shows, filters, user]);

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

  // 对话框状态预留
  const [detailShow, setDetailShow] = React.useState<Show | null>(null);
  const [editShow, setEditShow] = React.useState<Show | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [iterateShow, setIterateShow] = React.useState<Show | null>(null);

  const handleDelete = async (show: Show) => {
    if (!window.confirm(`确定要删除放映「${show.name}」吗？此操作不可撤销。`)) return;
    try {
      await api(`/api/shows/${show.id}`, { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: ["shows"] });
    } catch (err) {
      alert("删除失败：" + ((err as Error)?.message || "未知错误"));
    }
  };

  return (
    <div className="flex h-full flex-col gap-8">
      {/* 页头：与模板仓库一致的结构（左标题+描述，右总数徽章） */}
      <header className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">放映仓库</h1>
          <p className="text-xs text-muted-foreground">
            使用搜索与筛选快速定位放映组，点击卡片查看详情。
          </p>
        </div>
        <span className="inline-flex h-6 items-center rounded-full bg-muted px-2.5 text-xs text-muted-foreground">
          {filtered.length === shows.length
            ? `共 ${shows.length} 条`
            : `筛选后 ${filtered.length} / ${shows.length} 条`}
        </span>
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
            没有匹配的放映
          </div>
        ) : (
          <div className="grid grid-cols-2 content-start gap-x-4 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 lg:gap-x-5 lg:gap-y-6 xl:gap-x-6 xl:gap-y-7">
            {pageItems.map((s) => (
              <ShowCard
                key={s.id}
                show={s}
                onOpen={(x) => setDetailShow(x)}
                onEdit={(x) => {
                  setEditShow(x);
                  setEditOpen(true);
                }}
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
        open={detailShow != null}
        onOpenChange={(open) => {
          if (!open) setDetailShow(null);
        }}
        show={detailShow}
        onEdit={(s) => {
          setEditShow(s);
          setEditOpen(true);
          setDetailShow(null);
        }}
        onDuplicate={(s) => {
          const newName = window.prompt("请输入副本名称", `${s.name} - 副本`);
          if (newName?.trim()) {
            api(`/api/shows/${s.id}/duplicate`, { method: "POST", json: { name: newName.trim() } })
              .then(() => {
                toast.success("副本已创建");
                queryClient.invalidateQueries({ queryKey: ["shows"] });
                setDetailShow(null);
              })
              .catch((err: Error) => toast.error(err.message || "创建副本失败"));
          }
        }}
        onIterate={(s) => {
          setIterateShow(s);
          setDetailShow(null);
        }}
        onSwitchVersion={async (showId: number) => {
          // 从已有数据中查找，或重新 fetch
          const found = shows.find((s) => s.id === showId);
          if (found) {
            setDetailShow(found);
          } else {
            try {
              const res = await api<{ show: Show }>(`/api/shows/${showId}`);
              setDetailShow(res.show);
            } catch {
              toast.error("加载版本详情失败");
            }
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
