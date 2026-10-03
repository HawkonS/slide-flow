import { TableText } from "@/components/common/TableContent";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  Clock,
  Check,
  ChevronsUpDown,
  Download,
  Eye,
  FileText,
  Hash,
  Info,
  Loader2,
  OctagonX,
  Search,
  Trash2,
  Upload,
  User,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { FilterChip as ResourceFilterChip, type ChipOption } from "@/components/resource/filter-chips";
import { PageHeader } from "@/components/common/PageHeader";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api, downloadFile } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { isAdminRole, type UserOption } from "@/lib/types";
import { cn } from "@/lib/utils";

/* ---------- types ---------- */

interface TaskOwner {
  id: number;
  username: string;
  name: string | null;
}

interface TaskParams {
  import_target?: "resources" | "templates";
  name_prefix?: string;
  series?: string;
  subject?: string;
  platform?: string;
  ratio?: string;
  template_type?: string;
  tags?: string;
  visibility_scope?: string;
  visible_user_ids?: string;
  management_scope?: string;
  manage_user_ids?: string;
  remark_html?: string;
  status?: string;
  owner_id?: number;
  image_count?: number;
  /** 下载任务专属参数 */
  show_id?: number;
  show_name?: string;
  download_type?: string;
  watermark?: string;
  with_fonts?: boolean;
  embed_fonts?: boolean;
  file_size?: number;
  track_code?: string;
  client_ip?: string;
  task_id?: number;
  session_id?: string;
  file_name?: string;
  workflow_state?: string;
  slide_count?: number;
  fonts?: string[];
  missing_fonts?: string[];
  preview_status?: string;
  render_stage?: string;
  render_completed?: number;
  render_total?: number;
}

interface TaskResult {
  total?: number;
  created?: number;
  resource_ids?: number[];
  resource_detail_tokens?: Record<string, string>;
  template_ids?: number[];
  message?: string;
  expired?: boolean;
}

interface Task {
  id: number;
  task_type: string;
  status: string;
  owner_id: number;
  owner: TaskOwner | null;
  progress: number;
  upload_progress: number;
  total: number;
  message: string | null;
  result_data: TaskResult | null;
  error_message: string | null;
  params: TaskParams;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface TaskListResponse {
  items: Task[];
  total: number;
  page: number;
  page_size: number;
}

/**
 * 自适应分页大小：根据表格容器可用高度动态计算每页条数
 *
 * - 用 ResizeObserver 监听容器高度变化（窗口缩放、布局调整时自动更新）
 * - 100ms 防抖，避免高频回调引发频繁 setState
 * - 仅当计算出的值真正变化时才更新 state
 * - 初始返回 0，调用方可结合 `enabled: pageSize > 0` 避免初次渲染时
 *   发出基于占位值的无意义请求
 */
function useAdaptivePageSize(
  containerRef: React.RefObject<HTMLDivElement | null>,
  rowHeight = 49,
  headerHeight = 41,
): number {
  const [pageSize, setPageSize] = React.useState(0);
  // 使用 ref 保存防抖 timer，确保 cleanup 能同时清除 timer 与 ResizeObserver。
  const timerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let lastSize = 0;

    const calc = () => {
      timerRef.current = null;
      const available = el.clientHeight - headerHeight;
      // 减 1 行：为分页控件 / 容器 padding 等留出余量，确保最后一行不需要滚动
      const size = Math.max(5, Math.floor(available / rowHeight) - 1);
      if (size !== lastSize) {
        lastSize = size;
        setPageSize(size);
      }
    };

    const schedule = () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(calc, 100);
    };

    calc();
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      ro.disconnect();
    };
  }, [containerRef, rowHeight, headerHeight]);

  return pageSize;
}

/* ---------- constants ---------- */

type TaskStatus =
  | "uploading"
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

const TASK_TYPE_LABEL: Record<string, string> = {
  batch_split_import: "PPT 上传",
};

const importTaskPath = (task: Task) =>
  `${task.params.import_target === "templates" ? "/templates/import" : "/resources/import"}?task_id=${task.id}`;

const STATUS_LABEL: Record<TaskStatus, string> = {
  uploading: "上传中",
  pending: "等待中",
  processing: "处理中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const STATUS_BADGE_VARIANT: Record<
  TaskStatus,
  "default" | "secondary" | "success" | "destructive" | "warning" | "outline" | "soft" | "blue"
> = {
  uploading: "blue",
  pending: "outline",
  processing: "default",
  completed: "success",
  failed: "destructive",
  cancelled: "soft",
};

const SCOPE_LABEL: Record<string, string> = {
  public: "公开",
  partial: "部分",
  private: "私有",
};

const ACTIVE_STATUSES: TaskStatus[] = ["uploading", "pending", "processing"];

const STATUS_FILTERS: { value: "all" | TaskStatus; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "uploading", label: "上传中" },
  { value: "processing", label: "处理中" },
  { value: "pending", label: "等待中" },
  { value: "completed", label: "已完成" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已取消" },
];

/* ---------- helpers ---------- */

function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  try {
    const date = new Date(dateStr);
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

function formatRelativeTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = Date.now();
    const diffMs = now - date.getTime();
    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    if (days < 30) return `${days} 天前`;
    return date.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

function formatDuration(startStr: string, endStr: string | null): string {
  try {
    const start = new Date(startStr).getTime();
    const end = endStr ? new Date(endStr).getTime() : Date.now();
    const diffMs = end - start;
    if (diffMs < 0) return "-";
    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}时${minutes % 60}分`;
    if (minutes > 0) return `${minutes}分${seconds % 60}秒`;
    return `${seconds}秒`;
  } catch {
    return "-";
  }
}

function statusIcon(status: string): React.ReactElement {
  const cls = "h-3.5 w-3.5";
  switch (status) {
    case "uploading":
      return <Upload className={cls} />;
    case "pending":
      return <CircleDashed className={cls} />;
    case "processing":
      return <Loader2 className={cn(cls, "animate-spin")} />;
    case "completed":
      return <CheckCircle2 className={cls} />;
    case "failed":
      return <XCircle className={cls} />;
    case "cancelled":
      return <OctagonX className={cls} />;
    default:
      return <Info className={cls} />;
  }
}

function ownerDisplay(owner: TaskOwner | null, fallbackId: number): string {
  if (!owner) return `#${fallbackId}`;
  return owner.name || owner.username || `#${owner.id}`;
}

/* ---------- Task Row ---------- */

interface TaskRowProps {
  task: Task;
  onOpenDetails: () => void;
  onCancel: (task: Task) => void;
  canManage: boolean;
  showOwner: boolean;
  isAdmin: boolean;
  isSelected: boolean;
  onSelectToggle: () => void;
}

function TaskRow({ task, onOpenDetails, onCancel, canManage, showOwner, isAdmin, isSelected, onSelectToggle }: TaskRowProps) {
  const navigate = useNavigate();
  const status = task.status as TaskStatus;
  const isActive = ACTIVE_STATUSES.includes(status);
  const isCompleted = status === "completed";
  const isFailed = status === "failed";
  const isCancelled = status === "cancelled";

  const percent =
    task.total > 0 ? Math.min(100, Math.round((task.progress / task.total) * 100)) : 0;

  return (
    <>
      <TableRow
        className={cn(
          "cursor-pointer transition-colors",
          (isCompleted || isCancelled) && "opacity-80",
        )}
        onClick={onOpenDetails}
      >
        {isAdmin && (
          <TableCell onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={isSelected}
              onCheckedChange={onSelectToggle}
            />
          </TableCell>
        )}

        <TableCell className="font-mono text-xs text-muted-foreground">
          #{task.id}
        </TableCell>

        <TableCell>
          <div className="flex flex-col gap-0.5">
            <TableText className="text-sm font-medium" text={task.params.series || task.params.name_prefix || TASK_TYPE_LABEL[task.task_type] || task.task_type} />
            <TableText className="text-[11px] text-muted-foreground" text={`${TASK_TYPE_LABEL[task.task_type] || task.task_type}${task.params.subject ? ` · ${task.params.subject}` : ""}`} />
          </div>
        </TableCell>

        <TableCell>
          <Badge
            variant={STATUS_BADGE_VARIANT[status] || "outline"}
            className="gap-1 text-[11px]"
          >
            {statusIcon(status)}
            {STATUS_LABEL[status] || status}
          </Badge>
        </TableCell>

        <TableCell>
          <div className="flex min-w-0 items-center gap-2">
            {task.total > 0 ? (
              <>
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all duration-500",
                      isCompleted && "bg-emerald-500",
                      isFailed && "bg-destructive",
                      isCancelled && "bg-muted-foreground/60",
                      !isCompleted && !isFailed && !isCancelled && "bg-primary",
                    )}
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                  {task.progress}/{task.total}
                </span>
              </>
            ) : status === "processing" && task.message ? (
              <TableText className="text-xs text-muted-foreground" text={task.message} />
            ) : (
              <span className="text-xs text-muted-foreground">-</span>
            )}
          </div>
        </TableCell>

        {showOwner && (
          <TableCell className="whitespace-nowrap">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <User className="h-3 w-3 shrink-0" />
              <TableText text={ownerDisplay(task.owner, task.owner_id)} />
            </div>
          </TableCell>
        )}

        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
          {formatRelativeTime(task.created_at)}
        </TableCell>

        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatDuration(task.created_at, task.completed_at)}
          </span>
        </TableCell>

        <TableCell>
          <div className="flex items-center gap-1">
            {task.params.session_id && !isCompleted && !isCancelled ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(importTaskPath(task));
                }}
              >
                <Upload className="h-3.5 w-3.5" />
                继续
              </Button>
            ) : canManage && isActive ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel(task);
                }}
              >
                <OctagonX className="h-3.5 w-3.5" />
                停止
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              aria-label={`查看任务 #${task.id} 详情`}
              title="查看详情"
              onClick={(event) => {
                event.stopPropagation();
                onOpenDetails();
              }}
            >
              <Eye className="h-3.5 w-3.5" />
              详情
            </Button>
          </div>
        </TableCell>
      </TableRow>
    </>
  );
}

/* ---------- Task Detail Dialog ---------- */

function TaskDetail({ task, onClose }: { task: Task; onClose: () => void }) {
  const navigate = useNavigate();
  const params = task.params || {};
  const result = task.result_data || {};
  const resourceIds = Array.isArray(result.resource_ids) ? result.resource_ids : [];
  const resourceDetailTokens = result.resource_detail_tokens || {};
  const status = task.status as TaskStatus;
  const isActive = ACTIVE_STATUSES.includes(status);
  const taskTitle = params.series || params.name_prefix || TASK_TYPE_LABEL[task.task_type] || task.task_type;
  const percent = task.total > 0
    ? Math.min(100, Math.round((task.progress / task.total) * 100))
    : Math.min(100, Math.max(0, Number(task.upload_progress) || 0));
  const progressTone = status === "failed"
    ? "bg-destructive"
    : status === "cancelled"
      ? "bg-muted-foreground/60"
      : status === "completed"
        ? "bg-emerald-500"
        : "bg-primary";

  const continueImport = () => {
    onClose();
    navigate(importTaskPath(task));
  };

  return (
    <DialogContent className="flex max-h-[min(760px,calc(100vh-2rem))] max-w-3xl flex-col gap-0 overflow-hidden p-0">
      <DialogHeader className="border-b bg-muted/20 px-6 py-5 pr-12 text-left">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
              status === "failed" ? "bg-destructive/10 text-destructive" : status === "completed" ? "bg-emerald-500/10 text-emerald-600" : status === "cancelled" ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
            )}>
              {statusIcon(status)}
            </div>
            <div className="min-w-0">
              <DialogTitle className="truncate text-base">{taskTitle}</DialogTitle>
              <DialogDescription className="mt-1 truncate text-xs">
                上传任务 #{task.id} · {formatDateTime(task.created_at)}
              </DialogDescription>
            </div>
          </div>
          <Badge variant={STATUS_BADGE_VARIANT[status] || "outline"} className="shrink-0 gap-1 text-[11px]">
            {statusIcon(status)}
            {STATUS_LABEL[status] || status}
          </Badge>
        </div>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="space-y-5">
          {(task.total > 0 || task.upload_progress > 0 || task.message) && (
            <section className="rounded-lg border bg-background p-4">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-medium">处理进度</span>
                <span className="tabular-nums text-muted-foreground">{percent}%</span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full transition-[width] duration-500", progressTone)} style={{ width: `${percent}%` }} />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span>{task.total > 0 ? `${task.progress} / ${task.total} 页` : "上传处理中"}</span>
                {task.message && <span className="max-w-full truncate">{task.message}</span>}
              </div>
            </section>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <DetailCard icon={<Info className="h-3.5 w-3.5" />} title="任务信息">
              <InfoRow label="任务 ID" value={`#${task.id}`} mono />
              <InfoRow label="类型" value={TASK_TYPE_LABEL[task.task_type] || task.task_type} />
              <InfoRow label="提交人" value={ownerDisplay(task.owner, task.owner_id)} />
              <InfoRow label="更新时间" value={formatDateTime(task.updated_at)} />
              {task.completed_at && <InfoRow label="完成时间" value={formatDateTime(task.completed_at)} />}
              <InfoRow label="耗时" value={formatDuration(task.created_at, task.completed_at)} />
            </DetailCard>

            <DetailCard icon={<FileText className="h-3.5 w-3.5" />} title="提交参数">
              {params.import_target === "templates" && <InfoRow label="导入目标" value="标准模板" />}
              {params.series && <InfoRow label="系列" value={params.series} />}
              {params.name_prefix && params.import_target !== "templates" && <InfoRow label="名称前缀" value={params.name_prefix} />}
              {params.file_name && <InfoRow label="PPT 文件" value={params.file_name} />}
              {params.workflow_state && <InfoRow label="处理阶段" value={params.workflow_state === "font_check" ? "字体检测" : params.workflow_state === "rendering" ? "图片渲染" : params.workflow_state === "awaiting_confirmation" ? "等待确认导入" : params.workflow_state === "completed" ? "已完成" : params.workflow_state} />}
              {typeof params.slide_count === "number" && <InfoRow label="页数" value={`${params.slide_count} 页`} />}
              {typeof params.render_completed === "number" && typeof params.render_total === "number" && <InfoRow label="渲染进度" value={`${params.render_completed} / ${params.render_total} 页`} />}
              {params.subject && <InfoRow label="分类" value={params.subject} />}
              {params.tags && <InfoRow label="标签" value={params.tags} />}
              {params.visibility_scope && <InfoRow label="可见范围" value={SCOPE_LABEL[params.visibility_scope] || params.visibility_scope} />}
              {params.management_scope && <InfoRow label="管理范围" value={SCOPE_LABEL[params.management_scope] || params.management_scope} />}
              {typeof params.image_count === "number" && <InfoRow label="预览图片" value={`${params.image_count} 张`} />}
              {params.remark_html && (
                <div className="mt-3 space-y-1">
                  <div className="text-[11px] font-medium text-muted-foreground">备注</div>
                  <div className="rounded-md border bg-background p-2 text-xs leading-relaxed" dangerouslySetInnerHTML={{ __html: params.remark_html }} />
                </div>
              )}
            </DetailCard>
          </div>

          <DetailCard
            icon={status === "failed" ? <AlertCircle className="h-3.5 w-3.5 text-destructive" /> : <Hash className="h-3.5 w-3.5" />}
            title={status === "failed" ? "失败原因" : "执行结果"}
          >
            {status === "failed" && task.error_message ? (
              <div className="whitespace-pre-wrap break-all rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive">{task.error_message}</div>
            ) : status === "completed" ? (
              <>
                <InfoRow label="总页数" value={String(result.total ?? task.total ?? 0)} />
                <InfoRow label="成功创建" value={String(result.created ?? 0)} highlight />
                {resourceIds.length > 0 && (
                  <div className="mt-3 space-y-2">
                    <div className="text-[11px] font-medium text-muted-foreground">生成的资源 ID</div>
                    <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                      {resourceIds.map((id) => {
                        const detailToken = resourceDetailTokens[String(id)];
                        const className = "inline-flex items-center rounded-md border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground";
                        return detailToken ? (
                          <Link key={id} to={`/resources/${encodeURIComponent(detailToken)}`} onClick={onClose} className={`${className} text-primary hover:border-primary/50 hover:underline`} title={`打开资源 #${id} 的单页详情`}>#{id}</Link>
                        ) : (
                          <span key={id} className={className}>#{id}</span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            ) : status === "cancelled" ? (
              <div className="text-xs text-muted-foreground">任务已被取消</div>
            ) : isActive ? (
              <div className="text-xs text-muted-foreground">任务正在处理，完成后会显示生成的资源。</div>
            ) : (
              <div className="text-xs text-muted-foreground">暂无结果</div>
            )}
          </DetailCard>
        </div>
      </div>

      <DialogFooter className="border-t bg-muted/20 px-6 py-4">
        <Button type="button" variant="outline" onClick={onClose}>关闭</Button>
        {isActive && params.session_id && (
          <Button type="button" className="gap-1.5" onClick={continueImport}>
            <Upload className="h-3.5 w-3.5" />继续维护导入
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

function DetailCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
        {icon}
        {title}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "max-w-[65%] break-all text-right",
          mono && "font-mono",
          highlight && "font-semibold text-primary",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/* ---------- Status Chips ---------- */

interface UserOptionsResponse {
  users: UserOption[];
}

function TaskOwnerFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [search, setSearch] = React.useState("");
  const selectedId = /^\d+$/.test(value) ? Number(value) : null;

  React.useEffect(() => {
    const timer = window.setTimeout(() => setSearch(input.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [input]);

  const { data, isFetching } = useQuery({
    queryKey: ["users", "options", "task-owner", search, selectedId],
    queryFn: () => api<UserOptionsResponse>("/api/users/options", {
      params: {
        search: search || undefined,
        ids: selectedId ? String(selectedId) : undefined,
        limit: 100,
      },
    }),
    enabled: open || selectedId != null,
    staleTime: 60_000,
  });

  const users = data?.users ?? [];
  const selectedUser = users.find((user) => user.id === selectedId);
  const summary = value === "self"
    ? "仅自己"
    : value === "all"
      ? "全部用户"
      : selectedUser
        ? selectedUser.name || selectedUser.username
        : "指定用户";

  const choose = (nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "group inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-sm transition hover:border-foreground/30 hover:bg-accent",
            value !== "all" && "border-foreground/25 bg-primary-weak",
          )}
          aria-expanded={open}
          aria-label="按提交人筛选"
        >
          <span className={cn("text-muted-foreground", value !== "all" && "text-foreground")}>提交人</span>
          <span className="max-w-36 truncate font-medium">{summary}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            value={input}
            onValueChange={setInput}
            placeholder="输入姓名或用户名搜索"
          />
          <CommandList>
            <CommandItem value="all" onSelect={() => choose("all")}>
              <Check className={cn("h-4 w-4", value === "all" ? "opacity-100" : "opacity-0")} />
              <span>全部用户</span>
            </CommandItem>
            <CommandItem value="self" onSelect={() => choose("self")}>
              <Check className={cn("h-4 w-4", value === "self" ? "opacity-100" : "opacity-0")} />
              <span>仅自己</span>
            </CommandItem>
            <div className="my-1 border-t" />
            {isFetching && users.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-5 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />加载用户…
              </div>
            ) : users.length === 0 ? (
              <CommandEmpty>没有匹配的用户</CommandEmpty>
            ) : (
              users.map((user) => (
                <CommandItem
                  key={user.id}
                  value={String(user.id)}
                  onSelect={() => choose(String(user.id))}
                >
                  <Check className={cn("h-4 w-4", user.id === selectedId ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{user.name || user.username}</span>
                  <span className="ml-auto truncate text-xs text-muted-foreground">@{user.username}</span>
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function TaskFilterBar({
  isAdmin,
  ownerFilter,
  onOwnerFilterChange,
  filter,
  onFilterChange,
  searchInput,
  onSearchInputChange,
  searchPlaceholder,
  selectedCount,
  onBulkDelete,
  bulkDeletePending,
}: {
  isAdmin: boolean;
  ownerFilter: string;
  onOwnerFilterChange: (value: string) => void;
  filter: "all" | TaskStatus;
  onFilterChange: (value: "all" | TaskStatus) => void;
  searchInput: string;
  onSearchInputChange: (value: string) => void;
  searchPlaceholder: string;
  selectedCount: number;
  onBulkDelete?: () => void;
  bulkDeletePending?: boolean;
}) {
  const statusOptions: ChipOption[] = STATUS_FILTERS;

  return (
    <div className="page-toolbar">
      <div className="relative min-w-[220px] flex-1 sm:flex-none">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchInput}
          onChange={(event) => onSearchInputChange(event.target.value)}
          placeholder={searchPlaceholder}
          className={cn(
            "h-8 w-full bg-background pl-7 pr-3 text-sm shadow-sm sm:w-64",
            searchInput.trim() && "border-primary/40 bg-primary/5",
          )}
        />
      </div>

      <ResourceFilterChip
        label="状态"
        options={statusOptions}
        value={filter}
        onChange={(value) => onFilterChange(value as "all" | TaskStatus)}
        baseValue="all"
      />

      {isAdmin && (
        <TaskOwnerFilter value={ownerFilter} onChange={onOwnerFilterChange} />
      )}

      {isAdmin && onBulkDelete && (
        <Button
          variant="outline"
          size="sm"
          disabled={selectedCount === 0 || bulkDeletePending}
          onClick={onBulkDelete}
          className="ml-auto h-8 gap-1.5 px-3 text-sm text-destructive hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
          删除选中{selectedCount ? `（${selectedCount}）` : ""}
        </Button>
      )}
    </div>
  );
}

/* ---------- Pagination ---------- */

function TasksPagination({
  page,
  totalPages,
  total,
  pageSize,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onChange: (next: number) => void;
}) {
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return (
    <div className="flex shrink-0 items-center justify-between border-t pt-3 text-sm text-muted-foreground select-none">
      <span>
        显示 {start}-{end}，共 {total} 条
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onChange(Math.max(1, page - 1))}
        >
          上一页
        </Button>
        <span className="min-w-[52px] select-none text-center text-foreground">
          {page} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onChange(Math.min(totalPages, page + 1))}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}

/* ---------- Main component ---------- */

export default function TasksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const tab: "uploads" | "downloads" = rawTab === "uploads" ? "uploads" : "downloads";
  const { user } = useAuth();
  const canManage = isAdminRole(user?.role);
  const title = "任务管理";

  const handleTabChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "uploads") {
      next.set("tab", "uploads");
    } else {
      next.delete("tab");
    }
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="page-shell">
      <PageHeader
        title={title}
        titleExtra={
          <Badge variant="secondary" className="rounded-md px-2 text-[11px]">
            {canManage ? "可维护" : "只读"}
          </Badge>
        }
        description="查看上传和下载任务，按状态、提交人或关键词快速筛选。"
      />

      <Tabs value={tab} onValueChange={handleTabChange} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="w-fit border bg-muted/40">
          <TabsTrigger value="downloads" className="gap-1.5">
            <Download className="h-3.5 w-3.5" />
            下载任务
          </TabsTrigger>
          <TabsTrigger value="uploads" className="gap-1.5">
            <Upload className="h-3.5 w-3.5" />
            上传任务
          </TabsTrigger>
        </TabsList>
        <TabsContent
          value="downloads"
          className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <DownloadTasksTab canManage={canManage} />
        </TabsContent>
        <TabsContent
          value="uploads"
          className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <UploadTasksTab canManage={canManage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ---------- Upload Tasks Tab ---------- */

function UploadTasksTab({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [cancelTarget, setCancelTarget] = React.useState<Task | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  const [detailTask, setDetailTask] = React.useState<Task | null>(null);
  const [filter, setFilter] = React.useState<"all" | TaskStatus>("all");
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  // 用户维度筛选："all" = 所有用户；"self" = 仅自己；其他为某个用户 id 的字符串形式
  const [ownerFilter, setOwnerFilter] = React.useState<string>("all");
  const [searchInput, setSearchInput] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);

  // 表格容器引用 + 自适应分页大小（根据可用高度动态计算）
  const listContainerRef = React.useRef<HTMLDivElement | null>(null);
  const pageSize = useAdaptivePageSize(listContainerRef);

  const isAdmin = canManage;
  const currentUserId = user?.id ?? null;

  // 动态计算向后端传递的 owner_id（仅管理员能传，非管理员后端会忽略）
  const ownerIdParam = React.useMemo<number | undefined>(() => {
    if (!isAdmin) return undefined;
    if (ownerFilter === "all") return undefined;
    if (ownerFilter === "self") return currentUserId ?? undefined;
    const n = Number(ownerFilter);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }, [isAdmin, ownerFilter, currentUserId]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // 筛选/搜索/用户/分页大小变化时重置页码（避免越界）
  React.useEffect(() => {
    setPage(1);
  }, [filter, ownerIdParam, search, pageSize]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["tasks", "upload", ownerIdParam ?? "all", filter, search, page, pageSize],
    queryFn: async () => {
      const params: Record<string, string | number> = {
        task_type: "batch_split_import",
        page,
        page_size: pageSize,
      };
      if (ownerIdParam != null) params.owner_id = ownerIdParam;
      if (filter !== "all") params.status = filter;
      if (search) params.search = search;
      return api<TaskListResponse>("/api/tasks", { params });
    },
    // pageSize 首次完成测量前不发起请求，避免无意义的占位查询
    enabled: pageSize > 0,
    refetchInterval: (query) => {
      const list = query.state.data?.items ?? [];
      const hasActive = list.some((t) => ACTIVE_STATUSES.includes(t.status as TaskStatus));
      return hasActive ? 3000 : 15000;
    },
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });

  // 容器尚未测量完成时（pageSize=0），视为加载态
  const isMeasuring = pageSize === 0;

  const tasks = data?.items ?? [];
  const total = data?.total ?? tasks.length;
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));

  const filteredIds = React.useMemo(() => tasks.map((t) => t.id), [tasks]);
  const allSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));
  const someSelected = filteredIds.some((id) => selected.has(id)) && !allSelected;

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) filteredIds.forEach((id) => next.delete(id));
      else filteredIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const cancelMutation = useMutation({
    mutationFn: async (taskId: number) =>
      api(`/api/tasks/${taskId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      toast.success("任务已取消");
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      setCancelTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || "取消失败"),
  });

  const bulkDelMut = useMutation({
    mutationFn: async (ids: number[]) =>
      api<{ deleted: number }>("/api/admin/tasks/bulk-delete", {
        method: "POST",
        json: { task_ids: ids },
      }),
    onSuccess: (data) => {
      toast.success(`已删除 ${data.deleted} 个任务`);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (err: Error) => toast.error(err.message || "批量删除失败"),
  });

  // 管理员视角展示提交人列
  const showOwner = canManage;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <TaskFilterBar
        isAdmin={isAdmin}
        ownerFilter={ownerFilter}
        onOwnerFilterChange={setOwnerFilter}
        filter={filter}
        onFilterChange={setFilter}
        searchInput={searchInput}
        onSearchInputChange={setSearchInput}
        searchPlaceholder="搜索系列、文件名或主体"
        selectedCount={selected.size}
        bulkDeletePending={bulkDelMut.isPending}
        onBulkDelete={() => {
          setBulkDeleteOpen(true);
        }}
      />

      {/* 内容区 */}
      <div ref={listContainerRef} className="surface min-h-0 flex-1 overflow-auto">
        {isMeasuring || isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
          </div>
        ) : isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            加载失败：{(error as Error)?.message || "未知错误"}
          </div>
        ) : tasks.length === 0 ? (
          <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">
            {search
              ? `没有匹配“${search}”的上传任务`
              : filter === "all"
                ? "暂无上传任务"
                : `无${STATUS_LABEL[filter as TaskStatus] || ""}的上传任务`}
          </div>
        ) : (
          <div className="overflow-hidden">
            <Table className="min-w-[1160px]">
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  {isAdmin && (
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allSelected || (someSelected ? "indeterminate" : false)}
                        onCheckedChange={toggleAll}
                        disabled={filteredIds.length === 0}
                      />
                    </TableHead>
                  )}
                  <TableHead className="w-20">ID</TableHead>
                  <TableHead>任务</TableHead>
                  <TableHead className="w-28">状态</TableHead>
                  <TableHead className="w-48">进度</TableHead>
                  {showOwner && <TableHead className="w-32">提交人</TableHead>}
                  <TableHead className="w-28">提交时间</TableHead>
                  <TableHead className="w-24">耗时</TableHead>
                  <TableHead className="w-40">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onOpenDetails={() => setDetailTask(task)}
                    onCancel={setCancelTarget}
                    canManage={canManage}
                    showOwner={showOwner}
                    isAdmin={isAdmin}
                    isSelected={selected.has(task.id)}
                    onSelectToggle={() => toggleOne(task.id)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* 分页 */}
      {!isLoading && !isError && total > 0 && pageSize > 0 && (
        <TasksPagination
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={pageSize}
          onChange={setPage}
        />
      )}

      <Dialog
        open={!!detailTask}
        onOpenChange={(open) => {
          if (!open) setDetailTask(null);
        }}
      >
        {detailTask && <TaskDetail task={detailTask} onClose={() => setDetailTask(null)} />}
      </Dialog>

      {/* 停止确认对话框 */}
      <Dialog
        open={!!cancelTarget}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>确认停止任务</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确定要停止任务
            <span className="mx-1 font-semibold text-foreground">
              #{cancelTarget?.id}
              {cancelTarget?.params.name_prefix ? ` · ${cancelTarget.params.name_prefix}` : ""}
            </span>
            吗？此操作不可撤销。
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCancelTarget(null)}
              disabled={cancelMutation.isPending}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => cancelTarget && cancelMutation.mutate(cancelTarget.id)}
              disabled={cancelMutation.isPending}
            >
              {cancelMutation.isPending && (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              )}
              确认停止
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title="批量删除任务记录"
        description={`确定删除选中的 ${selected.size} 条任务记录吗？未完成的任务将停止，临时文件会清理；已导入的素材不受影响。`}
        confirmLabel="删除记录"
        destructive
        loading={bulkDelMut.isPending}
        onConfirm={() => {
          bulkDelMut.mutate(Array.from(selected), { onSuccess: () => setBulkDeleteOpen(false) });
        }}
      />
    </div>
  );
}

/* ---------- Download Tasks Tab ---------- */

const DOWNLOAD_TYPE_LABEL: Record<string, string> = {
  pdf: "PDF（纯图）",
  pptx_images: "PPT（纯图）",
  pptx: "PPT（无内嵌字体）",
  pptx_fonts: "ZIP（PPT + 字体包）",
  zip: "ZIP（逐个 PPT）",
  zip_fonts: "ZIP（PPT + 字体包）",
};

function formatFileSize(bytes?: number | null): string {
  if (bytes == null || bytes <= 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function downloadTaskShowName(task: Task): string {
  return (
    task.params?.show_name ||
    task.params?.name_prefix ||
    (task.params?.show_id ? `#${task.params.show_id}` : "—")
  );
}

function DownloadTasksTab({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [filter, setFilter] = React.useState<"all" | TaskStatus>("all");
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  // 用户维度筛选："all" = 所有用户；"self" = 仅自己；其他为某个用户 id 的字符串形式
  const [ownerFilter, setOwnerFilter] = React.useState<string>("all");
  // 搜索输入值与防抖后的实际查询值分开
  const [searchInput, setSearchInput] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);

  // 表格容器引用 + 自适应分页大小（根据可用高度动态计算）
  const listContainerRef = React.useRef<HTMLDivElement | null>(null);
  const pageSize = useAdaptivePageSize(listContainerRef);

  const isAdmin = canManage;
  const showOwner = canManage;
  const currentUserId = user?.id ?? null;

  // 动态计算向后端传递的 owner_id（仅管理员能传，非管理员后端会忽略）
  const ownerIdParam = React.useMemo<number | undefined>(() => {
    if (!isAdmin) return undefined;
    if (ownerFilter === "all") return undefined;
    if (ownerFilter === "self") return currentUserId ?? undefined;
    const n = Number(ownerFilter);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }, [isAdmin, ownerFilter, currentUserId]);

  // 输入防抖 300ms
  React.useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  // 筛选/搜索/用户/分页大小变化时重置页码（避免越界）
  React.useEffect(() => {
    setPage(1);
  }, [filter, ownerIdParam, search, pageSize]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["tasks", "download", ownerIdParam ?? "all", filter, search, page, pageSize],
    queryFn: async () => {
      const params: Record<string, string | number> = {
        task_type: "download",
        page,
        page_size: pageSize,
      };
      if (ownerIdParam != null) params.owner_id = ownerIdParam;
      if (filter !== "all") params.status = filter;
      if (search) params.search = search;
      return api<TaskListResponse>("/api/tasks", { params });
    },
    // pageSize 首次完成测量前不发起请求，避免无意义的占位查询
    enabled: pageSize > 0,
    refetchInterval: (query) => {
      const list = query.state.data?.items ?? [];
      const hasActive = list.some((t) => ACTIVE_STATUSES.includes(t.status as TaskStatus));
      return hasActive ? 3000 : 15000;
    },
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });

  // 容器尚未测量完成时（pageSize=0），视为加载态
  const isMeasuring = pageSize === 0;

  const tasks = data?.items ?? [];
  const total = data?.total ?? tasks.length;
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));

  const filteredIds = React.useMemo(() => tasks.map((t) => t.id), [tasks]);
  const allSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));
  const someSelected = filteredIds.some((id) => selected.has(id)) && !allSelected;

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) filteredIds.forEach((id) => next.delete(id));
      else filteredIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const bulkDelMut = useMutation({
    mutationFn: async (ids: number[]) =>
      api<{ deleted: number }>("/api/admin/tasks/bulk-delete", {
        method: "POST",
        json: { task_ids: ids },
      }),
    onSuccess: (data) => {
      toast.success(`已删除 ${data.deleted} 个任务`);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["tasks", "download"] });
    },
    onError: (err: Error) => toast.error(err.message || "批量删除失败"),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <TaskFilterBar
        isAdmin={isAdmin}
        ownerFilter={ownerFilter}
        onOwnerFilterChange={setOwnerFilter}
        filter={filter}
        onFilterChange={setFilter}
        searchInput={searchInput}
        onSearchInputChange={setSearchInput}
        searchPlaceholder="搜索追踪码、放映名称或文件名"
        selectedCount={selected.size}
        bulkDeletePending={bulkDelMut.isPending}
        onBulkDelete={() => {
          setBulkDeleteOpen(true);
        }}
      />

      {/* 内容区 */}
      <div ref={listContainerRef} className="surface min-h-0 flex-1 overflow-auto">
        {isMeasuring || isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
          </div>
        ) : isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            加载失败：{(error as Error)?.message || "未知错误"}
          </div>
        ) : tasks.length === 0 ? (
          <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">
            {search
              ? `没有匹配“${search}”的下载任务`
              : filter === "all"
                ? "暂无下载任务"
                : `无${STATUS_LABEL[filter as TaskStatus] || ""}的下载任务`}
          </div>
        ) : (
          <TooltipProvider delayDuration={150}>
          <div className="overflow-hidden">
            <Table className="min-w-[1120px]">
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  {isAdmin && (
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allSelected || (someSelected ? "indeterminate" : false)}
                        onCheckedChange={toggleAll}
                        disabled={filteredIds.length === 0}
                      />
                    </TableHead>
                  )}
                  <TableHead className="w-20">ID</TableHead>
                  <TableHead>放映名称</TableHead>
                  <TableHead className="w-28">下载类型</TableHead>
                  <TableHead className="w-44">状态</TableHead>
                  <TableHead className="w-32">追踪码</TableHead>
                  {showOwner && <TableHead className="w-28">提交人</TableHead>}
                  <TableHead className="w-24">提交时间</TableHead>
                  <TableHead className="w-28">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => (
                  <DownloadTaskRow
                    key={task.id}
                    task={task}
                    showOwner={showOwner}
                    isAdmin={isAdmin}
                    isSelected={selected.has(task.id)}
                    onSelectToggle={() => toggleOne(task.id)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
          </TooltipProvider>
        )}
      </div>

      {/* 分页 */}
      {!isLoading && !isError && total > 0 && pageSize > 0 && (
        <TasksPagination
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={pageSize}
          onChange={setPage}
        />
      )}
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title="批量删除任务记录"
        description={`确定删除选中的 ${selected.size} 条下载任务记录吗？未完成的任务将停止，删除后无法再从此记录下载文件；已保存到你设备的文件不受影响。`}
        confirmLabel="删除记录"
        destructive
        loading={bulkDelMut.isPending}
        onConfirm={() => {
          bulkDelMut.mutate(Array.from(selected), { onSuccess: () => setBulkDeleteOpen(false) });
        }}
      />
    </div>
  );
}

interface DownloadTaskRowProps {
  task: Task;
  showOwner: boolean;
  isAdmin: boolean;
  isSelected: boolean;
  onSelectToggle: () => void;
}

function DownloadTaskRow({ task, showOwner, isAdmin, isSelected, onSelectToggle }: DownloadTaskRowProps) {
  const [downloading, setDownloading] = React.useState(false);
  const status = task.status as TaskStatus;
  const isCompleted = status === "completed";
  const isFailed = status === "failed";
  const isCancelled = status === "cancelled";
  const isProgressing = status === "processing" || status === "pending" || status === "uploading";

  const percent =
    task.total > 0
      ? Math.min(100, Math.round((task.progress / task.total) * 100))
      : task.progress > 0 && task.progress <= 100
        ? Math.round(task.progress)
        : 0;

  const downloadType = task.params?.download_type || "";
  const downloadLabel = task.params?.embed_fonts
    ? "PPT（内嵌字体）"
    : task.params?.with_fonts && downloadType === "pptx"
      ? "ZIP（PPT + 字体包）"
      : DOWNLOAD_TYPE_LABEL[downloadType] || downloadType;
  const fileName = task.params?.file_name;
  const fileSize = task.params?.file_size;
  const trackCode = task.params?.track_code;
  const clientIp = task.params?.client_ip;
  const isExpired = task.result_data?.expired === true;

  const handleDownload = async () => {
    if (isExpired) {
      toast.error("下载文件已过期，请重新发起下载");
      return;
    }
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadFile(`/api/downloads/${task.id}/file`, fileName);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "下载失败");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <TableRow>
      {isAdmin && (
        <TableCell onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={isSelected} onCheckedChange={onSelectToggle} />
        </TableCell>
      )}

      <TableCell className="font-mono text-xs text-muted-foreground">#{task.id}</TableCell>

      <TableCell>
        <div className="flex flex-col gap-0.5">
          <TableText className="text-sm font-medium" text={downloadTaskShowName(task)} />
          <span className="text-[11px] text-muted-foreground">
            {task.params?.with_fonts && <span>含字体打包</span>}
            {task.params?.with_fonts && isCompleted && fileSize ? <span> · </span> : null}
            {isCompleted && fileSize ? (
              <span className="tabular-nums">{formatFileSize(fileSize)}</span>
            ) : null}
            {!task.params?.with_fonts && !(isCompleted && fileSize) && <span>&nbsp;</span>}
          </span>
        </div>
      </TableCell>

      <TableCell>
        <span className="inline-flex max-w-full items-center rounded-md border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
          <TableText text={downloadLabel || "—"} />
        </span>
      </TableCell>

      {/* 状态（含进度） */}
      <TableCell>
        <span
          className={cn(
            "inline-flex h-5 items-center gap-1 text-[11px]",
            isProgressing && "rounded-full border px-2.5 font-medium",
            isCompleted && "text-emerald-600",
            isFailed && "text-destructive max-w-full truncate",
            isCancelled && "text-muted-foreground",
          )}
          title={isFailed ? task.error_message || "处理失败" : undefined}
        >
          {statusIcon(status)}
          {isProgressing && percent > 0
            ? `${STATUS_LABEL[status] || status} ${percent}%`
            : STATUS_LABEL[status] || status}
        </span>
      </TableCell>

      {/* 追踪码（hover 显示 IP） */}
      <TableCell className="font-mono text-xs text-muted-foreground">
        {trackCode ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="block cursor-default truncate border-b border-dashed border-muted-foreground/40">
                {trackCode}
              </span>
            </TooltipTrigger>
            <TooltipPortal><TooltipContent side="top" className="max-w-[min(24rem,calc(100vw-2rem))] break-all font-mono">
              <div className="flex flex-col gap-0.5">
                <span>追踪码：{trackCode}</span>
                <span>客户端IP：{clientIp || "—"}</span>
              </div>
            </TooltipContent></TooltipPortal>
          </Tooltip>
        ) : clientIp ? (
          <TableText className="text-muted-foreground/80" text={clientIp} />
        ) : (
          <span className="text-muted-foreground/60">—</span>
        )}
      </TableCell>

      {showOwner && (
        <TableCell className="whitespace-nowrap">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <User className="h-3 w-3 shrink-0" />
            <TableText text={ownerDisplay(task.owner, task.owner_id)} />
          </div>
        </TableCell>
      )}

      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {formatRelativeTime(task.created_at)}
      </TableCell>

      <TableCell className="w-28">
        <div className="flex h-7 items-center">
          {isCompleted && isExpired ? (
            <span className="text-[11px] text-muted-foreground">已过期</span>
          ) : isCompleted ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              disabled={downloading}
              onClick={handleDownload}
            >
              {downloading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              下载
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground">—</span>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
