import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
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
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { CommonRemarkView, PersonalRemarkEditor, resolveVersion } from "@/components/resource/ResourceDetailDialog";
import { ResourceDownloadDialog } from "@/components/resource/ResourceDownloadDialog";
import { ResourceEditDialog } from "@/components/resource/ResourceEditDialog";
import { ResourceNewVersionDialog } from "@/components/resource/ResourceNewVersionDialog";
import { ResourcePreviewDialog } from "@/components/resource/ResourcePreviewDialog";
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
import { ApiError, api } from "@/lib/api";
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

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("zh-CN") : "-";
}

async function copyText(value: string, success = "已复制到剪贴板") {
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
  toast.success(success);
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
  const tags = parseTags(resource.tags);
  return (
    <Link
      to={`/resources/${resource.detail_token}`}
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
      <div className="p-3">
        <div className="truncate text-sm font-medium" title={resource.name}>{resource.name}</div>
        <div className="mt-2 flex min-h-5 items-center gap-1 overflow-hidden">
          {tags.length > 0 ? (
            <>
              {tags.slice(0, 2).map((tag) => (
                <span key={tag} className="max-w-24 truncate rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{tag}</span>
              ))}
              {tags.length > 2 && <span className="text-[10px] text-muted-foreground">+{tags.length - 2}</span>}
            </>
          ) : (
            <span className="truncate text-[11px] text-muted-foreground">{resource.subject || "未分类"}</span>
          )}
        </div>
      </div>
    </Link>
  );
}

function ShareLinksPanel({ resource, open }: { resource: Resource; open: boolean }) {
  const queryClient = useQueryClient();
  const [days, setDays] = React.useState("7");
  const [createdLink, setCreatedLink] = React.useState<string | null>(null);
  const { data, isLoading } = useQuery({
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
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">链接只展示预览和元数据，不授予 PPT 下载权限；你创建的链接可随时撤销。</p>
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
        {isLoading ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />加载分享链接…</div> : data?.items?.length ? data.items.map((item) => {
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: Resource;
  publicUrl: string;
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
                <p className="mt-1 text-xs text-muted-foreground">当前素材详情页</p>
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
  const queryClient = useQueryClient();
  const { resourceKey } = useParams();
  const validKey = Boolean(resourceKey && /^[A-Za-z0-9_-]{32,128}$/.test(resourceKey));
  const { data, isLoading, error } = useQuery({
    queryKey: ["resource-detail", resourceKey],
    queryFn: async () => (
      await api<{ resource: Resource }>(
        `/api/resources/by-key/${encodeURIComponent(resourceKey!)}`,
      )
    ).resource,
    enabled: validKey,
    retry: false,
  });
  const resource = data ?? null;
  const [selectedVersionId, setSelectedVersionId] = React.useState<number | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);
  const [newVersionOpen, setNewVersionOpen] = React.useState(false);
  const [downloadCtx, setDownloadCtx] = React.useState<{ resource: Resource; version: ResourceVersion } | null>(null);
  const [previewResource, setPreviewResource] = React.useState<Resource | null>(null);
  const [linksOpen, setLinksOpen] = React.useState(false);
  const [commonRemarkOpen, setCommonRemarkOpen] = React.useState(false);
  const [personalRemarkOpen, setPersonalRemarkOpen] = React.useState(false);

  React.useEffect(() => {
    if (resource) setSelectedVersionId(resource.current?.id ?? null);
  }, [resource?.id, resource?.current?.id]);

  const version = resource ? resolveVersion(resource, selectedVersionId) : null;
  const versionOptions = resource
    ? (resource.versions?.length ? resource.versions : [resource.current])
    : [];
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
  const secrecyLabel = resource?.secrecy_level || "";
  const statusLabel = resource?.status || "";
  const publicUrl = window.location.href;
  const closeAndRefresh = React.useCallback((open: boolean, setOpen: (value: boolean) => void) => {
    setOpen(open);
    if (!open && resource) {
      void queryClient.invalidateQueries({ queryKey: ["resource-detail", resourceKey] });
      void queryClient.invalidateQueries({ queryKey: ["resource", resource.id] });
    }
  }, [queryClient, resource, resourceKey]);

  if (!validKey) return <div className="mx-auto flex h-full w-full max-w-xl flex-col items-center justify-center gap-3 p-6 text-center"><FileKey2 className="h-8 w-8 text-muted-foreground" /><h1 className="text-lg font-semibold">素材不存在</h1><Button variant="outline" onClick={() => navigate("/resources")}><ArrowLeft className="mr-1.5 h-4 w-4" />返回素材库</Button></div>;
  if (isLoading) return <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />加载素材详情…</div>;
  if (!resource) {
    const status = error instanceof ApiError ? error.status : 0;
    return <div className="mx-auto flex h-full w-full max-w-xl flex-col items-center justify-center gap-3 p-6 text-center"><div className="rounded-full bg-destructive/10 p-3"><FileKey2 className="h-6 w-6 text-destructive" /></div><h1 className="text-lg font-semibold">{status === 403 ? "没有查看权限" : status === 404 ? "素材不存在" : "素材加载失败"}</h1><p className="text-sm text-muted-foreground">{status === 403 ? "该素材的可见范围不包含当前账号。" : "请返回素材库重试。"}</p><Button variant="outline" onClick={() => navigate("/resources")}><ArrowLeft className="mr-1.5 h-4 w-4" />返回素材库</Button></div>;
  }

  return (
    <div className="mx-auto min-h-full w-full max-w-[1600px] pb-8">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-1 py-2 sm:px-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            title="返回素材库"
            aria-label="返回素材库"
            onClick={() => navigate("/resources")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="max-w-full truncate text-xl font-semibold tracking-tight sm:text-2xl">{resource.name}</h1>
              {secrecyLabel && (
                <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                  {secrecyLabel}
                </Badge>
              )}
              {statusLabel && (
                <Badge variant={resource.status === "active" ? "secondary" : "outline"} className="h-5 px-1.5 text-[10px]">
                  {statusLabel}
                </Badge>
              )}
            </div>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border/70 px-2.5 text-muted-foreground shadow-none hover:text-foreground" onClick={() => setLinksOpen(true)}>
            <Link2 className="h-4 w-4" />链接与分享
          </Button>
          {resource.can_manage && (
            <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border/70 px-2.5 text-muted-foreground shadow-none hover:text-foreground" onClick={() => setNewVersionOpen(true)}>
              <RefreshCw className="h-4 w-4" />迭代
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
          <section className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b px-3 py-2 sm:px-4">
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Eye className="h-4 w-4" />
                <span className="font-medium text-foreground">预览</span>
                {tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                    {tag}
                  </Badge>
                ))}
              </div>
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" title="放大预览当前版本" onClick={() => setPreviewResource(version ? { ...resource, current: version } : resource)}>
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
          </section>

          <aside className="flex min-w-0 flex-col gap-3">
            <section className="rounded-lg border bg-card p-3 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">版本</h2>
                <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">
                  共 {versionOptions.length} 个版本
                </span>
              </div>
              <Select value={String(version?.id ?? "")} onValueChange={(value) => setSelectedVersionId(Number(value))}>
                <SelectTrigger className="mt-3 h-10 w-full border-border/70 bg-muted/30 px-3 text-sm font-medium hover:bg-muted/60" aria-label="切换版本">
                  <SelectValue placeholder="选择版本" />
                </SelectTrigger>
                <SelectContent>
                      {versionOptions.map((item) => (
                        <SelectItem key={item.id} value={String(item.id)}>
                          v{item.version_no}{item.id === resource.current.id ? "（当前）" : ""}{item.change_note ? ` · ${item.change_note}` : ""}
                        </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
      <ResourceLinksDialog open={linksOpen} onOpenChange={setLinksOpen} resource={resource} publicUrl={publicUrl} />
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
  secrecy_level: string;
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
                <Badge variant="outline">
                  {resource.secrecy_level}
                </Badge>
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

function hasRemarkHtml(html: string) {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;|&#xA0;|\s/gi, "").length > 0;
}

function remarkPreviewText(html: string) {
  return html
    .replace(/<br\s*\/?\s*>/gi, " " )
    .replace(/<\/(p|div|li|h[1-6])>/gi, " " )
    .replace(/<[^>]*>/g, " " )
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " " )
    .replace(/&amp;/gi, "&" )
    .replace(/&lt;/gi, "<" )
    .replace(/&gt;/gi, ">" )
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'" )
    .replace(/\s+/g, " " )
    .trim();
}
