import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ClipboardList,
  Download,
  Eye,
  GitBranch,
  HardDriveDownload,
  Lock,
  Maximize,
  MonitorPlay,
} from "lucide-react";

import { ShowDownloadDialog } from "@/components/show/ShowDownloadDialog";
import ShowOfflineCacheDialog from "@/components/show/ShowOfflineCacheDialog";
import { ShowResourcePrepDialog } from "@/components/show/ShowResourcePrepDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RESOURCE_SCOPE_LABEL } from "@/lib/constants";
import { api, getShowVersions } from "@/lib/api";
import { parseTags } from "@/lib/types";
import type {
  Show,
  ShowResource,
  ShowResourceAccessible,
  ShowResourceInaccessible,
  UpdateInfo,
} from "@/lib/types";

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN");
}

function isAccessible(resource: ShowResource): resource is ShowResourceAccessible {
  return resource.accessible === true;
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

export function ShowDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const showId = Number(id);
  const validId = Number.isInteger(showId) && showId > 0;
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [prepOpen, setPrepOpen] = React.useState(false);
  const [downloadOpen, setDownloadOpen] = React.useState(false);
  const [offlineCacheOpen, setOfflineCacheOpen] = React.useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["show-detail", showId],
    queryFn: () => api<{ show: Show }>(`/api/shows/${showId}`),
    enabled: validId,
    retry: false,
  });
  const show = data?.show ?? null;

  const { data: versionsData } = useQuery({
    queryKey: ["shows", showId, "versions"],
    queryFn: () => getShowVersions(showId),
    enabled: validId && !!show,
    staleTime: 30_000,
  });

  const { data: updatesData } = useQuery({
    queryKey: ["shows", showId, "check-updates"],
    queryFn: () => api<{ updates: UpdateInfo[] }>(`/api/shows/${showId}/check-updates`),
    enabled: validId && !!show,
    staleTime: 30_000,
  });

  React.useEffect(() => {
    setActiveIndex(0);
  }, [showId]);

  if (!validId) {
    return <ErrorState title="放映不存在" onBack={() => navigate("/manage/shows")} />;
  }
  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">加载放映详情…</div>;
  }
  if (!show) {
    const status = (error as { status?: number } | null)?.status;
    return <ErrorState title={status === 403 ? "没有查看权限" : "放映不存在或加载失败"} onBack={() => navigate("/manage/shows")} />;
  }

  const resources = show.resources ?? [];
  const activeResource = resources[activeIndex] ?? null;
  const previewUrl = activeResource && isAccessible(activeResource)
    ? activeResource.original_preview_url || activeResource.preview_url
    : null;
  const versions = [...(versionsData?.versions ?? [])].sort((a, b) => b.version_no - a.version_no);
  const updates = updatesData?.updates ?? [];
  const updateByResourceId = new Map(updates.map((item) => [item.resource_id, item]));

  return (
    <div className="mx-auto min-h-full w-full max-w-[1600px] pb-10">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-1 py-2 sm:px-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" title="返回放映库" aria-label="返回放映库" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="max-w-full truncate text-xl font-semibold tracking-tight sm:text-2xl">{show.name}</h1>
              <Badge variant="outline" className="h-5 px-1.5 text-[10px]">v{show.version_no}</Badge>
              {show.is_standard && <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">标准放映</Badge>}
            </div>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5" onClick={() => window.open(`/shows/${show.id}/fullscreen`, "_blank", "popup=yes,width=1920,height=1080")}>
            <Maximize className="h-4 w-4" />全屏放映
          </Button>
          <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5" onClick={() => { window.open(`/shows/${show.id}/display`, "slideflow-display", "popup=yes,width=1920,height=1080"); navigate(`/shows/${show.id}/present`); }}>
            <MonitorPlay className="h-4 w-4" />讲演模式
          </Button>
        </div>
      </header>

      <main className="min-w-0 pb-16 pt-5">
        <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
          <section className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b px-3 py-2 sm:px-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Eye className="h-4 w-4" />
                <span className="font-medium text-foreground">高清预览</span>
                <span>第 {resources.length ? activeIndex + 1 : 0} / {resources.length} 页</span>
              </div>
            </div>
            <div className="relative aspect-video w-full overflow-hidden bg-slate-100">
              {activeResource ? (
                isAccessible(activeResource) ? (
                  previewUrl ? <img src={previewUrl} alt={activeResource.name} decoding="async" className="absolute inset-0 h-full w-full object-contain" /> : <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">暂无预览图</div>
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-muted text-muted-foreground">
                    <Lock className="h-10 w-10" />
                    <p className="text-sm font-medium">资源 #{activeResource.id} 无权限</p>
                    <p className="text-xs">管理者：{(activeResource as ShowResourceInaccessible).managers.map((manager) => manager.name || manager.username).join("、")}</p>
                  </div>
                )
              ) : <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">暂无放映页面</div>}
            </div>
          </section>

          <aside className="flex min-w-0 flex-col gap-3">
            {versions.length > 1 && (
              <section className="rounded-lg border bg-card p-3 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">版本</h2>
                  <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">共 {versions.length} 个版本</span>
                </div>
                <Select value={String(show.id)} onValueChange={(value) => navigate(`/shows/${value}`)}>
                  <SelectTrigger className="mt-3 h-10 w-full border-border/70 bg-muted/30 px-3 text-sm font-medium" aria-label="切换放映版本"><SelectValue /></SelectTrigger>
                  <SelectContent>{versions.map((version) => <SelectItem key={version.id} value={String(version.id)}>v{version.version_no}{version.id === show.id ? "（当前）" : ""}{version.change_note ? ` · ${version.change_note}` : ""}</SelectItem>)}</SelectContent>
                </Select>
              </section>
            )}
            <section className="rounded-lg border bg-card p-3 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold">放映信息</h2>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{show.can_manage ? "可管理" : "只读"}</span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3">
                <InfoItem label="主体" value={show.subject || "未设置"} />
                <InfoItem label="状态" value={show.status || "-"} />
                <InfoItem label="标签" value={parseTags(show.tags).join("、") || "-"} />
                <InfoItem label="可见范围" value={RESOURCE_SCOPE_LABEL[show.visibility_scope] || show.visibility_scope} />
                <InfoItem label="管理范围" value={RESOURCE_SCOPE_LABEL[show.management_scope] || show.management_scope} />
                <InfoItem label="创建者" value={show.owner?.name || show.owner?.username || "-"} />
                <InfoItem label="资源数" value={`${resources.length} 页`} />
              </dl>
              {show.change_note && <p className="mt-3 border-t pt-3 text-xs leading-5 text-muted-foreground">变更说明：{show.change_note}</p>}
              <p className="mt-3 text-[10px] text-muted-foreground">更新于 {formatDate(show.updated_at)}</p>
            </section>
          </aside>
        </div>

        {updates.length > 0 && (
          <section className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300/70 bg-amber-50 px-4 py-3 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100">
            <div className="min-w-0">
              <p className="text-sm font-medium">有 {updates.length} 页资源可以升级</p>
              <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-200/80">当前放映引用的资源存在更新版本，创建新版本后即可选择升级。</p>
            </div>
            {show.can_manage && <Button size="sm" className="shrink-0" onClick={() => navigate(`/shows/${show.id}/iterate?tab=upgrade`)}>查看并升级</Button>}
          </section>
        )}

        <section className="mt-8 border-t pt-6">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">放映页面</h2>
              <p className="mt-1 text-xs text-muted-foreground">选择页面查看高清预览</p>
            </div>
            <span className="text-xs text-muted-foreground">{resources.length} 页</span>
          </div>
          {resources.length ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {resources.map((resource, index) => {
                const thumb = isAccessible(resource) ? resource.preview_url || resource.original_preview_url : null;
                return <button key={`${resource.id}-${index}`} type="button" onClick={() => { setActiveIndex(index); window.scrollTo({ top: 0, behavior: "smooth" }); }} className={`group overflow-hidden rounded-lg border bg-card text-left shadow-sm transition hover:border-primary/50 hover:shadow-md ${index === activeIndex ? "border-primary ring-2 ring-primary/20" : ""}`}>
                  <div className="relative aspect-video overflow-hidden bg-muted">
                    {thumb ? <img src={thumb} alt={resource.name} loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-[1.015]" /> : <div className="flex h-full items-center justify-center text-xs text-muted-foreground"><Lock className="mr-1 h-3.5 w-3.5" />无权限</div>}
                    <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{index + 1}</span>
                    {updateByResourceId.has(resource.id) && <span className="absolute right-2 top-2 rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-medium text-white">可升级</span>}
                  </div>
                  <div className="truncate px-3 py-2 text-xs font-medium" title={resource.name}>{resource.name}</div>
                </button>;
              })}
            </div>
          ) : <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">暂无放映页面</div>}
        </section>

        <div className="mt-6 flex flex-wrap gap-2 border-t pt-4">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setPrepOpen(true)}><ClipboardList className="h-4 w-4" />资源准备</Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDownloadOpen(true)}><Download className="h-4 w-4" />下载</Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOfflineCacheOpen(true)}><HardDriveDownload className="h-4 w-4" />离线缓存</Button>
          {show.can_manage && <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(`/shows/${show.id}/iterate`)}><GitBranch className="h-4 w-4" />版本迭代{updates.length > 0 && <Badge variant="secondary" className="ml-0.5 h-5 px-1.5 text-[10px]">{updates.length}</Badge>}</Button>}
        </div>
      </main>

      <ShowResourcePrepDialog open={prepOpen} onOpenChange={setPrepOpen} show={show} />
      <ShowDownloadDialog open={downloadOpen} onOpenChange={setDownloadOpen} show={show} />
      <ShowOfflineCacheDialog open={offlineCacheOpen} onOpenChange={setOfflineCacheOpen} show={show} />
    </div>
  );
}

function ErrorState({ title, onBack }: { title: string; onBack: () => void }) {
  return <div className="mx-auto flex h-full w-full max-w-xl flex-col items-center justify-center gap-3 p-6 text-center"><div className="rounded-full bg-muted p-3"><Lock className="h-6 w-6 text-muted-foreground" /></div><h1 className="text-lg font-semibold">{title}</h1><Button variant="outline" onClick={onBack}><ArrowLeft className="mr-1.5 h-4 w-4" />返回放映库</Button></div>;
}

export default ShowDetailPage;
