import * as React from "react";
import {
  ArrowLeft,
  ArrowUpCircle,
  ListPlus,
  Check,
  ChevronRight,
  CircleHelp,
  Clock,
  Eraser,
  FileText,
  GitBranch,
  Loader2,
  MessageSquareDiff,
  Save,
  Shuffle,
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "@/components/ui/tooltip";
import { RichTextEditor } from "@/components/resource/RichTextEditor";
import { PageOrderGrid } from "./PageOrderGrid";
import { ResourcePicker, PickerResource } from "./ResourcePicker";
import { cn } from "@/lib/utils";
import { api, fetchResourceDiff, iterateShow, iterateUpgradeShow, updateShowResources } from "@/lib/api";
import {
  CheckUpdatesResponse,
  IterateUpgradeRequest,
  ResourceDiff,
  Show,
  UpdateInfo,
} from "@/lib/types";

// ── 草稿暂存 (localStorage) ──
const DRAFT_KEY_PREFIX = "show-iteration-draft-";

interface IterationDraft {
  activeTab: TabMode;
  selectedIds: number[];
  remarkDrafts: Record<string, string>;
  changeNote: string;
  name: string;
  organizedResourceIds: number[];
  savedAt: string;
}

function loadDraft(showId: number): IterationDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY_PREFIX + showId);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveDraft(showId: number, draft: IterationDraft) {
  localStorage.setItem(DRAFT_KEY_PREFIX + showId, JSON.stringify(draft));
}

function clearDraft(showId: number) {
  localStorage.removeItem(DRAFT_KEY_PREFIX + showId);
}

/** 相对时间描述（如"3 分钟前"） */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

interface ShowUpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  show: Show | null;
  /** 页面模式：复用迭代内容，但不渲染 Dialog 遮罩和弹窗容器。 */
  page?: boolean;
  /** 页面首次进入时默认展示的工作模式。草稿存在时仍优先恢复草稿。 */
  initialTab?: TabMode;
  /** 创建成功回调，参数为新创建的版本 Show */
  onSuccess?: (newShow: Show) => void;
}

type View = "list" | "detail";
type TabMode = "upgrade" | "reorganize" | "order";

interface OrganizedResource {
  id: number;
  name: string;
  preview_url: string | null;
}

export function ShowUpgradeDialog({
  open,
  onOpenChange,
  show,
  page = false,
  initialTab = "upgrade",
  onSuccess,
}: ShowUpgradeDialogProps) {
  const queryClient = useQueryClient();
  const formId = React.useId();

  // ── 视图状态 ──
  const [view, setView] = React.useState<View>("list");
  const [detailResourceId, setDetailResourceId] = React.useState<number | null>(null);

  // ── Tab 模式 ──
  const [activeTab, setActiveTab] = React.useState<TabMode>(initialTab);
  // 创建版本前统一在弹窗里补变更说明和名称
  const [versionDialogOpen, setVersionDialogOpen] = React.useState(false);

  // ── 选中资源（升级 Tab） ──
  const [selectedIds, setSelectedIds] = React.useState<Set<number>>(new Set());

  // ── 放映备注草稿 ──
  const [remarkDrafts, setRemarkDrafts] = React.useState<Record<string, string>>({});

  // ── 表单字段（主视图） ──
  const [changeNote, setChangeNote] = React.useState("");
  const [name, setName] = React.useState("");

  // ── 重新组织状态 ──
  const [organizedResources, setOrganizedResources] = React.useState<OrganizedResource[]>([]);

  // ── 草稿状态 ──
  const [hasDraft, setHasDraft] = React.useState(false);
  const [draftSavedAt, setDraftSavedAt] = React.useState<string | null>(null);

  // 初始化 organizedResources
  const initialOrganizedRef = React.useRef<OrganizedResource[]>([]);

  // 打开对话框时：优先恢复草稿，否则重置状态
  React.useEffect(() => {
    if (open && show) {
      setView("list");
      setDetailResourceId(null);

      const accessible = show.resources
        .map((r) => ({ id: r.id, name: r.name, preview_url: r.accessible ? r.preview_url : null }));
      initialOrganizedRef.current = accessible;

      const draft = loadDraft(show.id);
      if (draft) {
        // 恢复草稿（旧草稿只有 upgrade/reorganize 两种模式）
        setActiveTab(
          draft.activeTab === "reorganize" || draft.activeTab === "order"
            ? draft.activeTab
            : "upgrade",
        );
        setSelectedIds(new Set(draft.selectedIds));
        setRemarkDrafts(draft.remarkDrafts);
        setChangeNote(draft.changeNote);
        setName(draft.name);
        setHasDraft(true);
        setDraftSavedAt(draft.savedAt);
        // 根据保存的 ID 列表从当前资源重建 organizedResources
        const resourceMap = new Map<number, OrganizedResource>(accessible.map((resource) => [resource.id, resource]));
        const restored = draft.organizedResourceIds
          .map((id) => resourceMap.get(id))
          .filter((r): r is OrganizedResource => r != null);
        setOrganizedResources(restored);
      } else {
        // 无草稿：重置
        setSelectedIds(new Set());
        setRemarkDrafts({});
        setChangeNote("");
        setName("");
        setActiveTab(initialTab);
        setHasDraft(false);
        setDraftSavedAt(null);
        setOrganizedResources(accessible);
      }
    }
  }, [open, show, initialTab]);

  // 切换 Tab 时，如果在详情视图自动返回列表
  const handleTabChange = (tab: TabMode) => {
    setActiveTab(tab);
    if (tab !== "upgrade" && view === "detail") {
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

  // 首次获取到数据时默认全选（仅在没有草稿恢复时生效）
  const initializedRef = React.useRef(false);
  React.useEffect(() => {
    if (updates.length > 0 && !initializedRef.current && !hasDraft) {
      setSelectedIds(new Set(updates.map((u) => u.resource_id)));
      initializedRef.current = true;
    }
  }, [updates, hasDraft]);
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
      if (show) clearDraft(show.id);
      setHasDraft(false);
      setDraftSavedAt(null);
      const count = result.upgraded?.length ?? 0;
      toast.success(`新版本创建成功，已升级 ${count} 个资源`);
      queryClient.invalidateQueries({ queryKey: ["shows"] });
      onSuccess?.(result.show);
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
    onSuccess: (result) => {
      onOpenChange(false);
      if (show) clearDraft(show.id);
      setHasDraft(false);
      setDraftSavedAt(null);
      toast.success("迭代成功，新版本已创建");
      queryClient.invalidateQueries({ queryKey: ["shows"] });
      onSuccess?.(result.show);
    },
    onError: (err: Error) => toast.error(err.message || "迭代失败"),
  });

  const isPending = upgradeMutation.isPending || iterateMutation.isPending;

  // 只调整顺序时直接更新当前放映，不创建新的版本。
  const reorderMutation = useMutation({
    mutationFn: async (resourceIds: number[]) => {
      if (!show) throw new Error("无放映信息");
      return updateShowResources(show.id, resourceIds);
    },
    onSuccess: (result) => {
      onOpenChange(false);
      if (show) clearDraft(show.id);
      setHasDraft(false);
      setDraftSavedAt(null);
      toast.success("播放顺序已保存，未创建新版本");
      queryClient.invalidateQueries({ queryKey: ["shows"] });
      if (show) {
        queryClient.invalidateQueries({ queryKey: ["show-detail", show.id] });
      }
      onSuccess?.(result.show);
    },
    onError: (err: Error) => toast.error(err.message || "保存播放顺序失败"),
  });

  const isAnyPending = isPending || reorderMutation.isPending;

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

  // ── 变更判断 ──
  const initialOrganizedIds = React.useMemo(
    () => initialOrganizedRef.current.map((resource) => resource.id),
    [organizedResources],
  );
  const organizedIds = React.useMemo(
    () => organizedResources.map((resource) => resource.id),
    [organizedResources],
  );
  const hasResourceSetChange = React.useMemo(() => {
    if (organizedIds.length !== initialOrganizedIds.length) return true;
    const initialSet = new Set(initialOrganizedIds);
    return organizedIds.some((id) => !initialSet.has(id));
  }, [organizedIds, initialOrganizedIds]);
  const hasOrderChange = React.useMemo(
    () => organizedIds.length === initialOrganizedIds.length && organizedIds.some((id, index) => id !== initialOrganizedIds[index]),
    [organizedIds, initialOrganizedIds],
  );
  const hasUpgradeChange = activeTab === "upgrade" && selectedIds.size > 0;
  const hasOrderOnlyChange = hasOrderChange && !hasResourceSetChange;
  const hasAction = activeTab === "upgrade"
    ? hasUpgradeChange
    : hasResourceSetChange || hasOrderOnlyChange;

  // ── 提交逻辑 ──
  const submitVersion = () => {
    if (!changeNote.trim() || !hasAction) return;
    if (activeTab === "upgrade") {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      const remarks: Record<string, string> = {};
      for (const [key, val] of Object.entries(remarkDrafts)) {
        if (selectedIds.has(Number(key))) remarks[key] = val;
      }
      upgradeMutation.mutate({
        resource_ids: ids,
        remarks,
        change_note: changeNote.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      return;
    }
    if (hasResourceSetChange) iterateMutation.mutate(organizedIds);
  };

  const handlePrimaryAction = () => {
    if (activeTab === "upgrade") {
      if (selectedIds.size === 0) return;
      setVersionDialogOpen(true);
      return;
    }
    if (hasResourceSetChange) {
      setVersionDialogOpen(true);
      return;
    }
    if (hasOrderOnlyChange) reorderMutation.mutate(organizedIds);
  };

  // ── 提交按钮文案 ──
  const getSubmitLabel = () => {
    if (activeTab === "upgrade") {
      if (selectedIds.size === 0) {
        return (
          <>
            <ArrowUpCircle className="mr-1.5 h-4 w-4" />
            选择资源后创建版本
          </>
        );
      }
      return (
        <>
          <ArrowUpCircle className="mr-1.5 h-4 w-4" />
          创建新版本并升级 {selectedIds.size} 个资源
        </>
      );
    }
    if (hasResourceSetChange) {
      return (
        <>
          <GitBranch className="mr-1.5 h-4 w-4" />
          创建新版本并应用资源调整
        </>
      );
    }
    return (
      <>
        <Shuffle className="mr-1.5 h-4 w-4" />
        <span className="sm:hidden">保存顺序</span>
        <span className="hidden sm:inline">保存播放顺序（不创建新版本）</span>
      </>
    );
  };

  // ResourcePicker 集成
  const pickerValue = React.useMemo(
    () => organizedResources.map((r) => r.id),
    [organizedResources],
  );

  const handlePickerChange = (ids: number[]) => {
    const currentMap = new Map(organizedResources.map((resource) => [resource.id, resource]));
    setOrganizedResources(ids.map((id) => {
      const current = currentMap.get(id);
      if (current) return current;
      const cached = resourceCacheRef.current.get(id);
      return {
        id,
        name: cached?.name ?? `资源 #${id}`,
        preview_url: cached?.preview_url ?? null,
      };
    }));
  };

  // ── 清除草稿 ──
  const handleClearDraft = React.useCallback(() => {
    if (!show) return;
    clearDraft(show.id);
    setHasDraft(false);
    setDraftSavedAt(null);
    // 重置所有表单状态
    setSelectedIds(new Set());
    setRemarkDrafts({});
    setChangeNote("");
    setName("");
    setActiveTab(initialTab);
    setView("list");
    setDetailResourceId(null);
    const accessible = show.resources
      .map((r) => ({ id: r.id, name: r.name, preview_url: r.accessible ? r.preview_url : null }));
    setOrganizedResources(accessible);
    initialOrganizedRef.current = accessible;
    toast.success("草稿已清除");
  }, [show, initialTab]);

  // ── 手动暂存草稿 ──
  const handleSaveDraft = React.useCallback(() => {
    if (!show) return;
    const draft: IterationDraft = {
      activeTab,
      selectedIds: Array.from(selectedIds),
      remarkDrafts,
      changeNote,
      name,
      organizedResourceIds: organizedResources.map((r) => r.id),
      savedAt: new Date().toISOString(),
    };
    saveDraft(show.id, draft);
    setHasDraft(true);
    setDraftSavedAt(draft.savedAt);
    toast.success("草稿已暂存");
  }, [show, activeTab, selectedIds, remarkDrafts, changeNote, name, organizedResources]);

  // ── 点击遮罩/ESC 关闭时自动暂存草稿（仅在内容发生变化时） ──
  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && show) {
        // 对比当前资源列表与初始状态，检测是否有实际改动
        const currentIds = organizedResources.map((r) => r.id);
        const initialIds = initialOrganizedRef.current.map((r) => r.id);
        const resourcesChanged =
          currentIds.length !== initialIds.length ||
          currentIds.some((id, i) => id !== initialIds[i]);
        const selectionChanged =
          selectedIds.size !== updates.length ||
          updates.some((update) => !selectedIds.has(update.resource_id));

        const hasUserChanges =
          changeNote.trim() !== "" ||
          name.trim() !== "" ||
          selectionChanged ||
          Object.keys(remarkDrafts).length > 0 ||
          resourcesChanged;
        if (hasUserChanges) {
          const draft: IterationDraft = {
            activeTab,
            selectedIds: Array.from(selectedIds),
            remarkDrafts,
            changeNote,
            name,
            organizedResourceIds: organizedResources.map((r) => r.id),
            savedAt: new Date().toISOString(),
          };
          saveDraft(show.id, draft);
          setHasDraft(true);
          setDraftSavedAt(draft.savedAt);
          toast.success("草稿已自动暂存");
        }
      }
      onOpenChange(nextOpen);
    },
    [show, onOpenChange, activeTab, selectedIds, updates, remarkDrafts, changeNote, name, organizedResources],
  );

  if (!show) return null;

  const draftChip = hasDraft && draftSavedAt ? (
    <span className="flex items-center gap-1 text-xs text-amber-600">
      有暂存草稿 ({relativeTime(draftSavedAt)})
      <button
        type="button"
        onClick={handleClearDraft}
        className="ml-1 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-amber-700 transition hover:bg-amber-100"
        title="清除草稿并重置表单"
      >
        <Eraser className="h-3 w-3" />
        清除
      </button>
    </span>
  ) : null;
  const titleContent = (
    <>
      <GitBranch className="h-5 w-5 text-primary" />
      版本迭代
      <Badge variant="outline" className="ml-1 text-xs font-normal">
        基于 v{show.version_no}
      </Badge>
      {draftChip}
    </>
  );
  const content = (
    <>
        {/* 弹窗模式才需要自己的标题栏；页面模式由外层页头承担 */}
        {!page && (
          <DialogHeader className="shrink-0 border-b px-6 py-4">
            <DialogTitle className="flex items-center gap-2 text-base">{titleContent}</DialogTitle>
            <DialogDescription className="sr-only">创建放映的新版本，可选升级资源或重新组织资源</DialogDescription>
          </DialogHeader>
        )}

        <div className="shrink-0 border-b px-6 py-3">
          <nav aria-label="版本迭代操作" className="grid grid-cols-3 gap-1.5 sm:gap-2">
            {([
              { id: "upgrade" as const, icon: ArrowUpCircle, title: "资源升级", hint: "带入新版本的资源", meta: `${updates.length} 待升级` },
              { id: "reorganize" as const, icon: ListPlus, title: "组织页面", hint: "增删页面", meta: `${organizedResources.length} 页` },
              { id: "order" as const, icon: Shuffle, title: "调整顺序", hint: "拖动卡片排序", meta: hasOrderOnlyChange ? "顺序已调整" : `${organizedResources.length} 页`, dirty: hasOrderOnlyChange },
            ]).map((tab) => {
              const Icon = tab.icon;
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleTabChange(tab.id)}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition sm:gap-3 sm:px-3.5 sm:py-2.5",
                    selected
                      ? "border-primary/40 bg-background shadow-sm"
                      : "border-transparent bg-muted/50 text-muted-foreground hover:border-border hover:bg-background",
                  )}
                >
                  <Icon className={cn("h-4 w-4 shrink-0 sm:h-5 sm:w-5", selected ? "text-primary" : "text-muted-foreground/70")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground sm:text-sm">{tab.title}</span>
                    <span className="mt-0.5 hidden truncate text-[11px] leading-4 sm:block">{tab.hint}</span>
                  </span>
                  <span className={cn("hidden shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-medium sm:inline-block", tab.dirty ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground")}>{tab.meta}</span>
                </button>
              );
            })}
          </nav>
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
          ) : activeTab === "order" ? (
            <PageOrderGrid
              ariaLabel="调整播放顺序"
              className="px-5 pb-4 pt-1"
              resources={organizedResources}
              onChange={(ids) => handlePickerChange(ids)}
              disabled={isAnyPending}
              emptyHint="当前放映没有页面，请先在「组织页面」中添加。"
            />
          ) : (
            <ReorganizeContent
              organizedResources={organizedResources}
              pickerValue={pickerValue}
              onPickerChange={handlePickerChange}
              onResourcesLoaded={handleResourcesLoaded}
            />
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="flex shrink-0 flex-col gap-2 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {page && draftChip}
            <span className="min-w-0">
              {activeTab === "upgrade"
                ? (hasUpgradeChange ? `已选择 ${selectedIds.size} 个资源升级` : "请选择要升级的资源")
                : hasResourceSetChange
                  ? "资源集合已变化，将创建新版本"
                  : hasOrderChange
                    ? "仅播放顺序变化，不创建新版本"
                    : activeTab === "order" ? <><span className="hidden sm:inline">拖动卡片或</span>按页码移动调整顺序</> : "尚未产生资源变更"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isAnyPending}>
              取消
            </Button>
            <Button variant="outline" onClick={handleSaveDraft} disabled={isAnyPending}>
              <Save className="mr-1.5 h-4 w-4" />
              暂存
            </Button>
            <Button
              disabled={!hasAction || isAnyPending}
              onClick={handlePrimaryAction}
            >
              {isAnyPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {getSubmitLabel()}
            </Button>
          </div>
        </div>

        <Dialog open={versionDialogOpen} onOpenChange={(next) => { if (!isAnyPending) setVersionDialogOpen(next); }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>创建新版本</DialogTitle>
              <DialogDescription>
                基于 v{show.version_no} 创建新版本。
                {activeTab === "upgrade"
                  ? `将把 ${selectedIds.size} 个资源升级到新版本。`
                  : `放映页面将由 ${initialOrganizedIds.length} 页调整为 ${organizedIds.length} 页。`}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-1">
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-dialog-change-note`}>变更说明 <span className="text-destructive" aria-hidden="true">*</span></Label>
                <Input
                  id={`${formId}-dialog-change-note`}
                  placeholder="说明本次新增、删除或升级的内容"
                  value={changeNote}
                  onChange={(event) => setChangeNote(event.target.value)}
                  autoFocus
                  className="h-9 bg-background"
                />
                <p className="text-xs leading-5 text-muted-foreground">只有资源新增、删除或升级才会创建版本；播放顺序单独调整会直接保存。</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-dialog-name`} className="flex items-center gap-1">名称 <span className="text-xs font-normal text-muted-foreground">（选填）</span></Label>
                <Input
                  id={`${formId}-dialog-name`}
                  placeholder={show.name}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-9 bg-background"
                />
                <p className="text-xs text-muted-foreground">留空则继承当前名称</p>
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setVersionDialogOpen(false)} disabled={isAnyPending}>取消</Button>
              <Button onClick={submitVersion} disabled={!changeNote.trim() || isAnyPending}>
                {isAnyPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                创建新版本
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
    </>
  );

  if (page) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
        {content}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[min(860px,92vh)] max-w-7xl flex-col gap-0 overflow-hidden p-0">
        {content}
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
   内容：组织页面
   ═══════════════════════════════════════════ */

function ReorganizeContent({
  organizedResources,
  pickerValue,
  onPickerChange,
  onResourcesLoaded,
}: {
  organizedResources: OrganizedResource[];
  pickerValue: number[];
  onPickerChange: (ids: number[]) => void;
  onResourcesLoaded?: (resources: PickerResource[]) => void;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-5">
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">组织放映页面</h3>
          <p className="mt-1 text-sm text-muted-foreground">左侧拖动缩略图调整顺序，右侧筛选并添加或移除页面。</p>
        </div>
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-right">
          <div className="text-lg font-semibold leading-none">{organizedResources.length}</div>
          <div className="mt-1 text-xs text-muted-foreground">当前页面</div>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ResourcePicker
          value={pickerValue}
          onChange={onPickerChange}
          onResourcesLoaded={onResourcesLoaded}
          selectedResources={organizedResources.map((resource) => ({
            id: resource.id,
            name: resource.name,
            tags: "",
            preview_url: resource.preview_url,
          }))}
          showSelectedSidebar
          selectedSidebarPosition="left"
          showViewModeSwitch
          showDensitySwitch={false}
          selectedThumbnails
          className="h-full"
        />
      </div>
      <p className="shrink-0 text-xs text-muted-foreground">仅调整顺序会直接保存当前放映；新增或删除资源会创建新版本。</p>
    </section>
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
