import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft, ChevronRight, Eye, FileKey2, Loader2, Lock } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { parseTags } from "@/lib/types";

interface SharedShowResource {
  id: number;
  name: string;
  sort_order: number;
  version_no: number;
  preview_url: string;
  common_remark_html: string;
}

interface SharedShow {
  id: number;
  name: string;
  subject: string;
  tags: string;
  status: string;
  version_no: number;
  change_note: string;
  created_at: string;
  updated_at: string;
  resources: SharedShowResource[];
}

interface SharedShowResponse {
  show: SharedShow;
  expires_at: string;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN");
}

export function ShowSharePage() {
  const navigate = useNavigate();
  const { token = "" } = useParams();
  const [activeIndex, setActiveIndex] = React.useState(0);
  const { data, isLoading, error } = useQuery({
    queryKey: ["show-share", token],
    queryFn: () => api<SharedShowResponse>(`/api/show-shares/${encodeURIComponent(token)}`),
    enabled: token.length > 0,
    retry: false,
  });

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />验证分享链接…</div>;
  }
  if (!data?.show) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
        <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
          <FileKey2 className="mx-auto h-8 w-8 text-muted-foreground" />
          <h1 className="mt-4 text-lg font-semibold">分享链接无效或已过期</h1>
          <p className="mt-2 text-sm text-muted-foreground">该放映分享链接可能已被撤销，或已超过有效期。</p>
          {error && <p className="mt-3 text-xs text-muted-foreground">请向分享者索取新的链接。</p>}
        </div>
      </div>
    );
  }

  const show = data.show;
  const resources = show.resources;
  const safeIndex = Math.min(activeIndex, Math.max(0, resources.length - 1));
  const activeResource = resources[safeIndex] ?? null;
  const tags = parseTags(show.tags);

  return (
    <div className="min-h-screen bg-muted/30 p-3 sm:p-6 lg:p-8">
      <div className="mx-auto flex min-h-[calc(100vh-1.5rem)] w-full max-w-[1800px] flex-col overflow-visible rounded-2xl border bg-card shadow-sm sm:min-h-[calc(100vh-3rem)] sm:overflow-hidden">
        <header className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b px-5 py-4 sm:px-7 sm:py-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Eye className="h-3.5 w-3.5" />安全分享 · 放映预览</div>
            <h1 className="mt-2 truncate text-xl font-semibold tracking-tight sm:text-2xl">{show.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">v{show.version_no}</Badge>
              {show.subject && <Badge variant="secondary">{show.subject}</Badge>}
              {tags.map((tag) => <Badge key={tag} variant="outline" className="font-normal">{tag}</Badge>)}
            </div>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>有效期至 {formatDate(data.expires_at)}</div>
            <div className="mt-1">共 {resources.length} 页</div>
          </div>
        </header>

        <main className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-3 sm:p-5 lg:overflow-hidden lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-5 lg:p-6">
          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-slate-950">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-xs text-slate-300">
              <span className="min-w-0 truncate">{activeResource?.name || "暂无页面"}</span>
              <span className="shrink-0 tabular-nums">第 {resources.length ? safeIndex + 1 : 0} / {resources.length} 页</span>
            </div>
            <div className="flex min-h-[min(48vh,520px)] flex-1 items-center justify-center bg-black p-2 sm:min-h-[min(62vh,760px)] sm:p-5">
              {activeResource ? (
                <img src={activeResource.preview_url} alt={activeResource.name} className="max-h-full max-w-full object-contain" />
              ) : (
                <div className="flex flex-col items-center gap-2 text-sm text-slate-400"><Lock className="h-8 w-8" />暂无可预览页面</div>
              )}
            </div>
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/10 px-3 py-3">
              <Button variant="outline" size="icon" className="h-8 w-8 border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white" disabled={safeIndex <= 0} onClick={() => setActiveIndex((index) => Math.max(0, index - 1))} aria-label="上一页"><ChevronLeft className="h-4 w-4" /></Button>
              <span className="text-xs text-slate-400">点击右侧页面快速切换</span>
              <Button variant="outline" size="icon" className="h-8 w-8 border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white" disabled={safeIndex >= resources.length - 1} onClick={() => setActiveIndex((index) => Math.min(resources.length - 1, index + 1))} aria-label="下一页"><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </section>

          <aside className="flex min-h-0 flex-col gap-3">
            <section className="min-h-0 flex-1 rounded-xl border bg-background p-3">
              <h2 className="mb-3 text-sm font-semibold">页面目录</h2>
              <div className="grid max-h-[min(62vh,760px)] min-h-0 grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3 lg:grid-cols-2">
                {resources.map((resource, index) => (
                  <button key={`${resource.id}-${index}`} type="button" onClick={() => setActiveIndex(index)} className={`group overflow-hidden rounded-md border text-left transition ${index === safeIndex ? "border-primary ring-2 ring-primary/20" : "hover:border-primary/50"}`}>
                    <div className="relative aspect-video overflow-hidden bg-muted"><img src={resource.preview_url} alt="" loading="lazy" className="h-full w-full object-cover transition group-hover:scale-[1.02]" /><span className="absolute left-1 top-1 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white">{index + 1}</span></div>
                    <div className="truncate px-2 py-1.5 text-[11px]" title={resource.name}>{resource.name}</div>
                  </button>
                ))}
              </div>
            </section>
            {show.change_note && <section className="rounded-xl border bg-background p-3"><h2 className="text-xs font-semibold">版本说明</h2><p className="mt-2 text-xs leading-5 text-muted-foreground">{show.change_note}</p></section>}
            <p className="px-1 text-[11px] leading-5 text-muted-foreground">此链接仅用于预览放映页面，不提供素材下载权限。</p>
          </aside>
        </main>
      </div>
    </div>
  );
}

export default ShowSharePage;
