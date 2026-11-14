import * as React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Upload, Video } from "lucide-react";

import { HomeActivity } from "@/components/home/HomeActivity";
import { HomePinned } from "@/components/home/HomePinned";
import { HomeTaskCard } from "@/components/home/HomeTaskCard";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useOpenDetail, useRestoreListScroll } from "@/lib/detail-navigation";
import type { Resource, Show } from "@/lib/types";

interface HomeStats {
  resources: { total: number; mine: number; managed: number; visible: number };
  shows: { total: number; mine: number; managed: number; visible: number };
  standard_shows: number;
  templates: { total: number };
  fonts: { total: number };
  tasks: { total: number; upload: number; download: number; unfinished: number; failed: number };
}

interface HomePins {
  resources: Resource[];
  shows: Show[];
}

function getGreetingPrefix(): string {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 12) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function MaterialCard({
  title,
  linkLabel,
  href,
  value,
  unit,
  counts,
  accent,
}: {
  title: string;
  linkLabel: string;
  href: string;
  value: number;
  unit: string;
  counts: { label: string; value: number }[];
  accent: "teal" | "blue";
}) {
  return (
    <Link
      to={href}
      className="group flex min-h-[142px] min-w-0 flex-col rounded-xl border bg-card p-4 shadow-sm transition-colors hover:border-slate-300"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-semibold text-slate-700">{title}</span>
        <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-muted-foreground group-hover:text-foreground">
          {linkLabel}<ArrowRight className="h-3 w-3" />
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={accent === "teal" ? "text-[36px] font-semibold leading-none tracking-[-0.04em] text-slate-900" : "text-[36px] font-semibold leading-none tracking-[-0.04em] text-slate-900"}>{value}</span>
        <span className="text-[10px] text-muted-foreground">{unit}</span>
      </div>
      <div className="mt-auto grid grid-cols-3 gap-2 border-t pt-2">
        {counts.map((item) => (
          <div key={item.label} className="min-w-0">
            <span className="block truncate text-[10px] text-muted-foreground">{item.label}</span>
            <b className="mt-0.5 block truncate text-[15px] font-semibold tabular-nums text-slate-800">{item.value}</b>
          </div>
        ))}
      </div>
    </Link>
  );
}

function QuickLink({
  title,
  value,
  href,
}: {
  title: string;
  value: number;
  href: string;
}) {
  return (
    <Link
      to={href}
      className="group flex min-h-0 flex-1 items-center gap-3 rounded-[10px] border bg-card px-4 shadow-sm transition-colors hover:border-slate-300"
    >
      <span className="text-[12px] font-semibold text-slate-700">{title}</span>
      <span className="ml-auto text-[19px] font-semibold tabular-nums text-slate-900">{value}<small className="ml-1 text-[9px] font-normal text-muted-foreground">个</small></span>
      <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-muted-foreground group-hover:text-foreground">进入<ArrowRight className="h-3 w-3" /></span>
    </Link>
  );
}

export function HomePage() {
  const { user } = useAuth();
  const openDetail = useOpenDetail();
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

  useRestoreListScroll(!statsLoading && !pinsLoading);

  const pinnedShows = pins?.shows ?? [];
  const pinnedResources = pins?.resources ?? [];
  const greeting = user?.name || user?.username || "你好";
  const tasks = stats?.tasks ?? { total: 0, upload: 0, download: 0, unfinished: 0, failed: 0 };

  return (
    <div data-list-scroll="results" className="flex min-h-full flex-col gap-3 pb-6 lg:h-full lg:min-h-0 lg:gap-4 lg:overflow-hidden lg:pb-0">
      <header className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-[22px] font-semibold leading-tight tracking-[-0.025em]">{getGreetingPrefix()}，{greeting}</h1>
          <p className="mt-1 text-[11px] text-muted-foreground">个人工作台</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button asChild size="sm" className="h-8 gap-1.5 rounded-md bg-[#22345e] text-[11px] font-medium text-white hover:bg-[#1a2a4c]">
            <Link to="/resources/import"><Upload className="h-3.5 w-3.5" />导入单页素材</Link>
          </Button>
          <Button asChild size="sm" className="h-8 gap-1.5 rounded-md bg-[#22345e] text-[11px] font-medium text-white hover:bg-[#1a2a4c]">
            <Link to="/manage/shows/new"><Video className="h-3.5 w-3.5" />创建放映素材</Link>
          </Button>
        </div>
      </header>

      {(statsError || pinsError) && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">
          <span>部分工作台数据加载失败，请检查网络后重试。</span>
          <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => { void refetchStats(); void refetchPins(); }}>重新加载</button>
        </div>
      )}

      <div className="grid shrink-0 gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(290px,0.82fr)]">
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          <MaterialCard
            title="单页素材"
            linkLabel="进入素材库"
            href="/resources"
            value={stats?.resources.total ?? 0}
            unit="个素材"
            counts={[
              { label: "我创建的", value: stats?.resources.mine ?? 0 },
              { label: "我管理的", value: stats?.resources.managed ?? 0 },
              { label: "我可见的", value: stats?.resources.visible ?? 0 },
            ]}
            accent="teal"
          />
          <MaterialCard
            title="放映素材"
            linkLabel="进入放映库"
            href="/manage/shows"
            value={stats?.shows.total ?? 0}
            unit="个放映"
            counts={[
              { label: "我创建的", value: stats?.shows.mine ?? 0 },
              { label: "我管理的", value: stats?.shows.managed ?? 0 },
              { label: "我可见的", value: stats?.shows.visible ?? 0 },
            ]}
            accent="blue"
          />
        </div>
        <div className="flex min-h-[142px] min-w-0 flex-col gap-1.5">
          <QuickLink title="标准放映" value={stats?.standard_shows ?? 0} href="/shows" />
          <QuickLink title="标准模板" value={stats?.templates.total ?? 0} href="/templates" />
          <QuickLink title="标准字体" value={stats?.fonts.total ?? 0} href="/fonts" />
        </div>
      </div>

      <div className="grid min-h-0 shrink-0 gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(290px,0.82fr)]">
        <HomeActivity />
        {user?.id ? <HomeTaskCard userId={user.id} unfinished={tasks.unfinished} failed={tasks.failed} /> : <div className="rounded-xl border bg-card" />}
      </div>

      <HomePinned
        shows={pinnedShows}
        resources={pinnedResources}
        loading={pinsLoading}
        error={pinsError}
        onOpenShow={(show) => openDetail(`/shows/${show.id}`)}
        onOpenResource={(resource) => {
          if (resource.detail_token) openDetail(`/resources/${encodeURIComponent(resource.detail_token)}`);
        }}
      />
    </div>
  );
}
