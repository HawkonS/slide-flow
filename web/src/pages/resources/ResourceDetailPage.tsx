import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
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
  UserRound,
} from "lucide-react";
import { toast } from "sonner";

import { CommonRemarkView, PersonalRemarkEditor, resolveVersion } from "@/components/resource/ResourceDetailDialog";
import { ResourceDownloadDialog } from "@/components/resource/ResourceDownloadDialog";
import { ResourceEditDialog } from "@/components/resource/ResourceEditDialog";
import { ResourceNewVersionDialog } from "@/components/resource/ResourceNewVersionDialog";
import { ResourcePreviewDialog } from "@/components/resource/ResourcePreviewDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DEFAULT_RESOURCE_SUBJECT,
  RESOURCE_SCOPE_LABEL,
  RESOURCE_SECRECY_LABEL,
  RESOURCE_STATUS_LABEL,
  SECRECY_BADGE_TONE,
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

function ShareLinksPanel({ resource }: { resource: Resource }) {
  const queryClient = useQueryClient();
  const [days, setDays] = React.useState("7");
  const [createdLink, setCreatedLink] = React.useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["resource", resource.id, "share-links"],
    queryFn: () => api<{ items: ShareLinkItem[] }>(`/api/resources/${resource.id}/share-links`),
    enabled: resource.can_manage,
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
    <section className="border-b pb-5 pt-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Link2 className="h-4 w-4 text-foreground/70" />分享链接</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">仅管理者可创建。链接只展示预览和元数据，不授予 PPT 下载权限；可随时撤销。</p>
        </div>
        <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-600" />
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

  React.useEffect(() => {
    if (resource) setSelectedVersionId(resource.current?.id ?? null);
  }, [resource?.id, resource?.current?.id]);

  const version = resource ? resolveVersion(resource, selectedVersionId) : null;
  const currentPreview = version?.original_preview_url || version?.preview_url;
  const tags = resource ? parseTags(resource.tags) : [];
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
    <div className="mx-auto flex h-full w-full max-w-[1480px] flex-col overflow-auto pb-8">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b px-1 pb-5 pt-1 sm:px-2">
        <div className="flex min-w-0 items-start gap-3">
          <Button
            variant="outline"
            size="icon"
            className="mt-1 h-9 w-9 shrink-0"
            title="返回素材库"
            aria-label="返回素材库"
            onClick={() => navigate("/resources")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              <span>单页素材</span>
              <span aria-hidden="true">/</span>
              <span>详情</span>
            </div>
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="max-w-full truncate text-2xl font-semibold tracking-tight sm:text-[28px]">{resource.name}</h1>
              <Badge variant={SECRECY_BADGE_TONE[resource.secrecy_level] || "outline"}>
                {RESOURCE_SECRECY_LABEL[resource.secrecy_level]}
              </Badge>
              <Badge variant={resource.status === "active" ? "secondary" : "outline"}>
                {RESOURCE_STATUS_LABEL[resource.status]}
              </Badge>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>v{version?.version_no ?? "-"}</span>
              <span aria-hidden="true">·</span>
              <span>最后修改 {formatDate(resource.updated_at)}</span>
              {tags.length > 0 && (
                <span className="flex flex-wrap items-center gap-1.5">
                  {tags.map((tag) => <Badge key={tag} variant="outline" className="h-5 px-1.5 text-[10px] font-normal">{tag}</Badge>)}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void copyText(publicUrl)}>
            <Clipboard className="h-4 w-4" />复制页面 URL
          </Button>
          {resource.can_manage && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setEditOpen(true)}>
              <Pencil className="h-4 w-4" />编辑
            </Button>
          )}
          {resource.can_manage && (
            <Button size="sm" className="gap-1.5" onClick={() => setDownloadCtx({ resource, version: version! })} disabled={!version}>
              <Download className="h-4 w-4" />下载
            </Button>
          )}
        </div>
      </header>

      <main className="min-w-0 pt-5">
        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="flex min-h-[430px] min-w-0 flex-col overflow-hidden rounded-xl border bg-[#101827] shadow-sm xl:h-[calc(100vh-235px)] xl:max-h-[640px] xl:min-h-[430px]">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-xs text-slate-300 sm:px-5">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-slate-400" />
                <span className="font-medium text-slate-100">预览</span>
                <span className="text-slate-500">当前版本 v{version?.version_no ?? "-"}</span>
              </div>
              <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-slate-300 hover:bg-white/10 hover:text-white" onClick={() => setPreviewResource(resource)}>
                <Maximize className="h-3.5 w-3.5" />放大查看
              </Button>
            </div>
            <div className="relative flex min-h-0 flex-1 items-center justify-center bg-[#0b1220] p-4 sm:p-8">
              <div className="pointer-events-none absolute inset-4 border border-white/5 sm:inset-8" />
              {currentPreview ? (
                <img src={currentPreview} alt={resource.name} decoding="async" className="relative max-h-full max-w-full object-contain" />
              ) : (
                <div className="text-sm text-slate-400">暂无预览图</div>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-[#101827] px-4 py-3 sm:px-5">
              <div className="min-w-0 text-xs text-slate-400">
                <span className="text-slate-200">版本切换</span>
              </div>
              <Select value={String(version?.id ?? "")} onValueChange={(value) => setSelectedVersionId(Number(value))} disabled={(resource.versions?.length ?? 0) < 2}>
                <SelectTrigger className="h-8 w-full border-white/10 bg-white/5 text-xs text-slate-100 hover:bg-white/10 sm:w-[190px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(resource.versions ?? []).map((item) => (
                    <SelectItem key={item.id} value={String(item.id)}>
                      v{item.version_no}{item.id === resource.current.id ? "（当前）" : ""}{item.change_note ? ` · ${item.change_note}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </section>

          <aside className="min-w-0 divide-y rounded-xl border bg-card px-5">
            <section className="py-5 first:pt-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">素材信息</h2>
                </div>
                <span className="font-mono text-[11px] text-muted-foreground">#{resource.id}</span>
              </div>
              <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4">
                <ScopeLine label="主体" value={resource.subject || DEFAULT_RESOURCE_SUBJECT || "未设置"} />
                <ScopeLine label="所有者" value={resource.owner?.name || resource.owner?.username || "-"} />
                <ScopeLine label="可见范围" value={RESOURCE_SCOPE_LABEL[resource.visibility_scope] || resource.visibility_scope} />
                <ScopeLine label="管理范围" value={RESOURCE_SCOPE_LABEL[resource.management_scope] || resource.management_scope} />
              </dl>
              <div className="mt-5 flex items-start gap-2.5 rounded-md bg-emerald-50 px-3 py-2.5 text-xs leading-relaxed text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <span>查看权限与下载权限分离，下载仅对管理者开放。</span>
              </div>
            </section>

            <section className="py-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">版本信息</h2>
                  <p className="mt-1 text-xs text-muted-foreground">当前版本 v{version?.version_no ?? "-"}</p>
                </div>
                {resource.can_manage && (
                  <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setNewVersionOpen(true)}>
                    <RefreshCw className="h-3.5 w-3.5" />迭代
                  </Button>
                )}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-4">
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-muted-foreground" />
                  <div className="min-w-0"><dt className="text-[11px] text-muted-foreground">创建时间</dt><dd className="mt-0.5 truncate text-xs font-medium">{formatDate(version?.created_at)}</dd></div>
                </div>
                <div className="flex items-center gap-2">
                  <UserRound className="h-4 w-4 text-muted-foreground" />
                  <div className="min-w-0"><dt className="text-[11px] text-muted-foreground">最后修改</dt><dd className="mt-0.5 truncate text-xs font-medium">{formatDate(resource.updated_at)}</dd></div>
                </div>
              </dl>
              <div className="mt-4 border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">版本说明：</span>{version?.change_note || "暂无说明"}
              </div>
            </section>

            <section className="py-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-semibold"><Clipboard className="h-4 w-4 text-muted-foreground" />页面地址</h2>
                </div>
                <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" title="复制页面 URL" aria-label="复制页面 URL" onClick={() => void copyText(publicUrl)}><Copy className="h-3.5 w-3.5" /></Button>
              </div>
              <Input readOnly value={publicUrl} className="mt-3 h-9 min-w-0 bg-muted/30 text-xs" aria-label="素材页面地址" />
            </section>

            {resource.can_manage && <ShareLinksPanel resource={resource} />}
          </aside>
        </div>

        <section className="mt-7 border-t pt-6">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">备注</h2>
            </div>
            <span className="text-[11px] text-muted-foreground">v{version?.version_no ?? "-"}</span>
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <CommonRemarkView html={version?.common_remark_html || ""} />
            <PersonalRemarkEditor resourceId={resource.id} versionId={version?.id ?? null} open />
          </div>
        </section>
      </main>

      <ResourceEditDialog open={editOpen} onOpenChange={(open) => closeAndRefresh(open, setEditOpen)} resource={resource} tagSuggestions={tags} subjectSuggestions={resource.subject ? [resource.subject] : []} />
      <ResourceNewVersionDialog open={newVersionOpen} onOpenChange={(open) => closeAndRefresh(open, setNewVersionOpen)} resource={resource} />
      <ResourceDownloadDialog open={downloadCtx != null} onOpenChange={(open) => { if (!open) setDownloadCtx(null); }} resource={downloadCtx?.resource ?? null} version={downloadCtx?.version ?? null} />
      <ResourcePreviewDialog open={previewResource != null} onOpenChange={(open) => { if (!open) setPreviewResource(null); }} resource={previewResource} />
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
  if (!data) return <div className="flex min-h-screen items-center justify-center p-6"><div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm"><FileKey2 className="mx-auto h-8 w-8 text-muted-foreground" /><h1 className="mt-4 text-lg font-semibold">分享链接无效或已过期</h1><p className="mt-2 text-sm text-muted-foreground">链接可能已被撤销、素材已停用，或超过有效期。</p></div></div>;
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
                <Badge variant={SECRECY_BADGE_TONE[resource.secrecy_level] || "outline"}>
                  {RESOURCE_SECRECY_LABEL[resource.secrecy_level] || resource.secrecy_level}
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
