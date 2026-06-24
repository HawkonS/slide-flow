import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock,
  Download,
  FileText,
  Hash,
  Info,
  Loader2,
  Lock,
  OctagonX,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  User,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { isAdminRole } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useNavLabel } from "@/lib/nav-config";

/* ---------- types ---------- */

interface TaskOwner {
  id: number;
  username: string;
  name: string | null;
  display_name?: string | null;
}

interface TaskParams {
  name_prefix?: string;
  subject?: string;
  tags?: string;
  resource_type?: string;
  secrecy_level?: string;
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
  file_name?: string;
  file_size?: number;
  track_code?: string;
  client_ip?: string;
}

interface UserOption {
  id: number;
  username: string;
  name: string | null;
  display_name?: string | null;
  role?: string;
}

interface UserOptionsResponse {
  users: UserOption[];
}

interface TaskResult {
  total?: number;
  created?: number;
  resource_ids?: number[];
  message?: string;
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
  /** 兼容旧后端：如果后端仍返回 tasks，进行回退 */
  tasks?: Task[];
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
  split_import: "拆分导入",
  batch_split_import: "批量拆分导入",
};

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
  return owner.display_name || owner.name || owner.username || `#${owner.id}`;
}

/* ---------- Task Row ---------- */

interface TaskRowProps {
  task: Task;
  expanded: boolean;
  onToggle: () => void;
  onCancel: (task: Task) => void;
  canManage: boolean;
  showOwner: boolean;
  isAdmin: boolean;
  isSelected: boolean;
  onSelectToggle: () => void;
}

function TaskRow({ task, expanded, onToggle, onCancel, canManage, showOwner, isAdmin, isSelected, onSelectToggle }: TaskRowProps) {
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
          expanded && "bg-muted/40",
          (isCompleted || isCancelled) && !expanded && "opacity-80",
        )}
        onClick={onToggle}
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
            <span className="text-sm font-medium">
              {task.params.name_prefix || TASK_TYPE_LABEL[task.task_type] || task.task_type}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {TASK_TYPE_LABEL[task.task_type] || task.task_type}
              {task.params.subject ? ` · ${task.params.subject}` : ""}
            </span>
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
          <div className="flex min-w-[160px] items-center gap-2">
            {task.total > 0 ? (
              <>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
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
              <span className="truncate text-xs text-muted-foreground">{task.message}</span>
            ) : (
              <span className="text-xs text-muted-foreground">-</span>
            )}
          </div>
        </TableCell>

        {showOwner && (
          <TableCell className="whitespace-nowrap">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <User className="h-3 w-3" />
              {ownerDisplay(task.owner, task.owner_id)}
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

        <TableCell className="w-20">
          {canManage && isActive ? (
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
          ) : (
            <span className="text-[11px] text-muted-foreground">-</span>
          )}
        </TableCell>

        <TableCell className="w-8 pr-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </TableCell>
      </TableRow>

      {/* 详情展开行 */}
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={(showOwner ? 9 : 8) + (isAdmin ? 1 : 0)} className="bg-muted/20 p-0">
            <TaskDetail task={task} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/* ---------- Task Detail Panel ---------- */

function TaskDetail({ task }: { task: Task }) {
  const params = task.params || {};
  const result = task.result_data || {};
  const resourceIds = Array.isArray(result.resource_ids) ? result.resource_ids : [];

  return (
    <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2 lg:grid-cols-3">
      {/* 基础信息 */}
      <DetailCard icon={<Info className="h-3.5 w-3.5" />} title="基础信息">
        <InfoRow label="任务 ID" value={`#${task.id}`} mono />
        <InfoRow
          label="类型"
          value={TASK_TYPE_LABEL[task.task_type] || task.task_type}
        />
        <InfoRow
          label="提交人"
          value={ownerDisplay(task.owner, task.owner_id)}
        />
        <InfoRow label="提交时间" value={formatDateTime(task.created_at)} />
        <InfoRow label="更新时间" value={formatDateTime(task.updated_at)} />
        {task.completed_at && (
          <InfoRow label="完成时间" value={formatDateTime(task.completed_at)} />
        )}
        <InfoRow
          label="耗时"
          value={formatDuration(task.created_at, task.completed_at)}
        />
      </DetailCard>

      {/* 提交参数 */}
      <DetailCard icon={<FileText className="h-3.5 w-3.5" />} title="提交参数">
        {params.name_prefix && <InfoRow label="名称前缀" value={params.name_prefix} />}
        {params.subject && <InfoRow label="分类" value={params.subject} />}
        {params.tags && <InfoRow label="标签" value={params.tags} />}
        {params.resource_type && (
          <InfoRow
            label="资源类型"
            value={params.resource_type === "template" ? "模板" : "素材"}
          />
        )}
        {params.visibility_scope && (
          <InfoRow
            label="可见范围"
            value={SCOPE_LABEL[params.visibility_scope] || params.visibility_scope}
          />
        )}
        {params.management_scope && (
          <InfoRow
            label="管理范围"
            value={SCOPE_LABEL[params.management_scope] || params.management_scope}
          />
        )}
        {params.secrecy_level && (
          <InfoRow label="密级" value={params.secrecy_level} />
        )}
        {typeof params.image_count === "number" && (
          <InfoRow label="预览图片" value={`${params.image_count} 张`} />
        )}
        {params.remark_html && (
          <div className="mt-2 space-y-1">
            <div className="text-[11px] font-medium text-muted-foreground">备注</div>
            <div
              className="rounded-md border bg-background p-2 text-xs leading-relaxed"
              dangerouslySetInnerHTML={{ __html: params.remark_html }}
            />
          </div>
        )}
      </DetailCard>

      {/* 执行结果 / 错误 */}
      <DetailCard
        icon={
          task.status === "failed" ? (
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
          ) : (
            <Hash className="h-3.5 w-3.5" />
          )
        }
        title={task.status === "failed" ? "失败原因" : "执行结果"}
      >
        {task.status === "failed" && task.error_message ? (
          <div className="whitespace-pre-wrap break-all rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            {task.error_message}
          </div>
        ) : task.status === "completed" ? (
          <>
            <InfoRow
              label="总页数"
              value={String(result.total ?? task.total ?? 0)}
            />
            <InfoRow
              label="成功创建"
              value={String(result.created ?? 0)}
              highlight
            />
            {resourceIds.length > 0 && (
              <div className="mt-2 space-y-1">
                <div className="text-[11px] font-medium text-muted-foreground">
                  生成的资源 ID
                </div>
                <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
                  {resourceIds.map((id) => (
                    <span
                      key={id}
                      className="inline-flex items-center rounded-md border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      #{id}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : task.status === "cancelled" ? (
          <div className="text-xs text-muted-foreground">任务已被取消</div>
        ) : task.message ? (
          <InfoRow label="当前状态" value={task.message} />
        ) : (
          <div className="text-xs text-muted-foreground">暂无结果</div>
        )}
      </DetailCard>
    </div>
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

function FilterChip({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground shadow-sm"
          : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground",
      )}
    >
      {children}
      {typeof count === "number" && (
        <span
          className={cn(
            "inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px]",
            active ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          {count}
        </span>
      )}
    </button>
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
  const title = useNavLabel("manage_tasks", "任务管理");

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
    <div className="flex h-full flex-col gap-4">
      {/* 页头 */}
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {canManage ? (
          <Badge variant="blue" className="gap-1 text-[11px]">
            <ShieldCheck className="h-3 w-3" />
            可维护
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-[11px] text-muted-foreground">
            <Lock className="h-3 w-3" />
            只读
          </Badge>
        )}
      </header>

      <Tabs value={tab} onValueChange={handleTabChange} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="w-fit">
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
  const [filter, setFilter] = React.useState<"all" | TaskStatus>("all");
  const [expandedId, setExpandedId] = React.useState<number | null>(null);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  // 用户维度筛选："all" = 所有用户；"self" = 仅自己；其他为某个用户 id 的字符串形式
  const [ownerFilter, setOwnerFilter] = React.useState<string>("all");
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

  // 筛选/用户/分页大小变化时重置页码（避免越界）
  React.useEffect(() => {
    setPage(1);
  }, [filter, ownerIdParam, pageSize]);

  // 用户下拉选项（仅管理员拉取）
  const { data: usersData } = useQuery({
    queryKey: ["users", "options"],
    queryFn: async () => api<UserOptionsResponse>("/api/users/options"),
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
  });
  const userOptions = usersData?.users ?? [];

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["tasks", "upload", ownerIdParam ?? "all", filter, page, pageSize],
    queryFn: async () => {
      const params: Record<string, string | number> = {
        page,
        page_size: pageSize,
      };
      if (ownerIdParam != null) params.owner_id = ownerIdParam;
      if (filter !== "all") params.status = filter;
      return api<TaskListResponse>("/api/tasks", { params });
    },
    // pageSize 首次完成测量前不发起请求，避免无意义的占位查询
    enabled: pageSize > 0,
    refetchInterval: (query) => {
      const list = query.state.data?.items ?? query.state.data?.tasks ?? [];
      const hasActive = list.some((t) => ACTIVE_STATUSES.includes(t.status as TaskStatus));
      return hasActive ? 3000 : 15000;
    },
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });

  // 容器尚未测量完成时（pageSize=0），视为加载态
  const isMeasuring = pageSize === 0;

  // 后端返回 items；过滤掉下载类任务（后端未限定 task_type，这里按原逻辑保证仅上传类可见）
  const tasks = React.useMemo(
    () => (data?.items ?? data?.tasks ?? []).filter((t) => t.task_type !== "download"),
    [data?.items, data?.tasks],
  );
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

  const toggleExpand = (id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  // 管理员视角展示提交人列
  const showOwner = canManage;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* 筛选区：用户下拉 + 状态 chips */}
      <div className="flex flex-wrap items-center gap-2">
        {isAdmin && (
          <Select value={ownerFilter} onValueChange={(v) => setOwnerFilter(v)}>
            <SelectTrigger className="h-8 w-[180px] rounded-full text-xs">
              <SelectValue placeholder="选择用户" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有用户</SelectItem>
              <SelectItem value="self">仅自己</SelectItem>
              {userOptions.map((u) => (
                <SelectItem key={u.id} value={String(u.id)}>
                  {u.display_name || u.name || u.username || `#${u.id}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {STATUS_FILTERS.map((f) => (
          <FilterChip
            key={f.value}
            active={filter === f.value}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </FilterChip>
        ))}
        {isAdmin && (
          <Button
            variant="outline"
            size="sm"
            disabled={selected.size === 0 || bulkDelMut.isPending}
            onClick={() => {
              if (!window.confirm(`确认删除选中的 ${selected.size} 个任务记录？`)) return;
              bulkDelMut.mutate(Array.from(selected));
            }}
            className="h-8 gap-1.5 rounded-full px-3 text-sm text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除选中{selected.size ? `（${selected.size}）` : ""}
          </Button>
        )}
      </div>

      {/* 内容区 */}
      <div ref={listContainerRef} className="min-h-0 flex-1 overflow-auto">
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
            {filter === "all" ? "暂无任务" : `无${STATUS_LABEL[filter as TaskStatus] || ""}的任务`}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  {isAdmin && (
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allSelected || (someSelected ? "indeterminate" : false)}
                        onCheckedChange={toggleAll}
                        disabled={filteredIds.length === 0}
                      />
                    </TableHead>
                  )}
                  <TableHead className="w-16">ID</TableHead>
                  <TableHead>任务</TableHead>
                  <TableHead className="w-28">状态</TableHead>
                  <TableHead className="w-48">进度</TableHead>
                  {showOwner && <TableHead className="w-32">提交人</TableHead>}
                  <TableHead className="w-28">提交时间</TableHead>
                  <TableHead className="w-20">耗时</TableHead>
                  <TableHead className="w-20">操作</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    expanded={expandedId === task.id}
                    onToggle={() => toggleExpand(task.id)}
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
    </div>
  );
}

/* ---------- Download Tasks Tab ---------- */

const DOWNLOAD_TYPE_LABEL: Record<string, string> = {
  pdf: "PDF",
  pptx_images: "纯图 PPT",
  pptx: "合并 PPT",
  pptx_fonts: "PPT + 字体包",
  zip: "逐个 PPT",
  zip_fonts: "PPT + 字体（ZIP）",
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
  // 用户维度筛选："all" = 所有用户；"self" = 仅自己；其他为某个用户 id 的字符串形式
  const [ownerFilter, setOwnerFilter] = React.useState<string>("all");
  // 追踪码搜索：输入值与防抖后的实际查询值分开
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

  // 用户下拉选项（仅管理员拉取）
  const { data: usersData } = useQuery({
    queryKey: ["users", "options"],
    queryFn: async () => api<UserOptionsResponse>("/api/users/options"),
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
  });
  const userOptions = usersData?.users ?? [];

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
      const list = query.state.data?.items ?? query.state.data?.tasks ?? [];
      const hasActive = list.some((t) => ACTIVE_STATUSES.includes(t.status as TaskStatus));
      return hasActive ? 3000 : 15000;
    },
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });

  // 容器尚未测量完成时（pageSize=0），视为加载态
  const isMeasuring = pageSize === 0;

  const tasks = data?.items ?? data?.tasks ?? [];
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
      {/* 筛选区：用户下拉 + 状态 chips + 追踪码搜索 */}
      <div className="flex flex-wrap items-center gap-2">
        {isAdmin && (
          <Select value={ownerFilter} onValueChange={(v) => setOwnerFilter(v)}>
            <SelectTrigger className="h-8 w-[180px] rounded-full text-xs">
              <SelectValue placeholder="选择用户" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有用户</SelectItem>
              <SelectItem value="self">仅自己</SelectItem>
              {userOptions.map((u) => (
                <SelectItem key={u.id} value={String(u.id)}>
                  {u.display_name || u.name || u.username || `#${u.id}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {STATUS_FILTERS.map((f) => (
          <FilterChip
            key={f.value}
            active={filter === f.value}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </FilterChip>
        ))}
        <div className="relative min-w-0">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="搜索追踪码"
            className={cn(
              "h-8 w-full sm:w-48 rounded-full border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition",
              "placeholder:text-muted-foreground",
              "focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              search.trim() !== "" && "border-primary/40 bg-primary/5",
            )}
          />
        </div>
        {isAdmin && (
          <Button
            variant="outline"
            size="sm"
            disabled={selected.size === 0 || bulkDelMut.isPending}
            onClick={() => {
              if (!window.confirm(`确认删除选中的 ${selected.size} 个任务记录？`)) return;
              bulkDelMut.mutate(Array.from(selected));
            }}
            className="h-8 gap-1.5 rounded-full px-3 text-sm text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除选中{selected.size ? `（${selected.size}）` : ""}
          </Button>
        )}
      </div>

      {/* 内容区 */}
      <div ref={listContainerRef} className="min-h-0 flex-1 overflow-auto">
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
              ? `没有匹配追踪码“${search}”的任务`
              : filter === "all"
                ? "暂无下载任务"
                : `无${STATUS_LABEL[filter as TaskStatus] || ""}的下载任务`}
          </div>
        ) : (
          <TooltipProvider delayDuration={150}>
          <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  {isAdmin && (
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allSelected || (someSelected ? "indeterminate" : false)}
                        onCheckedChange={toggleAll}
                        disabled={filteredIds.length === 0}
                      />
                    </TableHead>
                  )}
                  <TableHead className="w-14">ID</TableHead>
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
  const fileName = task.params?.file_name;
  const fileSize = task.params?.file_size;
  const trackCode = task.params?.track_code;
  const clientIp = task.params?.client_ip;

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
          <span className="truncate text-sm font-medium" title={downloadTaskShowName(task)}>
            {downloadTaskShowName(task)}
          </span>
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
        <span className="inline-flex items-center rounded-md border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {DOWNLOAD_TYPE_LABEL[downloadType] || downloadType || "—"}
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
              <span className="cursor-default border-b border-dashed border-muted-foreground/40">
                {trackCode}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="font-mono">
              <div className="flex flex-col gap-0.5">
                <span>追踪码：{trackCode}</span>
                <span>客户端IP：{clientIp || "—"}</span>
              </div>
            </TooltipContent>
          </Tooltip>
        ) : clientIp ? (
          <span className="text-muted-foreground/80" title={`客户端IP：${clientIp}`}>
            {clientIp}
          </span>
        ) : (
          <span className="text-muted-foreground/60">—</span>
        )}
      </TableCell>

      {showOwner && (
        <TableCell className="whitespace-nowrap">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <User className="h-3 w-3" />
            {ownerDisplay(task.owner, task.owner_id)}
          </div>
        </TableCell>
      )}

      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {formatRelativeTime(task.created_at)}
      </TableCell>

      <TableCell className="w-28">
        <div className="flex h-7 items-center">
          {isCompleted ? (
            <Button asChild variant="outline" size="sm" className="h-7 gap-1 text-xs">
              <a
                href={`/api/downloads/${task.id}/file`}
                download={fileName || undefined}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Download className="h-3.5 w-3.5" />
                下载
              </a>
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground">—</span>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
