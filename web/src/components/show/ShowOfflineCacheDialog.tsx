import * as React from "react";
import { AlertTriangle, CheckCircle2, HardDriveDownload, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import { downloadShow, type CachedShow, type CacheProgress } from "@/lib/pwa-cache";
import type { Show } from "@/lib/types";

interface ShowOfflineCacheDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  show: Show | null;
}

const PHASE_LABELS: Record<CacheProgress["phase"], string> = {
  preparing: "正在准备离线应用并校验授权",
  downloading: "正在下载高清图与缩略图",
  verifying: "正在校验文件与放映版本",
  ready: "缓存已就绪",
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, unit)).toFixed(unit ? 1 : 0) + " " + ["B", "KB", "MB", "GB"][unit];
}

export default function ShowOfflineCacheDialog({ open, onOpenChange, show }: ShowOfflineCacheDialogProps) {
  const auth = useAuth();
  const [online, setOnline] = React.useState(navigator.onLine);
  const [stage, setStage] = React.useState<"options" | "caching" | "done" | "unsupported">("options");
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<CacheProgress>({ phase: "preparing", completed: 0, total: 0, bytes: 0 });
  const [cached, setCached] = React.useState<CachedShow | null>(null);
  const [availableBytes, setAvailableBytes] = React.useState<number | null>(null);
  const [cancelling, setCancelling] = React.useState(false);
  const downloadRef = React.useRef<AbortController | null>(null);
  const generation = React.useRef(0);
  const viewRef = React.useRef({ open, showId: show?.id, userId: auth.user?.id, epoch: auth.epoch });
  viewRef.current = { open, showId: show?.id, userId: auth.user?.id, epoch: auth.epoch };
  const canDownload = online && !auth.offline;
  const accountName = auth.user?.name || auth.user?.username || "当前账号";

  React.useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    return () => { window.removeEventListener("online", changed); window.removeEventListener("offline", changed); };
  }, []);

  React.useEffect(() => {
    const current = ++generation.current;
    if (!open) return;
    setStage("options"); setError(null); setNotice(null); setCached(null); setCancelling(false); setAvailableBytes(null);
    setProgress({ phase: "preparing", completed: 0, total: 0, bytes: 0 });
    if (!window.isSecureContext || !("serviceWorker" in navigator) || !("indexedDB" in window) || !("caches" in window)) {
      setStage("unsupported");
      setError(!window.isSecureContext
        ? "离线播放需要安全连接，请使用 HTTPS 或本机 localhost 访问本站。"
        : "当前浏览器不支持离线应用，或浏览器已禁用本地存储。请使用支持 Service Worker 和 IndexedDB 的浏览器。");
    } else {
      void navigator.storage?.estimate?.().then(estimate => {
        if (generation.current === current && viewRef.current.open && viewRef.current.showId === show?.id && estimate.quota !== undefined) {
          setAvailableBytes(Math.max(0, estimate.quota - (estimate.usage || 0)));
        }
      }).catch(() => {});
    }
    return () => {
      generation.current++;
      downloadRef.current?.abort();
      downloadRef.current = null;
    };
  }, [open, show?.id, auth.user?.id, auth.epoch]);

  const close = (nextOpen: boolean) => {
    if (!nextOpen) {
      generation.current++;
      downloadRef.current?.abort();
      downloadRef.current = null;
    }
    onOpenChange(nextOpen);
  };

  const startCache = async () => {
    if (!open || !show || !canDownload || downloadRef.current) return;
    const view = viewRef.current;
    const showId = show.id;
    const current = ++generation.current;
    const controller = new AbortController();
    downloadRef.current = controller;
    const isCurrent = () => generation.current === current && downloadRef.current === controller
      && viewRef.current.open && viewRef.current.showId === view.showId
      && viewRef.current.userId === view.userId && viewRef.current.epoch === view.epoch;
    setStage("caching"); setError(null); setNotice(null); setCancelling(false);
    setProgress({ phase: "preparing", completed: 0, total: 0, bytes: 0 });
    try {
      const result = await downloadShow(showId, {
        signal: controller.signal,
        onProgress: value => { if (isCurrent()) setProgress(value); },
      });
      if (isCurrent()) { setCached(result); setStage("done"); }
    } catch (failure) {
      if (!isCurrent()) return;
      setStage("options");
      if (failure instanceof DOMException && failure.name === "AbortError") setNotice("本次下载已取消。");
      else setError(failure instanceof Error ? failure.message : "缓存失败，请检查网络与浏览器存储权限后重试。");
    } finally {
      const active = isCurrent();
      if (downloadRef.current === controller) downloadRef.current = null;
      if (active) setCancelling(false);
    }
  };

  if (!show) return null;
  const percent = progress.total > 0 ? Math.min(100, Math.round(progress.completed / progress.total * 100)) : 0;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><HardDriveDownload className="h-5 w-5" />离线缓存</DialogTitle>
          <DialogDescription>将「{show.name}」保存到此浏览器，断网时使用相同的全屏与讲演视图。</DialogDescription>
        </DialogHeader>
        {error && <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}
        {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
        {stage === "options" && (
          <div className="space-y-4 py-2">
            <div className="space-y-2 rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
              <p>包含高清页面、缩略图和当前版本的备注。无需选择文件夹，下载完成并通过校验后才会替换已有缓存。</p>
              <p>缓存仅供账号「{accountName}」在当前浏览器使用，并受离线授权有效期限制；退出账号后将不可使用。</p>
              <p>{availableBytes === null ? "浏览器将在下载前检查可用空间。" : "此站点当前可用空间约 " + formatBytes(availableBytes)}</p>
            </div>
            {!canDownload && <p role="status" className="text-sm text-amber-700">{!online ? "当前设备已离线，请连接网络后下载或更新。" : "当前为离线登录状态，请联网重新验证登录后下载。"}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => close(false)}>关闭</Button>
              <Button onClick={() => void startCache()} disabled={!canDownload}>{error ? "重试下载" : "开始缓存"}</Button>
            </DialogFooter>
          </div>
        )}
        {stage === "caching" && (
          <div className="space-y-4 py-2">
            <p role="status" aria-live="polite" className="flex items-center justify-center gap-2 text-sm font-medium"><Loader2 className="h-4 w-4 animate-spin" />{cancelling ? "正在取消下载" : PHASE_LABELS[progress.phase]}</p>
            <div role="progressbar" aria-label="离线缓存下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.total ? percent : undefined} className="h-2.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: String(percent) + "%" }} />
            </div>
            <p className="text-center text-sm text-muted-foreground">{progress.total ? progress.completed + " / " + progress.total + " 个文件 · " : ""}{formatBytes(progress.bytes)}</p>
            <p className="text-xs text-muted-foreground">下载中断或取消不会覆盖已有的完整缓存。</p>
            <DialogFooter><Button variant="outline" disabled={cancelling} onClick={() => { setCancelling(true); downloadRef.current?.abort(); }}>{cancelling ? "正在取消…" : "取消下载"}</Button></DialogFooter>
          </div>
        )}
        {stage === "done" && cached && (
          <div className="space-y-4 py-2">
            <div className="flex flex-col items-center gap-2 py-2">
              <CheckCircle2 className="h-10 w-10 text-emerald-600" />
              <p className="text-sm font-medium">缓存完成，可离线播放</p>
              <p className="text-sm text-muted-foreground">{cached.resources.length} 页 · {formatBytes(cached.total_bytes)}</p>
              <p className="text-center text-xs text-muted-foreground">授权有效至 {new Date(cached.expires_at).toLocaleString("zh-CN", { hour12: false })}</p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => close(false)}>完成</Button>
              <Button asChild><Link to="/manage/offline-cache" onClick={() => close(false)}>管理离线缓存</Link></Button>
            </DialogFooter>
          </div>
        )}
        {stage === "unsupported" && <DialogFooter><Button variant="outline" onClick={() => close(false)}>关闭</Button></DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
