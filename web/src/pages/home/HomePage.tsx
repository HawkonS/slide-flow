import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FileText,
  Layers,
  Loader2,
  Pin,
  Type as TypeIcon,
} from "lucide-react";

import { ResourceCard } from "@/components/resource/ResourceCard";
import { ResourceDetailDialog } from "@/components/resource/ResourceDetailDialog";
import { ShowCard } from "@/components/show/ShowCard";
import { ShowDetailDialog } from "@/components/show/ShowDetailDialog";
import { OfflineCacheBanner } from "@/components/home/OfflineCacheBanner";
import { StatCard } from "@/components/home/StatCard";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Resource, Show } from "@/lib/types";
import { useResponsiveGrid } from "@/lib/use-grid-layout";

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

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ["home", "stats"],
    queryFn: async () => api<HomeStats>("/api/me/home/stats"),
    staleTime: 30_000,
  });

  const { data: pins, isLoading: pinsLoading } = useQuery({
    queryKey: ["home", "pins"],
    queryFn: async () => api<HomePins>("/api/me/pins"),
    staleTime: 30_000,
  });

  const pinnedShows = pins?.shows ?? [];
  const pinnedResources = pins?.resources ?? [];

  const [detailResource, setDetailResource] = React.useState<Resource | null>(null);
  const [detailShow, setDetailShow] = React.useState<Show | null>(null);

  const greeting = user?.name || user?.username || "你好";

  // 列数由共享 hook 按页面宽度连续计算（首页不分页，只取 gridStyle）
  const contentRef = React.useRef<HTMLDivElement>(null);
  const { gridStyle } = useResponsiveGrid(contentRef);

  return (
    <div ref={contentRef} className="flex h-full flex-col gap-4 overflow-auto pb-4">
      {/* 欢迎语 */}
      <header className="flex items-center gap-4">
        <h1 className="text-xl font-semibold tracking-tight">{greeting}，欢迎回来</h1>
      </header>

      {/* 离线缓存维护提示 */}
      <OfflineCacheBanner />

      {/* 数据概览 */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          数据概览
        </h2>
        {statsLoading ? (
          <div className="flex items-center gap-2 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载中…
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="资源"
              value={stats?.resources.total ?? 0}
              hint={`我的 ${stats?.resources.mine ?? 0}`}
              icon={FileText}
              to="/resources"
            />
            <StatCard
              label="放映"
              value={stats?.shows.total ?? 0}
              hint={`我的 ${stats?.shows.mine ?? 0}`}
              icon={Layers}
              to="/shows"
            />
            <StatCard
              label="模板"
              value={stats?.templates.total ?? 0}
              icon={FileText}
              to="/templates"
            />
            <StatCard
              label="字体"
              value={stats?.fonts.total ?? 0}
              icon={TypeIcon}
              to="/fonts"
            />
          </div>
        )}
      </section>

      {/* 我置顶的放映 */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            我置顶的放映
          </h2>
          {pinnedShows.length > 0 && (
            <span className="text-xs text-muted-foreground">{pinnedShows.length} 项</span>
          )}
        </div>
        {pinsLoading ? (
          <div className="flex items-center gap-2 rounded-lg border border-dashed bg-card p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载中…
          </div>
        ) : pinnedShows.length === 0 ? (
          <EmptyPinned hint="在放映仓库点击卡片右上角 ⋯ 选择「置顶首页」" />
        ) : (
          <div className="grid content-start" style={gridStyle}>
            {pinnedShows.map((s) => (
              <ShowCard key={s.id} show={s} onOpen={(x) => setDetailShow(x)} />
            ))}
          </div>
        )}
      </section>

      {/* 我置顶的资源 */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            我置顶的资源
          </h2>
          {pinnedResources.length > 0 && (
            <span className="text-xs text-muted-foreground">{pinnedResources.length} 项</span>
          )}
        </div>
        {pinsLoading ? (
          <div className="flex items-center gap-2 rounded-lg border border-dashed bg-card p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载中…
          </div>
        ) : pinnedResources.length === 0 ? (
          <EmptyPinned hint="在资源仓库点击卡片右上角 ⋯ 选择「置顶首页」" />
        ) : (
          <div className="grid content-start" style={gridStyle}>
            {pinnedResources.map((r) => (
              <ResourceCard key={r.id} resource={r} onOpen={(x) => setDetailResource(x)} />
            ))}
          </div>
        )}
      </section>

      {/* 资源详情弹窗 */}
      <ResourceDetailDialog
        open={detailResource != null}
        onOpenChange={(open) => {
          if (!open) setDetailResource(null);
        }}
        resource={detailResource}
      />

      {/* 放映详情弹窗 */}
      <ShowDetailDialog
        open={detailShow != null}
        onOpenChange={(open) => {
          if (!open) setDetailShow(null);
        }}
        show={detailShow}
      />
    </div>
  );
}

function EmptyPinned({ hint }: { hint: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-dashed bg-card p-4 text-sm text-muted-foreground">
      <Pin className="h-4 w-4 shrink-0" />
      <span>暂无置顶项。{hint}</span>
    </div>
  );
}
