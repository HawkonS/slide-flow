import { copyText } from "@/lib/clipboard";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, Link2, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import type { Show } from "@/lib/types";

interface ShowShareLinkItem {
  id: number;
  page_count: number;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  share_path: string | null;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN");
}


export function ShowShareDialog({ open, onOpenChange, show }: { open: boolean; onOpenChange: (open: boolean) => void; show: Show }) {
  const queryClient = useQueryClient();
  const [days, setDays] = React.useState("7");
  const [createdLink, setCreatedLink] = React.useState<string | null>(null);
  const queryKey = ["show", show.id, "share-links"];
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => api<{ items: ShowShareLinkItem[] }>(`/api/shows/${show.id}/share-links`),
    enabled: open,
  });
  const create = useMutation({
    mutationFn: () => api<{ share_path: string; expires_at: string }>(`/api/shows/${show.id}/share-links`, {
      method: "POST",
      json: { expires_in_days: Number(days) },
    }),
    onSuccess: (result) => {
      const url = `${window.location.origin}${result.share_path}`;
      setCreatedLink(url);
      void copyText(url);
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (error: Error) => toast.error(error.message || "创建分享链接失败"),
  });
  const revoke = useMutation({
    mutationFn: (linkId: number) => api(`/api/shows/${show.id}/share-links/${linkId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("分享链接已撤销");
      setCreatedLink(null);
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (error: Error) => toast.error(error.message || "撤销失败"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(720px,calc(100vh-2rem))] max-w-xl overflow-y-auto p-0">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <DialogTitle className="flex items-center gap-2 text-base"><Link2 className="h-4 w-4 text-muted-foreground" />链接与分享</DialogTitle>
          <DialogDescription>分享“{show.name}”的放映预览。链接仅提供页面预览，不授予素材下载权限。</DialogDescription>
        </DialogHeader>
        <div className="space-y-6 px-6 py-5">
          <section>
            <h2 className="text-sm font-semibold">创建分享链接</h2>
            <p className="mt-1 text-xs text-muted-foreground">设置有效期后创建，链接会自动复制到剪贴板。</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Select value={days} onValueChange={setDays}>
                <SelectTrigger className="h-9 w-full sm:w-32"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="1">1 天</SelectItem><SelectItem value="7">7 天</SelectItem><SelectItem value="30">30 天</SelectItem></SelectContent>
              </Select>
              <Button className="h-9 gap-1.5" onClick={() => create.mutate()} disabled={create.isPending}>
                {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                创建分享链接
              </Button>
            </div>
            {createdLink && <div className="mt-3 flex min-w-0 gap-2"><Input readOnly value={createdLink} className="h-9 min-w-0 text-xs" aria-label="新创建的分享链接" /><Button variant="outline" size="icon" className="h-9 w-9 shrink-0" title="复制分享链接" aria-label="复制分享链接" onClick={() => void copyText(createdLink)}><Copy className="h-4 w-4" /></Button><Button variant="outline" size="icon" className="h-9 w-9 shrink-0" title="打开分享页" aria-label="打开分享页" onClick={() => window.open(createdLink, "_blank", "noopener,noreferrer")}><ExternalLink className="h-4 w-4" /></Button></div>}
          </section>
          <section className="border-t pt-5">
            <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">已创建的链接</h2><span className="text-xs text-muted-foreground">最多显示 20 条</span></div>
            <div className="mt-3 space-y-2">
              {isLoading ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />加载分享链接…</div> : isError ? <div role="alert" className="flex items-center justify-between gap-2 text-sm text-destructive">分享记录加载失败<Button variant="outline" size="sm" onClick={() => void refetch()}>重试</Button></div> : data?.items?.length ? data.items.map((item) => {
                const expired = Boolean(item.revoked_at) || new Date(item.expires_at).getTime() <= Date.now();
                const url = item.share_path ? `${window.location.origin}${item.share_path}` : null;
                return <div key={item.id} className="flex items-center justify-between gap-3 border-t py-2 text-xs"><div className="min-w-0"><div className="font-medium">{item.revoked_at ? "已撤销" : expired ? "已过期" : "有效分享链接"}</div><div className="text-muted-foreground">{item.page_count} 页 · 到期：{formatDate(item.expires_at)} · 创建：{formatDate(item.created_at)}</div></div><div className="flex shrink-0 items-center gap-1">{url && !expired && <Button variant="ghost" size="icon" className="h-7 w-7" title="复制分享链接" aria-label="复制分享链接" onClick={() => void copyText(url)}><Copy className="h-3.5 w-3.5" /></Button>}{!item.revoked_at && !expired && <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" title="撤销分享链接" aria-label="撤销分享链接" onClick={() => revoke.mutate(item.id)} disabled={revoke.isPending}><Trash2 className="h-3.5 w-3.5" /></Button>}</div></div>;
              }) : <p className="text-xs text-muted-foreground">还没有创建分享链接。</p>}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ShowShareDialog;
