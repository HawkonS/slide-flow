import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Layers,
  Loader2,
  Maximize,
  MonitorPlay,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useResponsiveGrid } from "@/lib/use-grid-layout";
import { useUrlPage } from "@/lib/use-url-page";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/common/PageHeader";
import { checkPwaUpdate, ensureOfflineShellReady, requestPwaInstall, usePwaStatus, type PwaStatusSnapshot } from "@/lib/pwa";
import {
  listCachedShows, getCachedAsset, downloadShow, deleteCachedShow, invalidateCachedShow,
  type CachedShow, type CacheProgress,
} from "@/lib/pwa-cache";
import {
  assertOfflineIdentity, createClientId, offlineOwnerKey, readOfflineIdentity, OFFLINE_SESSION_EVENT,
  type OfflineIdentity, type PwaChange,
} from "@/lib/offline-session";

interface OfflineVersionResponse {
  show_id: number;
  queried_show_id?: number;
  series_id?: string;
  version_no: number;
  updated_at: string;
  resource_versions: Record<string, number>;
  resource_updates?: Record<string, number>;
}

type UpdateStatus = "idle" | "checking" | "done" | "failed";
interface ShowUpdateInfo {
  hasUpdate: boolean;
  remoteVersion?: number;
  latestShowId?: number;
  resourceUpdateCount?: number;
  checking?: boolean;
  checkError?: string;
  updating?: boolean;
  cancelling?: boolean;
  error?: string;
  notice?: string;
  progress?: CacheProgress;
}

const PHASE_LABELS: Record<CacheProgress["phase"], string> = {
  preparing: "正在准备并校验授权", downloading: "正在下载高清图与缩略图",
  verifying: "正在校验文件与放映版本", ready: "缓存已就绪",
};
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, unit)).toFixed(unit ? 1 : 0) + " " + ["B", "KB", "MB", "GB"][unit];
}
function progressPercent(progress: CacheProgress): number {
  return progress.total > 0 ? Math.min(100, Math.round(progress.completed / progress.total * 100)) : 0;
}
function unavailableReason(entry: CachedShow, now: number): string | null {
  if (entry.revoked) return "离线授权已撤销，请联网重新下载";
  const expires = Date.parse(entry.expires_at);
  return !Number.isFinite(expires) || expires <= now ? "离线授权已到期，请联网重新下载" : null;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试";
}

function PwaDeploymentCard({ status }: { status: PwaStatusSnapshot }) {
  const [busy, setBusy] = useState(false);
  const tone = status.status === "deployed"
    ? "border-emerald-200/80 bg-emerald-50/60 dark:border-emerald-900/60 dark:bg-emerald-950/20"
    : status.status === "update-available"
      ? "border-amber-200/80 bg-amber-50/70 dark:border-amber-900/60 dark:bg-amber-950/20"
      : status.status === "error" || status.status === "unsupported"
        ? "border-destructive/30 bg-destructive/5"
        : "border-sky-200/80 bg-sky-50/60 dark:border-sky-900/60 dark:bg-sky-950/20";
  const iconTone = status.status === "deployed" ? "text-emerald-600" : status.status === "update-available" ? "text-amber-600" : "text-sky-600";
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try { await action(); toast.success(success); }
    catch (error) { toast.error(errorText(error)); }
    finally { setBusy(false); }
  };
  const title = status.status === "development"
    ? "开发环境未部署本地应用"
    : status.status === "deployed"
      ? "本地应用已部署"
      : status.status === "update-available"
        ? "本地应用有更新"
        : status.status === "checking"
          ? "正在检查本地应用"
          : status.status === "unsupported"
            ? "当前环境无法部署本地应用"
            : status.status === "error" ? "本地应用需要维护" : "本地应用尚未部署";
  return (
    <section className={cn("rounded-lg border p-4", tone)} aria-label="本地应用部署状态">
      <div className="flex flex-wrap items-start gap-3">
        <div className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-background/80", iconTone)}>
          {status.status === "deployed" ? <ShieldCheck className="h-5 w-5" /> : <Smartphone className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{title}</h2>
            {status.standalone && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">已安装到设备</span>}
            {status.controlled && <span className="rounded-full bg-background/80 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">当前页面已接管</span>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{status.message}</p>
          {status.environment === "development" && <p className="mt-1 text-xs text-muted-foreground">开发服务器只提供调试页面；发布构建后访问应用服务，才会部署可离线运行的本地应用。</p>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {status.installable && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(requestPwaInstall, "已提交本地应用安装")}>安装应用</Button>}
          {status.environment === "production" && status.status !== "unsupported" && (
            <Button size="sm" variant="outline" disabled={busy || status.status === "checking"} onClick={() => void run(checkPwaUpdate, "已检查本地应用更新")}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}检查更新
            </Button>
          )}
          {status.environment === "production" && (status.status === "error" || status.status === "not-deployed") && (
            <Button size="sm" disabled={busy} onClick={() => void run(ensureOfflineShellReady, "本地应用已准备就绪")}>重新部署</Button>
          )}
        </div>
      </div>
    </section>
  );
}

/* ---------- Filter Types ---------- */

interface OfflineFilters {
  query: string;
  subject: string;
  status: string;
  tags: string[];
  tagsMode: "any" | "all";
}

const DEFAULT_FILTERS: OfflineFilters = {
  query: "",
  subject: "all",
  status: "all",
  tags: [],
  tagsMode: "all",
};

/* ---------- Filter Options ---------- */

const OFFLINE_STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "active", label: "正常" },
  { value: "disabled", label: "停用" },
] as const;

/* ---------- FilterChip Component ---------- */

interface FilterOption {
  value: string;
  label: string;
}

function FilterChip({
  label,
  options,
  value,
  onChange,
  baseValue,
}: {
  label: string;
  options: readonly FilterOption[];
  value: string;
  onChange: (v: string) => void;
  baseValue?: string;
}) {
  const current = options.find((o) => o.value === value) || options[0];
  const base = baseValue ?? options[0]?.value;
  const dirty = current?.value !== base;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "group inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-sm transition",
            "hover:border-primary/40 hover:bg-primary/5",
            dirty && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          <span className={cn("text-muted-foreground", dirty && "text-primary/80")}>
            {label}
          </span>
          <span className="font-medium">{current?.label ?? ""}</span>
          <ChevronDown
            className={cn("h-3.5 w-3.5 opacity-60 transition", dirty && "opacity-80")}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-1" align="start">
        <div className="max-h-72 overflow-auto">
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChange(opt.value)}
                className={cn(
                  "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm transition hover:bg-accent",
                  active && "text-primary",
                )}
              >
                <span className="truncate">{opt.label}</span>
                {active && <Check className="h-3.5 w-3.5" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TagFilterChip({
  label,
  emptyText = "暂无数据",
  tags,
  selected,
  mode,
  onToggle,
  onClear,
  onChangeMode,
}: {
  label: string;
  emptyText?: string;
  tags: string[];
  selected: string[];
  mode: "any" | "all";
  onToggle: (t: string) => void;
  onClear: () => void;
  onChangeMode: (v: "any" | "all") => void;
}) {
  const dirty = selected.length > 0;
  const modeLabel = mode === "all" ? "与" : "或";
  const summary =
    selected.length === 0
      ? "全部"
      : selected.length === 1
        ? selected[0]
        : `${modeLabel} · 已选 ${selected.length} 项`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-sm transition",
            "hover:border-primary/40 hover:bg-primary/5",
            dirty && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          <span className={cn("text-muted-foreground", dirty && "text-primary/80")}>{label}</span>
          <span className="font-medium">{summary}</span>
          <ChevronDown className={cn("h-3.5 w-3.5 opacity-60", dirty && "opacity-80")} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-1" align="start">
        <div className="mb-1 border-b px-1 pb-2 pt-1">
          <div className="mb-1 text-xs text-muted-foreground">匹配方式</div>
          <div className="grid grid-cols-2 gap-1">
            {([
              { v: "all", label: "与（全部满足）" },
              { v: "any", label: "或（任一满足）" },
            ] as const).map((it) => {
              const active = it.v === mode;
              return (
                <button
                  key={it.v}
                  type="button"
                  onClick={() => onChangeMode(it.v)}
                  className={cn(
                    "h-7 rounded-md border text-xs transition",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "bg-background hover:border-primary/40 hover:bg-primary/5",
                  )}
                >
                  {it.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="max-h-72 overflow-auto">
          {tags.length === 0 ? (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground">{emptyText}</div>
          ) : (
            tags.map((tag) => {
              const checked = selected.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => onToggle(tag)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <Checkbox checked={checked} className="pointer-events-none" />
                  <span className="flex-1 truncate text-left">{tag}</span>
                </button>
              );
            })
          )}
        </div>
        {selected.length > 0 && (
          <div className="flex justify-end border-t pt-1">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClear}>
              清空
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/* ---------- Thumbnail Hook ---------- */

function useCoverThumbnail(entry: CachedShow, now: number): string | null {
  const [image, setImage] = useState<{ packageId: string; owner: string; url: string } | null>(null);
  const valid = !unavailableReason(entry, now);
  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    setImage(null);
    const identity = readOfflineIdentity();
    if (!valid || !identity || offlineOwnerKey(identity) !== entry.owner_key) return;
    void getCachedAsset(entry.package_id, 0, "thumb").then(blob => {
      if (disposed) return;
      assertOfflineIdentity(identity);
      objectUrl = URL.createObjectURL(blob);
      setImage({ packageId: entry.package_id, owner: entry.owner_key, url: objectUrl });
    }).catch(() => { /* Expired, revoked, or missing thumbnails use the fallback. */ });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [entry.package_id, entry.owner_key, valid]);
  return valid && image?.packageId === entry.package_id && image.owner === entry.owner_key ? image.url : null;
}

/* ---------- CacheCard Component ---------- */

interface CacheCardProps {
  showId: string;
  entry: CachedShow;
  now: number;
  canDownload: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onCheck: () => void;
  updateInfo?: ShowUpdateInfo;
  onFullscreen: () => void;
  onPresent: () => void;
  onDelete: () => void;
}

function CacheCard({
  showId,
  entry,
  now, canDownload, onDownload, onCancel, onCheck,
  updateInfo,
  onFullscreen,
  onPresent,
  onDelete,
}: CacheCardProps) {
  const thumbUrl = useCoverThumbnail(entry, now);
  const isUpdating = updateInfo?.updating;
  const hasUpdate = updateInfo?.hasUpdate;
  const progress = updateInfo?.progress;
  const unavailable = unavailableReason(entry, now);

  return (
    <article data-slot="card" data-show-id={showId} className="group relative flex flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      {/* 16:9 Preview area */}
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted">
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={entry.name}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Layers className="h-8 w-8" />
          </div>
        )}

        {/* Version badge - top left */}
        <span className="absolute left-2 top-2 inline-flex items-center rounded bg-black/50 px-1.5 py-0.5 text-[11px] font-medium text-white">
          v{entry.version_no}
        </span>

        {/* Update badge - if there's an update available */}
        {hasUpdate && (
          <span className="absolute right-10 top-2 inline-flex items-center rounded bg-amber-500/90 px-1.5 py-0.5 text-[11px] font-medium text-white">
            有更新
          </span>
        )}

        {/* Progress overlay during update */}
        {isUpdating && progress && (
          <div className="absolute inset-x-0 bottom-0 bg-black/60 px-2 py-1">
            <div className="h-1 overflow-hidden rounded-full bg-white/30">
              <div
                className="h-full rounded-full bg-white transition-all duration-300"
                style={{ width: `${progressPercent(progress)}%` }}
              />
            </div>
            <div className="mt-0.5 text-center text-[10px] text-white/80">
              {PHASE_LABELS[progress.phase]} · {progress.completed}/{progress.total} · {formatBytes(progress.bytes)}
            </div>
          </div>
        )}

        {/* Top-right dropdown menu (delete) - appears on hover */}
        {(
          <div className="absolute right-2 top-2 opacity-100 transition">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="更多操作"
                  disabled={isUpdating}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background/90 text-foreground shadow-sm transition hover:bg-background disabled:pointer-events-none disabled:opacity-50"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onCheck} disabled={!canDownload || isUpdating || updateInfo?.checking}>
                  <RefreshCw className="mr-2 h-4 w-4" />检查更新
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onDownload} disabled={!canDownload || isUpdating}>重新下载</DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={onDelete}
                  disabled={isUpdating}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  删除缓存
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {/* Title area */}
      <div className="px-3 pt-2.5">
        <h3 className="line-clamp-1 text-[13px] font-medium">{entry.name}</h3>
        <p className="mt-1 text-[11px] text-muted-foreground">{entry.resources.length} 页 · {formatBytes(entry.total_bytes)}</p>
        <p className={cn("mt-0.5 text-[11px]", unavailable ? "text-amber-700" : "text-muted-foreground")}>
          {unavailable || "授权有效至 " + new Date(entry.expires_at).toLocaleString("zh-CN", { hour12: false })}
        </p>
        {updateInfo?.checking && <p role="status" className="mt-1 text-xs text-muted-foreground">正在检查更新…</p>}
        {updateInfo?.checkError && <p role="alert" className="mt-1 text-xs text-destructive">检查更新失败：{updateInfo.checkError}</p>}
        {!!updateInfo?.resourceUpdateCount && <p role="status" className="mt-1 text-xs text-muted-foreground">有 {updateInfo.resourceUpdateCount} 个素材新版，需先迭代发布放映；重新下载不会升级素材。</p>}
        {updateInfo?.error && <p role="alert" className="mt-1 text-xs text-destructive">{updateInfo.error}</p>}
        {updateInfo?.notice && <p role="status" className="mt-1 text-xs text-muted-foreground">{updateInfo.notice}</p>}
        {(isUpdating || hasUpdate || unavailable || updateInfo?.error || updateInfo?.notice || updateInfo?.checkError) && (
          <div className="mt-1 flex flex-wrap gap-1">
            {isUpdating ? <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onCancel} disabled={updateInfo?.cancelling}>
              {updateInfo?.cancelling ? "正在取消…" : "取消下载"}
            </Button> : <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onDownload} disabled={!canDownload}>
              {updateInfo?.error || updateInfo?.notice ? "重试下载" : hasUpdate ? "下载更新" : "重新下载"}
            </Button>}
            {updateInfo?.checkError && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCheck} disabled={!canDownload || isUpdating}>重试检查</Button>}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="mt-1.5 flex items-center gap-1 border-t bg-muted/30 px-2 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onFullscreen}
          disabled={isUpdating || !!unavailable}
          className="h-7 flex-1 gap-1 px-1.5 text-[11px] font-normal"
          title="全屏放映"
        >
          <Maximize className="h-3 w-3 shrink-0" />
          <span className="truncate">全屏放映</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onPresent}
          disabled={isUpdating || !!unavailable}
          className="h-7 flex-1 gap-1 px-1.5 text-[11px] font-normal"
          title="讲演视图"
        >
          <MonitorPlay className="h-3 w-3 shrink-0" />
          <span className="truncate">讲演视图</span>
        </Button>
      </div>
    </article>
  );
}

/* ---------- Main Component ---------- */

export default function OfflineCachePage() {
  const navTitle = "离线缓存";
  const auth = useAuth();
  const pwaStatus = usePwaStatus();
  const ownerKey = auth.identity ? offlineOwnerKey(auth.identity) : "";
  const [supported] = useState(() => window.isSecureContext && "serviceWorker" in navigator && "indexedDB" in window && "caches" in window);
  const [online, setOnline] = useState(navigator.onLine);
  const [cacheState, setCacheState] = useState<{ owner: string; entries: CachedShow[] }>({ owner: "", entries: [] });
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [storage, setStorage] = useState<StorageEstimate | null>(null);
  const [now, setNow] = useState(Date.now);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [showUpdates, setShowUpdates] = useState<Record<string, ShowUpdateInfo>>({});
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [updatesDialogOpen, setUpdatesDialogOpen] = useState(false);
  const [filters, setFilters] = useState<OfflineFilters>(DEFAULT_FILTERS);
  const mounted = React.useRef(false);
  const ownerRef = React.useRef(ownerKey);
  ownerRef.current = ownerKey;
  const listRequest = React.useRef(0);
  const batchRequest = React.useRef(0);
  const bulkRequest = React.useRef(0);
  const allChecking = React.useRef(false);
  const checks = React.useRef(new Map<string, AbortController>());
  const downloads = React.useRef(new Map<string, AbortController>());
  const invalidPackages = React.useRef(new Map<string, "revoked" | "deleted">());
  const cachedShows = useMemo(() => cacheState.owner === ownerKey ? cacheState.entries : [], [cacheState, ownerKey]);
  const entriesRef = React.useRef(cachedShows);
  entriesRef.current = cachedShows;
  const canDownload = online && !auth.offline && !!ownerKey;
  const networkRef = React.useRef(canDownload);
  networkRef.current = canDownload;

  const isCurrent = useCallback((identity: OfflineIdentity | null): identity is OfflineIdentity => {
    if (!mounted.current || !identity || ownerRef.current !== offlineOwnerKey(identity)) return false;
    try { assertOfflineIdentity(identity); return true; } catch { return false; }
  }, []);
  const abortWork = useCallback(() => {
    for (const controller of checks.current.values()) controller.abort();
    for (const controller of downloads.current.values()) controller.abort();
    checks.current.clear(); downloads.current.clear();
    batchRequest.current++; bulkRequest.current++; allChecking.current = false;
  }, []);
  const refreshCaches = useCallback(async () => {
    const identity = readOfflineIdentity();
    const request = ++listRequest.current;
    if (!isCurrent(identity)) { if (mounted.current) setLoading(false); return; }
    try {
      const [entries, estimate] = await Promise.all([
        listCachedShows(),
        navigator.storage?.estimate ? navigator.storage.estimate().catch(() => undefined) : Promise.resolve(undefined),
      ]);
      if (!isCurrent(identity) || request !== listRequest.current) return;
      setCacheState({ owner: offlineOwnerKey(identity), entries: entries
        .filter(entry => invalidPackages.current.get(entry.package_id) !== "deleted")
        .map(entry => ({ ...entry, revoked: entry.revoked || invalidPackages.current.get(entry.package_id) === "revoked" })) });
      setStorage(estimate ?? null); setListError(null); setNow(Date.now());
    } catch (error) {
      if (isCurrent(identity) && request === listRequest.current) setListError(errorText(error));
    } finally { if (isCurrent(identity) && request === listRequest.current) setLoading(false); }
  }, [isCurrent]);

  useEffect(() => {
    mounted.current = true;
    abortWork(); invalidPackages.current.clear();
    setCacheState({ owner: ownerKey, entries: [] }); setShowUpdates({}); setUpdateStatus("idle");
    setDeleteConfirm(null); setDeleting(null); setUpdatesDialogOpen(false); setListError(null); setLoading(supported);
    if (supported && ownerKey) {
      void refreshCaches();
    } else setLoading(false);
    const sessionChanged = () => {
      const identity = readOfflineIdentity();
      if (!identity || offlineOwnerKey(identity) !== ownerRef.current) {
        abortWork(); listRequest.current++;
        setCacheState({ owner: "", entries: [] }); setShowUpdates({});
        setUpdateStatus("idle"); setDeleteConfirm(null); setUpdatesDialogOpen(false);
      } else void refreshCaches();
    };
    const cacheChanged = (event: Event) => {
      const detail = (event as CustomEvent<PwaChange & { showId?: number }>).detail;
      if (detail?.ownerKey && detail.ownerKey !== ownerRef.current) return;
      if (detail?.ownerKey === ownerRef.current && detail.showId && detail.reason) {
        for (const entry of entriesRef.current) if (entry.show_id === detail.showId) invalidPackages.current.set(entry.package_id, detail.reason);
        setCacheState(previous => ({ ...previous, entries: previous.entries
          .filter(entry => invalidPackages.current.get(entry.package_id) !== "deleted")
          .map(entry => ({ ...entry, revoked: entry.revoked || invalidPackages.current.get(entry.package_id) === "revoked" })) }));
      }
      setUpdateStatus(previous => previous === "checking" ? previous : "idle");
      void refreshCaches();
    };
    const connectionChanged = () => { setOnline(navigator.onLine); setUpdateStatus("idle"); };
    const clockChanged = () => setNow(Date.now());
    window.addEventListener(OFFLINE_SESSION_EVENT, sessionChanged);
    window.addEventListener("slideflow-pwa-change", cacheChanged);
    window.addEventListener("online", connectionChanged); window.addEventListener("offline", connectionChanged);
    window.addEventListener("focus", clockChanged);
    return () => {
      mounted.current = false; listRequest.current++; abortWork();
      window.removeEventListener(OFFLINE_SESSION_EVENT, sessionChanged);
      window.removeEventListener("slideflow-pwa-change", cacheChanged);
      window.removeEventListener("online", connectionChanged); window.removeEventListener("offline", connectionChanged);
      window.removeEventListener("focus", clockChanged);
    };
  }, [ownerKey, auth.epoch, supported, abortWork, isCurrent, refreshCaches]);
  useEffect(() => {
    const nextExpiry = Math.min(...cachedShows.map(entry => Date.parse(entry.expires_at)).filter(expiry => expiry > now));
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(1, nextExpiry - Date.now() + 10)));
    return () => window.clearTimeout(timer);
  }, [cachedShows, now]);

  const checkShowUpdate = useCallback(async (showId: string): Promise<"update" | "current" | "failed" | "resource-hint" | "stale"> => {
    const identity = readOfflineIdentity();
    const entry = entriesRef.current.find(item => String(item.show_id) === showId);
    if (!isCurrent(identity) || !entry || !networkRef.current || !navigator.onLine) return "stale";
    if (!allChecking.current) setUpdateStatus("idle");
    checks.current.get(showId)?.abort();
    const controller = new AbortController();
    checks.current.set(showId, controller);
    const active = () => isCurrent(identity) && checks.current.get(showId) === controller;
    const timer = window.setTimeout(() => controller.abort(new DOMException("检查更新超时，请重试", "TimeoutError")), 30_000);
    setShowUpdates(previous => ({ ...previous, [showId]: { ...previous[showId], hasUpdate: previous[showId]?.hasUpdate ?? false, checking: true, checkError: undefined } }));
    try {
      const data = await api<OfflineVersionResponse>("/api/shows/" + showId + "/offline-version", { signal: controller.signal, cache: "no-store" });
      if (!active()) return "stale";
      if (entriesRef.current.find(item => item.show_id === entry.show_id)?.package_id !== entry.package_id) throw new Error("缓存已变化，请重新检查");
      if (!data || !Number.isSafeInteger(data.show_id) || data.show_id < 1 || !Number.isSafeInteger(data.version_no) || data.version_no < 1
          || !data.resource_versions || typeof data.resource_versions !== "object" || Array.isArray(data.resource_versions)
          || Object.entries(data.resource_versions).some(([id, version]) => !Number.isSafeInteger(Number(id)) || Number(id) < 1 || !Number.isSafeInteger(version) || version < 1)
          || (data.resource_updates !== undefined && (!data.resource_updates || typeof data.resource_updates !== "object" || Array.isArray(data.resource_updates)
            || Object.entries(data.resource_updates).some(([id, version]) => !Number.isSafeInteger(Number(id)) || Number(id) < 1
              || !Number.isSafeInteger(version) || typeof data.resource_versions[id] !== "number" || version <= data.resource_versions[id])))
          || (data.queried_show_id !== undefined && data.queried_show_id !== entry.show_id)
          || (data.series_id !== undefined && data.series_id !== entry.series_id)) throw new Error("服务器返回的版本信息无效");
      const versions = new Map(entry.resources.map(resource => [String(resource.id), resource.version_no]));
      const resourceChanged = Object.keys(data.resource_versions).length !== versions.size
        || Object.entries(data.resource_versions).some(([id, version]) => versions.get(id) !== version);
      const hasUpdate = data.show_id !== entry.show_id || data.version_no !== entry.version_no
        || data.updated_at !== entry.updated_at || resourceChanged || !!unavailableReason(entry, Date.now());
      const resourceUpdateCount = Object.keys(data.resource_updates ?? {}).length;
      setShowUpdates(previous => ({ ...previous, [showId]: { ...previous[showId], hasUpdate, remoteVersion: data.version_no, latestShowId: data.show_id, resourceUpdateCount, checking: false, checkError: undefined } }));
      return hasUpdate ? "update" : resourceUpdateCount ? "resource-hint" : "current";
    } catch (failure) {
      if (!active()) return "stale";
      let error = failure;
      if (failure instanceof ApiError && [403, 404, 410].includes(failure.status)) {
        try { await invalidateCachedShow(entry.show_id, identity); }
        catch (invalidationError) { error = invalidationError; }
      }
      if (!active()) return "stale";
      const message = controller.signal.aborted ? errorText(controller.signal.reason) : errorText(error);
      setShowUpdates(previous => ({ ...previous, [showId]: { ...previous[showId], hasUpdate: previous[showId]?.hasUpdate ?? false, checking: false, checkError: message } }));
      return "failed";
    } finally {
      window.clearTimeout(timer);
      if (checks.current.get(showId) === controller) checks.current.delete(showId);
    }
  }, [isCurrent]);

  const checkAllUpdates = useCallback(async () => {
    const identity = readOfflineIdentity();
    if (!isCurrent(identity) || !networkRef.current || allChecking.current || downloads.current.size) return;
    const entries = [...entriesRef.current];
    if (!entries.length) return;
    const request = ++batchRequest.current;
    allChecking.current = true; setUpdateStatus("checking");
    let updates = 0;
    let resourceHints = 0;
    let failures = 0;
    try {
      for (const entry of entries) {
        if (!isCurrent(identity) || request !== batchRequest.current) return;
        const result = await checkShowUpdate(String(entry.show_id));
        if (result === "update") updates++;
        else if (result === "resource-hint") resourceHints++;
        else if (result !== "current") failures++;
      }
      if (!isCurrent(identity) || request !== batchRequest.current) return;
      setUpdateStatus(failures ? "failed" : "done");
      if (failures) toast.error("部分缓存检查更新失败，请重试；已有完整缓存仍保留");
      else if (!updates && resourceHints) toast.info("放映缓存已同步；素材新版需先迭代发布放映");
      else if (!updates) toast.success("全部已是最新版本");
      if (updates) setUpdatesDialogOpen(true);
    } finally { if (request === batchRequest.current) allChecking.current = false; }
  }, [checkShowUpdate, isCurrent]);

  const downloadItem = useCallback(async (key: string, showId: number) => {
    const identity = readOfflineIdentity();
    if (!isCurrent(identity) || !networkRef.current || !navigator.onLine || downloads.current.has(key)) return;
    checks.current.get(key)?.abort(); checks.current.delete(key);
    const controller = new AbortController();
    downloads.current.set(key, controller);
    const active = () => isCurrent(identity) && downloads.current.get(key) === controller;
    setUpdateStatus("idle");
    setShowUpdates(previous => ({ ...previous, [key]: { ...previous[key], hasUpdate: previous[key]?.hasUpdate ?? false,
      checking: false, checkError: undefined, updating: true, cancelling: false, error: undefined, notice: undefined,
      progress: { phase: "preparing", completed: 0, total: 0, bytes: 0 } } }));
    try {
      const entry = await downloadShow(showId, { signal: controller.signal, onProgress: progress => {
        if (active()) setShowUpdates(previous => ({ ...previous, [key]: { ...previous[key], progress } }));
      } });
      if (!active()) return;
      setShowUpdates(previous => ({ ...previous, [key]: { ...previous[key], hasUpdate: false, updating: false, cancelling: false, error: undefined, notice: undefined } }));
      await refreshCaches();
      if (active()) toast.success("「" + entry.name + "」缓存完成");
    } catch (failure) {
      if (!active()) return;
      let error = failure;
      // The cache core already handles 403/404; explicit expiry denial is also definitive.
      if (failure instanceof ApiError && failure.status === 410) {
        try { await invalidateCachedShow(showId, identity); }
        catch (invalidationError) { error = invalidationError; }
      }
      if (!active()) return;
      const cancelled = controller.signal.aborted || (failure instanceof DOMException && failure.name === "AbortError");
      setShowUpdates(previous => ({ ...previous, [key]: { ...previous[key], updating: false, cancelling: false,
        notice: cancelled ? "本次下载已取消，原完整缓存仍保留。" : undefined,
        error: cancelled ? undefined : errorText(error) } }));
      await refreshCaches();
    } finally { if (downloads.current.get(key) === controller) downloads.current.delete(key); }
  }, [isCurrent, refreshCaches]);
  const cancelDownload = useCallback((key: string) => {
    const controller = downloads.current.get(key);
    if (!controller) return;
    bulkRequest.current++;
    setShowUpdates(previous => ({ ...previous, [key]: { ...previous[key], cancelling: true } }));
    controller.abort();
  }, []);
  const updateShow = useCallback((showId: string, entry: CachedShow) =>
    downloadItem(showId, showUpdates[showId]?.latestShowId ?? entry.show_id), [downloadItem, showUpdates]);

  const handleDelete = useCallback(async (showId: string) => {
    const identity = readOfflineIdentity();
    if (!isCurrent(identity) || deleting || downloads.current.has(showId)) return;
    setDeleting(showId);
    checks.current.get(showId)?.abort(); checks.current.delete(showId);
    try {
      await deleteCachedShow(Number(showId));
      if (!isCurrent(identity)) return;
      setDeleteConfirm(null); setUpdateStatus("idle");
      setShowUpdates(previous => { const next = { ...previous }; delete next[showId]; return next; });
      await refreshCaches();
      if (isCurrent(identity)) toast.success("缓存已删除");
    } catch (error) { if (isCurrent(identity)) toast.error("删除失败：" + errorText(error)); }
    finally { if (isCurrent(identity)) setDeleting(null); }
  }, [deleting, isCurrent, refreshCaches]);

  const startPlayback = useCallback((entry: CachedShow, presenter: boolean) => {
    const identity = readOfflineIdentity();
    if (!isCurrent(identity) || entry.owner_key !== offlineOwnerKey(identity)
        || entriesRef.current.find(item => item.show_id === entry.show_id)?.package_id !== entry.package_id) return;
    const reason = unavailableReason(entry, Date.now());
    if (reason) { toast.error(reason); return; }
    const params = new URLSearchParams({ offline: "true", package_id: entry.package_id, source: "cache" });
    if (!presenter) {
      window.open("/shows/" + entry.show_id + "/fullscreen?" + params.toString(), "_blank", "popup=yes,width=1920,height=1080");
      return;
    }
    const session = createClientId();
    params.set("playback_session", session);
    // Keep this synchronous with the click so the paired display retains user activation.
    window.open("/shows/" + entry.show_id + "/display?" + params.toString(), "slideflow-display-" + session, "popup=yes,width=1920,height=1080");
    window.location.href = "/shows/" + entry.show_id + "/present?" + params.toString();
  }, [isCurrent]);

  const shows = useMemo<Array<[string, CachedShow]>>(() => cachedShows.map(entry => [String(entry.show_id), entry]), [cachedShows]);
  const entriesMap = useMemo(() => Object.fromEntries(shows), [shows]);
  const cachedBytes = cachedShows.reduce((sum, entry) => sum + entry.total_bytes, 0);
  const anyDownloading = Object.values(showUpdates).some(info => info.updating);

  // Extract subjects and tags from manifest data
  const { subjects, tags } = useMemo(() => {
    const subjectSet = new Set<string>();
    const tagSet = new Set<string>();
    shows.forEach(([, entry]) => {
      if (entry.subject) subjectSet.add(entry.subject.trim());
      if (entry.tags) entry.tags.forEach((t) => tagSet.add(t));
    });
    return {
      subjects: Array.from(subjectSet).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
      tags: Array.from(tagSet).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    };
  }, [shows]);

  // Subject options for filter
  const subjectOptions = useMemo<FilterOption[]>(() => {
    return [{ value: "all", label: "全部" }, ...subjects.map((x) => ({ value: x, label: x }))];
  }, [subjects]);

  // Filtered shows
  const filtered = useMemo(() => {
    const q = filters.query.trim().toLowerCase();
    return shows.filter(([, entry]) => {
      // Tag filter
      const eTags = new Set(entry.tags || []);
      if (filters.tags.length > 0) {
        if (filters.tagsMode === "all") {
          if (!filters.tags.every((t) => eTags.has(t))) return false;
        } else {
          if (!filters.tags.some((t) => eTags.has(t))) return false;
        }
      }

      // Subject filter
      if (filters.subject !== "all") {
        const entrySubject = entry.subject || "";
        if (entrySubject !== filters.subject) return false;
      }

      // Status filter
      if (filters.status !== "all") {
        const entryStatus = entry.status || "active";
        if (entryStatus !== filters.status) return false;
      }

      // Search query
      if (q) {
        const hay = [entry.name, entry.subject || "", entry.owner_name || ""]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }

      return true;
    });
  }, [shows, filters]);

  // Pagination: dynamic grid sizing
  const contentRef = React.useRef<HTMLDivElement>(null);
  const { pageSize, gridStyle } = useResponsiveGrid(contentRef, { titleHeight: 132 });

  const [page, setPage] = useUrlPage();
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  useEffect(() => {
    if (!loading && page > totalPages) setPage(1);
  }, [page, totalPages, loading, setPage]);
  const previousFilters = React.useRef(filters);
  useEffect(() => {
    if (previousFilters.current !== filters) { previousFilters.current = filters; setPage(1); }
  }, [filters, setPage]);
  const pageStart = (page - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);

  // Filter helpers
  const isDirty =
    filters.query.trim() !== "" ||
    filters.status !== "all" ||
    filters.subject !== "all" ||
    filters.tags.length > 0;

  const resetFilters = () => setFilters(DEFAULT_FILTERS);
  const toggleTag = (t: string) => {
    setFilters((f) => ({
      ...f,
      tags: f.tags.includes(t) ? f.tags.filter((x) => x !== t) : [...f.tags, t],
    }));
  };

  if (!supported) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
        <AlertTriangle className="h-12 w-12 text-yellow-500" />
        <h1 className="text-xl font-semibold">{window.isSecureContext ? "浏览器不支持离线应用" : "需要安全连接"}</h1>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          {window.isSecureContext ? "请使用支持 Service Worker、IndexedDB 和 Cache Storage 的浏览器，并允许本地存储。" : "离线缓存需要通过 HTTPS 或本机 localhost 访问本站。"}
        </p>
      </div>
    );
  }

  const updatesAvailableCount = Object.values(showUpdates).filter((s) => s.hasUpdate).length;
  const resourceHintsCount = Object.values(showUpdates).filter((s) => !!s.resourceUpdateCount).length;

  return (
    <div className="page-shell">
      <PageHeader
        title={navTitle}
        titleExtra={<span className="text-xs text-muted-foreground">当前浏览器 · {auth.user?.name || auth.user?.username || "当前账号"}</span>}
        count={filtered.length === shows.length ? "共 " + shows.length + " 条" : "筛选后 " + filtered.length + " / " + shows.length + " 条"}
        description={"当前账号缓存 " + formatBytes(cachedBytes) + (storage?.quota !== undefined
          ? " · 此站点可用空间约 " + formatBytes(Math.max(0, storage.quota - (storage.usage || 0)))
          : " · 浏览器暂未提供容量估计") + "。缓存受授权有效期限制，退出账号后不可使用。"}
      />
      <PwaDeploymentCard status={pwaStatus} />
      {!canDownload && <p role="status" className="text-xs text-amber-700">{!online ? "当前设备已离线，可播放仍在有效期内的完整缓存；连接网络后可检查和更新。" : "当前为离线登录状态，请联网重新验证登录后下载或检查更新。"}</p>}
      {listError && <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 p-3 text-sm text-destructive">
        <span>读取缓存失败：{listError}</span><Button variant="outline" size="sm" onClick={() => void refreshCaches()}>重新读取</Button>
      </div>}

      {/* Filters bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filters.query}
            onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
            placeholder="搜索名称、关键词"
            className={cn(
              "h-8 w-full rounded-md border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition sm:w-56",
              "placeholder:text-muted-foreground",
              "focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              filters.query.trim() !== "" && "border-primary/40 bg-primary/5",
            )}
          />
        </div>
        <FilterChip
          label="状态"
          options={OFFLINE_STATUS_OPTIONS}
          value={filters.status}
          onChange={(v) => setFilters((f) => ({ ...f, status: v }))}
        />
        {subjects.length > 0 && (
          <FilterChip
            label="主体"
            options={subjectOptions}
            value={filters.subject}
            onChange={(v) => setFilters((f) => ({ ...f, subject: v }))}
          />
        )}
        {tags.length > 0 && (
          <TagFilterChip
            label="标签"
            emptyText="暂无标签"
            tags={tags}
            selected={filters.tags}
            mode={filters.tagsMode}
            onToggle={toggleTag}
            onClear={() => setFilters((f) => ({ ...f, tags: [] }))}
            onChangeMode={(v) => setFilters((f) => ({ ...f, tagsMode: v }))}
          />
        )}

        {isDirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={resetFilters}
            className="h-8 gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            重置筛选
          </Button>
        )}

        {/* Right actions */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {updateStatus === "checking" && <span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在检查…</span>}
          {updateStatus === "failed" && <span role="alert" className="text-xs text-destructive">检查更新失败，请重试</span>}
          {updateStatus === "done" && updatesAvailableCount > 0 && <button type="button" className="text-xs text-amber-700" onClick={() => setUpdatesDialogOpen(true)}>{updatesAvailableCount} 个需要更新</button>}
          {updateStatus === "done" && updatesAvailableCount === 0 && <span role="status" className="flex items-center gap-1.5 text-xs text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" />{resourceHintsCount ? "放映缓存已同步 · 素材需迭代" : "全部最新"}</span>}
          {shows.length > 0 && <Button variant="outline" size="sm" onClick={() => void checkAllUpdates()} disabled={!canDownload || updateStatus === "checking" || anyDownloading} className="h-8 gap-1.5 px-3 text-sm">
            <RefreshCw className={cn("h-3.5 w-3.5", updateStatus === "checking" && "animate-spin")} />检查全部更新
          </Button>}
        </div>
      </div>

      {/* Content area */}
      <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
        {loading ? <div role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />正在读取缓存…</div>
          : filtered.length === 0 ? (
            <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">
              {shows.length === 0 ? "暂无离线缓存。联网后可从放映详情下载到此浏览器。" : "没有匹配的缓存项"}
            </div>
          ) : (
            <div className="grid content-start" style={gridStyle}>
              {pageItems.map(([showId, entry]) => <CacheCard
                key={entry.package_id}
                showId={showId}
                entry={entry}
                now={now}
                canDownload={canDownload}
                updateInfo={showUpdates[showId]}
                onFullscreen={() => startPlayback(entry, false)}
                onPresent={() => startPlayback(entry, true)}
                onDownload={() => void updateShow(showId, entry)}
                onCancel={() => cancelDownload(showId)}
                onCheck={() => void checkShowUpdate(showId)}
                onDelete={() => setDeleteConfirm(showId)}
              />)}
            </div>
          )}
      </div>

      {/* Pagination */}
      {filtered.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t pt-3 text-sm text-muted-foreground select-none">
          <span>
            显示 {pageStart + 1}-{Math.min(pageStart + pageSize, filtered.length)}，共{" "}
            {filtered.length} 条
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <span className="min-w-[52px] text-center text-foreground select-none">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一页
            </Button>
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-sm mx-4">
            <CardContent className="p-6 space-y-4">
              <div className="space-y-2">
                <h3 className="text-lg font-semibold">确认删除</h3>
                <p className="text-sm text-muted-foreground">
                  确定要删除「{entriesMap[deleteConfirm]?.name}」的离线缓存吗？此操作不可撤销。
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" disabled={!!deleting} onClick={() => setDeleteConfirm(null)}>
                  取消
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={!!deleting}
                  onClick={() => void handleDelete(deleteConfirm)}
                >
                  确认删除
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Updates available dialog */}
      <Dialog open={updatesDialogOpen} onOpenChange={setUpdatesDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              发现可用更新
            </DialogTitle>
            <DialogDescription>
              下载已发布的放映版本，或重新获取当前版本的有效授权。同一放映固定引用的素材版本不会因重新下载而自动升级为未发布的素材修订。
            </DialogDescription>
          </DialogHeader>
          {(() => {
            const updatableEntries = Object.entries(showUpdates)
              .filter(([sid, info]) => info.hasUpdate && entriesMap[sid])
              .map(([sid, info]) => ({
                showId: sid,
                info,
                entry: entriesMap[sid],
              }));
            if (updatableEntries.length === 0) {
              return (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  没有可更新的放映库
                </div>
              );
            }
            const anyUpdating = updatableEntries.some((x) => x.info.updating);
            return (
              <>
                <div className="max-h-[60vh] space-y-2 overflow-auto">
                  {updatableEntries.map(({ showId, info, entry }) => (
                    <div
                      key={showId}
                      className="flex items-center justify-between gap-3 rounded-md border p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-1 text-sm font-medium">{entry.name}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          本地 v{entry.version_no}
                          <span className="mx-1.5 text-muted-foreground/60">→</span>
                          <span className="text-amber-600">目标 v{info.remoteVersion}</span>
                        </div>
                        {info.updating && info.progress && (
                          <div className="mt-1.5 flex items-center gap-2">
                            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary transition-all duration-300"
                                style={{
                                  width: `${progressPercent(info.progress)}%`,
                                }}
                              />
                            </div>
                            <span className="text-[10px] text-muted-foreground">
                              {info.progress.completed}/{info.progress.total} · {formatBytes(info.progress.bytes)}
                            </span>
                          </div>
                        )}
                      </div>
                      {info.error && <p role="alert" className="text-xs text-destructive">{info.error}</p>}
                      {info.notice && <p role="status" className="text-xs text-muted-foreground">{info.notice}</p>}
                      {info.updating ? <Button size="sm" variant="outline" disabled={info.cancelling} onClick={() => cancelDownload(showId)} className="shrink-0">
                        {info.cancelling ? "正在取消…" : "取消下载"}
                      </Button> : <Button size="sm" variant="outline" disabled={!canDownload} onClick={() => void updateShow(showId, entry)} className="shrink-0">
                        {info.error || info.notice ? "重试下载" : "更新此项"}
                      </Button>}
                    </div>
                  ))}
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setUpdatesDialogOpen(false)}
                    disabled={anyUpdating}
                  >
                    关闭
                  </Button>
                  <Button
                    disabled={anyUpdating || !canDownload}
                    onClick={async () => {
                      const request = ++bulkRequest.current;
                      for (const { showId, entry } of updatableEntries) {
                        if (request !== bulkRequest.current || !networkRef.current) break;
                        await updateShow(showId, entry);
                      }
                    }}
                  >
                    {anyUpdating ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        更新中...
                      </>
                    ) : (
                      `全部更新 (${updatableEntries.length})`
                    )}
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
