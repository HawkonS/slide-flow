import * as React from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowRight, ArrowUp, CheckCircle2, Clock3, Sparkles, XCircle } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type TaskTab = "todo" | "upload" | "download" | "other";

interface HomeTask {
  id: number;
  task_type: string;
  status: string;
  created_at: string;
  completed_at?: string | null;
  progress: number;
  total: number;
  error_message?: string | null;
  params?: {
    show_name?: string;
    series?: string;
    name_prefix?: string;
    file_name?: string;
    subject?: string;
    target_type?: string;
    target_id?: number;
    [key: string]: unknown;
  };
}

interface TaskListResponse {
  items: HomeTask[];
  total: number;
}

const TABS: { value: TaskTab; label: string }[] = [
  { value: "todo", label: "待办" },
  { value: "upload", label: "上传" },
  { value: "download", label: "下载" },
  { value: "other", label: "其他" },
];

const STATUS_LABEL: Record<string, string> = {
  uploading: "上传中",
  pending: "等待中",
  processing: "处理中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function isAiTask(task: HomeTask): boolean {
  return task.task_type === "ai_tagging";
}

function taskTitle(task: HomeTask): string {
  if (isAiTask(task)) return task.status === "failed" ? "模型识别错误" : "模型识别";
  const params = task.params ?? {};
  return params.series || params.name_prefix || params.show_name || params.file_name || "未命名任务";
}

function taskKind(task: HomeTask): string {
  if (isAiTask(task)) return "模型识别";
  return task.task_type === "batch_split_import" ? "上传任务" : "下载任务";
}

function relativeTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "failed") return <XCircle className="h-3 w-3" />;
  if (status === "completed") return <CheckCircle2 className="h-3 w-3" />;
  if (status === "processing" || status === "uploading") return <Clock3 className="h-3 w-3 animate-pulse" />;
  return <Clock3 className="h-3 w-3" />;
}

function TaskRowContent({ task }: { task: HomeTask }) {
  const isUpload = task.task_type === "batch_split_import";
  const isAi = isAiTask(task);
  return (
    <>
      <span className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
        isAi ? "bg-amber-50 text-amber-600" : isUpload ? "bg-emerald-50 text-emerald-600" : "bg-blue-50 text-blue-600",
      )}>
        {isAi ? <Sparkles className="h-3.5 w-3.5" /> : isUpload ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-semibold">{taskTitle(task)}</span>
        <span className="mt-0.5 block truncate text-[9px] text-muted-foreground">
          {taskKind(task)} · {relativeTime(task.created_at)}
        </span>
      </span>
      <span className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[9px] font-medium",
        task.status === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
      )}>
        <StatusIcon status={task.status} />
        {STATUS_LABEL[task.status] ?? task.status}
      </span>
    </>
  );
}

export function HomeTaskCard({
  userId,
  unfinished,
  failed,
}: {
  userId: number;
  unfinished: number;
  failed: number;
}) {
  const [tab, setTab] = React.useState<TaskTab>("todo");
  const [selectedFailedTask, setSelectedFailedTask] = React.useState<HomeTask | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["home", "tasks", tab, userId],
    queryFn: () => {
      const params: Record<string, string | number | boolean> = {
        owner_id: userId,
        page_size: tab === "todo" ? 4 : 4,
      };
      if (tab === "todo") {
        params.unfinished = true;
        params.task_types = "batch_split_import,download";
      } else if (tab === "upload") {
        params.task_type = "batch_split_import";
      } else if (tab === "download") {
        params.task_type = "download";
      } else {
        params.task_type = "ai_tagging";
        params.status = "failed";
      }
      return api<TaskListResponse>("/api/tasks", { params });
    },
    enabled: userId > 0,
    staleTime: 15_000,
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((task) => ["uploading", "pending", "processing"].includes(task.status)) ? 5_000 : 30_000;
    },
  });

  const dismissMutation = useMutation({
    mutationFn: (taskId: number) => api(`/api/tasks/${taskId}/dismiss`, { method: "POST" }),
    onSuccess: () => {
      toast.success("已忽略这条任务错误");
      setSelectedFailedTask(null);
      void queryClient.invalidateQueries({ queryKey: ["home", "tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["home", "stats"] });
    },
    onError: (error: Error) => toast.error(error.message || "忽略失败"),
  });

  const tasks = data?.items ?? [];
  const total = data?.total ?? tasks.length;
  const href = tab === "upload" ? "/manage/tasks?tab=uploads" : "/manage/tasks";
  const summary = tab === "todo"
    ? `${unfinished} 个未完成 · ${failed} 个失败`
    : tab === "other"
      ? `共 ${total} 条模型识别错误`
      : `共 ${total} 条最近${tab === "upload" ? "上传" : "下载"}`;

  return (
    <>
      <section className="flex min-w-0 flex-col rounded-xl border bg-card shadow-sm">
        <div className="flex h-[50px] shrink-0 items-center justify-between gap-3 border-b px-5">
          <h2 className="text-sm font-semibold tracking-tight">任务</h2>
          <div className="flex items-center gap-0.5 rounded-lg border bg-muted/30 p-0.5">
            {TABS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={cn(
                  "rounded-md px-2.5 py-1 text-[10px] font-semibold transition-colors",
                  tab === item.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setTab(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1">
          {isLoading ? (
            <div className="flex h-full min-h-[220px] items-center justify-center text-sm text-muted-foreground">正在加载任务…</div>
          ) : isError ? (
            <div className="flex h-full min-h-[220px] items-center justify-center text-sm text-muted-foreground">暂时无法读取任务</div>
          ) : tasks.length === 0 ? (
            <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-2 px-5 text-center text-sm text-muted-foreground">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              {tab === "todo" ? "没有未完成的任务" : tab === "other" ? "没有模型识别错误" : `没有最近${tab === "upload" ? "上传" : "下载"}记录`}
            </div>
          ) : (
            <div>
              {tasks.map((task) => {
                const row = <TaskRowContent task={task} />;
                return task.status === "failed" ? (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => setSelectedFailedTask(task)}
                    className="flex w-full min-h-[57px] items-center gap-2.5 border-b px-5 py-2.5 text-left last:border-b-0 hover:bg-muted/30"
                  >
                    {row}
                  </button>
                ) : (
                  <Link
                    key={task.id}
                    to={href}
                    className="flex min-h-[57px] items-center gap-2.5 border-b px-5 py-2.5 last:border-b-0 hover:bg-muted/30"
                  >
                    {row}
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t px-5 py-2 text-[10px] text-muted-foreground">
          <span>{summary}</span>
          {tab === "other" ? (
            <span className="inline-flex items-center gap-1 font-semibold text-muted-foreground">点击任务查看并处理</span>
          ) : (
            <Link to="/manage/tasks" className="inline-flex items-center gap-1 font-semibold text-muted-foreground hover:text-foreground">
              全部任务<ArrowRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      </section>

      <Dialog open={!!selectedFailedTask} onOpenChange={(open) => { if (!open) setSelectedFailedTask(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {selectedFailedTask && isAiTask(selectedFailedTask) ? "模型识别错误" : "任务失败"}
            </DialogTitle>
            <DialogDescription>
              {selectedFailedTask ? `${relativeTime(selectedFailedTask.created_at)} · 任务 #${selectedFailedTask.id}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              {selectedFailedTask && isAiTask(selectedFailedTask)
                ? "这条智能标注任务已经失败，不会自动恢复。你可以忽略它，避免一直占用首页待办。"
                : "这条任务已经失败，不会自动恢复。你可以忽略它，避免一直占用首页待办。"}
            </p>
            {selectedFailedTask?.error_message && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive">
                {selectedFailedTask.error_message}
              </div>
            )}
            {selectedFailedTask && isAiTask(selectedFailedTask) && selectedFailedTask.params?.target_id && (
              <p className="text-xs text-muted-foreground">
                标注对象：素材 #{selectedFailedTask.params.target_id}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedFailedTask(null)}>关闭</Button>
            <Button
              variant="destructive"
              disabled={dismissMutation.isPending}
              onClick={() => selectedFailedTask && dismissMutation.mutate(selectedFailedTask.id)}
            >
              忽略此错误
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
