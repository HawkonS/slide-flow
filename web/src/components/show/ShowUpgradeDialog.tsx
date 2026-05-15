import * as React from "react";
import {
  ArrowLeft,
  ArrowUpCircle,
  Check,
  ChevronRight,
  Clock,
  FileText,
  GitBranch,
  GripVertical,
  Loader2,
  MessageSquareDiff,
  Shuffle,
  X,
} from "lucide-react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RichTextEditor } from "@/components/resource/RichTextEditor";
import { ResourcePicker, PickerResource } from "./ResourcePicker";
import { cn } from "@/lib/utils";
import { api, fetchResourceDiff, iterateShow, iterateUpgradeShow } from "@/lib/api";
import {
  CheckUpdatesResponse,
  IterateUpgradeRequest,
  ResourceDiff,
  Show,
  ShowResource,
  UpdateInfo,
} from "@/lib/types";

interface ShowUpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  show: Show | null;
  onSuccess?: () => void;
}

type View = "list" | "detail";
type TabMode = "upgrade" | "reorganize";

interface OrganizedResource {
  id: number;
  name: string;
  preview_url: string | null;
}

export function ShowUpgradeDialog({
  open,
  onOpenChange,
  show,
  onSuccess,
}: ShowUpgradeDialogProps) {
  const queryClient = useQueryClient();

  // ── 视图状态 ──
  const [view, setView] = React.useState<View>("list");
  const [detailResourceId, setDetailResourceId] = React.useState<number | null>(null);

  // ── Tab 模式 ──
  const [activeTab, setActiveTab] = React.useState<TabMode>("reorganize");

  // ── 选中资源（升级 Tab） ──
  const [selectedIds, setSelectedIds] = React.useState<Set<number>>(new Set());

  // ── 放映备注草稿 ──
  const [remarkDrafts, setRemarkDrafts] = React.useState<Record<string, string>>({});

  // ── 表单字段（主视图） ──
  const [changeNote, setChangeNote] = React.useState("");
  const [name, setName] = React.useState("");

  // ── 重新组织状态 ──
  const [organizedResources, setOrganizedResources] = React.useState<OrganizedResource[]>([]);
  const [draggingId, setDraggingId] = React.useState<number | null>(null);

  // 初始化 organizedResources
  const initialOrganizedRef = React.useRef<OrganizedResource[]>([]);

  // 打开或关闭对话框时重置状态
  React.useEffect(() => {
    if (open && show) {
      setView("list");
      setDetailResourceId(null);
      setSelectedIds(new Set());
      setRemarkDrafts({});
      setChangeNote("");
      setName("");
      setActiveTab("reorganize");
      setDraggingId(null);
      // 初始化重新组织列表
      const accessible = show.resources
        .filter((r): r is Extract<ShowResource, { accessible: true }> => r.accessible === true)
        .map((r) => ({ id: r.id, name: r.name, preview_url: r.preview_url }));
      setOrganizedResources(accessible);
      initialOrganizedRef.current = accessible;
    }
  }, [open, show]);

  // 切换 Tab 时，如果在详情视图自动返回列表
  const handleTabChange = (tab: TabMode) => {
    setActiveTab(tab);
    if (tab === "reorganize" && view === "detail") {
      setView("list");
      setDetailResourceId(null);
    }
  };

  // ── check-updates 查询 ──
  const {
    data: updatesData,
    isLoading: updatesLoading,
  } = useQuery({
    queryKey: ["shows", show?.id, "check-updates"],
    queryFn: async (): Promise<CheckUpdatesResponse> => {
      if (!show) return { updates: [] };
      return api<CheckUpdatesResponse>(`/api/shows/${show.id}/check-updates`);
    },
    enabled: open && !!show,
    staleTime: 0,
  });

  const updates = updatesData?.updates ?? [];

  // ── 资源信息缓存（由 ResourcePicker 加载页面数据时填充） ──
  const resourceCacheRef = React.useRef<Map<number, PickerResource>>(new Map());
  const handleResourcesLoaded = React.useCallback((resources: PickerResource[]) => {
    for (const r of resources) {
      resourceCacheRef.current.set(r.id, r);
    }
  }, []);

  // 首次获取到数据时默认全选
  const initializedRef = React.useRef(false);
  React.useEffect(() => {
    if (updates.length > 0 && !initializedRef.current) {
      setSelectedIds(new Set(updates.map((u) => u.resource_id)));
      initializedRef.current = true;
    }
  }, [updates]);
  React.useEffect(() => {
    if (!open) initializedRef.current = false;
  }, [open]);

  // ── resource-diff 查询 ──
  const {
    data: diffData,
    isLoading: diffLoading,
  } = useQuery({
    queryKey: ["shows", show?.id, "resource-diff", detailResourceId],
    queryFn: () => fetchResourceDiff(show!.id, detailResourceId!),
    enabled: view === "detail" && !!show && detailResourceId !== null,
    staleTime: 30_000,
  });

  // ── 升级 mutation（有选中资源时） ──
  const upgradeMutation = useMutation({
    mutationFn: async (payload: IterateUpgradeRequest) => {
      if (!show) throw new Error("无放映信息");
      return iterateUpgradeShow(show.id, payload);
    },
    onSuccess: (result) => {
      onOpenChange(false);
      const count = result.upgraded?.length ?? 0;
      toast.success(`新版本创建成功，已升级 ${count} 个资源`);
      queryClient.invalidateQueries({ queryKey: ["shows"] });
      onSuccess?.();
    },
    onError: (err: Error) => toast.error(err.message || "升级失败"),
  });

  // ── 纯迭代 mutation ──
  const iterateMutation = useMutation({
    mutationFn: async (resourceIds?: number[]) => {
      if (!show) throw new Error("无放映信息");
      const payload: { change_note: string; name?: string; resource_ids?: number[] } = {
        change_note: changeNote.trim(),
      };
      if (name.trim()) {
        payload.name = name.trim();
      }
      if (resourceIds) {
        payload.resource_ids = resourceIds;
      }
      return iterateShow(show.id, payload);
    },
    onSuccess: () => {
      onOpenChange(false);
      toast.success("迭代成功，新版本已创建");
      queryClient.invalidateQueries({ queryKey: ["shows"] });
      onSuccess?.();
    },
    onError: (err: Error) => toast.error(err.message || "迭代失败"),
  });

  const isPending = upgradeMutation.isPending || iterateMutation.isPending;

  // ── 操作函数 ──
  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === updates.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(updates.map((u) => u.resource_id)));
    }
  };

  const openDetail = (resourceId: number) => {
    setDetailResourceId(resourceId);
    setView("detail");
  };

  const backToList = () => {
    setView("list");
    setDetailResourceId(null);
  };

  // ── 重新组织：判断是否有变化 ──
  const hasOrganizeChange = React.useMemo(() => {
    const initial = initialOrganizedRef.current;
    if (organizedResources.length !== initial.length) return true;
    return organizedResources.some((r, i) => r.id !== initial[i].id);
  }, [organizedResources]);

  // ── 提交逻辑 ──
  const handleSubmit = () => {
    if (!changeNote.trim()) return;

    if (activeTab === "upgrade") {
      if (selectedIds.size > 0) {
        const ids = Array.from(selectedIds);
        const remarks: Record<string, string> = {};
        for (const [key, val] of Object.entries(remarkDrafts)) {
          if (selectedIds.has(Number(key))) {
            remarks[key] = val;
          }
        }
        upgradeMutation.mutate({
          resource_ids: ids,
          remarks,
          change_note: changeNote.trim(),
        });
      } else {
        iterateMutation.mutate(undefined);
      }
    } else {
      // 重新组织 Tab
      if (hasOrganizeChange) {
        const resourceIds = organizedResources.map((r) => r.id);
        iterateMutation.mutate(resourceIds);
      } else {
        iterateMutation.mutate(undefined);
      }
    }
  };

  // ── 提交按钮文案 ──
  const getSubmitLabel = () => {
    if (activeTab === "upgrade") {
      if (selectedIds.size > 0) {
        return (
          <>
            <ArrowUpCircle className="mr-1.5 h-4 w-4" />
            创建新版本并升级 {selectedIds.size} 个资源
          </>
        );
      }
      return (
        <>
          <GitBranch className="mr-1.5 h-4 w-4" />
          创建新版本
        </>
      );
    }
    // reorganize tab
    if (hasOrganizeChange) {
      return (
        <>
          <Shuffle className="mr-1.5 h-4 w-4" />
          创建新版本（已调整资源）
        </>
      );
    }
    return (
      <>
        <GitBranch className="mr-1.5 h-4 w-4" />
        创建新版本
      </>
    );
  };

  // ── 拖拽逻辑 ──
  const handleDragStart = (id: number) => (e: React.DragEvent) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", String(id));
    } catch { /* ignore */ }
  };

  const handleDragOver = (overId: number) => (e: React.DragEvent) => {
    if (draggingId === null || draggingId === overId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOrganizedResources((prev) => {
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
    setDraggingId(null);
  };

  const removeResource = (id: number) => {
    setOrganizedResources((prev) => prev.filter((r) => r.id !== id));
  };

  // ResourcePicker 集成
  const pickerValue = React.useMemo(
    () => organizedResources.map((r) => r.id),
    [organizedResources],
  );

  const handlePickerChange = (ids: number[]) => {
    // 找出新增的 id（在 ids 中但不在当前 organizedResources 中的）
    const currentSet = new Set(organizedResources.map((r) => r.id));
    const newIds = ids.filter((id) => !currentSet.has(id));
    // 找出被移除的 id（在当前中但不在 ids 中的）
    const newSet = new Set(ids);
    const remaining = organizedResources.filter((r) => newSet.has(r.id));
    // 对于新增 id，从缓存中查找完整信息（名称、预览图）
    if (newIds.length > 0) {
      setOrganizedResources([
        ...remaining,
        ...newIds.map((id) => {
          const res = resourceCacheRef.current.get(id);
          return {
            id,
            name: res?.name ?? `资源 #${id}`,
            preview_url: res?.preview_url ?? null,
          };
        }),
      ]);
    } else {
      setOrganizedResources(remaining);
    }
  };

  if (!show) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(860px,92vh)] max-w-6xl flex-col gap-0 overflow-hidden p-0">
        {/* 标题栏 */}
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <GitBranch className="h-5 w-5 text-primary" />
            版本迭代
            <Badge variant="outline" className="ml-1 text-xs font-normal">
              基于 v{show.version_no}
            </Badge>
          </DialogTitle>
          <DialogDescription className="sr-only">
            创建放映的新版本，可选升级资源或重新组织资源
          </DialogDescription>
        </DialogHeader>

        {/* 顶部表单区（紧凑，shrink-0，不滚动） */}
        <div className="shrink-0 border-b px-6 py-4 space-y-3">
          {/* 表单行：变更说明和名称水平排列 */}
          <div className="flex gap-4">
            <div className="flex-1 space-y-1.5">
              <Label>
                变更说明 <span className="text-destructive">*</span>
              </Label>
              <Textarea
                placeholder="描述本次迭代的变更内容..."
                value={changeNote}
                onChange={(e) => setChangeNote(e.target.value)}
                className="resize-none"
                rows={1}
              />
            </div>
            <div className="w-64 space-y-1.5">
              <Label>名称</Label>
              <Input
                placeholder={show.name}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">留空则继承当前名称</p>
            </div>
          </div>

          {/* 模式切换：内联按钮组 */}
          <div className="flex gap-1 rounded-lg bg-muted p-1 w-fit">
            <button
              type="button"
              onClick={() => handleTabChange("reorganize")}
              className={cn(
                "px-4 py-1.5 text-sm rounded-md transition",
                activeTab === "reorganize"
                  ? "bg-background shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              重新组织
            </button>
            <button
              type="button"
              onClick={() => handleTabChange("upgrade")}
              className={cn(
                "px-4 py-1.5 text-sm rounded-md transition",
                activeTab === "upgrade"
                  ? "bg-background shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              资源升级
            </button>
          </div>
        </div>

        {/* 内容区（flex-1, overflow） */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {view === "detail" && activeTab === "upgrade" ? (
            <DetailContent
              diff={diffData ?? null}
              loading={diffLoading}
              remarkDraft={
                detailResourceId != null
                  ? remarkDrafts[String(detailResourceId)]
                  : undefined
              }
              onRemarkChange={(html) => {
                if (detailResourceId != null) {
                  setRemarkDrafts((prev) => ({
                    ...prev,
                    [String(detailResourceId)]: html,
                  }));
                }
              }}
              onBack={backToList}
            />
          ) : activeTab === "upgrade" ? (
            <UpgradeContent
              updates={updates}
              loading={updatesLoading}
              selectedIds={selectedIds}
              toggleSelect={toggleSelect}
              toggleAll={toggleAll}
              openDetail={openDetail}
            />
          ) : (
            <ReorganizeContent
              organizedResources={organizedResources}
              draggingId={draggingId}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              onRemoveResource={removeResource}
              pickerValue={pickerValue}
              onPickerChange={handlePickerChange}
              onResourcesLoaded={handleResourcesLoaded}
            />
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="flex shrink-0 items-center justify-between border-t px-6 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            取消
          </Button>
          <Button
            disabled={!changeNote.trim() || isPending}
            onClick={handleSubmit}
          >
            {isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {getSubmitLabel()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ═══════════════════════════════════════════
   内容：资源升级
   ═══════════════════════════════════════════ */

function UpgradeContent({
  updates,
  loading,
  selectedIds,
  toggleSelect,
  toggleAll,
  openDetail,
}: {
  updates: UpdateInfo[];
  loading: boolean;
  selectedIds: Set<number>;
  toggleSelect: (id: number) => void;
  toggleAll: () => void;
  openDetail: (id: number) => void;
}) {
  const allSelected = updates.length > 0 && selectedIds.size === updates.length;
  const hasUpgradable = !loading && updates.length > 0;

  return (
    <div className="p-5">
      {loading ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="text-sm">检查资源更新…</span>
        </div>
      ) : hasUpgradable ? (
        <div className="space-y-3">
          {/* 资源列表头 */}
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">可升级的资源</h4>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={toggleAll}
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition"
              >
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={() => toggleAll()}
                />
                {allSelected ? "取消全选" : "全选"}
              </button>
              <span className="text-xs text-muted-foreground">
                已选 <span className="font-medium text-foreground">{selectedIds.size}</span> / {updates.length}
              </span>
            </div>
          </div>

          {/* 资源列表 */}
          <ul className="space-y-2">
            {updates.map((item) => (
              <UpdateItemRow
                key={item.resource_id}
                item={item}
                selected={selectedIds.has(item.resource_id)}
                onToggle={() => toggleSelect(item.resource_id)}
                onDetail={() => openDetail(item.resource_id)}
              />
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-10 justify-center text-muted-foreground">
          <Check className="h-5 w-5 text-green-500" />
          <span className="text-sm">所有资源已是最新版本</span>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   内容：重新组织（左右两半布局，卡片网格）
   ═══════════════════════════════════════════ */

function ReorganizeContent({
  organizedResources,
  draggingId,
  onDragStart,
  onDragOver,
  onDragEnd,
  onRemoveResource,
  pickerValue,
  onPickerChange,
  onResourcesLoaded,
}: {
  organizedResources: OrganizedResource[];
  draggingId: number | null;
  onDragStart: (id: number) => (e: React.DragEvent) => void;
  onDragOver: (id: number) => (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onRemoveResource: (id: number) => void;
  pickerValue: number[];
  onPickerChange: (ids: number[]) => void;
  onResourcesLoaded?: (resources: PickerResource[]) => void;
}) {
  // ── 拖拽自动滚动 ──
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);

  const handleContainerDragOver = (e: React.DragEvent) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const y = e.clientY;
    const threshold = 60;
    const speed = 8;

    if (y - rect.top < threshold) {
      container.scrollTop -= speed;
    } else if (rect.bottom - y < threshold) {
      container.scrollTop += speed;
    }
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-2 gap-0">
      {/* 左半：当前资源 - 卡片网格 */}
      <div className="flex flex-col border-r p-4 overflow-hidden">
        <div className="mb-3 flex shrink-0 items-center justify-between">
          <h4 className="text-sm font-medium">
            当前资源
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              ({organizedResources.length} 个)
            </span>
          </h4>
          <span className="text-xs text-muted-foreground">拖拽排序</span>
        </div>
        <div
          ref={scrollContainerRef}
          onDragOver={handleContainerDragOver}
          className="min-h-0 flex-1 overflow-y-auto">
          {organizedResources.length === 0 ? (
            <div className="flex items-center justify-center rounded-lg border border-dashed px-4 py-12 text-muted-foreground">
              <span className="text-sm">暂无资源，请从右侧添加</span>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {organizedResources.map((r, idx) => {
                const isDragging = r.id === draggingId;
                return (
                  <div
                    key={r.id}
                    draggable
                    onDragStart={onDragStart(r.id)}
                    onDragOver={onDragOver(r.id)}
                    onDragEnd={onDragEnd}
                    className={cn(
                      "group relative cursor-grab rounded-md border bg-background transition active:cursor-grabbing",
                      isDragging && "opacity-40",
                    )}
                  >
                    {/* 缩略图 */}
                    <div className="relative aspect-[16/9] w-full overflow-hidden rounded-t-md bg-muted">
                      {r.preview_url ? (
                        <img
                          src={r.preview_url}
                          alt={r.name}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-[10px] text-muted-foreground">
                          无预览
                        </div>
                      )}
                      {/* 序号（左上角） */}
                      <span className="absolute left-1 top-1 z-10 flex h-5 min-w-[20px] items-center justify-center rounded bg-black/60 px-1 text-[10px] font-medium text-white">
                        {idx + 1}
                      </span>
                      {/* 删除按钮（右上角，hover 显示） */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveResource(r.id);
                        }}
                        className="absolute right-1 top-1 z-10 hidden h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-destructive group-hover:flex"
                        title="移除"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                    {/* 名称 */}
                    <div className="truncate px-1.5 py-1 text-xs">{r.name}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 右半：ResourcePicker */}
      <div className="flex flex-col p-4 overflow-hidden">
        <div className="mb-3 flex shrink-0 items-center justify-between">
          <h4 className="text-sm font-medium">添加资源</h4>
          <span className="text-xs text-muted-foreground">
            共 {pickerValue.length} 条
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <ResourcePicker
            value={pickerValue}
            onChange={onPickerChange}
            onResourcesLoaded={onResourcesLoaded}
            showSelectedSidebar={false}
            className="h-full"
          />
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   内容：详情对比视图
   ═══════════════════════════════════════════ */

function DetailContent({
  diff,
  loading,
  remarkDraft,
  onRemarkChange,
  onBack,
}: {
  diff: ResourceDiff | null;
  loading: boolean;
  remarkDraft: string | undefined;
  onRemarkChange: (html: string) => void;
  onBack: () => void;
}) {
  // 使用 ref 追踪是否已经初始化了草稿
  const initializedRef = React.useRef(false);
  React.useEffect(() => {
    if (diff && remarkDraft === undefined && !initializedRef.current) {
      onRemarkChange(diff.show_remark_html || "");
      initializedRef.current = true;
    }
  }, [diff, remarkDraft, onRemarkChange]);
  React.useEffect(() => {
    initializedRef.current = false;
  }, [diff?.resource_id]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部返回栏 */}
      <div className="flex shrink-0 items-center gap-2 border-b px-5 py-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent transition"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="truncate text-sm font-medium">
          {loading ? "加载中…" : diff?.resource_name ?? "资源详情"}
        </span>
        {diff && (
          <Badge variant="outline" className="ml-1 text-xs">
            v{diff.current_version_no} → v{diff.latest_version_no}
          </Badge>
        )}
      </div>

      {/* 内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="text-sm">加载对比数据…</span>
          </div>
        ) : diff ? (
          <div className="space-y-6">
            {/* 预览图对比 */}
            <section>
              <h4 className="mb-3 text-sm font-medium">预览图对比</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <span className="text-xs text-muted-foreground">
                    当前版本 (v{diff.current_version_no})
                  </span>
                  <div className="overflow-hidden rounded-lg border bg-muted">
                    <div className="aspect-[16/9] w-full">
                      {diff.current_original_preview_url || diff.current_preview_url ? (
                        <img
                          src={(diff.current_original_preview_url || diff.current_preview_url)!}
                          alt="当前版本"
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
                          无预览
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <span className="text-xs text-muted-foreground">
                    最新版本 (v{diff.latest_version_no})
                  </span>
                  <div className="overflow-hidden rounded-lg border bg-muted">
                    <div className="aspect-[16/9] w-full">
                      {diff.latest_original_preview_url || diff.latest_preview_url ? (
                        <img
                          src={(diff.latest_original_preview_url || diff.latest_preview_url)!}
                          alt="最新版本"
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
                          无预览
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* 版本历史 */}
            {diff.versions_between.length > 0 && (
              <section>
                <h4 className="mb-3 text-sm font-medium">
                  版本历史
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    ({diff.versions_between.length} 个版本)
                  </span>
                </h4>
                <div className="space-y-1.5">
                  {diff.versions_between.map((v) => (
                    <div
                      key={v.version_no}
                      className="flex items-start gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm"
                    >
                      <Badge variant="outline" className="mt-0.5 shrink-0 text-xs">
                        v{v.version_no}
                      </Badge>
                      <span className="min-w-0 flex-1 text-sm">
                        {v.change_note || (
                          <span className="text-muted-foreground">无变更说明</span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {formatDate(v.created_at)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* 通用备注对比 */}
            {(diff.common_remark_diff.current_html || diff.common_remark_diff.latest_html) && (
              <section>
                <h4 className="mb-3 flex items-center gap-1.5 text-sm font-medium">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  通用备注对比
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <RemarkCompareBox
                    label="当前版本备注"
                    html={diff.common_remark_diff.current_html}
                  />
                  <RemarkCompareBox
                    label="最新版本备注"
                    html={diff.common_remark_diff.latest_html}
                  />
                </div>
              </section>
            )}

            {/* 放映备注编辑 — 始终可见 */}
            <section>
              <h4 className="mb-3 text-sm font-medium">
                放映备注
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  （可编辑，升级时将随版本一起保存）
                </span>
              </h4>
              <div className="overflow-hidden rounded-md border bg-background shadow-sm" style={{ height: 160 }}>
                <RichTextEditor
                  className="h-full"
                  bordered={false}
                  value={remarkDraft ?? diff.show_remark_html ?? ""}
                  onChange={onRemarkChange}
                  placeholder="输入放映备注…"
                  minHeight={0}
                />
              </div>
            </section>
          </div>
        ) : (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
            无数据
          </div>
        )}
      </div>
    </div>
  );
}

/** 单行资源卡片 */
function UpdateItemRow({
  item,
  selected,
  onToggle,
  onDetail,
}: {
  item: UpdateInfo;
  selected: boolean;
  onToggle: () => void;
  onDetail: () => void;
}) {
  const versionGap = item.version_gap ?? (item.latest_version_no - item.current_version_no);

  return (
    <li
      className={cn(
        "flex items-center gap-4 rounded-lg border p-3 transition",
        selected
          ? "border-primary/40 bg-primary/[0.03]"
          : "border-border hover:border-border/80",
      )}
    >
      {/* 勾选框 */}
      <Checkbox
        checked={selected}
        onCheckedChange={() => onToggle()}
        className="shrink-0"
      />

      {/* 预览图对比 */}
      <div className="flex shrink-0 items-center gap-1">
        <PreviewThumb url={item.current_preview_url} alt="当前" />
        <ChevronRight className="h-3 w-3 text-muted-foreground" />
        <PreviewThumb url={item.preview_url} alt="最新" />
      </div>

      {/* 资源信息 */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.name}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="gap-1 text-xs">
            v{item.current_version_no}
            <span className="text-muted-foreground">→</span>
            v{item.latest_version_no}
          </Badge>
          {versionGap > 1 && (
            <Badge variant="secondary" className="text-xs">
              跨{versionGap}个版本
            </Badge>
          )}
          {item.has_remark_change && (
            <Badge variant="secondary" className="gap-1 text-xs text-amber-600">
              <MessageSquareDiff className="h-3 w-3" />
              备注有更新
            </Badge>
          )}
        </div>
      </div>

      {/* 查看详情 */}
      <Button
        size="sm"
        variant="ghost"
        onClick={onDetail}
        className="shrink-0 text-xs"
      >
        查看详情
        <ChevronRight className="ml-0.5 h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

/** 缩略预览图 */
function PreviewThumb({ url, alt }: { url: string | null; alt: string }) {
  return (
    <div className="shrink-0 overflow-hidden rounded border bg-muted" style={{ width: 80 }}>
      <div className="aspect-[16/9] w-full">
        {url ? (
          <img src={url} alt={alt} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] text-muted-foreground">
            无预览
          </div>
        )}
      </div>
    </div>
  );
}

/** 备注对比只读框 */
function RemarkCompareBox({ label, html }: { label: string; html: string }) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="max-h-48 overflow-y-auto rounded-md border bg-muted/30 px-3 py-2 text-sm">
        {html ? (
          <div
            className="prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <p className="text-muted-foreground">暂无备注</p>
        )}
      </div>
    </div>
  );
}

/** 日期格式化 */
function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}
