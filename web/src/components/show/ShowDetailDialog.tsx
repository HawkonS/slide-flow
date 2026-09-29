import * as React from "react";
import {
  ClipboardList,
  Download,
  GitBranch,
  HardDrive,
  HardDriveDownload,
  Lock,
  Maximize,
  MonitorPlay,
  Pencil,
  ChevronDown,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShowResourcePrepDialog } from "@/components/show/ShowResourcePrepDialog";
import { ShowDownloadDialog } from "@/components/show/ShowDownloadDialog";
import ShowOfflineCacheDialog from "@/components/show/ShowOfflineCacheDialog";
import {
  RESOURCE_SCOPE_LABEL,
} from "@/lib/constants";
import { getShowVersions } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { listCachedShows, type CachedShow } from "@/lib/pwa-cache";
import { OFFLINE_SESSION_EVENT, offlineOwnerKey, readOfflineIdentity } from "@/lib/offline-session";
import {
  parseTags,
  Show,
  ShowResource,
  ShowResourceAccessible,
  ShowResourceInaccessible,
} from "@/lib/types";

export interface ShowDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  show: Show | null;
  onEdit?: (show: Show) => void;
  onDuplicate?: (show: Show) => void;
  onIterate?: (show: Show) => void;
  onSwitchVersion?: (showId: number) => void;
}

type OfflineCacheStatus = "checking" | "none" | "ready" | "expired" | "revoked" | "unavailable";
interface OfflineCacheSnapshot {
  ownerKey: string;
  showId: number | undefined;
  status: OfflineCacheStatus;
  entry: CachedShow | null;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function isAccessible(r: ShowResource): r is ShowResourceAccessible {
  return r.accessible === true;
}

function isInaccessible(r: ShowResource): r is ShowResourceInaccessible {
  return r.accessible === false;
}

export function ShowDetailDialog({
  open,
  onOpenChange,
  show,
  onEdit,
  onIterate,
  onSwitchVersion,
}: ShowDetailDialogProps) {
  const navigate = useNavigate();
  const auth = useAuth();
  const ownerKey = auth.identity && auth.identity.user.id === auth.user?.id ? offlineOwnerKey(auth.identity) : "";
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [prepOpen, setPrepOpen] = React.useState(false);
  const [downloadOpen, setDownloadOpen] = React.useState(false);
  const [offlineCacheOpen, setOfflineCacheOpen] = React.useState(false);
  const [cacheSnapshot, setCacheSnapshot] = React.useState<OfflineCacheSnapshot>({ ownerKey: "", showId: undefined, status: "checking", entry: null });
  const cacheScope = React.useRef({ open, showId: show?.id, ownerKey });
  cacheScope.current = { open, showId: show?.id, ownerKey };
  const matchingCache = cacheSnapshot.ownerKey === ownerKey && cacheSnapshot.showId === show?.id;
  const cacheStatus = matchingCache ? cacheSnapshot.status : "checking";
  const cachedEntry = matchingCache ? cacheSnapshot.entry : null;
  const isCachedOffline = cacheStatus === "ready" && !!cachedEntry;

  const { data: versionsData } = useQuery({
    queryKey: ["shows", show?.id, "versions"],
    queryFn: () => getShowVersions(show!.id),
    enabled: open && !!show,
    staleTime: 0,
  });

  const versions = React.useMemo(() => {
    const list = versionsData?.versions ?? [];
    return [...list].sort((a, b) => b.version_no - a.version_no);
  }, [versionsData]);

  const hasMultipleVersions = versions.length > 1;

  React.useEffect(() => {
    if (open) {
      setActiveIndex(0);
    }
  }, [open, show?.id]);

  React.useEffect(() => {
    if (!open || !show) return;
    const showId = show.id;
    let cancelled = false;
    let request = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setCacheSnapshot({ ownerKey, showId, status: "checking", entry: null });
    const check = async () => {
      const current = ++request;
      clearTimeout(timer);
      const commit = (status: OfflineCacheStatus, entry: CachedShow | null = null) => {
        const scope = cacheScope.current;
        if (!cancelled && current === request && scope.open && scope.showId === showId && scope.ownerKey === ownerKey) {
          setCacheSnapshot({ ownerKey, showId, status, entry });
        }
      };
      const identity = readOfflineIdentity();
      if (!identity || !ownerKey || offlineOwnerKey(identity) !== ownerKey) { commit("unavailable"); return; }
      try {
        const entries = await listCachedShows();
        const latest = readOfflineIdentity();
        if (cancelled || current !== request || !latest || offlineOwnerKey(latest) !== ownerKey) return;
        const entry = entries.find(item => item.show_id === showId);
        if (!entry) { commit("none"); return; }
        const expiry = Date.parse(entry.expires_at);
        const now = Date.now();
        const status = entry.revoked ? "revoked" : !Number.isFinite(expiry) || expiry <= now ? "expired" : "ready";
        commit(status, entry);
        if (status === "ready") timer = setTimeout(() => { void check(); }, Math.min(2_147_483_647, expiry - now + 10));
      } catch {
        commit("unavailable");
      }
    };
    const changed = () => { void check(); };
    const visible = () => { if (!document.hidden) changed(); };
    window.addEventListener("slideflow-pwa-change", changed);
    window.addEventListener(OFFLINE_SESSION_EVENT, changed);
    document.addEventListener("visibilitychange", visible);
    changed();
    return () => {
      cancelled = true; request++; clearTimeout(timer);
      window.removeEventListener("slideflow-pwa-change", changed);
      window.removeEventListener(OFFLINE_SESSION_EVENT, changed);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [show?.id, open, ownerKey]);

  if (!show) return null;

  const resources = show.resources ?? [];
  const activeResource = resources[activeIndex] ?? null;

  const previewUrl =
    activeResource && isAccessible(activeResource)
      ? activeResource.preview_url || activeResource.original_preview_url
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-5xl flex-col gap-4 overflow-hidden">
        <DialogHeader className="pr-10">
          <div className="flex items-center gap-3">
            <DialogTitle className="text-lg">{show.name}</DialogTitle>
            <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-sm font-medium text-muted-foreground">
              v{show.version_no}
            </span>
            {isCachedOffline && (
              <span title={`当前账号在此浏览器的缓存，有效至 ${formatDate(cachedEntry?.expires_at)}`} className="inline-flex items-center gap-1 text-xs text-green-600 bg-green-50 px-1.5 py-0.5 rounded">
                <HardDrive className="h-3 w-3" />
                浏览器缓存有效
              </span>
            )}
            {(cacheStatus === "expired" || cacheStatus === "revoked") && (
              <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
                <HardDrive className="h-3 w-3" />
                {cacheStatus === "revoked" ? "离线授权已撤销" : "离线缓存已过期"}
              </span>
            )}
            {cacheStatus === "unavailable" && <span className="text-xs text-muted-foreground">缓存状态暂不可用</span>}
          </div>
          <DialogDescription className="sr-only">放映详情</DialogDescription>
        </DialogHeader>

        {/* 主内容区：左右两栏 */}
        <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
          {/* 左侧：大图 + 缩略图 */}
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            {/* 大预览图 */}
            <div className="relative aspect-[16/9] w-full overflow-hidden rounded-lg border bg-muted">
              {activeResource ? (
                isAccessible(activeResource) ? (
                  previewUrl ? (
                    <img
                      src={previewUrl}
                      alt={activeResource.name}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
                      无预览
                    </div>
                  )
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-muted text-muted-foreground">
                    <Lock className="h-10 w-10" />
                    <p className="text-sm font-medium">
                      资源 #{activeResource.id} 无权限
                    </p>
                    <p className="text-xs">
                      管理者：
                      {(activeResource as ShowResourceInaccessible).managers
                        .map((m) => m.name || m.username)
                        .join("、")}
                    </p>
                  </div>
                )
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
                  无资源
                </div>
              )}
            </div>

            {/* 缩略图列表 */}
            {resources.length > 0 && (
              <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
                {resources.map((r, idx) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setActiveIndex(idx)}
                    className={`relative shrink-0 overflow-hidden rounded border ${
                      idx === activeIndex
                        ? "border-primary ring-1 ring-primary"
                        : "border-border hover:border-muted-foreground"
                    }`}
                    style={{ width: 80 }}
                  >
                    <div className="aspect-[16/9] w-full">
                      {isAccessible(r) ? (
                        r.preview_url || r.original_preview_url ? (
                          <img
                            src={r.preview_url || r.original_preview_url || undefined}
                            alt={r.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center bg-muted text-xs text-muted-foreground">
                            无预览
                          </div>
                        )
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center bg-muted text-muted-foreground">
                          <Lock className="h-4 w-4" />
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 右侧：元数据面板 */}
          <div className="w-72 shrink-0 overflow-y-auto">
            {/* 版本选择器 */}
            {onSwitchVersion && hasMultipleVersions && (
              <div className="mb-3">
                <Select
                  value={String(show.id)}
                  onValueChange={(v) => onSwitchVersion(Number(v))}
                >
                  <SelectTrigger className="h-8 w-full gap-1 px-2 text-sm">
                    <span className="truncate">
                      <SelectValue placeholder={`v${show.version_no}`} />
                    </span>
                  </SelectTrigger>
                  <SelectContent className="max-w-[360px]">
                    {versions.map((v) => (
                      <SelectItem key={v.id} value={String(v.id)} className="max-w-[340px] text-sm">
                        <span className="truncate">
                          v{v.version_no}
                          {v.id === show.id ? "（当前）" : ""}
                          {v.change_note ? ` · ${v.change_note}` : ""}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-3">
              <InfoRow label="主体" value={show.subject || "—"} />
              <InfoRow
                label="状态"
                value={show.status}
              />
              <InfoRow
                label="标签"
                value={parseTags(show.tags).join("、") || "—"}
              />
              <InfoRow label="版本" value={`v${show.version_no}`} />
              {show.change_note && (
                <InfoRow label="变更说明" value={show.change_note} />
              )}
              <InfoRow
                label="可见范围"
                value={RESOURCE_SCOPE_LABEL[show.visibility_scope] || "—"}
              />
              <InfoRow
                label="管理范围"
                value={RESOURCE_SCOPE_LABEL[show.management_scope] || "—"}
              />
              <InfoRow
                label="创建者"
                value={show.owner?.name || show.owner?.username || "—"}
              />
              <InfoRow
                label="最终修改"
                value={show.updated_by?.name || show.updated_by?.username || "—"}
              />
              <InfoRow label="创建时间" value={formatDate(show.created_at)} />
              <InfoRow label="更新时间" value={formatDate(show.updated_at)} />
              <InfoRow label="资源数" value={`${resources.length} 项`} />
            </div>
          </div>
        </div>

        {/* 底部按钮区 */}
        <div className="flex flex-wrap gap-2 border-t pt-3">
          <div className="flex gap-1">
            {isCachedOffline ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1">
                    <Maximize className="h-4 w-4" />
                    全屏放映
                    <ChevronDown className="h-3 w-3 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => {
                    if (cachedEntry) window.open(`/shows/${show.id}/fullscreen?offline=true&package_id=${encodeURIComponent(cachedEntry.package_id)}`, '_blank', 'popup=yes,width=1920,height=1080');
                  }}>
                    <WifiOff className="mr-2 h-4 w-4" />
                    本地缓存放映
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => {
                    window.open(`/shows/${show.id}/fullscreen`, '_blank', 'popup=yes,width=1920,height=1080');
                  }}>
                    <Wifi className="mr-2 h-4 w-4" />
                    在线放映
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button variant="outline" size="sm" onClick={() => {
                window.open(`/shows/${show.id}/fullscreen`, '_blank', 'popup=yes,width=1920,height=1080');
              }}>
                <Maximize className="mr-1 h-4 w-4" />
                全屏放映
              </Button>
            )}
            {isCachedOffline ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1">
                    <MonitorPlay className="h-4 w-4" />
                    讲演模式
                    <ChevronDown className="h-3 w-3 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => {
                    if (cachedEntry) navigate(`/shows/${show.id}/present?offline=true&package_id=${encodeURIComponent(cachedEntry.package_id)}`);
                  }}>
                    <WifiOff className="mr-2 h-4 w-4" />
                    本地缓存放映
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => {
                    navigate(`/shows/${show.id}/present`);
                  }}>
                    <Wifi className="mr-2 h-4 w-4" />
                    在线放映
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button variant="outline" size="sm" onClick={() => {
                navigate(`/shows/${show.id}/present`);
              }}>
                <MonitorPlay className="mr-1 h-4 w-4" />
                讲演模式
              </Button>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => setPrepOpen(true)}>
            <ClipboardList className="mr-1 h-4 w-4" />
            资源准备
          </Button>
          <Button variant="outline" size="sm" onClick={() => setDownloadOpen(true)}>
            <Download className="mr-1 h-4 w-4" />
            下载
          </Button>
          <Button variant="outline" size="sm" onClick={() => setOfflineCacheOpen(true)}>
            <HardDriveDownload className="mr-1 h-4 w-4" />
            离线缓存
          </Button>
          {onIterate && show.can_manage && (
            <Button variant="outline" size="sm" onClick={() => navigate(`/shows/${show.id}/iterate`)}>
              <GitBranch className="mr-1 h-4 w-4" />
              版本迭代
            </Button>
          )}
          {onEdit && show.can_manage && (
            <Button variant="outline" size="sm" onClick={() => onEdit(show)}>
              <Pencil className="mr-1 h-4 w-4" />
              编辑信息
            </Button>
          )}
        </div>

        <ShowResourcePrepDialog open={prepOpen} onOpenChange={setPrepOpen} show={show} />
        <ShowDownloadDialog open={downloadOpen} onOpenChange={setDownloadOpen} show={show} />
        <ShowOfflineCacheDialog open={offlineCacheOpen} onOpenChange={setOfflineCacheOpen} show={show} />
      </DialogContent>
    </Dialog>
  );
}
