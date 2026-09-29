import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  GripVertical,
  ImageOff,
  Loader2,
  Minus,
  Plus,
  CircleHelp,
  Save,
  ZoomIn,
  X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/PageHeader";
import { ResourcePicker, type PickerResource } from "@/components/show/ResourcePicker";
import { TagInput } from "@/components/resource/TagInput";
import { UserPicker } from "@/components/resource/UserPicker";
import { useMetadataTagOptions } from "@/components/resource/MetadataTagSelect";
import { MetadataTagSelect } from "@/components/resource/MetadataTagSelect";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MANAGEMENT_SCOPE_OPTIONS,
  VISIBILITY_SCOPE_OPTIONS,
} from "@/lib/constants";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Show } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  readShowCreateDraft,
  showCreateDraftKey,
  type ShowCreateFormDraft,
  type ShowCreateDraft,
} from "@/lib/show-create-draft";

type ScopeValue = "public" | "partial" | "private";

interface FormState {
  name: string;
  subject: string;
  tagList: string[];
  status: string;
  visibility_scope: ScopeValue;
  management_scope: ScopeValue;
  visible_user_ids: number[];
  visible_user_tags: string[];
  manage_user_ids: number[];
  manage_user_tags: string[];
}

interface ShowFacetResponse {
  all_tags?: string[];
  all_subjects?: string[];
}

const INITIAL_FORM: FormState = {
  name: "",
  subject: "",
  tagList: [],
  status: "",
  visibility_scope: "public",
  management_scope: "private",
  visible_user_ids: [],
  visible_user_tags: [],
  manage_user_ids: [],
  manage_user_tags: [],
};

const STEPS = ["填写信息", "选择素材", "排序确认"];

function mergeDraftForm(draft: ShowCreateFormDraft | undefined): FormState {
  return {
    ...INITIAL_FORM,
    ...draft,
    visibility_scope:
      draft?.visibility_scope === "partial" || draft?.visibility_scope === "private"
        ? draft.visibility_scope
        : "public",
    management_scope:
      draft?.management_scope === "partial" || draft?.management_scope === "public"
        ? draft.management_scope
        : "private",
    visible_user_ids: Array.isArray(draft?.visible_user_ids) ? draft.visible_user_ids : [],
    visible_user_tags: Array.isArray(draft?.visible_user_tags) ? draft.visible_user_tags : [],
    manage_user_ids: Array.isArray(draft?.manage_user_ids) ? draft.manage_user_ids : [],
    manage_user_tags: Array.isArray(draft?.manage_user_tags) ? draft.manage_user_tags : [],
  };
}

export function ShowCreatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [initialDraft] = React.useState(() => readShowCreateDraft(user?.id));
  const [form, setForm] = React.useState<FormState>(() => mergeDraftForm(initialDraft?.form));
  const [resourceIds, setResourceIds] = React.useState<number[]>(initialDraft?.resourceIds ?? []);
  const [resourceCache, setResourceCache] = React.useState<Record<number, PickerResource>>(() =>
    Object.fromEntries((initialDraft?.resources ?? []).map((resource) => [resource.id, resource])),
  );
  const [viewMode, setViewMode] = React.useState<"card" | "list">("card");
  const [step, setStep] = React.useState(initialDraft?.step ?? 0);
  const [hydratedOwnerId, setHydratedOwnerId] = React.useState<number | null>(user?.id ?? null);
  const [draftSavedAt, setDraftSavedAt] = React.useState(initialDraft?.savedAt ?? "");
  const [draggingId, setDraggingId] = React.useState<number | null>(null);
  const [dragOverId, setDragOverId] = React.useState<number | null>(null);
  const [moveFromPage, setMoveFromPage] = React.useState("");
  const [moveToPosition, setMoveToPosition] = React.useState("1");
  const [thumbnailColumns, setThumbnailColumns] = React.useState(4);
  const thumbnailScale = 8 - thumbnailColumns;
  const sortGridRef = React.useRef<HTMLOListElement>(null);
  const [previewResourceId, setPreviewResourceId] = React.useState<number | null>(null);
  const sortAutoScrollRef = React.useRef<{ clientY: number; frame: number | null }>({ clientY: 0, frame: null });

  const stopSortAutoScroll = React.useCallback(() => {
    const frame = sortAutoScrollRef.current.frame;
    if (frame != null) window.cancelAnimationFrame(frame);
    sortAutoScrollRef.current.frame = null;
  }, []);

  const autoScrollSortGrid = React.useCallback((clientY: number) => {
    sortAutoScrollRef.current.clientY = clientY;
    if (sortAutoScrollRef.current.frame != null) return;
    const tick = () => {
      const container = sortGridRef.current;
      if (!container) return stopSortAutoScroll();
      const rect = container.getBoundingClientRect();
      const edge = Math.min(96, rect.height * 0.2);
      const y = sortAutoScrollRef.current.clientY;
      const distance = y < rect.top + edge
        ? (rect.top + edge - y) / edge
        : y > rect.bottom - edge
          ? (y - (rect.bottom - edge)) / edge
          : 0;
      if (distance <= 0) return stopSortAutoScroll();
      const direction = y < rect.top + edge ? -1 : 1;
      container.scrollTop += direction * Math.min(28, Math.max(2, Math.round(distance * 24)));
      sortAutoScrollRef.current.frame = window.requestAnimationFrame(tick);
    };
    sortAutoScrollRef.current.frame = window.requestAnimationFrame(tick);
  }, [stopSortAutoScroll]);

  React.useEffect(() => stopSortAutoScroll, [stopSortAutoScroll]);

  const { options: statusOptions } = useMetadataTagOptions("status");
  const { data: facets } = useQuery({
    queryKey: ["shows", "create-facets"],
    queryFn: () =>
      api<ShowFacetResponse>("/api/shows", {
        params: { page: 1, page_size: 1 },
      }),
    staleTime: 60_000,
  });

  React.useEffect(() => {
    const ownerId = user?.id;
    if (!ownerId || hydratedOwnerId === ownerId) return;
    const draft = readShowCreateDraft(ownerId);
    setForm(mergeDraftForm(draft?.form));
    setResourceIds(draft?.resourceIds ?? []);
    setResourceCache(
      Object.fromEntries((draft?.resources ?? []).map((resource) => [resource.id, resource])),
    );
    setStep(draft?.step ?? 0);
    setDraftSavedAt(draft?.savedAt ?? "");
    setHydratedOwnerId(ownerId);
  }, [hydratedOwnerId, user?.id]);

  React.useEffect(() => {
    if (!form.status && statusOptions[0]?.value) {
      setForm((current) => ({ ...current, status: statusOptions[0].value }));
    }
  }, [form.status, statusOptions]);

  const makeDraft = React.useCallback(
    (stepOverride = step): ShowCreateDraft => ({
      form,
      resourceIds,
      resources: Object.values(resourceCache),
      step: stepOverride,
      savedAt: new Date().toISOString(),
    }),
    [form, resourceCache, resourceIds, step],
  );

  const saveDraft = React.useCallback(
    (notify = true, stepOverride?: number) => {
      if (!user?.id || hydratedOwnerId !== user.id) return;
      const draft = makeDraft(stepOverride);
      try {
        localStorage.setItem(showCreateDraftKey(user.id), JSON.stringify(draft));
        setDraftSavedAt(draft.savedAt);
        if (notify) toast.success("草稿已暂存到当前浏览器");
      } catch {
        if (notify) toast.error("暂存失败，请检查浏览器存储空间或权限");
      }
    },
    [hydratedOwnerId, makeDraft, user?.id],
  );

  React.useEffect(() => {
    if (!user?.id || hydratedOwnerId !== user.id) return;
    const timer = window.setTimeout(() => saveDraft(false), 250);
    return () => window.clearTimeout(timer);
  }, [form, hydratedOwnerId, resourceCache, resourceIds, saveDraft, user?.id]);

  React.useEffect(() => {
    if (step !== 1 || !user?.id || resourceIds.length === 0) return;
    let cancelled = false;
    api<{ ids: number[] }>("/api/resources/ids")
      .then(({ ids }) => {
        if (cancelled) return;
        const available = new Set(ids);
        setResourceIds((current) => {
          const next = current.filter((id) => available.has(id));
          return next.length === current.length ? current : next;
        });
        setResourceCache((current) => {
          let changed = false;
          const next = { ...current };
          for (const id of Object.keys(next)) {
            if (!available.has(Number(id))) {
              delete next[Number(id)];
              changed = true;
            }
          }
          return changed ? next : current;
        });
      })
      .catch(() => {
        // Keep the draft intact when the validation request is unavailable.
      });
    return () => { cancelled = true; };
  }, [resourceIds.length, step, user?.id]);

  const mutation = useMutation({
    mutationFn: () =>
      api<{ show: Show }>("/api/shows", {
        method: "POST",
        json: {
          name: form.name.trim(),
          subject: form.subject.trim(),
          tags: form.tagList.filter(Boolean).join(","),
          status: form.status,
          visibility_scope: form.visibility_scope,
          management_scope: form.management_scope,
          visible_user_ids:
            form.visibility_scope === "partial" ? form.visible_user_ids : [],
          visible_user_tags:
            form.visibility_scope === "partial" ? form.visible_user_tags : [],
          manage_user_ids:
            form.management_scope === "partial" ? form.manage_user_ids : [],
          manage_user_tags:
            form.management_scope === "partial" ? form.manage_user_tags : [],
          resource_ids: resourceIds,
        },
      }),
    onSuccess: () => {
      if (user?.id) localStorage.removeItem(showCreateDraftKey(user.id));
      toast.success("放映已创建");
      queryClient.invalidateQueries({ queryKey: ["shows"] });
      queryClient.invalidateQueries({ queryKey: ["home", "pins"] });
      queryClient.invalidateQueries({ queryKey: ["home", "stats"] });
      navigate("/manage/shows");
    },
    onError: (err: Error) => toast.error(err.message || "创建放映失败"),
  });

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleResourcesLoaded = React.useCallback((items: PickerResource[]) => {
    setResourceCache((current) => {
      let changed = false;
      const next = { ...current };
      for (const item of items) {
        const previous = current[item.id];
        if (
          !previous ||
          previous.name !== item.name ||
          previous.preview_url !== item.preview_url ||
          previous.tags !== item.tags ||
          previous.subject !== item.subject
        ) {
          next[item.id] = item;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);

  const validateInfo = () => {
    if (!form.name.trim()) {
      toast.error("请填写放映名称");
      return false;
    }
    if (!form.status.trim()) {
      toast.error("请选择放映状态，状态选项加载完成后再试");
      return false;
    }
    if (
      form.visibility_scope === "partial" &&
      form.visible_user_ids.length === 0 &&
      form.visible_user_tags.length === 0
    ) {
      toast.error("可见范围为部分时请至少选择一位用户或一个用户标签");
      return false;
    }
    if (
      form.management_scope === "partial" &&
      form.manage_user_ids.length === 0 &&
      form.manage_user_tags.length === 0
    ) {
      toast.error("管理范围为部分时请至少选择一位用户或一个用户标签");
      return false;
    }
    return true;
  };

  const goNext = () => {
    if (step === 0 && !validateInfo()) return;
    if (step === 1 && resourceIds.length === 0) {
      toast.error("请至少选择一页单页素材");
      return;
    }
    saveDraft(false, step + 1);
    setStep((current) => Math.min(STEPS.length - 1, current + 1));
  };

  const orderedResources = resourceIds.map(
    (id) =>
      resourceCache[id] ?? {
        id,
        name: `素材 #${id}`,
        tags: "",
        preview_url: null,
      },
  );

  const startSortDrag = (id: number) => (event: React.DragEvent<HTMLElement>) => {
    setDraggingId(id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(id));
  };

  const dropSortDrag = (targetId: number) => (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    stopSortAutoScroll();
    const sourceId = draggingId ?? Number(event.dataTransfer.getData("text/plain"));
    if (!Number.isInteger(sourceId) || sourceId === targetId) return;
    setResourceIds((current) => {
      const from = current.indexOf(sourceId);
      const target = current.indexOf(targetId);
      if (from < 0 || target < 0) return current;
      const targetRect = event.currentTarget.getBoundingClientRect();
      const insertAfter = event.clientX > targetRect.left + targetRect.width / 2 || event.clientY > targetRect.top + targetRect.height / 2;
      const next = [...current];
      next.splice(from, 1);
      const targetAfterRemoval = next.indexOf(targetId);
      const destination = targetAfterRemoval + (insertAfter ? 1 : 0);
      next.splice(Math.max(0, destination), 0, sourceId);
      return next;
    });
    setDraggingId(null);
    setDragOverId(null);
  };

  const moveToPagePosition = () => {
    const from = Number(moveFromPage);
    const to = Number(moveToPosition);
    if (!Number.isInteger(from) || from < 1 || from > resourceIds.length) {
      toast.error(`起始页码需在 1 到 ${resourceIds.length} 之间`);
      return;
    }
    if (!Number.isInteger(to) || to < 1 || to > resourceIds.length) {
      toast.error(`目标位置需在 1 到 ${resourceIds.length} 之间`);
      return;
    }
    setResourceIds((current) => {
      const next = [...current];
      const [resourceId] = next.splice(from - 1, 1);
      next.splice(to - 1, 0, resourceId);
      return next;
    });
    setMoveFromPage("");
  };

  const previewResource = orderedResources.find((resource) => resource.id === previewResourceId) ?? null;

  const ownerId = user?.id;

  return (
    <div className="page-shell">
      <PageHeader
        title="创建放映"
        description="先填写放映信息，再选择素材并确认播放顺序。"
        actions={
          <>
            <span className="hidden text-xs text-muted-foreground md:inline" role="status">
              {draftSavedAt ? "草稿已自动暂存" : "编辑内容会自动暂存"}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => navigate("/manage/shows")}
              disabled={mutation.isPending}
            >
              <X className="h-3.5 w-3.5" />
              退出
            </Button>
          </>
        }
      />

      <nav aria-label="创建放映步骤" className="shrink-0">
        <ol className="grid grid-cols-3 gap-2">
          {STEPS.map((label, index) => {
            const current = index === step;
            const completed = index < step;
            return (
              <li
                key={label}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-sm",
                  current
                    ? "border-foreground/25 bg-primary-weak font-medium text-foreground"
                    : completed
                      ? "border-foreground/15 text-foreground"
                      : "border-transparent bg-muted/40 text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs",
                    current ? "bg-primary text-primary-foreground" : "bg-muted",
                  )}
                >
                  {completed ? <CheckCircle2 className="h-4 w-4" /> : index + 1}
                </span>
                <span className="truncate">{label}</span>
              </li>
            );
          })}
        </ol>
      </nav>

      <main className="min-h-0 flex-1 overflow-hidden">
        {step === 0 && (
          <section className="surface h-full overflow-y-auto p-4 sm:p-6">
            <div className="mb-5 border-b pb-3">
              <h2 className="text-base font-semibold">放映信息</h2>
              <p className="mt-1 text-sm text-muted-foreground">填写名称、分类和访问范围，信息可随时暂存。</p>
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              <div className="grid gap-1.5 md:col-span-2">
                <Label htmlFor="show-create-name">放映名称</Label>
                <Input
                  id="show-create-name"
                  value={form.name}
                  onChange={(event) => updateForm("name", event.target.value)}
                  placeholder="例如：2026 年春季发布会"
                  autoFocus
                  required
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="show-create-subject">主体</Label>
                <MetadataTagSelect
                  domain="subject"
                  id="show-create-subject"
                  value={form.subject}
                  onChange={(value) => updateForm("subject", value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>状态</Label>
                <Select value={form.status || undefined} onValueChange={(value) => updateForm("status", value)}>
                  <SelectTrigger><SelectValue placeholder="请选择状态" /></SelectTrigger>
                  <SelectContent>
                    {statusOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5 md:col-span-2">
                <Label>标签</Label>
                <TagInput
                  value={form.tagList}
                  onChange={(value) => updateForm("tagList", value)}
                  suggestions={facets?.all_tags ?? []}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>可见范围</Label>
                <Select
                  value={form.visibility_scope}
                  onValueChange={(value) => updateForm("visibility_scope", value as ScopeValue)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VISIBILITY_SCOPE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>管理范围</Label>
                <Select
                  value={form.management_scope}
                  onValueChange={(value) => updateForm("management_scope", value as ScopeValue)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MANAGEMENT_SCOPE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {form.visibility_scope === "partial" && (
                <div className="grid gap-1.5 md:col-span-2">
                  <Label className="text-xs text-muted-foreground">可见用户或用户标签（至少选 1 项）</Label>
                  <UserPicker
                    value={form.visible_user_ids}
                    onChange={(value) => updateForm("visible_user_ids", value)}
                    tagValue={form.visible_user_tags}
                    onTagChange={(value) => updateForm("visible_user_tags", value)}
                    allowTagSelection
                    lockedIds={ownerId ? [ownerId] : undefined}
                  />
                </div>
              )}
              {form.management_scope === "partial" && (
                <div className="grid gap-1.5 md:col-span-2">
                  <Label className="text-xs text-muted-foreground">可管理用户或用户标签（至少选 1 项）</Label>
                  <UserPicker
                    value={form.manage_user_ids}
                    onChange={(value) => updateForm("manage_user_ids", value)}
                    tagValue={form.manage_user_tags}
                    onTagChange={(value) => updateForm("manage_user_tags", value)}
                    allowTagSelection
                    lockedIds={ownerId ? [ownerId] : undefined}
                  />
                </div>
              )}
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="flex h-full min-h-0 flex-col gap-3">
            <div className="flex shrink-0 items-end justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">选择单页素材</h2>
              </div>
              <span className="shrink-0 text-sm text-muted-foreground">已选 {resourceIds.length} 页</span>
            </div>
            <ResourcePicker
              value={resourceIds}
              onChange={setResourceIds}
              onResourcesLoaded={handleResourcesLoaded}
              className="min-h-0 flex-1"
              showSelectedSidebar
              selectedSidebarPosition="left"
              showViewModeSwitch
              showDensitySwitch={false}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
            />
          </section>
        )}

        {step === 2 && (
          <section className="flex h-full min-h-0 flex-col">
            <div className="mb-3 flex shrink-0 flex-wrap items-center gap-3 border-b pb-3">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <h2 className="min-w-0 truncate text-base font-semibold">确认播放顺序</h2>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="查看排序规则">
                        <CircleHelp className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="start" className="space-y-1 text-xs">
                      <p>拖到卡片左侧或上半部：插入到目标之前</p>
                      <p>拖到卡片右侧或下半部：插入到目标之后</p>
                    </TooltipContent>
                  </Tooltip>
              </div>
              <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
                <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-2 py-1.5 shadow-sm">
                  <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">移动页面</span>
                  <div className="flex items-center gap-1">
                    <Input
                      id="show-create-move-from"
                      type="number"
                      min={1}
                      max={resourceIds.length}
                      value={moveFromPage}
                      onChange={(event) => setMoveFromPage(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") moveToPagePosition(); }}
                      className="h-8 w-14 bg-muted/30 text-center"
                      aria-label="当前页码"
                      placeholder="原页"
                    />
                    <span className="px-0.5 text-muted-foreground">→</span>
                    <Input
                      id="show-create-move-to"
                      type="number"
                      min={1}
                      max={resourceIds.length}
                      value={moveToPosition}
                      onChange={(event) => setMoveToPosition(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") moveToPagePosition(); }}
                      className="h-8 w-14 bg-muted/30 text-center"
                      aria-label="目标位置"
                      placeholder="目标"
                    />
                    <Button type="button" size="sm" className="h-8 px-2.5" onClick={moveToPagePosition}>移动</Button>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 rounded-lg border bg-muted/30 px-2 py-1.5 shadow-sm">
                  <span className="mr-0.5 text-xs font-medium text-muted-foreground">缩略图</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 border-0 shadow-none"
                    title="缩小缩略图"
                    aria-label="缩小缩略图"
                    disabled={thumbnailColumns >= 6}
                    onClick={() => setThumbnailColumns((columns) => Math.min(6, columns + 1))}
                  ><Minus className="h-4 w-4" /></Button>
                  <input
                    type="range"
                    min={2}
                    max={6}
                    step={1}
                    value={thumbnailScale}
                    onChange={(event) => setThumbnailColumns(8 - Number(event.target.value))}
                    className="w-24 accent-primary"
                    aria-label="缩略图大小"
                    title="缩略图大小"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 border-0 shadow-none"
                    title="放大缩略图"
                    aria-label="放大缩略图"
                    disabled={thumbnailColumns <= 2}
                    onClick={() => setThumbnailColumns((columns) => Math.max(2, columns - 1))}
                  ><Plus className="h-4 w-4" /></Button>
                </div>
              </div>
            </div>
            {orderedResources.length === 0 ? (
              <div className="surface flex flex-1 items-center justify-center text-sm text-muted-foreground">
                还没有选择素材，请返回上一步添加。
              </div>
            ) : (
              <ol
                ref={sortGridRef}
                className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 gap-3 overflow-x-hidden overflow-y-auto overscroll-contain pb-1 pr-1 sm:grid-cols-2 lg:grid-cols-[repeat(var(--sort-columns),minmax(0,1fr))]"
                style={{ "--sort-columns": thumbnailColumns } as React.CSSProperties}
              >
                  {orderedResources.map((resource, index) => {
                    return (
                      <li
                        key={resource.id}
                        data-sort-resource-id={resource.id}
                        draggable
                        onDragStart={startSortDrag(resource.id)}
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          setDragOverId(resource.id);
                          autoScrollSortGrid(event.clientY);
                        }}
                        onDrop={dropSortDrag(resource.id)}
                        onDragEnd={() => { stopSortAutoScroll(); setDraggingId(null); setDragOverId(null); }}
                        className={cn(
                          "group relative min-w-0 cursor-grab select-none overflow-hidden rounded-md border bg-background text-left transition active:cursor-grabbing",
                          "hover:border-primary/50 hover:shadow-sm",
                          draggingId === resource.id && "opacity-40",
                          dragOverId === resource.id && "ring-2 ring-primary",
                        )}
                      >
                        <div className="relative aspect-video w-full bg-muted">
                          {resource.preview_url ? (
                            <img src={resource.preview_url} alt={resource.name} loading="lazy" decoding="async" className="h-full w-full object-contain" />
                          ) : (
                            <div className="flex h-full items-center justify-center text-muted-foreground"><ImageOff className="h-8 w-8" /></div>
                          )}
                          <span className="absolute left-2 top-2 flex h-7 min-w-7 items-center justify-center rounded bg-black/75 px-2 text-sm font-semibold text-white">{index + 1}</span>
                          <div className="absolute right-2 top-2 z-10 flex flex-col overflow-hidden rounded-md bg-black/70 text-white shadow-sm backdrop-blur-sm">
                            <button
                              type="button"
                              onMouseDown={(event) => event.stopPropagation()}
                              className="flex h-8 w-8 items-center justify-center transition hover:bg-black/85"
                              aria-label={`拖动第 ${index + 1} 页调整顺序`}
                              title="按住拖动排序"
                            ><GripVertical className="h-4 w-4" /></button>
                            <button
                              type="button"
                              onMouseDown={(event) => event.stopPropagation()}
                              onClick={() => setPreviewResourceId(resource.id)}
                              className="flex h-8 w-8 items-center justify-center border-t border-white/20 transition hover:bg-black/85 focus-visible:outline-none"
                              aria-label={`放大查看 ${resource.name}`}
                              title="放大查看"
                            ><ZoomIn className="h-4 w-4" /></button>
                          </div>
                        </div>
                        <div className="flex min-w-0 items-center gap-2 px-3 py-2.5">
                          <p className="min-w-0 flex-1 truncate text-sm font-medium" title={resource.name}>{resource.name}</p>
                          <span className="shrink-0 text-xs text-muted-foreground">ID {resource.id}</span>
                        </div>
                      </li>
                    );
                  })}
              </ol>
            )}
          </section>
        )}
      </main>

      <Dialog open={previewResource != null} onOpenChange={(open) => { if (!open) setPreviewResourceId(null); }}>
        <DialogContent className="flex h-[min(92vh,900px)] w-[min(96vw,1440px)] max-w-none flex-col gap-0 p-0">
          {previewResource && (
            <>
              <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 pr-12">
                <div className="min-w-0">
                  <DialogTitle className="truncate text-sm">{previewResource.name}</DialogTitle>
                  <DialogDescription className="mt-1">第 {resourceIds.indexOf(previewResource.id) + 1} / {resourceIds.length} 页 · 素材 ID {previewResource.id}</DialogDescription>
                </div>
                <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => window.open(`/api/resources/${previewResource.id}/preview`, "_blank", "noopener,noreferrer")}>
                  <ExternalLink className="h-4 w-4" />打开原图
                </Button>
              </div>
              <div className="flex min-h-0 flex-1 items-center justify-center bg-black/90 p-2 sm:p-5">
                {previewResource.preview_url ? (
                  <img src={`/api/resources/${previewResource.id}/preview`} alt={previewResource.name} className="max-h-full max-w-full object-contain" />
                ) : (
                  <div className="flex flex-col items-center gap-2 text-white/70"><ImageOff className="h-10 w-10" /><span>暂无预览图</span></div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <footer className="sticky bottom-0 z-20 flex shrink-0 items-center justify-between gap-2 border-t bg-background py-3">
        <span className="text-xs text-muted-foreground">
          第 {step + 1} / {STEPS.length} 步 · {STEPS[step]} · 共 {resourceIds.length} 页
        </span>
        <div className="flex gap-2">
          {step > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                saveDraft(false, step - 1);
                setStep((current) => current - 1);
              }}
            >
              <ArrowLeft className="h-4 w-4" />
              上一步
            </Button>
          )}
          <Button type="button" variant="outline" onClick={() => saveDraft()}>
            <Save className="h-4 w-4" />
            暂存
          </Button>
          {step < STEPS.length - 1 ? (
            <Button type="button" onClick={goNext}>
              下一步
              <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => {
                if (!validateInfo()) {
                  setStep(0);
                  return;
                }
                if (resourceIds.length === 0) {
                  toast.error("请至少选择一页单页素材");
                  setStep(1);
                  return;
                }
                mutation.mutate();
              }}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {mutation.isPending ? "创建中…" : "确认创建"}
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

export default ShowCreatePage;
