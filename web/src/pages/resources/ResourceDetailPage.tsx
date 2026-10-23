import { copyText } from "@/lib/clipboard";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useDetailReturn, useResourceListParams } from "@/lib/detail-navigation";
import {
  ArrowLeft,
  ArrowRight,
  Clipboard,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileKey2,
  Link2,
  Loader2,
  Maximize,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { CommonRemarkView, PersonalRemarkEditor } from "@/components/resource/ResourceDetailDialog";
import { ResourceDownloadDialog } from "@/components/resource/ResourceDownloadDialog";
import { ResourceEditDialog } from "@/components/resource/ResourceEditDialog";
import { ResourceNewVersionDialog } from "@/components/resource/ResourceNewVersionDialog";
import { ResourcePreviewDialog } from "@/components/resource/ResourcePreviewDialog";
import { SmartTaggingDialog } from "@/components/common/SmartTaggingDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DEFAULT_RESOURCE_SUBJECT,
  RESOURCE_SCOPE_LABEL,
} from "@/lib/constants";
import { ApiError, api, apiWithTimeout } from "@/lib/api";
import { parseTags, type Resource, type ResourceVersion } from "@/lib/types";

interface ShareLinkItem {
  id: number;
  created_by: number;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

interface PersonalRemarkResponse {
  content_html: string;
  version_id: number;
}

interface ResourceListResponse {
  items: Resource[];
}

interface AdjacentResource {
  id: number;
  name: string;
  detail_token: string;
}

interface ResourceNeighbors {
  previous: AdjacentResource | null;
  next: AdjacentResource | null;
  position: number | null;
  total: number;
}

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("zh-CN") : "-";
}


function ScopeLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

function RecommendedResourceCard({ resource }: { resource: Resource }) {
  const location = useLocation();
  return (
    <Link
      to={`/resources/${resource.detail_token}`}
      state={location.state}
      className="group overflow-hidden rounded-lg border bg-card shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
    >
      <div className="relative aspect-video overflow-hidden bg-slate-100">
        {resource.current?.preview_url ? (
          <img
            src={resource.current.preview_url}
            alt={resource.name}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.015]"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">暂无预览</div>
        )}
      </div>
      <div className="flex min-h-[48px] items-center border-t bg-[hsl(var(--surface-subtle))] px-3 py-2.5">
        <div className="truncate text-sm font-medium" title={resource.name}>{resource.name}</div>
      </div>
    </Link>
  );
}

function ShareLinksPanel({ resource, open }: { resource: Resource; open: boolean }) {
  const queryClient = useQueryClient();
  const [days, setDays] = React.useState("7");
  const [createdLink, setCreatedLink] = React.useState<string | null>(null);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["resource", resource.id, "share-links"],
    queryFn: () => api<{ items: ShareLinkItem[] }>(`/api/resources/${resource.id}/share-links`),
    enabled: open,
  });
  const create = useMutation({
    mutationFn: () => api<{ share_path: string; expires_at: string }>(`/api/resources/${resource.id}/share-links`, {
      method: "POST",
      json: { expires_in_days: Number(days) },
    }),
    onSuccess: (result) => {
      const url = `${window.location.origin}${result.share_path}`;
      setCreatedLink(url);
      void copyText(url, "分享链接已创建并复制");
      void queryClient.invalidateQueries({ queryKey: ["resource", resource.id, "share-links"] });
    },
    onError: (error: Error) => toast.error(error.message || "创建分享链接失败"),
  });
  const revoke = useMutation({
    mutationFn: (linkId: number) => api(`/api/resources/${resource.id}/share-links/${linkId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("分享链接已撤销");
      void queryClient.invalidateQueries({ queryKey: ["resource", resource.id, "share-links"] });
    },
    onError: (error: Error) => toast.error(error.message || "撤销失败"),
  });

  return (
    <section className="border-t pt-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Link2 className="h-4 w-4 text-foreground/70" />分享链接</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">对方无需登录即可查看素材预览和基本信息，无法下载源文件。链接可随时撤销。</p>
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="h-9 w-full sm:w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1">1 天</SelectItem>
            <SelectItem value="7">7 天</SelectItem>
            <SelectItem value="30">30 天</SelectItem>
          </SelectContent>
        </Select>
          <Button className="h-9 gap-1.5" onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
          创建分享链接
        </Button>
      </div>
      {createdLink && (
        <div className="mt-3 flex gap-2">
          <Input readOnly value={createdLink} className="h-9 min-w-0 text-xs" aria-label="新创建的分享链接" />
          <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" title="复制分享链接" aria-label="复制分享链接" onClick={() => void copyText(createdLink)}><Copy className="h-4 w-4" /></Button>
          <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" title="打开分享链接" aria-label="打开分享链接" onClick={() => window.open(createdLink, "_blank", "noopener,noreferrer")}><ExternalLink className="h-4 w-4" /></Button>
        </div>
      )}
      <div className="mt-4 space-y-2">
        {isLoading ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />加载分享链接…</div> : isError ? <div role="alert" className="flex items-center justify-between gap-2 text-sm text-destructive">分享记录加载失败<Button variant="outline" size="sm" onClick={() => void refetch()}>重试</Button></div> : data?.items?.length ? data.items.map((item) => {
          const expired = item.revoked_at || new Date(item.expires_at).getTime() <= Date.now();
          return <div key={item.id} className="flex items-center justify-between gap-3 border-t py-2 text-xs">
            <div className="min-w-0"><div className="font-medium">{item.revoked_at ? "已撤销" : expired ? "已过期" : "有效分享链接"}</div><div className="text-muted-foreground">到期：{formatDate(item.expires_at)} · 创建：{formatDate(item.created_at)}</div></div>
            {!item.revoked_at && !expired && <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive" title="撤销分享链接" aria-label="撤销分享链接" onClick={() => revoke.mutate(item.id)} disabled={revoke.isPending}><Trash2 className="h-3.5 w-3.5" /></Button>}
          </div>;
        }) : <p className="text-xs text-muted-foreground">还没有创建分享链接。</p>}
      </div>
    </section>
  );
}

function ResourceLinksDialog({
  open,
  onOpenChange,
  resource,
  publicUrl,
  version,
  followsLatest,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: Resource;
  publicUrl: string;
  version: ResourceVersion;
  followsLatest: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(720px,calc(100vh-2rem))] max-w-xl overflow-y-auto p-0">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Link2 className="h-4 w-4 text-muted-foreground" />
            链接与分享
          </DialogTitle>
          <DialogDescription>
            复制素材页面地址，或创建临时分享链接发给他人。临时链接只能预览，不能下载 PPT。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 px-6 py-5">
          <section>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">页面地址</h2>
                <p className="mt-1 text-xs text-muted-foreground">{followsLatest ? "始终显示最新版" : `固定显示 v${version.version_no}`}</p>
              </div>
              <Clipboard className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="mt-3 flex min-w-0 gap-2">
              <Input readOnly value={publicUrl} className="h-9 min-w-0 bg-muted/30 text-xs" aria-label="素材页面地址" />
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0"
                title="复制页面地址"
                aria-label="复制页面地址"
                onClick={() => void copyText(publicUrl)}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0"
                title="打开页面地址"
                aria-label="打开页面地址"
                onClick={() => window.open(publicUrl, "_blank", "noopener,noreferrer")}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </div>
          </section>

          <ShareLinksPanel resource={resource} open={open} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ResourceDetailPage() {
  const navigate = useNavigate();
  const returnToList = useDetailReturn("/resources");
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { resourceKey } = useParams();
  const versionParam = searchParams.get("version");
  const followsLatest = versionParam === null;
  const requestedVersionNo = versionParam !== null && /^[1-9]\d*$/.test(versionParam)
    && Number.isSafeInteger(Number(versionParam)) ? Number(versionParam) : null;
  const validKey = Boolean(resourceKey && /^[A-Za-z0-9_-]{32,128}$/.test(resourceKey));
  const { data, isLoading, error } = useQuery({
    // Revalidate on entry and URL version changes so the bare address follows updates.
    queryKey: ["resource-detail", resourceKey, versionParam],
    queryFn: async () => (
      await api<{ resource: Resource }>(
        `/api/resources/by-key/${encodeURIComponent(resourceKey!)}`,
      )
    ).resource,
    enabled: validKey,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const resource = data ?? null;
  const listParams = useResourceListParams();
  const neighbors = useQuery({
    queryKey: ["resource-neighbors", resource?.id, listParams],
    queryFn: ({ signal }) => apiWithTimeout<ResourceNeighbors>(`/api/resources/${resource!.id}/neighbors`, { params: listParams, signal }, 12_000),
    enabled: resource != null,
    staleTime: 30_000,
  });
  const [switchingResource, setSwitchingResource] = React.useState(false);
  const switchRequestRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => {
    switchRequestRef.current?.abort();
    switchRequestRef.current = null;
  }, [resourceKey]);
  const switchResource = async (target: AdjacentResource | null | undefined) => {
    if (!target || switchRequestRef.current) return;
    const controller = new AbortController();
    switchRequestRef.current = controller;
    setSwitchingResource(true);
    try {
      // Keep the current frame visible until the next detail is available.
      const result = await apiWithTimeout<{ resource: Resource }>(`/api/resources/by-key/${encodeURIComponent(target.detail_token)}`, { signal: controller.signal }, 12_000);
      if (controller.signal.aborted) return;
      queryClient.setQueryData(["resource-detail", target.detail_token, null], result.resource);
      const next = new URLSearchParams(searchParams);
      next.delete("version");
      const search = next.toString();
      navigate({ pathname: `/resources/${encodeURIComponent(target.detail_token)}`, search: search ? `?${search}` : "", hash: location.hash }, { replace: true, preventScrollReset: true, state: location.state });
    } catch (error) {
      if (!controller.signal.aborted) {
        toast.error(error instanceof Error ? error.message : "切换素材失败，请重试");
        if (error instanceof ApiError && [403, 404].includes(error.status)) void neighbors.refetch();
      }
    } finally {
      if (switchRequestRef.current === controller) {
        switchRequestRef.current = null;
        setSwitchingResource(false);
      }
    }
  };
  const [editOpen, setEditOpen] = React.useState(false);
  const [newVersionOpen, setNewVersionOpen] = React.useState(false);
  const [downloadCtx, setDownloadCtx] = React.useState<{ resource: Resource; version: ResourceVersion } | null>(null);
  const [previewResource, setPreviewResource] = React.useState<Resource | null>(null);
  const [linksOpen, setLinksOpen] = React.useState(false);
  const [commonRemarkOpen, setCommonRemarkOpen] = React.useState(false);
  const [personalRemarkOpen, setPersonalRemarkOpen] = React.useState(false);
  const [smartTaggingOpen, setSmartTaggingOpen] = React.useState(false);
  React.useEffect(() => {
    setEditOpen(false);
    setNewVersionOpen(false);
    setDownloadCtx(null);
    setPreviewResource(null);
    setLinksOpen(false);
    setCommonRemarkOpen(false);
    setPersonalRemarkOpen(false);
    setSmartTaggingOpen(false);
    setSwitchingResource(false);
  }, [resourceKey]);

  const versionOptions = resource
    ? (resource.versions?.length ? resource.versions : [resource.current])
    : [];
  const version = followsLatest
    ? resource?.current ?? null
    : versionOptions.find((item) => item.version_no === requestedVersionNo) ?? null;
  const selectVersion = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "latest") next.delete("version");
    else next.set("version", value);
    const search = next.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash }, { preventScrollReset: true, state: location.state });
  };
  const personalRemarkQuery = useQuery({
    queryKey: ["resource", resource?.id, "personal-remark", version?.id],
    queryFn: async () => api<PersonalRemarkResponse>(
      `/api/resources/${resource!.id}/personal-remark`,
      version?.id ? { params: { version_id: version.id } } : undefined,
    ),
    enabled: resource != null && version?.id != null,
    staleTime: 30_000,
  });
  const commonRemarkPreview = remarkPreviewText(version?.common_remark_html || "");
  const personalRemarkPreview = remarkPreviewText(personalRemarkQuery.data?.content_html || "");
  // 列表使用缩略图；进入单页详情后直接展示当前版本高清预览。
  const currentPreview = version?.original_preview_url || version?.preview_url;
  const tags = resource ? parseTags(resource.tags) : [];
  const recommendationsQuery = useQuery({
    queryKey: ["resource-recommendations", resource?.id, tags.join(","), resource?.subject],
    queryFn: async () => {
      const currentResource = resource!;
      const currentTags = new Set(tags);
      const selected: Resource[] = [];
      const seen = new Set<number>([currentResource.id]);
      const appendItems = (items: Resource[]) => {
        for (const item of items) {
          if (seen.has(item.id)) continue;
          selected.push(item);
          seen.add(item.id);
          if (selected.length === 5) break;
        }
      };
      const loadResources = async (params: Record<string, string | number>) => {
        try {
          const response = await api<ResourceListResponse>("/api/resources", { params });
          return response.items;
        } catch {
          // 某一层推荐失败时继续走下一层，避免整个推荐区被隐藏。
          return [];
        }
      };

      if (tags.length > 0) {
        const related = await loadResources({
          page: 1,
          page_size: 100,
          tags: tags.join(","),
          tags_mode: "any",
          sort: "updated_desc",
        });
        const ranked = related
          .filter((item) => item.id !== currentResource.id)
          .map((item) => ({
            item,
            tagMatches: parseTags(item.tags).filter((tag) => currentTags.has(tag)).length,
            sameSubject: Boolean(currentResource.subject && item.subject === currentResource.subject),
          }))
          .sort((a, b) =>
            b.tagMatches - a.tagMatches
            || Number(b.sameSubject) - Number(a.sameSubject)
            || Date.parse(b.item.updated_at) - Date.parse(a.item.updated_at),
          )
          .map(({ item }) => item);
        appendItems(ranked);
      }

      // 很多历史素材没有标签：先用相同主体补足，比直接随机推荐更相关。
      if (selected.length < 5 && currentResource.subject) {
        const sameSubject = await loadResources({
          page: 1,
          page_size: 50,
          subject: currentResource.subject,
          sort: "updated_desc",
        });
        appendItems(sameSubject);
      }

      if (selected.length < 5) {
        const fallback = await loadResources({
          page: 1,
          page_size: 100,
          sort: "updated_desc",
        });
        appendItems(fallback);
      }

      return selected;
    },
    enabled: resource != null,
    staleTime: 60_000,
  });
  const statusLabel = resource?.status || "";
  const publicUrl = `${window.location.origin}${location.pathname}${location.search}${location.hash}`;
  const closeAndRefresh = React.useCallback((open: boolean, setOpen: (value: boolean) => void) => {
    setOpen(open);
    if (!open && resource) {
      void queryClient.invalidateQueries({ queryKey: ["resource-detail", resourceKey] });
      void queryClient.invalidateQueries({ queryKey: ["resource", resource.id] });
    }
  }, [queryClient, resource, resourceKey]);

  if (!validKey) return <div className="mx-auto flex h-full w-full max-w-xl flex-col items-center justify-center gap-3 p-6 text-center"><FileKey2 className="h-8 w-8 text-muted-foreground" /><h1 className="text-lg font-semibold">素材不存在</h1><Button variant="outline" onClick={returnToList}><ArrowLeft className="mr-1.5 h-4 w-4" />返回素材库</Button></div>;
  if (isLoading) return <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />加载素材详情…</div>;
  if (!resource) {
    const status = error instanceof ApiError ? error.status : 0;
    return <div className="mx-auto flex h-full w-full max-w-xl flex-col items-center justify-center gap-3 p-6 text-center"><div className="rounded-full bg-destructive/10 p-3"><FileKey2 className="h-6 w-6 text-destructive" /></div><h1 className="text-lg font-semibold">{status === 403 ? "没有查看权限" : status === 404 ? "素材不存在" : "素材加载失败"}</h1><p className="text-sm text-muted-foreground">{status === 403 ? "该素材的可见范围不包含当前账号。" : "请返回素材库重试。"}</p><Button variant="outline" onClick={returnToList}><ArrowLeft className="mr-1.5 h-4 w-4" />返回素材库</Button></div>;
  }
  if (!version) {
    return (
      <div className="mx-auto flex h-full w-full max-w-xl flex-col items-center justify-center gap-3 p-6 text-center">
        <FileKey2 className="h-8 w-8 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{requestedVersionNo === null ? "版本参数无效" : "版本不存在"}</h1>
        <p className="text-sm text-muted-foreground">{requestedVersionNo === null ? "请使用 ?version=版本号，例如 ?version=2。" : `「${resource.name}」的 v${requestedVersionNo} 不存在或已删除。`}</p>
        <Button variant="outline" onClick={() => selectVersion("latest")}>查看最新版</Button>
      </div>
    );
  }

  return (
    <div className="min-h-full w-full pb-8">
      <header className="flex flex-col justify-between gap-x-4 gap-y-2 border-b px-1 py-2 sm:flex-row sm:items-center sm:px-2">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            title="返回素材库"
            aria-label="返回素材库"
            onClick={returnToList}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex h-9 min-w-0 items-center gap-2">
              <h1 title={resource.name} className="min-w-0 truncate text-xl font-semibold tracking-tight sm:text-2xl">{resource.name}</h1>
              {statusLabel && (
                <Badge variant={resource.status === "active" ? "secondary" : "outline"} className="h-5 shrink-0 px-1.5 text-[10px]">
                  {statusLabel}
                </Badge>
              )}
            </div>
          </div>
        </div>
        <div className="flex min-h-[70px] w-full shrink-0 flex-wrap content-start items-center gap-1.5 sm:min-h-0 sm:w-auto">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border/70 px-2.5 text-muted-foreground shadow-none hover:text-foreground" onClick={() => setLinksOpen(true)}>
            <Link2 className="h-4 w-4" />链接与分享
          </Button>
          {resource.can_manage && (
            <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border/70 px-2.5 text-muted-foreground shadow-none hover:text-foreground" onClick={() => setNewVersionOpen(true)}>
              <RefreshCw className="h-4 w-4" />迭代
            </Button>
          )}
          {resource.can_manage && (
            <Button variant="outline" size="sm" aria-label="智能标注" className="h-8 gap-1.5 border-border/70 px-2.5 text-muted-foreground shadow-none hover:text-foreground" onClick={() => setSmartTaggingOpen(true)}>
              <Sparkles className="h-4 w-4" /><span className="hidden sm:inline">智能标注</span>
            </Button>
          )}
          {resource.can_manage && (
            <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border/70 px-3 text-muted-foreground shadow-none hover:text-foreground" onClick={() => setEditOpen(true)}>
              <Pencil className="h-4 w-4" />编辑
            </Button>
          )}
          {resource.can_manage && (
            <Button size="sm" className="h-8 gap-1.5 px-3 shadow-sm" onClick={() => setDownloadCtx({ resource, version: version! })} disabled={!version}>
              <Download className="h-4 w-4" />下载
            </Button>
          )}
          {!resource.can_manage && <Badge variant="soft" className="h-8 px-2.5">只读访问</Badge>}
        </div>
      </header>

      <main className="min-w-0 pb-16 pt-5">
        <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
          <section aria-label="素材预览" aria-busy={switchingResource} className="min-w-0 self-start overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="flex h-12 items-center justify-between gap-2 border-b px-3 py-2 sm:px-4">
              <div className="flex min-w-0 items-center gap-2 overflow-hidden text-xs text-muted-foreground">
                <Eye className="h-4 w-4 shrink-0" />
                <span className="shrink-0 font-medium text-foreground">预览</span>
                {tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="h-5 shrink-0 px-1.5 text-[10px] font-normal">
                    {tag}
                  </Badge>
                ))}
              </div>
              <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1.5 px-2 text-xs" title="放大预览当前版本" onClick={() => setPreviewResource(version ? { ...resource, current: version } : resource)}>
                <Maximize className="h-3.5 w-3.5" />放大查看
              </Button>
            </div>
            <div className="relative aspect-video w-full overflow-hidden bg-slate-100">
              {currentPreview ? (
                <img src={currentPreview} alt={resource.name} decoding="async" className="absolute inset-0 h-full w-full object-contain" />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">暂无预览图</div>
              )}
            </div>
            <nav aria-label="素材切换" className="flex h-14 items-center justify-between gap-2 border-t bg-card px-3 sm:px-4">
              <Button type="button" variant="outline" size="sm" className="shrink-0 gap-1.5" disabled={switchingResource || !neighbors.data?.previous} title={neighbors.data?.previous?.name} onClick={() => void switchResource(neighbors.data?.previous)}><ArrowLeft />上一个素材</Button>
              <div role="status" aria-live="polite" className="flex min-w-0 items-center justify-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                {switchingResource || neighbors.isLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-label="正在加载素材" /> : neighbors.isError ? <Button type="button" variant="ghost" size="sm" className="h-7 px-1 text-xs" onClick={() => void neighbors.refetch()}>重试</Button> : neighbors.data?.position ? `${neighbors.data.position} / ${neighbors.data.total}` : "—"}
              </div>
              <Button type="button" variant="outline" size="sm" className="shrink-0 gap-1.5" disabled={switchingResource || !neighbors.data?.next} title={neighbors.data?.next?.name} onClick={() => void switchResource(neighbors.data?.next)}>下一个素材<ArrowRight /></Button>
            </nav>
          </section>

          <aside className="flex min-w-0 flex-col gap-3">
            <section className="rounded-lg border bg-card p-3 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">版本</h2>
                <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">
                  共 {versionOptions.length} 个版本
                </span>
              </div>
              <Select value={followsLatest ? "latest" : String(version.version_no)} onValueChange={selectVersion}>
                <SelectTrigger className="mt-3 h-10 w-full border-border/70 bg-muted/30 px-3 text-sm font-medium hover:bg-muted/60" aria-label="切换版本">
                  <SelectValue placeholder="选择版本" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="latest">最新版 · v{resource.current.version_no}</SelectItem>
                  {versionOptions.map((item) => (
                    <SelectItem key={item.id} value={String(item.version_no)}>
                      v{item.version_no}{item.id === resource.current.id ? "（当前）" : ""}{item.change_note ? ` · ${item.change_note}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-2 text-xs text-muted-foreground">{followsLatest ? "自动跟随最新版" : `已固定到 v${version.version_no}，切换至最新版可自动跟随更新`}</p>
            </section>

            <section className="rounded-lg border bg-card p-3 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold">素材信息</h2>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {resource.can_manage ? "可管理" : "只读"}
                </span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2.5">
                <ScopeLine label="主体" value={resource.subject || DEFAULT_RESOURCE_SUBJECT || "未设置"} />
                <ScopeLine label="所有者" value={resource.owner?.name || resource.owner?.username || "-"} />
                <ScopeLine label="可见范围" value={RESOURCE_SCOPE_LABEL[resource.visibility_scope] || resource.visibility_scope} />
                <ScopeLine label="管理范围" value={RESOURCE_SCOPE_LABEL[resource.management_scope] || resource.management_scope} />
              </dl>
              <div className="mt-2 text-[10px] text-muted-foreground">更新于 {formatDate(resource.updated_at)}</div>
            </section>

            <button type="button" onClick={() => setCommonRemarkOpen(true)} className="group relative flex min-h-[96px] w-full flex-1 flex-col items-start rounded-lg border bg-card p-3 text-left shadow-sm transition hover:border-primary/40 hover:bg-muted/30">
              <span className="flex w-full items-center justify-between gap-2">
                <span className="text-sm font-medium">通用备注</span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {resource.can_manage ? "可维护" : "仅查看"}
                </span>
              </span>
              <span className="mt-2 line-clamp-3 w-full flex-1 pr-7 text-xs leading-5 text-muted-foreground">
                {commonRemarkPreview || "暂无通用备注"}
              </span>
              <ArrowRight className="absolute bottom-3 right-3 h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>

            <button type="button" onClick={() => setPersonalRemarkOpen(true)} className="group relative flex min-h-[96px] w-full flex-1 flex-col items-start rounded-lg border bg-card p-3 text-left shadow-sm transition hover:border-primary/40 hover:bg-muted/30">
              <span className="flex w-full items-center justify-between gap-2">
                <span className="text-sm font-medium">个人备注</span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  可维护
                </span>
              </span>
              <span className="mt-2 line-clamp-3 w-full flex-1 pr-7 text-xs leading-5 text-muted-foreground">
                {personalRemarkQuery.isLoading ? "正在加载个人备注…" : personalRemarkPreview || "暂无个人备注"}
              </span>
              <ArrowRight className="absolute bottom-3 right-3 h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>

          </aside>
        </div>

        <section className="mt-8 border-t pt-6">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">猜你想要</h2>
            </div>
            {!recommendationsQuery.isLoading && (recommendationsQuery.data?.length ?? 0) > 0 && (
              <span className="text-xs text-muted-foreground">{recommendationsQuery.data?.length ?? 0} 个推荐</span>
            )}
          </div>
          {recommendationsQuery.isLoading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="overflow-hidden rounded-lg border bg-card">
                  <div className="aspect-video animate-pulse bg-muted" />
                  <div className="space-y-2 p-3"><div className="h-4 animate-pulse rounded bg-muted" /><div className="h-3 w-2/3 animate-pulse rounded bg-muted" /></div>
                </div>
              ))}
            </div>
          ) : (recommendationsQuery.data?.length ?? 0) > 0 ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {recommendationsQuery.data?.map((item) => (
                <RecommendedResourceCard key={item.id} resource={item} />
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              暂时没有其他可见素材
            </div>
          )}
        </section>
      </main>

      <ResourceEditDialog open={editOpen} onOpenChange={(open) => closeAndRefresh(open, setEditOpen)} resource={resource} tagSuggestions={tags} subjectSuggestions={resource.subject ? [resource.subject] : []} />
      <ResourceNewVersionDialog open={newVersionOpen} onOpenChange={(open) => closeAndRefresh(open, setNewVersionOpen)} resource={resource} />
      <ResourceDownloadDialog open={downloadCtx != null} onOpenChange={(open) => { if (!open) setDownloadCtx(null); }} resource={downloadCtx?.resource ?? null} version={downloadCtx?.version ?? null} />
      <ResourcePreviewDialog open={previewResource != null} onOpenChange={(open) => { if (!open) setPreviewResource(null); }} resource={previewResource} />
      <SmartTaggingDialog open={smartTaggingOpen} onOpenChange={setSmartTaggingOpen} targetId={resource.id} versionId={version.id} currentTags={tags} onApplied={() => void queryClient.invalidateQueries({ queryKey: ["resource-detail", resourceKey] })} />
      <ResourceLinksDialog open={linksOpen} onOpenChange={setLinksOpen} resource={resource} publicUrl={publicUrl} version={version} followsLatest={followsLatest} />
      <Dialog open={commonRemarkOpen} onOpenChange={setCommonRemarkOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-hidden p-0">
          <DialogHeader className="sr-only"><DialogTitle>通用备注</DialogTitle><DialogDescription>查看或编辑当前版本的通用备注</DialogDescription></DialogHeader>
          <CommonRemarkView
            html={version?.common_remark_html || ""}
            resourceId={resource.id}
            versionId={version?.id ?? null}
            canManage={resource.can_manage}
            className="h-[min(560px,75vh)] rounded-none border-0 bg-card"
          />
        </DialogContent>
      </Dialog>
      <Dialog open={personalRemarkOpen} onOpenChange={setPersonalRemarkOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-hidden p-0">
          <DialogHeader className="sr-only"><DialogTitle>个人备注</DialogTitle><DialogDescription>查看或编辑仅自己可见的备注</DialogDescription></DialogHeader>
          <PersonalRemarkEditor
            resourceId={resource.id}
            versionId={version?.id ?? null}
            open={personalRemarkOpen}
            className="h-[min(560px,75vh)] rounded-none border-0 bg-card"
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface PublicShareResource {
  id: number;
  name: string;
  subject: string;
  tags: string;
  current_version: number;
  updated_at: string;
  preview_url: string;
  detail_path: string;
  version: { id: number; version_no: number; change_note: string; common_remark_html: string; created_at: string };
}

export function ResourceSharePage() {
  const navigate = useNavigate();
  const { token } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["resource-share", token],
    queryFn: () => api<{ resource: PublicShareResource; expires_at: string }>(`/api/resource-shares/${encodeURIComponent(token || "")}`),
    enabled: !!token,
    retry: false,
  });
  if (isLoading) return <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />验证分享链接…</div>;
  if (!data) return <div className="flex min-h-screen items-center justify-center p-6"><div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm"><FileKey2 className="mx-auto h-8 w-8 text-muted-foreground" /><h1 className="mt-4 text-lg font-semibold">分享链接无效或已过期</h1><p className="mt-2 text-sm text-muted-foreground">链接可能已被撤销或超过有效期。</p></div></div>;
  const resource = data.resource;
  const tags = parseTags(resource.tags);
  return (
    <div className="min-h-screen bg-muted/30 p-4 sm:p-8">
      <div className="mx-auto max-w-5xl overflow-hidden rounded-2xl border bg-card shadow-sm">
        <header className="border-b px-5 py-5 sm:px-8">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Link2 className="h-3.5 w-3.5" />
            SlideFlow 安全分享
          </div>
          <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{resource.name}</h1>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="font-normal">{tag}</Badge>
                ))}
              </div>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              有效期至<br />{formatDate(data.expires_at)}
            </div>
          </div>
        </header>
        <main className="grid gap-6 p-5 sm:p-8 md:grid-cols-[minmax(0,1fr)_280px]">
          <div className="overflow-hidden rounded-xl bg-slate-950 p-3 sm:p-5">
            <img src={resource.preview_url} alt={resource.name} className="max-h-[70vh] w-full object-contain" />
          </div>
          <aside className="space-y-4">
            <section className="rounded-lg border p-4">
              <h2 className="text-sm font-semibold">分享范围</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                此链接仅提供当前素材的预览和基本信息，不包含 PPT 下载权限。
              </p>
              <div className="mt-4 space-y-2 text-xs text-muted-foreground">
                <div>主体：{resource.subject || "未设置"}</div>
                <div>版本：v{resource.version.version_no}</div>
                <div>更新时间：{formatDate(resource.updated_at)}</div>
              </div>
            </section>
            <section className="rounded-lg border bg-muted/30 p-4">
              <Button className="w-full justify-between" onClick={() => navigate(resource.detail_path)}>
                进入原素材
                <ArrowRight className="h-4 w-4" />
              </Button>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                进入后需要登录，并会校验你的素材查看权限。
              </p>
            </section>
            {resource.version.common_remark_html && (
              <section className="rounded-lg border p-4">
                <h2 className="mb-2 text-sm font-semibold">备注</h2>
                <div
                  className="prose prose-sm max-w-none text-sm"
                  dangerouslySetInnerHTML={{ __html: resource.version.common_remark_html }}
                />
              </section>
            )}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
              链接可由素材管理者随时撤销
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
}

export default ResourceDetailPage;

const REMARK_PREVIEW_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&#160;": " ",
  "&#xa0;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function remarkPreviewText(html: string) {
  return html
    .replace(/<br\s*\/?\s*>/gi, " " )
    .replace(/<\/(p|div|li|h[1-6])>/gi, " " )
    .replace(/<[^>]*>/g, " " )
    // Decode only the original matches, so &amp;lt; remains literal &lt; text.
    .replace(/&(?:nbsp|#160|#xa0|amp|lt|gt|quot|#39|apos);/gi, (entity) => REMARK_PREVIEW_ENTITIES[entity.toLowerCase()])
    .replace(/\s+/g, " " )
    .trim();
}
