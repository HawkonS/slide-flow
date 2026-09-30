import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  FileText,
  LayoutTemplate,
  Layers,
  Loader2,
  MonitorPlay,
  Pin,
  Type as TypeIcon,
  Upload,
} from "lucide-react";

import { ResourceCard } from "@/components/resource/ResourceCard";
import { ShowCard } from "@/components/show/ShowCard";
import { OfflineCacheBanner } from "@/components/home/OfflineCacheBanner";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/home/StatCard";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Resource, Show } from "@/lib/types";

interface HomeStats {
  resources: { total: number; mine: number };
  shows: { total: number; mine: number };
  templates: { total: number };
  fonts: { total: number };
}

interface HomePins {
  resources: Resource[];
  shows: Show[];
}

export function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const { data: stats, isLoading: statsLoading, isError: statsError, refetch: refetchStats } = useQuery({
    queryKey: ["home", "stats"],
    queryFn: async () => api<HomeStats>("/api/me/home/stats"),
    staleTime: 30_000,
  });

  const { data: pins, isLoading: pinsLoading, isError: pinsError, refetch: refetchPins } = useQuery({
    queryKey: ["home", "pins"],
    queryFn: async () => api<HomePins>("/api/me/pins"),
    staleTime: 30_000,
  });

  const pinnedShows = pins?.shows ?? [];
  const pinnedResources = pins?.resources ?? [];

  const greeting = user?.name || user?.username || "你好";
  const greetingPrefix = getGreetingPrefix();

  return (
    <div className="min-h-full overflow-auto pb-6">
      <div className="space-y-5">
        <header className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold">{greetingPrefix}，{greeting}</h1>
            <p className="mt-1 text-sm text-muted-foreground">个人工作台</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link to="/resources/import"><Upload className="mr-1.5 h-4 w-4" />导入单页素材</Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/manage/shows/new"><MonitorPlay className="mr-1.5 h-4 w-4" />创建放映</Link>
            </Button>
          </div>
        </header>

        <OfflineCacheBanner />
        {(statsError || pinsError) && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm text-muted-foreground"><span>部分工作台数据加载失败，请检查网络后重试。</span><Button variant="outline" size="sm" onClick={() => { void refetchStats(); void refetchPins(); }}>重新加载</Button></div>}

        <section className="space-y-3">
          <h2 className="text-base font-semibold tracking-tight">数据概览</h2>
          {statsLoading ? (
            <div className="flex items-center gap-2 rounded-lg border bg-card p-5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
          ) : statsError ? <p className="text-sm text-muted-foreground">暂时无法获取数据概览</p> : (
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <StatCard label="资源" value={stats?.resources.total ?? 0} hint={`我的 ${stats?.resources.mine ?? 0}`} icon={FileText} to="/resources" />
              <StatCard label="放映素材" value={stats?.shows.total ?? 0} hint={`我的 ${stats?.shows.mine ?? 0}`} icon={Layers} to="/manage/shows" />
              <StatCard label="模板" value={stats?.templates.total ?? 0} icon={LayoutTemplate} to="/templates" />
              <StatCard label="字体" value={stats?.fonts.total ?? 0} icon={TypeIcon} to="/fonts" />
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold tracking-tight">我的置顶</h2>
            <span className="text-xs text-muted-foreground">共 {pinnedShows.length + pinnedResources.length} 项</span>
          </div>
          <div className="grid gap-x-8 gap-y-6 xl:grid-cols-2">
            <PinnedPanel title="放映素材" count={pinnedShows.length} loading={pinsLoading} empty={pinsError ? <p className="text-sm text-muted-foreground">暂时无法加载置顶放映</p> : <EmptyPinned title="还没有置顶放映" hint="从放映素材或标准放映的卡片菜单中置顶" to="/manage/shows" action="浏览放映" />}>
              <div className="grid gap-3 sm:grid-cols-2">
                {pinnedShows.map((s) => <ShowCard key={s.id} show={s} onOpen={(x) => navigate(`/shows/${x.id}`)} />)}
              </div>
            </PinnedPanel>
            <PinnedPanel title="单页素材" count={pinnedResources.length} loading={pinsLoading} empty={pinsError ? <p className="text-sm text-muted-foreground">暂时无法加载置顶素材</p> : <EmptyPinned title="还没有置顶素材" hint="从单页素材卡片菜单中置顶常用内容" to="/resources" action="浏览素材" />}>
              <div className="grid gap-3 sm:grid-cols-2">
                {pinnedResources.map((r) => <ResourceCard key={r.id} resource={r} onOpen={(x) => x.detail_token && navigate(`/resources/${encodeURIComponent(x.detail_token)}`)} />)}
              </div>
            </PinnedPanel>
          </div>
        </section>

      </div>
    </div>
  );
}

function getGreetingPrefix() {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 12) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function PinnedPanel({ title, count, loading, empty, children }: { title: string; count: number; loading: boolean; empty: React.ReactNode; children: React.ReactNode }) {
  return <section className="min-w-0 space-y-3"><div className="flex items-center justify-between gap-3 border-b pb-2"><h3 className="text-sm font-semibold">{title}</h3><span className="text-xs text-muted-foreground">{count} 项</span></div>{loading ? <div className="flex min-h-[132px] items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div> : count === 0 ? empty : children}</section>;
}

function EmptyPinned({ title, hint, to, action }: { title: string; hint: string; to: string; action: string }) {
  return (
    <div className="flex min-h-[132px] flex-wrap items-center gap-4 border-b border-dashed py-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Pin className="h-5 w-5" /></div>
      <div className="min-w-0 flex-1"><p className="text-sm font-medium">{title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p></div>
      <Link to={to} className="inline-flex shrink-0 items-center gap-1 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium transition hover:bg-accent">{action}<ArrowRight className="h-3.5 w-3.5" /></Link>
    </div>
  );
}
