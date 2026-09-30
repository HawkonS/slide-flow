import { copyText } from "@/lib/clipboard";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Copy,
  ExternalLink,
  FileKey2,
  Loader2,
  MonitorPlay,
  MoreHorizontal,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/PageHeader";
import { PageMetrics } from "@/components/common/PageMetrics";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { isAdminRole } from "@/lib/types";

type ShareKind = "resources" | "shows";
type ShareStatus = "active" | "expired" | "revoked";

interface ManagedShareLink {
  id: number;
  status: ShareStatus;
  share_path: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  creator: { id: number; name: string | null; username: string | null };
  resource?: { id: number; name: string; subject: string; status: string; detail_path: string };
  show?: { id: number; name: string; subject: string; status: string; version_no: number; page_count: number; detail_path: string };
}

interface ShareListResponse {
  items: ManagedShareLink[];
  total: number;
  page: number;
  page_size: number;
  stats: Record<"total" | ShareStatus, number>;
}

const STATUS_LABEL: Record<ShareStatus, string> = { active: "有效", expired: "已过期", revoked: "已撤销" };
const STATUS_TONE: Record<ShareStatus, "success" | "warning" | "destructive" | "outline"> = { active: "success", expired: "warning", revoked: "outline" };

const TAB_CONFIG: Record<ShareKind, {
  label: string;
  description: string;
  searchPlaceholder: string;
  listPath: string;
  idsPath: string;
  bulkPath: string;
  detailPrefix: string;
}> = {
  resources: {
    label: "单页素材分享",
    description: "管理单页素材的临时预览链接。",
    searchPlaceholder: "搜索素材或创建人",
    listPath: "/api/resource-share-links",
    idsPath: "/api/resource-share-links/ids",
    bulkPath: "/api/resource-share-links/bulk-revoke",
    detailPrefix: "/api/resources",
  },
  shows: {
    label: "放映资源分享",
    description: "管理标准放映的页面预览链接。",
    searchPlaceholder: "搜索放映、主体或创建人",
    listPath: "/api/show-share-links",
    idsPath: "/api/show-share-links/ids",
    bulkPath: "/api/show-share-links/bulk-revoke",
    detailPrefix: "/api/shows",
  },
};

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("zh-CN") : "-";
}


function useAdaptivePageSize(containerRef: React.RefObject<HTMLDivElement | null>): number {
  const [pageSize, setPageSize] = React.useState(0);
  React.useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    let timer: number | null = null;
    const compute = () => {
      timer = null;
      const rows = Math.max(5, Math.floor((element.clientHeight - 52) / 56));
      setPageSize((current) => current === rows ? current : rows);
    };
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(compute, 80);
    };
    compute();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [containerRef]);
  return pageSize;
}

function ShareLinksTab({ kind, isAdmin }: { kind: ShareKind; isAdmin: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const config = TAB_CONFIG[kind];
  const [status, setStatus] = React.useState<"all" | ShareStatus>("all");
  const [searchInput, setSearchInput] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = React.useState(false);
  const [isSelectingAll, setIsSelectingAll] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const pageSize = useAdaptivePageSize(contentRef);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);
  React.useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [kind, status, search, pageSize]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["managed-share-links", kind, page, pageSize, status, search],
    queryFn: () => api<ShareListResponse>(config.listPath, { params: { page, page_size: pageSize, status, search: search || undefined } }),
    enabled: pageSize > 0,
    placeholderData: (previous) => previous,
  });

  const revoke = useMutation({
    mutationFn: (item: ManagedShareLink) => {
      const target = kind === "resources" ? item.resource : item.show;
      if (!target) throw new Error("分享对象不存在");
      return api(`${config.detailPrefix}/${target.id}/share-links/${item.id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      toast.success("分享链接已撤销");
      void queryClient.invalidateQueries({ queryKey: ["managed-share-links", kind] });
    },
    onError: (mutationError: Error) => toast.error(mutationError.message || "撤销失败"),
  });
  const bulkRevoke = useMutation({
    mutationFn: (linkIds: number[]) => api<{ revoked: number }>(config.bulkPath, { method: "POST", json: { link_ids: linkIds } }),
    onSuccess: (result) => {
      toast.success(`已撤销 ${result.revoked} 条分享链接`);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ["managed-share-links", kind] });
    },
    onError: (mutationError: Error) => toast.error(mutationError.message || "批量撤销失败"),
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / Math.max(pageSize, 1)));
  const itemIds = items.map((item) => item.id);
  const allSelected = itemIds.length > 0 && itemIds.every((id) => selected.has(id));
  const someSelected = itemIds.some((id) => selected.has(id)) && !allSelected;
  React.useEffect(() => {
    if (data && page > totalPages) setPage(totalPages);
  }, [data, page, totalPages]);

  const selectPage = (checked: boolean, ids: number[]) => {
    setSelected((current) => {
      const next = new Set(current);
      ids.forEach((id) => checked ? next.add(id) : next.delete(id));
      return next;
    });
  };
  const selectFiltered = async () => {
    setIsSelectingAll(true);
    try {
      const result = await api<{ ids: number[] }>(config.idsPath, { params: { status, search: search || undefined } });
      setSelected(new Set(result.ids));
      toast.success(`已选择 ${result.ids.length} 条分享链接`);
    } catch (selectionError) {
      toast.error((selectionError as Error).message || "选择筛选结果失败");
    } finally {
      setIsSelectingAll(false);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {kind === "resources" ? <FileKey2 className="h-3.5 w-3.5" /> : <MonitorPlay className="h-3.5 w-3.5" />}
        <span>{config.description}</span>
        <Badge variant="outline" className="ml-auto hidden h-5 px-1.5 text-[10px] sm:inline-flex">仅预览，不提供下载</Badge>
      </div>
      <PageMetrics ariaLabel={`${config.label}统计`} items={[
        { label: "分享链接", value: data?.stats.total ?? 0, icon: FileKey2 },
        { label: "有效", value: data?.stats.active ?? 0, icon: CheckCircle2, tone: "success" },
        { label: "已过期", value: data?.stats.expired ?? 0, icon: Clock3, tone: "warning" },
        { label: "已撤销", value: data?.stats.revoked ?? 0, icon: Ban, tone: "destructive" },
      ]} />

      <div className="page-toolbar shrink-0">
        <div className="relative min-w-[220px] flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder={config.searchPlaceholder} className="h-8 w-full bg-background pl-7 pr-3 text-sm shadow-sm sm:w-64" />
        </div>
        <Select value={status} onValueChange={(value) => setStatus(value as "all" | ShareStatus)}>
          <SelectTrigger className="h-8 w-32 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="active">有效</SelectItem><SelectItem value="expired">已过期</SelectItem><SelectItem value="revoked">已撤销</SelectItem></SelectContent>
        </Select>
        {isAdmin && <div className="ml-auto flex items-center gap-2">{selected.size > 0 && <span className="text-xs text-muted-foreground">已选 <span className="font-medium text-primary">{selected.size}</span> 项</span>}<Button variant="outline" size="sm" className="h-8 gap-1.5 px-3 text-sm text-destructive hover:text-destructive" disabled={selected.size === 0 || bulkRevoke.isPending} onClick={() => setBulkConfirmOpen(true)}>{bulkRevoke.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}批量撤销{selected.size ? `（${selected.size}）` : ""}</Button></div>}
      </div>

      <div ref={contentRef} className="surface min-h-0 flex-1 overflow-auto">
        {pageSize === 0 || isLoading ? <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" />加载分享记录…</div> : isError ? <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">加载失败：{error?.message || "分享记录加载失败"}</div> : items.length ? (
          <div className="overflow-hidden"><Table className="min-w-[980px]"><TableHeader><TableRow className="bg-muted/40 hover:bg-muted/40">
            {isAdmin && <TableHead className="w-10"><div className="flex items-center gap-0.5"><Checkbox checked={allSelected ? true : someSelected ? "indeterminate" : false} onCheckedChange={(checked) => selectPage(Boolean(checked), itemIds)} aria-label="选择当前页分享链接" /><DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="rounded p-0.5 hover:bg-accent" aria-label="选择更多分享链接"><ChevronDown className="h-3 w-3 text-muted-foreground" /></button></DropdownMenuTrigger><DropdownMenuContent align="start" className="w-48"><DropdownMenuItem onClick={() => selectPage(true, itemIds)}><Check className="mr-2 h-3.5 w-3.5" />全选本页</DropdownMenuItem><DropdownMenuItem onClick={() => void selectFiltered()} disabled={isSelectingAll}><Check className="mr-2 h-3.5 w-3.5" />选择筛选结果</DropdownMenuItem><DropdownMenuItem onClick={() => setSelected(new Set())}><X className="mr-2 h-3.5 w-3.5" />取消选择</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div></TableHead>}
            <TableHead>{kind === "resources" ? "单页素材" : "放映资源"}</TableHead><TableHead className="w-24">状态</TableHead><TableHead className="w-40">创建人</TableHead><TableHead className="w-44">创建时间</TableHead><TableHead className="w-44">有效期至</TableHead><TableHead className="w-44 text-right">操作</TableHead>
          </TableRow></TableHeader><TableBody>{items.map((item) => {
            const target = kind === "resources" ? item.resource : item.show;
            const shareUrl = item.share_path ? `${window.location.origin}${item.share_path}` : null;
            if (!target) return null;
            return <TableRow key={item.id}>
              {isAdmin && <TableCell><Checkbox checked={selected.has(item.id)} onCheckedChange={(checked) => selectPage(Boolean(checked), [item.id])} aria-label={`选择分享链接 ${item.id}`} /></TableCell>}
              <TableCell><button type="button" onClick={() => navigate(target.detail_path)} className="max-w-[360px] text-left"><div className="truncate font-medium hover:underline">{target.name}</div><div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><span className="truncate">{target.subject || "未设置主体"}</span>{kind === "resources" ? <span>单页素材</span> : <span>v{item.show?.version_no ?? "-"} · {item.show?.page_count ?? 0} 页</span>}</div></button></TableCell>
              <TableCell><Badge variant={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge></TableCell><TableCell className="text-sm text-muted-foreground">{item.creator.name || item.creator.username || "-"}</TableCell><TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDate(item.created_at)}</TableCell><TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDate(item.expires_at)}</TableCell>
              <TableCell><div className="flex justify-end gap-1">{shareUrl ? <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5" title="复制分享链接" onClick={() => void copyText(shareUrl)}><Copy className="h-3.5 w-3.5" />复制链接</Button> : <span className="self-center px-2 text-[11px] text-muted-foreground" title="该链接创建于集中管理功能上线前，系统未保存可恢复的原始地址">历史链接</span>}{(shareUrl || item.status === "active") && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`分享链接 ${item.id} 更多操作`} title="更多操作"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-36">{shareUrl && <DropdownMenuItem onClick={() => window.open(shareUrl, "_blank", "noopener,noreferrer")}><ExternalLink className="mr-2 h-3.5 w-3.5" />打开分享页</DropdownMenuItem>}{item.status === "active" && <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={revoke.isPending} onClick={() => revoke.mutate(item)}><Trash2 className="mr-2 h-3.5 w-3.5" />撤销分享</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu>}</div></TableCell>
            </TableRow>;
          })}</TableBody></Table></div>
        ) : <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">{search || status !== "all" ? "没有匹配的分享记录" : `暂无${config.label}记录`}</div>}
      </div>
      {!isLoading && !isError && total > 0 && <div className="flex shrink-0 select-none flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm text-muted-foreground"><span>显示 {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, total)}，共 {total} 条</span><div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><span className="min-w-[52px] text-center text-foreground">{page} / {totalPages}</span><Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</Button></div></div>}
      <ConfirmDialog
        open={bulkConfirmOpen}
        onOpenChange={setBulkConfirmOpen}
        title="批量撤销分享"
        description={`确定撤销选中的 ${selected.size} 条分享链接吗？撤销后，原链接将立即失效。`}
        confirmLabel="确认撤销"
        destructive
        loading={bulkRevoke.isPending}
        onConfirm={() => {
          bulkRevoke.mutate(Array.from(selected), { onSuccess: () => setBulkConfirmOpen(false) });
        }}
      />
    </div>
  );
}

export default function ShareManagePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const isAdmin = isAdminRole(user?.role);
  const tab: ShareKind = searchParams.get("tab") === "shows" ? "shows" : "resources";
  const handleTabChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "shows") next.set("tab", "shows");
    else next.delete("tab");
    setSearchParams(next, { replace: true });
  };
  return <div className="page-shell">
    <PageHeader title="分享管理" titleExtra={<Badge variant="secondary" className="rounded-md px-2 text-[11px]">{isAdmin ? "可维护" : "仅管理自己的分享"}</Badge>} description="分别管理单页素材分享和放映资源分享，按状态、对象或创建人快速筛选。" />
    <Tabs value={tab} onValueChange={handleTabChange} className="flex min-h-0 flex-1 flex-col">
      <TabsList className="w-fit border bg-muted/40"><TabsTrigger value="resources" className="gap-1.5"><FileKey2 className="h-3.5 w-3.5" />单页素材分享</TabsTrigger><TabsTrigger value="shows" className="gap-1.5"><MonitorPlay className="h-3.5 w-3.5" />放映资源分享</TabsTrigger></TabsList>
      <TabsContent value="resources" className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"><ShareLinksTab kind="resources" isAdmin={isAdmin} /></TabsContent>
      <TabsContent value="shows" className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"><ShareLinksTab kind="shows" isAdmin={isAdmin} /></TabsContent>
    </Tabs>
  </div>;
}
