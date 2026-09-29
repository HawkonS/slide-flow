import * as React from "react";
import { Eye, EyeOff, GripVertical, LayoutGrid, List as ListIcon, Lock, Save } from "lucide-react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RichTextEditor } from "@/components/resource/RichTextEditor";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import {
  Resource,
  Show,
  ShowResource,
  ShowResourceAccessible,
  ShowResourceInaccessible,
} from "@/lib/types";

interface ShowResourcePrepDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  show: Show | null;
}

type ViewMode = "list" | "grid";

function isAccessible(r: ShowResource): r is ShowResourceAccessible {
  return r.accessible === true;
}

function isInaccessible(r: ShowResource): r is ShowResourceInaccessible {
  return r.accessible === false;
}

/** 获取资源详情（用于通用备注与大图预览） */
async function fetchResourceDetail(resourceId: number): Promise<Resource> {
  const res = await api<{ resource: Resource }>(
    `/api/resources/${resourceId}`,
  );
  return res.resource;
}

/** 获取个人备注 */
function fetchPersonalRemark(resourceId: number) {
  return api<{ content_html: string | null }>(
    `/api/resources/${resourceId}/personal-remark`,
  );
}

/** 获取放映备注 */
function fetchShowRemark(showId: number, resourceId: number) {
  return api<{ content_html: string | null }>(
    `/api/shows/${showId}/remarks/${resourceId}`,
  );
}

/** 小号「保存」按钮：高度压到与标签行高接近，未改时灰色不可点，已改时蓝色可点 */
function InlineSaveButton({
  dirty,
  pending,
  onClick,
}: {
  dirty: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={dirty ? "default" : "outline"}
      disabled={!dirty || pending}
      onClick={onClick}
      className="h-6 gap-1 rounded px-2 text-xs"
    >
      <Save className="h-3 w-3" />
      保存
    </Button>
  );
}

export function ShowResourcePrepDialog({
  open,
  onOpenChange,
  show,
}: ShowResourcePrepDialogProps) {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = React.useState<number | null>(null);
  const [viewMode, setViewMode] = React.useState<ViewMode>("list");
  const [orderedResources, setOrderedResources] = React.useState<
    ShowResource[]
  >([]);
  const [draggingId, setDraggingId] = React.useState<number | null>(null);

  const canManageShow = show?.can_manage ?? false;

  const toggleHidden = React.useCallback(
    async (resourceId: number, currentHidden: boolean) => {
      if (!show) return;
      // 乐观更新本地状态，立即反映在 UI 上
      setOrderedResources((prev) =>
        prev.map((r) =>
          r.id === resourceId ? { ...r, hidden: !currentHidden } : r,
        ),
      );
      try {
        await api(`/api/shows/${show.id}/resources/${resourceId}/hidden`, {
          method: "PATCH",
          json: { hidden: !currentHidden },
        });
        queryClient.invalidateQueries({ queryKey: ["shows"] });
      } catch (err: any) {
        // 失败时回滚本地状态
        setOrderedResources((prev) =>
          prev.map((r) =>
            r.id === resourceId ? { ...r, hidden: currentHidden } : r,
          ),
        );
        toast.error(err?.message || "切换隐藏状态失败");
      }
    },
    [show, queryClient],
  );

  // 打开或切换 show 时重置本地顺序和选中项
  React.useEffect(() => {
    if (!open || !show) return;
    const list = show.resources ?? [];
    setOrderedResources(list);
    setActiveId((prev) =>
      prev && list.some((r) => r.id === prev) ? prev : list[0]?.id ?? null,
    );
  }, [open, show?.id, show?.resources]);

  const reorderMutation = useMutation({
    mutationFn: async (resourceIds: number[]) => {
      if (!show) return null;
      return api(`/api/shows/${show.id}/resources`, {
        method: "PUT",
        json: { resource_ids: resourceIds },
      });
    },
    onSuccess: () => {
      toast.success("资源顺序已保存");
      queryClient.invalidateQueries({ queryKey: ["shows"] });
    },
    onError: (err: Error) => {
      toast.error(err.message || "保存顺序失败");
      // 回滚
      setOrderedResources(show?.resources ?? []);
    },
  });

  const commitReorder = React.useCallback(
    (next: ShowResource[]) => {
      const nextIds = next.map((r) => r.id);
      const originalIds = (show?.resources ?? []).map((r) => r.id);
      if (JSON.stringify(nextIds) === JSON.stringify(originalIds)) return;
      reorderMutation.mutate(nextIds);
    },
    [reorderMutation, show?.resources],
  );

  const handleDragStart = (id: number) => (e: React.DragEvent) => {
    if (!canManageShow) return;
    setDraggingId(id);
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", String(id));
    } catch {
      /* ignore */
    }
  };

  const handleDragOver = (overId: number) => (e: React.DragEvent) => {
    if (!canManageShow || draggingId === null || draggingId === overId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOrderedResources((prev) => {
      const from = prev.findIndex((r) => r.id === draggingId);
      const to = prev.findIndex((r) => r.id === overId);
      if (from < 0 || to < 0 || from === to) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const handleDragEnd = () => {
    if (draggingId !== null) {
      commitReorder(orderedResources);
    }
    setDraggingId(null);
  };

  if (!show) return null;

  const activeResource =
    orderedResources.find((r) => r.id === activeId) ?? null;
  const activeIdx = activeResource
    ? orderedResources.findIndex((r) => r.id === activeResource.id)
    : -1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(960px,95vh)] max-w-6xl flex-col gap-0 overflow-hidden p-0">
        {/* 顶部标题栏 */}
        <DialogHeader className="shrink-0 border-b px-6 py-3">
          <DialogTitle className="flex flex-wrap items-center gap-x-3 gap-y-1 pr-8 text-base font-semibold">
            <span>资源准备</span>
            {activeResource && (
              <span className="text-xs font-normal text-muted-foreground">
                第 {activeIdx + 1} / {orderedResources.length} 个
                <span className="mx-1">·</span>
                <span className="text-foreground">{activeResource.name}</span>
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            查看和编辑放映资源的备注
          </DialogDescription>
        </DialogHeader>

        {/* 主体 */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* 左栏：资源缩略图 */}
          <aside className="flex w-72 shrink-0 flex-col border-r bg-muted/20">
            <div className="flex shrink-0 items-center justify-between border-b bg-background/60 px-3 py-2">
              <span className="text-xs text-muted-foreground">
                共 {orderedResources.length} 个
                {canManageShow ? " · 可拖拽" : ""}
              </span>
              <div className="inline-flex items-center gap-0.5 rounded-md border bg-background p-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode("list")}
                  title="列表视图"
                  className={cn(
                    "inline-flex h-6 w-6 items-center justify-center rounded-sm transition",
                    viewMode === "list"
                      ? "bg-muted text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <ListIcon className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("grid")}
                  title="卡片视图"
                  className={cn(
                    "inline-flex h-6 w-6 items-center justify-center rounded-sm transition",
                    viewMode === "grid"
                      ? "bg-muted text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {viewMode === "list" ? (
                <ul className="flex flex-col gap-1.5">
                  {orderedResources.map((r, idx) => {
                    const active = r.id === activeId;
                    const dragging = r.id === draggingId;
                    return (
                      <li
                        key={r.id}
                        draggable={canManageShow}
                        onDragStart={handleDragStart(r.id)}
                        onDragOver={handleDragOver(r.id)}
                        onDragEnd={handleDragEnd}
                        onClick={() => setActiveId(r.id)}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-md border bg-background p-1.5 text-left transition",
                          active
                            ? "border-primary ring-1 ring-primary/40"
                            : "border-transparent hover:border-border hover:bg-accent",
                          dragging && "opacity-40",
                          r.hidden && "opacity-50 bg-muted",
                        )}
                      >
                        <span className="w-5 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground">
                          {idx + 1}
                        </span>
                        {canManageShow && (
                          <GripVertical className="h-3 w-3 shrink-0 cursor-grab text-muted-foreground" />
                        )}
                        <div
                          className="shrink-0 overflow-hidden rounded border bg-muted"
                          style={{ width: 56 }}
                        >
                          <div className="relative aspect-[16/9] w-full">
                            {isAccessible(r) ? (
                              r.preview_url || r.original_preview_url ? (
                                <img
                                  src={
                                    (r.preview_url ||
                                      r.original_preview_url) ??
                                    ""
                                  }
                                  alt={r.name}
                                  className="absolute inset-0 h-full w-full object-cover"
                                />
                              ) : (
                                <div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">
                                  无预览
                                </div>
                              )
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                                <Lock className="h-3 w-3" />
                              </div>
                            )}
                          </div>
                        </div>
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 text-xs leading-snug">
                            {r.name}
                          </span>
                        </span>
                        {canManageShow && (
                          <button
                            type="button"
                            draggable={false}
                            title={r.hidden ? "显示资源" : "隐藏资源"}
                            onPointerDown={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleHidden(r.id, r.hidden);
                            }}
                            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition"
                          >
                            {r.hidden ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <ul className="grid grid-cols-2 gap-2">
                  {orderedResources.map((r, idx) => {
                    const active = r.id === activeId;
                    const dragging = r.id === draggingId;
                    return (
                      <li
                        key={r.id}
                        draggable={canManageShow}
                        onDragStart={handleDragStart(r.id)}
                        onDragOver={handleDragOver(r.id)}
                        onDragEnd={handleDragEnd}
                        onClick={() => setActiveId(r.id)}
                        title={r.name}
                        className={cn(
                          "relative cursor-pointer overflow-hidden rounded-md border bg-muted transition",
                          active
                            ? "ring-2 ring-primary ring-offset-1"
                            : "hover:ring-1 hover:ring-border",
                          dragging && "opacity-40",
                          r.hidden && "opacity-50",
                        )}
                      >
                        <div className="relative aspect-[16/9] w-full">
                          {isAccessible(r) ? (
                            r.preview_url || r.original_preview_url ? (
                              <img
                                src={
                                  (r.preview_url || r.original_preview_url) ??
                                  ""
                                }
                                alt={r.name}
                                className="absolute inset-0 h-full w-full object-cover"
                              />
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">
                                无预览
                              </div>
                            )
                          ) : (
                            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                              <Lock className="h-4 w-4" />
                            </div>
                          )}
                        </div>
                        <span className="absolute left-1 top-1 rounded bg-background/85 px-1 text-[10px] tabular-nums text-foreground shadow-sm">
                          {idx + 1}
                        </span>
                        {canManageShow && (
                          <button
                            type="button"
                            draggable={false}
                            title={r.hidden ? "显示资源" : "隐藏资源"}
                            onPointerDown={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleHidden(r.id, r.hidden);
                            }}
                            className="absolute bottom-1 right-1 rounded bg-background/85 p-0.5 text-muted-foreground shadow-sm hover:text-foreground transition"
                          >
                            {r.hidden ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </aside>

          {/* 右栏：预览图 + 备注 Tabs */}
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {activeResource ? (
              isInaccessible(activeResource) ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                  <Lock className="h-8 w-8" />
                  <p className="text-sm">无权限查看此资源的备注</p>
                </div>
              ) : (
                <div className="flex min-h-0 w-full flex-1 flex-col gap-3 overflow-hidden px-6 py-4">
                  {/* 预览图：宽度填满容器，保持 16:9 */}
                  <div className="relative aspect-[16/9] w-full shrink-0 overflow-hidden rounded-md border bg-muted shadow-sm">
                    <ResourcePreviewImage
                      key={`preview-${activeResource.id}`}
                      resourceId={activeResource.id}
                      fallbackPreviewUrl={
                        activeResource.preview_url ||
                        activeResource.original_preview_url ||
                        null
                      }
                    />
                  </div>

                  {/* 通用备注 */}
                  <CommonRemarkEditor
                    key={`common-${activeResource.id}`}
                    resourceId={activeResource.id}
                    queryClient={queryClient}
                  />

                  {/* 个人 + 放映 */}
                  <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2">
                    <PersonalRemarkSection
                      key={`personal-${activeResource.id}`}
                      resourceId={activeResource.id}
                      queryClient={queryClient}
                    />
                    <ShowRemarkSection
                      key={`show-${show.id}-${activeResource.id}`}
                      showId={show.id}
                      resourceId={activeResource.id}
                      queryClient={queryClient}
                    />
                  </div>
                </div>
              )
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                请选择资源
              </div>
            )}
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 大图预览：仅负责预览图本身（导入合并后由父级容器给定尺寸） */
function ResourcePreviewImage({
  resourceId,
  fallbackPreviewUrl,
}: {
  resourceId: number;
  fallbackPreviewUrl: string | null;
}) {
  const { data } = useQuery({
    queryKey: ["resource", resourceId, "detail"],
    queryFn: () => fetchResourceDetail(resourceId),
    enabled: resourceId > 0,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const previewUrl =
    data?.current?.preview_url ||
    data?.current?.original_preview_url ||
    fallbackPreviewUrl ||
    null;
  return previewUrl ? (
    <img
      src={previewUrl}
      alt="资源预览"
      className="absolute inset-0 h-full w-full object-contain"
    />
  ) : (
    <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
      {data ? "无预览" : "加载中…"}
    </div>
  );
}

/** 通用备注编辑区（有管理权限可编辑，否则只读） */
function CommonRemarkEditor({
  resourceId,
  queryClient,
}: {
  resourceId: number;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const { data } = useQuery({
    queryKey: ["resource", resourceId, "detail"],
    queryFn: () => fetchResourceDetail(resourceId),
    enabled: resourceId > 0,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const serverHtml = data?.current?.common_remark_html || "";
  const canManage = data?.can_manage ?? false;

  const [draft, setDraft] = React.useState(serverHtml);
  const syncedRef = React.useRef(false);
  React.useEffect(() => {
    if (!syncedRef.current && data) {
      setDraft(serverHtml);
      syncedRef.current = true;
    }
  }, [data, serverHtml]);

  const mutation = useMutation({
    mutationFn: async () =>
      api(`/api/resources/${resourceId}/common-remark`, {
        method: "POST",
        json: { content_html: draft, apply_scope: "latest" },
      }),
    onSuccess: () => {
      toast.success("通用备注已保存");
      queryClient.invalidateQueries({
        queryKey: ["resource", resourceId, "detail"],
      });
      queryClient.invalidateQueries({ queryKey: ["resources"] });
    },
    onError: (err: Error) => toast.error(err.message || "保存失败"),
  });

  const dirty = draft !== serverHtml;

  return (
    <section className="flex shrink-0 flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">
          通用备注{" "}
          <span className="text-xs font-normal text-muted-foreground">
            {canManage ? "（仅管理者可编辑，仅作用于当前版本）" : "（只读）"}
          </span>
        </h4>
        {canManage && (
          <InlineSaveButton
            dirty={dirty}
            pending={mutation.isPending}
            onClick={() => mutation.mutate()}
          />
        )}
      </div>
      <div
        className="overflow-hidden rounded-md border bg-background shadow-sm"
        style={{ height: 110 }}
      >
        {canManage ? (
          <RichTextEditor
            className="h-full"
            bordered={false}
            value={draft}
            onChange={setDraft}
            placeholder="输入通用备注…"
            minHeight={0}
          />
        ) : (
          <div className="h-full overflow-y-auto px-3 py-2 text-sm">
            {serverHtml ? (
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: serverHtml }}
              />
            ) : (
              <p className="text-muted-foreground">暂无通用备注</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** 个人备注（可编辑） */
function PersonalRemarkSection({
  resourceId,
  queryClient,
}: {
  resourceId: number;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const { data } = useQuery({
    queryKey: ["resource", resourceId, "personal-remark"],
    queryFn: () => fetchPersonalRemark(resourceId),
    enabled: resourceId > 0,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const serverHtml = data?.content_html || "";
  const [draft, setDraft] = React.useState(serverHtml);
  const syncedRef = React.useRef(false);
  React.useEffect(() => {
    if (!syncedRef.current && data) {
      setDraft(serverHtml);
      syncedRef.current = true;
    }
  }, [data, serverHtml]);

  const mutation = useMutation({
    mutationFn: async () =>
      api(`/api/resources/${resourceId}/personal-remark`, {
        method: "PUT",
        json: { content_html: draft },
      }),
    onSuccess: () => {
      toast.success("个人备注已保存");
      queryClient.invalidateQueries({
        queryKey: ["resource", resourceId, "personal-remark"],
      });
    },
    onError: (err: Error) => toast.error(err.message || "保存失败"),
  });

  const dirty = draft !== serverHtml;

  return (
    <section className="flex min-h-0 flex-col gap-2 rounded-md border p-3">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h4 className="text-sm font-medium">
          个人备注{" "}
          <span className="text-xs font-normal text-muted-foreground">
            （仅自己可见）
          </span>
        </h4>
        <InlineSaveButton
          dirty={dirty}
          pending={mutation.isPending}
          onClick={() => mutation.mutate()}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border bg-background shadow-sm">
        <RichTextEditor
          className="h-full"
          bordered={false}
          value={draft}
          onChange={setDraft}
          placeholder="输入个人备注…"
          minHeight={0}
        />
      </div>
    </section>
  );
}

/** 放映备注（可编辑） */
function ShowRemarkSection({
  showId,
  resourceId,
  queryClient,
}: {
  showId: number;
  resourceId: number;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const { data } = useQuery({
    queryKey: ["shows", showId, "remarks", resourceId],
    queryFn: () => fetchShowRemark(showId, resourceId),
    enabled: showId > 0 && resourceId > 0,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const serverHtml = data?.content_html || "";
  const [draft, setDraft] = React.useState(serverHtml);
  const syncedRef = React.useRef(false);
  React.useEffect(() => {
    if (!syncedRef.current && data) {
      setDraft(serverHtml);
      syncedRef.current = true;
    }
  }, [data, serverHtml]);

  const mutation = useMutation({
    mutationFn: async () =>
      api(`/api/shows/${showId}/remarks/${resourceId}`, {
        method: "PUT",
        json: { content_html: draft },
      }),
    onSuccess: () => {
      toast.success("放映备注已保存");
      queryClient.invalidateQueries({
        queryKey: ["shows", showId, "remarks", resourceId],
      });
    },
    onError: (err: Error) => toast.error(err.message || "保存失败"),
  });

  const dirty = draft !== serverHtml;

  return (
    <section className="flex min-h-0 flex-col gap-2 rounded-md border p-3">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h4 className="text-sm font-medium">
          放映备注{" "}
          <span className="text-xs font-normal text-muted-foreground">
            （仅本次放映使用）
          </span>
        </h4>
        <InlineSaveButton
          dirty={dirty}
          pending={mutation.isPending}
          onClick={() => mutation.mutate()}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border bg-background shadow-sm">
        <RichTextEditor
          className="h-full"
          bordered={false}
          value={draft}
          onChange={setDraft}
          placeholder="输入放映备注…"
          minHeight={0}
        />
      </div>
    </section>
  );
}
