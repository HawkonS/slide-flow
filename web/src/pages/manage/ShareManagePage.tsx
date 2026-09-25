import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Copy, ExternalLink, FileKey2, Loader2, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { RESOURCE_SECRECY_LABEL, SECRECY_BADGE_TONE } from "@/lib/constants";

type ShareStatus = "active" | "expired" | "revoked" | "disabled";

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
    secrecy_level: string;
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
  disabled: "素材已停用",
};

const STATUS_TONE: Record<ShareStatus, "success" | "warning" | "destructive" | "outline"> = {
  active: "success",
  expired: "warning",
  revoked: "outline",
  disabled: "destructive",
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
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const appliedSearch = searchParams.get("q") || "";
  const rawStatus = searchParams.get("status") || "all";
  const status = ["all", "active", "expired", "revoked", "disabled"].includes(rawStatus)
    ? rawStatus
    : "all";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const pageSize = 20;
  const [search, setSearch] = React.useState(appliedSearch);

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
    queryKey: ["managed-share-links", page, status, appliedSearch],
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

  React.useEffect(() => {
    if (data && page > totalPages) setPage(totalPages);
  }, [data, page, totalPages]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader
        title="分享管理"
        count={`${data?.stats.total ?? 0} 条`}
        description="集中查看和撤销你有权管理的单页素材临时分享链接。"
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ["all", "全部", data?.stats.total ?? 0],
          ["active", "有效", data?.stats.active ?? 0],
          ["expired", "已过期", data?.stats.expired ?? 0],
          ["revoked", "已撤销", data?.stats.revoked ?? 0],
          ["disabled", "素材已停用", data?.stats.disabled ?? 0],
        ].map(([value, label, count]) => (
          <button
            key={String(value)}
            type="button"
            onClick={() => setStatus(String(value))}
            className={`rounded-lg border bg-card px-4 py-3 text-left transition hover:border-foreground/20 ${status === value ? "ring-2 ring-primary/20 border-primary/40" : ""}`}
          >
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{count}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1 sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索素材或创建人" className="pl-9" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="active">有效</SelectItem>
            <SelectItem value="expired">已过期</SelectItem>
            <SelectItem value="revoked">已撤销</SelectItem>
            <SelectItem value="disabled">素材已停用</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-card">
        {isLoading ? (
          <div className="flex h-full min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />加载分享记录…</div>
        ) : isError ? (
          <div className="flex h-full min-h-48 items-center justify-center text-sm text-destructive">{error?.message || "分享记录加载失败"}</div>
        ) : data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>原素材</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-40">创建人</TableHead>
                <TableHead className="w-44">创建时间</TableHead>
                <TableHead className="w-44">有效期至</TableHead>
                <TableHead className="w-36 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((item) => {
                const shareUrl = item.share_path ? `${window.location.origin}${item.share_path}` : null;
                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <button type="button" onClick={() => navigate(item.resource.detail_path)} className="max-w-[340px] text-left">
                        <div className="truncate font-medium hover:underline">{item.resource.name}</div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="truncate">{item.resource.subject || "未设置主体"}</span>
                          <Badge variant={SECRECY_BADGE_TONE[item.resource.secrecy_level] || "outline"} className="h-5 shrink-0 px-1.5 text-[10px]">
                            {RESOURCE_SECRECY_LABEL[item.resource.secrecy_level] || item.resource.secrecy_level}
                          </Badge>
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
                          <>
                            <Button variant="ghost" size="icon" title="复制分享链接" aria-label="复制分享链接" onClick={() => void copyText(shareUrl)}><Copy /></Button>
                            <Button variant="ghost" size="icon" title="打开分享页" aria-label="打开分享页" onClick={() => window.open(shareUrl, "_blank", "noopener,noreferrer")}><ExternalLink /></Button>
                          </>
                        ) : (
                          <span className="self-center px-2 text-[11px] text-muted-foreground" title="该链接创建于集中管理功能上线前，系统未保存可恢复的原始地址">历史链接</span>
                        )}
                        {(item.status === "active" || item.status === "disabled") && (
                          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" title="撤销分享链接" aria-label="撤销分享链接" disabled={revoke.isPending} onClick={() => revoke.mutate(item)}><Trash2 /></Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
            <FileKey2 className="h-8 w-8" />
            <div><div className="font-medium text-foreground">暂无分享记录</div><div className="mt-1">在单页素材详情页创建临时分享链接后，会统一显示在这里。</div></div>
          </div>
        )}
      </div>

      {!isLoading && !isError && total > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t pt-3 text-sm text-muted-foreground">
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
