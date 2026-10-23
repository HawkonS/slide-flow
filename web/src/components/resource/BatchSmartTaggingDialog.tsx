import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, ImageUp, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { parseTags, type Resource } from "@/lib/types";

interface TaggingResult {
  suggested_tags?: string[];
  existing_tags?: string[];
  applied_tags?: string[];
  tags_applied?: boolean;
}

interface TaggingTask {
  id: number;
  status: string;
  message?: string | null;
  error_message?: string | null;
  result_data?: TaggingResult;
}

interface ItemState {
  taskId?: number;
  status: "idle" | "starting" | "processing" | "failed" | "applied";
  selected: string[];
  error?: string;
}

interface BatchSmartTaggingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceIds: number[];
  resources: Resource[];
  onComplete: () => void;
}

const EMPTY_ITEM: ItemState = { status: "idle", selected: [] };

export function BatchSmartTaggingDialog({ open, onOpenChange, resourceIds, resources, onComplete }: BatchSmartTaggingDialogProps) {
  const queryClient = useQueryClient();
  const idsKey = resourceIds.join(",");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [consented, setConsented] = React.useState(false);
  const [items, setItems] = React.useState<Record<number, ItemState>>({});
  const startedIds = React.useRef(new Set<number>());
  const cachedResources = React.useMemo(() => new Map(resources.map((resource) => [resource.id, resource])), [resources]);
  const activeId = resourceIds[activeIndex];
  const activeState = activeId ? items[activeId] ?? EMPTY_ITEM : EMPTY_ITEM;

  React.useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    setConsented(false);
    setItems({});
    startedIds.current.clear();
  }, [open, idsKey]);

  const resourceQuery = useQuery({
    queryKey: ["batch-ai-tagging-resource", activeId],
    queryFn: async () => {
      const cached = activeId ? cachedResources.get(activeId) : undefined;
      if (cached) return cached;
      const result = await api<{ resource: Resource }>(`/api/resources/${activeId}`);
      return result.resource;
    },
    enabled: open && activeId != null,
  });
  const resource = resourceQuery.data;

  const startMutation = useMutation({
    mutationFn: (target: Resource) => api<{ task_id: number }>(`/api/ai-tagging/resources/${target.id}`, {
      method: "POST",
      params: target.current?.id ? { version_id: target.current.id } : undefined,
    }),
    onSuccess: (result, target) => {
      setItems((current) => ({ ...current, [target.id]: { ...(current[target.id] ?? EMPTY_ITEM), taskId: result.task_id, status: "processing" } }));
    },
    onError: (error: Error, target) => {
      setItems((current) => ({ ...current, [target.id]: { ...(current[target.id] ?? EMPTY_ITEM), status: "failed", error: error.message || "无法开始智能识别" } }));
    },
  });

  React.useEffect(() => {
    if (!open || !consented || !resource || activeState.taskId || activeState.status !== "idle" || startedIds.current.has(resource.id)) return;
    startedIds.current.add(resource.id);
    setItems((current) => ({ ...current, [resource.id]: { ...(current[resource.id] ?? EMPTY_ITEM), status: "starting" } }));
    startMutation.mutate(resource);
  }, [open, consented, resource, activeState.status, activeState.taskId, startMutation.mutate]);

  const taskQuery = useQuery({
    queryKey: ["ai-tagging-task", activeState.taskId],
    queryFn: () => api<TaggingTask>(`/api/tasks/${activeState.taskId}`),
    enabled: open && activeState.taskId != null,
    refetchInterval: (query) => {
      const status = (query.state.data as TaggingTask | undefined)?.status;
      return status === "completed" || status === "failed" || status === "cancelled" ? false : 1000;
    },
  });
  const task = taskQuery.data;
  const suggestions = task?.result_data?.suggested_tags ?? [];
  const existingTags = task?.result_data?.existing_tags ?? (resource ? parseTags(resource.tags) : []);
  const taskRunning = !!activeState.taskId && (!task || ["pending", "processing"].includes(task.status));
  const taskFailed = activeState.status === "failed" || task?.status === "failed";
  const taskCompleted = task?.status === "completed";
  const isApplied = activeState.status === "applied" || task?.result_data?.tags_applied === true;

  const applyMutation = useMutation({
    mutationFn: () => api(`/api/ai-tagging/tasks/${activeState.taskId}/apply`, { method: "POST", json: { tags: activeState.selected } }),
    onSuccess: () => {
      if (activeId) setItems((current) => ({ ...current, [activeId]: { ...(current[activeId] ?? EMPTY_ITEM), status: "applied" } }));
      void queryClient.invalidateQueries({ queryKey: ["resources"] });
      const nextIndex = activeIndex + 1;
      if (nextIndex < resourceIds.length) {
        setActiveIndex(nextIndex);
      } else {
        toast.success(`已完成 ${resourceIds.length} 项素材的智能识别`);
        onComplete();
        onOpenChange(false);
      }
    },
    onError: (error: Error) => toast.error(error.message || "写入标签失败"),
  });

  const setSelected = (tag: string, checked: boolean) => {
    if (!activeId || isApplied) return;
    setItems((current) => {
      const item = current[activeId] ?? EMPTY_ITEM;
      const selected = checked ? [...item.selected, tag] : item.selected.filter((value) => value !== tag);
      return { ...current, [activeId]: { ...item, selected } };
    });
  };

  const retry = () => {
    if (!activeId) return;
    startedIds.current.delete(activeId);
    setItems((current) => ({ ...current, [activeId]: { status: "idle", selected: [] } }));
    void queryClient.invalidateQueries({ queryKey: ["ai-tagging-task"] });
  };

  const goPrevious = () => setActiveIndex((index) => Math.max(0, index - 1));
  const goNext = () => setActiveIndex((index) => Math.min(resourceIds.length - 1, index + 1));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" />批量智能识别</DialogTitle>
          <DialogDescription>{resourceIds.length ? `第 ${activeIndex + 1} / ${resourceIds.length} 项${resource ? ` · ${resource.name}` : ""}` : "没有选中的素材"}</DialogDescription>
        </DialogHeader>

        {!consented ? (
          <div className="space-y-4 py-3">
            <div className="flex items-start gap-3 rounded-md border bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
              <ImageUp className="mt-0.5 h-4 w-4 shrink-0" />
              <p>本次选中的 {resourceIds.length} 张图片会逐一发送到当前默认视觉模型，用于生成系统分类标签建议。开始前请确认你已获得必要的数据外发授权。</p>
            </div>
          </div>
        ) : resourceQuery.isLoading ? (
          <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在加载素材…</div>
        ) : resourceQuery.isError || !resource ? (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{(resourceQuery.error as Error)?.message || "素材加载失败"}</div>
        ) : (
          <div className="grid min-h-0 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(260px,0.8fr)]">
            <div className="flex min-h-64 items-center justify-center overflow-hidden rounded-md border bg-muted/30 p-2 lg:min-h-[420px]">
              {resource.current?.preview_url ? <img src={resource.current.preview_url} alt={resource.name} className="max-h-[62vh] w-full object-contain" /> : <div className="text-sm text-muted-foreground">当前素材没有可用预览图</div>}
            </div>
            <div className="flex min-h-0 flex-col gap-4">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold" title={resource.name}>{resource.name}</h3>
                <p className="mt-1 text-xs text-muted-foreground">版本 {resource.current_version} · ID {resource.id}</p>
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">已有标签</p>
                {existingTags.length ? <div className="flex flex-wrap gap-1.5">{existingTags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}</div> : <p className="text-xs text-muted-foreground">暂无标签</p>}
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-auto">
                <p className="text-xs font-medium text-muted-foreground">模型建议</p>
                {taskRunning || activeState.status === "starting" ? <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{task?.message || "正在分析图片…"}</div> : taskFailed ? <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{activeState.error || task?.error_message || "智能识别失败"}</div> : taskCompleted && suggestions.length ? <div className="grid gap-2">{suggestions.map((tag) => <label key={tag} className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${isApplied ? "opacity-70" : "cursor-pointer hover:bg-muted/50"}`}><Checkbox checked={activeState.selected.includes(tag) || (isApplied && (task.result_data?.applied_tags ?? []).includes(tag))} disabled={isApplied} onCheckedChange={(checked) => setSelected(tag, checked === true)} /><span className="min-w-0 flex-1 break-words">{tag}</span>{existingTags.includes(tag) && <span className="text-[11px] text-muted-foreground">已有</span>}</label>)}</div> : taskCompleted ? <div className="rounded-md border border-dashed px-3 py-7 text-center text-sm text-muted-foreground">模型没有找到合适的系统分类标签</div> : consented && activeState.status === "idle" ? <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />准备识别…</div> : <p className="py-8 text-sm text-muted-foreground">等待识别</p>}
              </div>
              {isApplied && <p className="text-xs text-emerald-700 dark:text-emerald-400">本页已确认，写入的标签已追加到素材。</p>}
            </div>
          </div>
        )}

        <DialogFooter className="sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 sm:mr-auto">
            <Button type="button" variant="outline" size="icon" title="上一页素材" aria-label="上一页素材" disabled={activeIndex <= 0} onClick={goPrevious}><ArrowLeft className="h-4 w-4" /></Button>
            <Button type="button" variant="outline" size="icon" title="下一页素材" aria-label="下一页素材" disabled={activeIndex >= resourceIds.length - 1} onClick={goNext}><ArrowRight className="h-4 w-4" /></Button>
          </div>
          {!consented ? <><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="button" className="gap-1.5" disabled={!resourceIds.length} onClick={() => setConsented(true)}><Sparkles className="h-4 w-4" />开始识别</Button></> : taskFailed ? <Button type="button" variant="outline" className="gap-1.5" onClick={retry}><RotateCcw className="h-4 w-4" />重试本页</Button> : taskCompleted && !isApplied ? <><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>稍后继续</Button><Button type="button" className="gap-1.5" disabled={applyMutation.isPending} onClick={() => applyMutation.mutate()}>{applyMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{activeIndex === resourceIds.length - 1 ? "确认并完成" : "确认并下一页"}</Button></> : isApplied ? <Button type="button" onClick={() => activeIndex < resourceIds.length - 1 ? goNext() : onOpenChange(false)}>{activeIndex === resourceIds.length - 1 ? "完成" : "下一页"}</Button> : <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
