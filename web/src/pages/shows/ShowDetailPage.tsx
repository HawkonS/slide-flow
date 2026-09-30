import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  GitBranch,
  HardDriveDownload,
  Link2,
  LayoutGrid,
  Loader2,
  Lock,
  Maximize,
  MonitorPlay,
  Play,
} from "lucide-react";

import { ShowDownloadDialog } from "@/components/show/ShowDownloadDialog";
import ShowOfflineCacheDialog from "@/components/show/ShowOfflineCacheDialog";
import { ShowResourceRemarks } from "@/components/show/ShowResourceRemarks";
import { ShowShareDialog } from "@/components/show/ShowShareDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RESOURCE_SCOPE_LABEL } from "@/lib/constants";
import { api, getShowVersions } from "@/lib/api";
import { parseTags, type Show, type ShowResource, type ShowResourceAccessible, type ShowResourceInaccessible, type UpdateInfo } from "@/lib/types";
import { createClientId } from "@/lib/offline-session";

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

function PageThumb({ resource, index, active, onClick, compact = false }: {
  resource: ShowResource;
  index: number;
  active: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  const thumb = isAccessible(resource) ? resource.preview_url || resource.original_preview_url : null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`第 ${index + 1} 页${resource.name ? `：${resource.name}` : ""}`}
      aria-pressed={active}
      title={resource.name}
      className={[
        "group relative text-left transition-colors",
        compact
          ? `w-24 shrink-0 rounded-lg p-1 sm:w-28 ${active ? "bg-primary/5" : "hover:bg-muted"}`
          : `w-full overflow-hidden rounded-md border bg-muted ${active ? "border-primary ring-2 ring-primary/25" : "border-border/70 hover:border-primary/50"}`,
      ].join(" ")}
    >
      <div className={[
        "relative aspect-video overflow-hidden",
        compact ? `rounded-md border bg-background shadow-sm ${active ? "border-primary ring-1 ring-primary" : "border-border/80 group-hover:border-primary/40"}` : "",
      ].join(" ")}>
        {thumb ? (
          <img src={thumb} alt={resource.name} loading="lazy" decoding="async" draggable={false} className={`absolute inset-0 h-full w-full ${compact ? "object-contain" : "object-cover transition-transform group-hover:scale-[1.02]"}`} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground"><Lock className="h-4 w-4" /></div>
        )}
        {!compact && <span className="absolute left-1.5 top-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">{index + 1}</span>}
      </div>
      {compact
        ? <span className={`block pt-1.5 text-center text-[11px] leading-4 tabular-nums ${active ? "font-semibold text-foreground" : "text-muted-foreground"}`}>{index + 1}</span>
        : <div className="truncate px-2 py-1.5 text-[11px] font-medium" title={resource.name}>{resource.name}</div>}
    </button>
  );
}

function PageRail({ resources, activeIndex, onSelect, onOpenAll }: {
  resources: ShowResource[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onOpenAll: () => void;
}) {
  const railRef = React.useRef<HTMLDivElement>(null);
  const railId = React.useId();
  const [scrollable, setScrollable] = React.useState({ left: false, right: false });

  React.useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const updateScrollState = () => {
      const left = rail.scrollLeft > 1;
      const right = rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1;
      setScrollable((previous) => previous.left === left && previous.right === right ? previous : { left, right });
    };
    updateScrollState();
    rail.addEventListener("scroll", updateScrollState, { passive: true });
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(rail);
    return () => {
      rail.removeEventListener("scroll", updateScrollState);
      observer.disconnect();
    };
  }, [resources.length]);

  React.useEffect(() => {
    const rail = railRef.current;
    const selected = rail?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (!rail || !selected) return;
    const viewport = rail.getBoundingClientRect();
    const thumbnail = selected.getBoundingClientRect();
    // Reveal selections from the page picker without moving the document vertically.
    if (thumbnail.left < viewport.left + 4) {
      rail.scrollBy({ left: thumbnail.left - viewport.left - 4, behavior: "instant" });
    } else if (thumbnail.right > viewport.right - 4) {
      rail.scrollBy({ left: thumbnail.right - viewport.right + 4, behavior: "instant" });
    }
  }, [activeIndex, resources]);

  const scrollRail = (direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({
      left: direction * Math.max(96, rail.clientWidth * 0.8),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  };

  if (!resources.length) return null;
  return (
    <nav aria-label="放映页面导航" className="flex items-center gap-1.5 border-t bg-muted/25 px-2 py-2.5 sm:gap-3 sm:px-4">
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-full text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-25" disabled={!scrollable.left} aria-label="向左滚动缩略图" aria-controls={railId} title="向左滚动缩略图" onClick={() => scrollRail(-1)}><ChevronLeft className="h-4 w-4" /></Button>
      <div className="relative min-w-0 flex-1">
        <div ref={railRef} id={railId} role="group" aria-label="页面缩略图" className="scrollbar-hide flex gap-2 overflow-x-auto overscroll-x-contain p-1">
          {resources.map((resource, index) => (
            <PageThumb key={`${resource.id}-${index}`} resource={resource} index={index} active={index === activeIndex} onClick={() => onSelect(index)} compact />
          ))}
        </div>
        {scrollable.left && <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-3 bg-gradient-to-r from-card to-transparent" />}
        {scrollable.right && <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-3 bg-gradient-to-l from-card to-transparent" />}
      </div>
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-full text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-25" disabled={!scrollable.right} aria-label="向右滚动缩略图" aria-controls={railId} title="向右滚动缩略图" onClick={() => scrollRail(1)}><ChevronRight className="h-4 w-4" /></Button>
      <div className="flex shrink-0 items-center self-stretch border-l pl-1.5 sm:pl-3">
        <Button type="button" variant="ghost" size="sm" className="h-auto flex-col gap-1.5 rounded-lg px-2 py-2 text-muted-foreground hover:bg-background hover:text-foreground" aria-label="全部页面" title="全部页面" onClick={onOpenAll}><LayoutGrid className="h-4 w-4" /><span className="hidden text-[10px] sm:inline">全部页面</span></Button>
      </div>
    </nav>
  );
}

function AllPagesDialog({ open, onOpenChange, resources, activeIndex, onSelect }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resources: ShowResource[];
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-4 pr-12"><DialogTitle className="flex items-center gap-2 text-base"><LayoutGrid className="h-4 w-4 text-muted-foreground" />全部页面</DialogTitle><DialogDescription>点击页面即可快速切换当前预览。</DialogDescription></DialogHeader>
        <div className="max-h-[calc(90vh-86px)] overflow-y-auto p-5">
          {resources.length ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{resources.map((resource, index) => <PageThumb key={`${resource.id}-${index}`} resource={resource} index={index} active={index === activeIndex} onClick={() => { onSelect(index); onOpenChange(false); }} />)}</div> : <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">暂无放映页面</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShowRemarksPanel({ show, resource }: { show: Show; resource: ShowResource | null }) {
  return (
    <section className="rounded-lg border bg-card p-3 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">资源准备</h2>
        <span className="text-[10px] text-muted-foreground">点击卡片编辑</span>
      </div>
      {resource && isAccessible(resource) ? (
        <div className="space-y-3">
          <ShowResourceRemarks showId={show.id} resource={resource} />
        </div>
      ) : (
        <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" />当前页面的资源不可访问，无法查看或编辑备注。
        </div>
      )}
    </section>
  );
}

export function ShowDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const showId = Number(id);
  const validId = Number.isInteger(showId) && showId > 0;
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [allPagesOpen, setAllPagesOpen] = React.useState(false);
  const [downloadOpen, setDownloadOpen] = React.useState(false);
  const [offlineCacheOpen, setOfflineCacheOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);

  const { data, isLoading, error } = useQuery({ queryKey: ["show-detail", showId], queryFn: () => api<{ show: Show }>(`/api/shows/${showId}`), enabled: validId, retry: false });
  const show = data?.show ?? null;
  const { data: versionsData } = useQuery({ queryKey: ["shows", showId, "versions"], queryFn: () => getShowVersions(showId), enabled: validId && !!show, staleTime: 30_000 });
  const { data: updatesData } = useQuery({ queryKey: ["shows", showId, "check-updates"], queryFn: () => api<{ updates: UpdateInfo[] }>(`/api/shows/${showId}/check-updates`), enabled: validId && !!show, staleTime: 30_000 });
  React.useEffect(() => { setActiveIndex(0); }, [showId]);

  if (!validId) return <ErrorState title="放映不存在" onBack={() => navigate("/manage/shows")} />;
  if (isLoading) return <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />加载放映详情…</div>;
  if (!show) { const status = (error as { status?: number } | null)?.status; return <ErrorState title={status === 403 ? "没有查看权限" : "放映不存在或加载失败"} onBack={() => navigate("/manage/shows")} />; }

  const resources = show.resources ?? [];
  const activeResource = resources[activeIndex] ?? null;
  const previewUrl = activeResource && isAccessible(activeResource) ? activeResource.original_preview_url || activeResource.preview_url : null;
  const versions = [...(versionsData?.versions ?? [])].sort((a, b) => b.version_no - a.version_no);
  const versionOptions = versions.length ? versions : [{ id: show.id, version_no: show.version_no, name: show.name, change_note: show.change_note || "", resource_count: resources.length, created_at: show.created_at, owner: show.owner || { id: show.owner_id, username: "", name: null } }];
  const updates = updatesData?.updates ?? [];
  const tags = parseTags(show.tags);
  const openFullscreen = () => window.open(`/shows/${show.id}/fullscreen`, "_blank", "popup=yes,width=1920,height=1080");
  const openPresenter = () => {
    const session = createClientId();
    const params = new URLSearchParams({ playback_session: session });
    window.open(`/shows/${show.id}/display?${params.toString()}`, `slideflow-display-${session}`, "popup=yes,width=1920,height=1080");
    navigate(`/shows/${show.id}/present?${params.toString()}`);
  };

  return (
    <div className="min-h-full w-full pb-10">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-1 py-2 sm:px-2"><div className="flex min-w-0 items-center gap-2.5"><Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" title="返回放映库" aria-label="返回放映库" onClick={() => navigate(-1)}><ArrowLeft className="h-4 w-4" /></Button><div className="min-w-0"><div className="flex min-w-0 flex-wrap items-center gap-2"><h1 className="max-w-full truncate text-xl font-semibold tracking-tight sm:text-2xl">{show.name}</h1><Badge variant="outline" className="h-5 px-1.5 text-[10px]">v{show.version_no}</Badge>{show.is_standard && <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">标准放映</Badge>}</div></div></div><div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto"><div className="flex items-stretch"><Button size="sm" className="h-8 gap-1.5 rounded-r-none px-3" onClick={openFullscreen}><Play className="h-4 w-4" />放映</Button><DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" className="h-8 w-8 rounded-l-none border-l border-primary-foreground/25 px-0" aria-label="选择放映模式"><ChevronDown className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-36"><DropdownMenuItem onClick={openFullscreen}><Maximize className="h-4 w-4" />全屏放映</DropdownMenuItem><DropdownMenuItem onClick={openPresenter}><MonitorPlay className="h-4 w-4" />讲演放映</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div><Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5" onClick={() => setShareOpen(true)}><Link2 className="h-4 w-4" />分享</Button><Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5" onClick={() => setDownloadOpen(true)}><Download className="h-4 w-4" />资源下载</Button><Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5" onClick={() => setOfflineCacheOpen(true)}><HardDriveDownload className="h-4 w-4" />离线缓存</Button>{show.can_manage && <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5" onClick={() => navigate(`/shows/${show.id}/iterate`)}><GitBranch className="h-4 w-4" />版本迭代{updates.length > 0 && <Badge variant="secondary" className="ml-0.5 h-5 px-1.5 text-[10px]">{updates.length}</Badge>}</Button>}</div></header>
      <main className="min-w-0 pb-16 pt-5"><div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_340px]"><section className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm"><div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b px-3 py-2 sm:px-4"><div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground"><Eye className="h-4 w-4" /><span className="font-medium text-foreground">预览</span>{tags.map((tag) => <Badge key={tag} variant="outline" className="h-5 px-1.5 text-[10px] font-normal">{tag}</Badge>)}</div><span className="shrink-0 text-xs tabular-nums text-muted-foreground">第 <strong className="font-semibold text-foreground">{resources.length ? activeIndex + 1 : 0}</strong> / {resources.length} 页</span></div><div className="relative aspect-video w-full overflow-hidden bg-slate-100">{activeResource ? isAccessible(activeResource) ? previewUrl ? <img src={previewUrl} alt={activeResource.name} decoding="async" className="absolute inset-0 h-full w-full object-contain" /> : <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">暂无预览图</div> : <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-muted text-muted-foreground"><Lock className="h-10 w-10" /><p className="text-sm font-medium">资源 #{activeResource.id} 无权限</p><p className="text-xs">管理者：{(activeResource as ShowResourceInaccessible).managers.map((manager) => manager.name || manager.username).join("、")}</p></div> : <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">暂无放映页面</div>}</div><PageRail resources={resources} activeIndex={activeIndex} onSelect={setActiveIndex} onOpenAll={() => setAllPagesOpen(true)} /></section><aside className="flex min-w-0 flex-col gap-3"><section className="rounded-lg border bg-card p-3 shadow-sm"><div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">版本</h2><span className="rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">共 {versionOptions.length} 个版本</span></div><Select value={String(show.id)} onValueChange={(value) => navigate(`/shows/${value}`)}><SelectTrigger className="mt-3 h-10 w-full border-border/70 bg-muted/30 px-3 text-sm font-medium hover:bg-muted/60" aria-label="切换放映版本"><SelectValue /></SelectTrigger><SelectContent>{versionOptions.map((version) => <SelectItem key={version.id} value={String(version.id)}>v{version.version_no}{version.id === show.id ? "（当前）" : ""}{version.change_note ? ` · ${version.change_note}` : ""}</SelectItem>)}</SelectContent></Select></section><section className="rounded-lg border bg-card p-3 shadow-sm"><div className="flex items-center justify-between gap-2"><h2 className="text-xs font-semibold">放映信息</h2><span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{show.can_manage ? "可管理" : "只读"}</span></div><dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3"><InfoItem label="主体" value={show.subject || "未设置"} /><InfoItem label="状态" value={show.status || "-"} /><InfoItem label="可见范围" value={RESOURCE_SCOPE_LABEL[show.visibility_scope] || show.visibility_scope} /><InfoItem label="管理范围" value={RESOURCE_SCOPE_LABEL[show.management_scope] || show.management_scope} /><InfoItem label="创建者" value={show.owner?.name || show.owner?.username || "-"} /><InfoItem label="页面数" value={`${resources.length} 页`} /></dl>{show.change_note && <p className="mt-3 border-t pt-3 text-xs leading-5 text-muted-foreground">变更说明：{show.change_note}</p>}<p className="mt-3 text-[10px] text-muted-foreground">更新于 {formatDate(show.updated_at)}</p></section><ShowRemarksPanel show={show} resource={activeResource} /></aside></div>{updates.length > 0 && <section className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300/70 bg-amber-50 px-4 py-3 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100"><div className="min-w-0"><p className="text-sm font-medium">有 {updates.length} 页资源可以升级</p><p className="mt-1 text-xs text-amber-800/80 dark:text-amber-200/80">当前放映引用的资源存在更新版本，创建新版本后即可选择升级。</p></div>{show.can_manage && <Button size="sm" className="shrink-0" onClick={() => navigate(`/shows/${show.id}/iterate?tab=upgrade`)}>查看并升级</Button>}</section>}</main>
      <AllPagesDialog open={allPagesOpen} onOpenChange={setAllPagesOpen} resources={resources} activeIndex={activeIndex} onSelect={setActiveIndex} /><ShowShareDialog open={shareOpen} onOpenChange={setShareOpen} show={show} /><ShowDownloadDialog open={downloadOpen} onOpenChange={setDownloadOpen} show={show} /><ShowOfflineCacheDialog open={offlineCacheOpen} onOpenChange={setOfflineCacheOpen} show={show} />
    </div>
  );
}

function ErrorState({ title, onBack }: { title: string; onBack: () => void }) {
  return <div className="mx-auto flex h-full w-full max-w-xl flex-col items-center justify-center gap-3 p-6 text-center"><div className="rounded-full bg-muted p-3"><Lock className="h-6 w-6 text-muted-foreground" /></div><h1 className="text-lg font-semibold">{title}</h1><Button variant="outline" onClick={onBack}><ArrowLeft className="mr-1.5 h-4 w-4" />返回放映库</Button></div>;
}

export default ShowDetailPage;
