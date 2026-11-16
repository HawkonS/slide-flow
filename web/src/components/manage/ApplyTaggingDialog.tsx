import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Sparkles } from "lucide-react";
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
import { api } from "@/lib/api";

interface ApplyTaggingTask {
  id: number;
  status: string;
  message?: string | null;
  error_message?: string | null;
  params?: {
    target_type?: string;
    target_id?: number;
    target_name?: string;
    target_deleted?: boolean;
    connection_name?: string;
    model?: string;
  };
  result_data?: {
    suggested_tags?: string[];
    existing_tags?: string[];
    applied_tags?: string[];
    tags_applied?: boolean;
  };
}

interface ApplyTaggingDialogProps {
  taskId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplied?: () => void;
}

export function ApplyTaggingDialog({ taskId, open, onOpenChange, onApplied }: ApplyTaggingDialogProps) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = React.useState<string[]>([]);
  const [initializedTaskId, setInitializedTaskId] = React.useState<number | null>(null);

  const taskQuery = useQuery({
    queryKey: ["tasks", "tagging-detail", taskId],
    queryFn: () => api<ApplyTaggingTask>(`/api/tasks/${taskId}`),
    enabled: open && taskId != null,
    staleTime: 0,
  });
  const task = taskQuery.data;
  const result = task?.result_data;
  const suggestions = result?.suggested_tags ?? [];
  const existingTags = result?.existing_tags ?? [];

  React.useEffect(() => {
    if (!open) {
      setInitializedTaskId(null);
      setSelected([]);
      return;
    }
    if (!task || initializedTaskId === task.id) return;
    setInitializedTaskId(task.id);
    const suggested = task.result_data?.suggested_tags ?? [];
    const existing = task.result_data?.existing_tags ?? [];
    setSelected(suggested.filter((tag) => !existing.includes(tag)));
  }, [initializedTaskId, open, task]);

  const applyMut = useMutation({
    mutationFn: () => api(`/api/ai-tagging/tasks/${taskId}/apply`, {
      method: "POST",
      json: { tags: selected },
    }),
    onSuccess: () => {
      toast.success(selected.length ? "标签已写入" : "已确认，不新增标签");
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["resource-detail"] });
      void queryClient.invalidateQueries({ queryKey: ["resources"] });
      void queryClient.invalidateQueries({ queryKey: ["shows"] });
      void queryClient.invalidateQueries({ queryKey: ["home"] });
      onApplied?.();
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message || "写入标签失败"),
  });

  const toggle = (tag: string, checked: boolean) => {
    setSelected((current) => checked ? [...current, tag] : current.filter((item) => item !== tag));
  };
  const targetName = task?.params?.target_name || `素材 #${task?.params?.target_id ?? "—"}`;
  const alreadyApplied = !!result?.tags_applied;
  const targetDeleted = !!task?.params?.target_deleted;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            应用标注建议
          </DialogTitle>
          <DialogDescription>
            选择要写入「{targetName}」的标签；已有标签会保留。
          </DialogDescription>
        </DialogHeader>

        {taskQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />正在读取标注结果…
          </div>
        ) : taskQuery.isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            无法读取标注任务，请稍后重试。
          </div>
        ) : !task ? null : task.status !== "completed" ? (
          <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
            {task.status === "failed"
              ? task.error_message || "智能标注失败，无法应用建议。"
              : "标注任务尚未完成，请等待任务完成后再应用建议。"}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {task.params?.connection_name && <span>模型连接：{task.params.connection_name}</span>}
              {task.params?.model && <span>· 模型：{task.params.model}</span>}
            </div>
            {targetDeleted && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                目标素材已删除，无法写入标签。
              </div>
            )}

            {existingTags.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">已有标签</p>
                <div className="flex flex-wrap gap-1.5">
                  {existingTags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
                </div>
              </div>
            )}

            {suggestions.length > 0 ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">建议标签</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {suggestions.map((tag) => (
                    <label key={tag} className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted/50">
                      <Checkbox
                        checked={selected.includes(tag)}
                        disabled={alreadyApplied || applyMut.isPending || targetDeleted}
                        onCheckedChange={(checked) => toggle(tag, checked === true)}
                      />
                      <span>{tag}</span>
                      {existingTags.includes(tag) && <span className="ml-auto text-[11px] text-muted-foreground">已有</span>}
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                模型没有找到合适的系统分类标签。
              </div>
            )}

            {alreadyApplied && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300">
                已写入：{result?.applied_tags?.join("、") || "未新增标签"}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applyMut.isPending}>
            关闭
          </Button>
          {task?.status === "completed" && !alreadyApplied && !targetDeleted && (
            <Button
              className="gap-1.5"
              disabled={applyMut.isPending || taskQuery.isLoading}
              onClick={() => applyMut.mutate()}
            >
              {applyMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {selected.length ? `写入 ${selected.length} 个标签` : "确认不新增标签"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
