import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";

interface DirectorySyncSchedule {
  enabled: boolean;
  interval_hours: number;
  next_due_at: string | null;
  last_completed_at: string | null;
  last_status: string;
  last_message: string;
  active_task_id: number | null;
}

const INTERVALS = [
  { value: 1, label: "每 1 小时" },
  { value: 6, label: "每 6 小时" },
  { value: 12, label: "每 12 小时" },
  { value: 24, label: "每 24 小时" },
  { value: 72, label: "每 3 天" },
  { value: 168, label: "每 7 天" },
];

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}

export function DirectorySyncScheduleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = React.useState(false);
  const [intervalHours, setIntervalHours] = React.useState("24");

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "directory-schedule"],
    queryFn: () => api<DirectorySyncSchedule>("/api/departments/sync-schedule"),
    enabled: open,
    staleTime: 5_000,
  });

  React.useEffect(() => {
    if (!open || !data) return;
    setEnabled(data.enabled);
    setIntervalHours(String(data.interval_hours));
  }, [open, data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api<DirectorySyncSchedule>("/api/departments/sync-schedule", {
        method: "PUT",
        json: { enabled, interval_hours: Number(intervalHours) },
      }),
    onSuccess: () => {
      toast.success(enabled ? "定时同步已保存" : "定时同步已关闭");
      queryClient.invalidateQueries({ queryKey: ["admin", "directory-schedule"] });
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message || "保存定时同步失败"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            定时同步
          </DialogTitle>
          <DialogDescription>
            按固定间隔自动同步飞书部门、成员和负责人；每次同步会生成一条可追踪的同步任务。
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">启用定时同步</p>
                <p className="text-xs text-muted-foreground">关闭后不再自动创建同步任务。</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="启用定时同步" />
            </div>
            <div className="grid gap-2">
              <Label>同步间隔</Label>
              <Select value={intervalHours} onValueChange={setIntervalHours} disabled={!enabled}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVALS.map((item) => (
                    <SelectItem key={item.value} value={String(item.value)}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <p>下次同步：{formatDateTime(data?.next_due_at)}</p>
              <p>
                上次同步：{formatDateTime(data?.last_completed_at)}
                {data?.last_status ? ` · ${data.last_status === "completed" ? "成功" : data.last_status === "failed" ? "失败" : data.last_status}` : ""}
              </p>
              {data?.active_task_id ? <p>同步任务运行中：#{data.active_task_id}</p> : null}
              {data?.last_message ? <p className="truncate" title={data.last_message}>{data.last_message}</p> : null}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saveMutation.isPending}>
            取消
          </Button>
          <Button onClick={() => saveMutation.mutate()} disabled={isLoading || saveMutation.isPending}>
            {saveMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
