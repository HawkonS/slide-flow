import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Ban, Check, CheckCircle2, ChevronDown, Clock3, Copy, ExternalLink, FileKey2, Loader2, MoreHorizontal, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/PageHeader";
import { PageMetrics } from "@/components/common/PageMetrics";
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
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { isAdminRole } from "@/lib/types";

type ShareStatus = "active" | "expired" | "revoked";

interface ManagedShareLink {
  id: number;
  status: ShareStatus;
  share_path: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  creator: { id: number; name: string | null; username: string | null };
  resource: {
    id: number;
    name: string;
    subject: string;
    status: string;
    detail_path: string;
  };
}

interface ShareListResponse {
  items: ManagedShareLink[];
  total: number;
  page: number;
  page_size: number;
  stats: Record<"total" | ShareStatus, number>;
}

const STATUS_LABEL: Record<ShareStatus, string> = {
  active: "有效",
  expired: "已过期",
  revoked: "已撤销",
};

const STATUS_TONE: Record<ShareStatus, "success" | "warning" | "destructive" | "outline"> = {
  active: "success",
  expired: "warning",
  revoked: "outline",
};

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("zh-CN") : "-";
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  toast.success("分享链接已复制");
}

export default function ShareManagePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = isAdminRole(user?.role);
  const [searchParams, setSearchParams] = useSearchParams();
  const appliedSearch = searchParams.get("q") || "";
  const rawStatus = searchParams.get("status") || "all";
  const status = ["all", "active", "expired", "revoked"].includes(rawStatus)
    ? rawStatus
    : "all";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = React.useState(10);
  const [search, setSearch] = React.useState(appliedSearch);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [isSelectingAll, setIsSelectingAll] = React.useState(false);

  React.useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const compute = () => {
      if (!element.clientHeight) return;
      const rows = Math.max(5, Math.floor((element.clientHeight - 45) / 64));
      setPageSize((current) => (current === rows ? current : rows));
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (search === appliedSearch) return;
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      const value = search.trim();
      if (value) next.set("q", value);
      else next.delete("q");
      next.set("page", "1");
      setSearchParams(next, { replace: true });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [appliedSearch, search, searchParams, setSearchParams]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["managed-share-links", page, pageSize, status, appliedSearch],
    queryFn: () => api<ShareListResponse>("/api/resource-share-links", {
      params: { page, page_size: pageSize, status, search: appliedSearch || undefined },
    }),
    placeholderData: (previous) => previous,
  });

  const revoke = useMutation({
    mutationFn: (item: ManagedShareLink) => api(
      `/api/resources/${item.resource.id}/share-links/${item.id}`,
      { method: "DELETE" },
    ),
    onSuccess: () => {
      toast.success("分享链接已撤销");
      void queryClient.invalidateQueries({ queryKey: ["managed-share-links"] });
    },
    onError: (mutationError: Error) => toast.error(mutationError.message || "撤销失败"),
  });

  const bulkRevoke = useMutation({
    mutationFn: (linkIds: number[]) => api<{ revoked: number }>(
      "/api/resource-share-links/bulk-revoke",
      { method: "POST", json: { link_ids: linkIds } },
    ),
    onSuccess: (result) => {
      toast.success(`已撤销 ${result.revoked} 条分享链接`);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ["managed-share-links"] });
    },
    onError: (mutationError: Error) => toast.error(mutationError.message || "批量撤销失败"),
  });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const setPage = (nextPage: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(Math.max(1, nextPage)));
    setSearchParams(next);
  };
  const setStatus = (nextStatus: string) => {
    const next = new URLSearchParams(searchParams);
    if (nextStatus === "all") next.delete("status");
    else next.set("status", nextStatus);
    next.set("page", "1");
    setSearchParams(next);
  };

  const pageItemIds = data?.items.map((item) => item.id) ?? [];
  const allSelected = pageItemIds.length > 0 && pageItemIds.every((id) => selected.has(id));
  const someSelected = pageItemIds.some((id) => selected.has(id)) && !allSelected;
  const setPageSelection = (checked: boolean, ids: number[]) => {
    setSelected((current) => {
      const next = new Set(current);
      ids.forEach((id) => (checked ? next.add(id) : next.delete(id)));
      return next;
    });
  };
  const selectFiltered = async () => {
    setIsSelectingAll(true);
    try {
      const result = await api<{ ids: number[] }>("/api/resource-share-links/ids", {
        params: { status, search: appliedSearch || undefined },
      });
      setSelected(new Set(result.ids));
      toast.success(`已选择 ${result.ids.length} 条分享链接`);
    } catch (selectionError) {
      toast.error((selectionError as Error).message || "选择筛选结果失败");
    } finally {
      setIsSelectingAll(false);
    }
  };

  React.useEffect(() => {
    setSelected(new Set());
  }, [appliedSearch, status]);

  React.useEffect(() => {
    if (data && page > totalPages) setPage(totalPages);
  }, [data, page, totalPages]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page-shell">
      <PageHeader
        title="分享管理"
        description={
          isAdmin
            ? "集中查看和撤销你创建或有管理权限的单页素材临时分享链接。"
            : "集中查看和撤销你创建的单页素材临时分享链接。"
        }
      />

      <PageMetrics
        ariaLabel="分享链接统计"
        items={[
          { label: "分享链接", value: data?.stats.total ?? 0, icon: FileKey2 },
          { label: "有效", value: data?.stats.active ?? 0, icon: CheckCircle2, tone: "success" },
          { label: "已过期", value: data?.stats.expired ?? 0, icon: Clock3, tone: "warning" },
          { label: "已撤销", value: data?.stats.revoked ?? 0, icon: Ban, tone: "destructive" },
        ]}
      />

      <div className="page-toolbar">
        <div className="relative min-w-[240px] flex-1 sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索素材或创建人" className="h-8 pl-9" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="active">有效</SelectItem>
            <SelectItem value="expired">已过期</SelectItem>
            <SelectItem value="revoked">已撤销</SelectItem>
          </SelectContent>
        </Select>
        {isAdmin && (
          <div className="ml-auto flex items-center gap-2">
            {selected.size > 0 && <span className="text-xs text-muted-foreground">已选 <span className="font-medium text-primary">{selected.size}</span> 项</span>}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={selected.size === 0 || bulkRevoke.isPending}
              onClick={() => {
                if (window.confirm(`确认撤销选中的 ${selected.size} 条分享链接？`)) {
                  bulkRevoke.mutate(Array.from(selected));
                }
              }}
            >
              {bulkRevoke.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              批量撤销
            </Button>
          </div>
        )}
      </div>

      <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" />加载分享记录…</div>
        ) : isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">加载失败：{error?.message || "分享记录加载失败"}</div>
        ) : data?.items.length ? (
          <div className="overflow-hidden rounded-md border bg-card">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  {isAdmin && (
                    <TableHead className="w-10">
                      <div className="flex items-center gap-0.5">
                        <Checkbox
                          checked={allSelected ? true : someSelected ? "indeterminate" : false}
                          onCheckedChange={(checked) => setPageSelection(Boolean(checked), pageItemIds)}
                          aria-label="选择当前页分享链接"
                        />
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button type="button" className="rounded p-0.5 hover:bg-accent" aria-label="选择更多分享链接">
                              <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="w-48">
                            <DropdownMenuItem onClick={() => setPageSelection(true, pageItemIds)}>
                              <Check className="mr-2 h-3.5 w-3.5" />全选本页
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => void selectFiltered()} disabled={isSelectingAll}>
                              <Check className="mr-2 h-3.5 w-3.5" />选择筛选结果
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setSelected(new Set())}>
                              <X className="mr-2 h-3.5 w-3.5" />取消选择
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableHead>
                  )}
                  <TableHead>原素材</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-40">创建人</TableHead>
                  <TableHead className="w-44">创建时间</TableHead>
                  <TableHead className="w-44">有效期至</TableHead>
                  <TableHead className="w-44 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((item) => {
                  const shareUrl = item.share_path ? `${window.location.origin}${item.share_path}` : null;
                  return (
                    <TableRow key={item.id}>
                      {isAdmin && (
                        <TableCell>
                          <Checkbox
                            checked={selected.has(item.id)}
                            onCheckedChange={(checked) => setPageSelection(Boolean(checked), [item.id])}
                            aria-label={`选择分享链接 ${item.id}`}
                          />
                        </TableCell>
                      )}
                      <TableCell>
                        <button type="button" onClick={() => navigate(item.resource.detail_path)} className="max-w-[340px] text-left">
                          <div className="truncate font-medium hover:underline">{item.resource.name}</div>
                          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="truncate">{item.resource.subject || "未设置主体"}</span>
                          </div>
                        </button>
                      </TableCell>
                      <TableCell><Badge variant={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{item.creator.name || item.creator.username || "-"}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDate(item.created_at)}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDate(item.expires_at)}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {shareUrl ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 gap-1.5 px-2.5"
                              title="复制分享链接"
                              onClick={() => void copyText(shareUrl)}
                            >
                              <Copy className="h-3.5 w-3.5" />复制链接
                            </Button>
                          ) : (
                            <span className="self-center px-2 text-[11px] text-muted-foreground" title="该链接创建于集中管理功能上线前，系统未保存可恢复的原始地址">历史链接</span>
                          )}
                          {(shareUrl || item.status === "active") && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  aria-label={`分享链接 ${item.id} 更多操作`}
                                  title="更多操作"
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-36">
                                {shareUrl && (
                                  <DropdownMenuItem onClick={() => window.open(shareUrl, "_blank", "noopener,noreferrer")}>
                                    <ExternalLink className="mr-2 h-3.5 w-3.5" />打开分享页
                                  </DropdownMenuItem>
                                )}
                                {item.status === "active" && (
                                  <DropdownMenuItem
                                    className="text-destructive focus:text-destructive"
                                    disabled={revoke.isPending}
                                    onClick={() => revoke.mutate(item)}
                                  >
                                    <Trash2 className="mr-2 h-3.5 w-3.5" />撤销分享
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">
            {appliedSearch || status !== "all" ? "没有匹配的分享记录" : "暂无分享记录"}
          </div>
        )}
      </div>

      {!isLoading && !isError && total > 0 && (
        <div className="flex shrink-0 select-none items-center justify-between border-t pt-3 text-sm text-muted-foreground">
          <span>显示 {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, total)}，共 {total} 条</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button>
            <span className="min-w-[52px] text-center text-foreground">{page} / {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</Button>
          </div>
        </div>
      )}
    </div>
  );
}
