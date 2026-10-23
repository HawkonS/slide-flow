import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ImageUp, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";

interface TaskResult {
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
  progress: number;
  total: number;
  result_data?: TaskResult;
}

interface SmartTaggingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetId: number;
  versionId?: number;
  currentTags: string[];
  onApplied?: () => void;
}

export function SmartTaggingDialog({ open, onOpenChange, targetId, versionId, currentTags, onApplied }: SmartTaggingDialogProps) {
  const qc = useQueryClient();
  const [taskId, setTaskId] = React.useState<number | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (open) { setTaskId(null); setSelected([]); }
  }, [open, targetId]);

  const startMut = useMutation({
    mutationFn: () => api<{ task_id: number }>(`/api/ai-tagging/resources/${targetId}`, { method: "POST", params: versionId ? { version_id: versionId } : undefined }),
    onSuccess: (result) => { setTaskId(result.task_id); },
    onError: (error: Error) => toast.error(error.message || "无法开始智能标注"),
  });
  const taskQuery = useQuery({
    queryKey: ["ai-tagging-task", taskId],
    queryFn: () => api<TaskResult & { id: number }>(`/api/tasks/${taskId}`),
    enabled: taskId !== null,
    refetchInterval: (query) => {
      const status = (query.state.data as TaggingTask | undefined)?.status;
      return status === "completed" || status === "failed" || status === "cancelled" ? false : 1000;
    },
  });
  const task = taskQuery.data as unknown as TaggingTask | undefined;
  const suggestions = task?.result_data?.suggested_tags ?? [];
  const applyMut = useMutation({
    mutationFn: () => api(`/api/ai-tagging/tasks/${taskId}/apply`, { method: "POST", json: { tags: selected } }),
    onSuccess: () => {
      toast.success(selected.length ? "标签已写入" : "已确认，不添加新标签");
      void qc.invalidateQueries({ queryKey: ["resource-detail"] });
      void qc.invalidateQueries({ queryKey: ["show-detail"] });
      void qc.invalidateQueries({ queryKey: ["resources"] });
      void qc.invalidateQueries({ queryKey: ["shows"] });
      onApplied?.();
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message || "写入标签失败"),
  });

  const toggle = (tag: string, checked: boolean) => setSelected((current) => checked ? [...current, tag] : current.filter((item) => item !== tag));
  const running = taskId !== null && (!task || ["pending", "processing"].includes(task.status));
  const finished = task?.status === "completed";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" />智能标注</DialogTitle>
          <DialogDescription>将当前素材预览图发送给已配置的视觉模型，生成系统分类标签建议。</DialogDescription>
        </DialogHeader>
        {!taskId && <div className="space-y-4 py-2"><div className="flex items-start gap-3 rounded-md border bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"><ImageUp className="mt-0.5 h-4 w-4 shrink-0" /><p>图片会发送到当前默认模型服务，请确认你已获得必要的数据外发授权。</p></div>{currentTags.length > 0 && <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"><span>已有标签</span>{currentTags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}</div>}</div>}
        {taskId && running && <div className="flex flex-col items-center gap-3 py-10 text-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /><p className="text-sm font-medium">{task?.message || "正在分析图片…"}</p><p className="text-xs text-muted-foreground">图片处理和模型响应可能需要一点时间</p></div>}
        {task?.status === "failed" && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{task.error_message || "智能标注失败，请稍后重试"}</div>}
        {finished && <div className="space-y-4 py-2"><div><p className="text-sm font-medium">请选择要写入的建议标签</p></div>{suggestions.length ? <div className="grid gap-2 sm:grid-cols-2">{suggestions.map((tag) => <label key={tag} className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted/50"><Checkbox checked={selected.includes(tag)} onCheckedChange={(checked) => toggle(tag, checked === true)} /><span>{tag}</span>{currentTags.includes(tag) && <span className="ml-auto text-[11px] text-muted-foreground">已有</span>}</label>)}</div> : <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">模型没有找到合适的系统分类标签</div>}</div>}
        <DialogFooter>{!taskId && <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>}{!taskId && <Button type="button" className="gap-1.5" disabled={startMut.isPending} onClick={() => startMut.mutate()}>{startMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}发送图片并分析</Button>}{task?.status === "failed" && <Button type="button" onClick={() => { setTaskId(null); setSelected([]); }}>重新开始</Button>}{finished && <><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button type="button" className="gap-1.5" disabled={applyMut.isPending} onClick={() => applyMut.mutate()}>{applyMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}确认写入</Button></>}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
