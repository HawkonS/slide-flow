import * as React from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  HardDrive,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Smartphone,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { listCachedShows } from "@/lib/pwa-cache";
import { OFFLINE_SESSION_EVENT, offlineOwnerKey, readOfflineIdentity } from "@/lib/offline-session";
import { usePwaStatus } from "@/lib/pwa";

type BannerState =
  | { kind: "loading" }
  | { kind: "unsupported"; reason: "insecure" | "browser" }
  | { kind: "empty" }
  | { kind: "unavailable"; message: string }
  | { kind: "configured"; validCount: number; expiredCount: number; revokedCount: number };

const TARGET = "/manage/offline-cache";

/** 当前账号在此浏览器中的离线缓存状态。 */
export function OfflineCacheBanner() {
  const auth = useAuth();
  const pwaStatus = usePwaStatus();
  const ownerKey = auth.identity && auth.identity.user.id === auth.user?.id ? offlineOwnerKey(auth.identity) : "";
  const ownerRef = React.useRef(ownerKey);
  ownerRef.current = ownerKey;
  const accountName = auth.user?.name || auth.user?.username || "当前账号";
  const [snapshot, setSnapshot] = React.useState<{ ownerKey: string; state: BannerState }>({ ownerKey: "", state: { kind: "loading" } });
  const state: BannerState = snapshot.ownerKey === ownerKey ? snapshot.state : { kind: "loading" };

  React.useEffect(() => {
    let cancelled = false;
    let request = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSnapshot({ ownerKey, state: { kind: "loading" } });
    const refresh = async () => {
      const current = ++request;
      clearTimeout(timer);
      const commit = (next: BannerState) => {
        if (!cancelled && current === request && ownerRef.current === ownerKey) setSnapshot({ ownerKey, state: next });
      };
      if (!window.isSecureContext || !("serviceWorker" in navigator) || !("indexedDB" in window) || !("caches" in window)) {
        commit({ kind: "unsupported", reason: window.isSecureContext ? "browser" : "insecure" });
        return;
      }
      const identity = readOfflineIdentity();
      if (!identity || !ownerKey || offlineOwnerKey(identity) !== ownerKey) {
        commit({ kind: "unavailable", message: "请联网验证登录，并允许此站点使用浏览器存储后查看缓存。" });
        return;
      }
      try {
        const entries = await listCachedShows();
        const latest = readOfflineIdentity();
        if (cancelled || current !== request || ownerRef.current !== ownerKey || !latest || offlineOwnerKey(latest) !== ownerKey) return;
        const now = Date.now();
        let validCount = 0, expiredCount = 0, revokedCount = 0;
        let nextExpiry = Infinity;
        for (const entry of entries) {
          const expiry = Date.parse(entry.expires_at);
          if (entry.revoked) revokedCount++;
          else if (!Number.isFinite(expiry) || expiry <= now) expiredCount++;
          else { validCount++; nextExpiry = Math.min(nextExpiry, expiry); }
        }
        commit(entries.length ? { kind: "configured", validCount, expiredCount, revokedCount } : { kind: "empty" });
        if (Number.isFinite(nextExpiry)) timer = setTimeout(() => { void refresh(); }, Math.min(2_147_483_647, nextExpiry - now + 10));
      } catch {
        commit({ kind: "unavailable", message: "无法读取当前浏览器的缓存，请前往管理页检查存储权限或重新下载。" });
      }
    };
    const changed = () => { void refresh(); };
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
  }, [ownerKey]);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-3 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在读取当前账号的浏览器缓存…
      </div>
    );
  }

  if (state.kind === "unsupported") {
    const text =
      state.reason === "insecure"
        ? "当前为非安全连接，本地应用无法部署（需通过 HTTPS 或 localhost 访问）"
        : "当前浏览器无法部署本地应用，需要启用 Service Worker 和浏览器本地存储。";
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed bg-muted/40 p-3 text-xs text-muted-foreground">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span className="flex-1">{text}</span>
      </div>
    );
  }

  if (pwaStatus.status === "development") {
    return (
      <BannerLink
        to={TARGET}
        toneClass="border-sky-200/80 bg-sky-50/70 hover:border-sky-300 dark:border-sky-900/50 dark:bg-sky-950/20"
        iconWrapClass="bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300"
        icon={<Smartphone className="h-5 w-5" />}
        title="开发环境未部署本地应用"
        badge={<span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">发布构建后可用</span>}
        description={pwaStatus.message}
        actionLabel="查看维护"
        actionToneClass="bg-sky-600 text-white hover:bg-sky-700 dark:bg-sky-500 dark:hover:bg-sky-600"
      />
    );
  }

  if (pwaStatus.status === "update-available") {
    return (
      <BannerLink
        to={TARGET}
        toneClass="border-amber-200/80 bg-amber-50/70 hover:border-amber-300 dark:border-amber-900/50 dark:bg-amber-950/20"
        iconWrapClass="bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300"
        icon={<RefreshCw className="h-5 w-5" />}
        title="本地应用有更新"
        badge={<span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">待维护</span>}
        description={pwaStatus.message}
        actionLabel="检查更新"
        actionToneClass="bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
      />
    );
  }

  if (pwaStatus.status === "error" || pwaStatus.status === "not-deployed") {
    return (
      <BannerLink
        to={TARGET}
        toneClass="border-rose-200/80 bg-rose-50/70 hover:border-rose-300 dark:border-rose-900/50 dark:bg-rose-950/20"
        iconWrapClass="bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300"
        icon={<ShieldAlert className="h-5 w-5" />}
        title="本地应用需要维护"
        badge={<span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">未就绪</span>}
        description={pwaStatus.message}
        actionLabel="打开维护"
        actionToneClass="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-500 dark:hover:bg-rose-600"
      />
    );
  }

  if (state.kind === "empty" || (state.kind === "configured" && state.validCount === 0)) {
    const stale = state.kind === "configured";
    return (
      <BannerLink
        to={TARGET}
        toneClass="border-amber-200/80 bg-amber-50/70 hover:border-amber-300 dark:border-amber-900/50 dark:bg-amber-950/20"
        iconWrapClass="bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300"
        icon={<HardDrive className="h-5 w-5" />}
        title={stale ? "本地应用已部署 · 缓存需要更新" : "本地应用已部署 · 尚未缓存放映"}
        badge={
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
            {stale ? "暂无有效缓存" : "尚未缓存"}
          </span>
        }
        description={stale
          ? `当前浏览器 · 账号「${accountName}」 · ${state.expiredCount} 个已过期，${state.revokedCount} 个已撤销，请联网重新下载。`
          : `当前浏览器 · 账号「${accountName}」。下载完成后可在授权有效期内断网播放。`}
        actionLabel="管理缓存"
        actionToneClass="bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
      />
    );
  }

  if (state.kind === "unavailable") {
    return (
      <BannerLink
        to={TARGET}
        toneClass="border-sky-200/80 bg-sky-50/70 hover:border-sky-300 dark:border-sky-900/50 dark:bg-sky-950/20"
        iconWrapClass="bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300"
        icon={<ShieldAlert className="h-5 w-5" />}
        title="本地应用维护中"
        description={`账号「${accountName}」 · ${state.message}`}
        actionLabel="查看管理"
        actionToneClass="bg-sky-600 text-white hover:bg-sky-700 dark:bg-sky-500 dark:hover:bg-sky-600"
      />
    );
  }

  // configured
  return (
    <BannerLink
      to={TARGET}
      toneClass="border-emerald-200/70 bg-emerald-50/60 hover:border-emerald-300 dark:border-emerald-900/40 dark:bg-emerald-950/20"
      iconWrapClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
      icon={<HardDrive className="h-5 w-5" />}
      title="本地应用已部署 · 离线缓存已就绪"
      badge={
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200/60 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-800/60">
          <CheckCircle2 className="h-3 w-3" />
          可用 {state.validCount} 个放映
        </span>
      }
      description={
        <>
          当前浏览器 · 账号「<span className="font-medium text-foreground">{accountName}</span>」
          {state.expiredCount || state.revokedCount ? ` · ${state.expiredCount} 个已过期，${state.revokedCount} 个已撤销` : " · 仅在授权有效期内可用"}
        </>
      }
      actionLabel="管理"
      actionToneClass="border border-emerald-300/70 bg-white text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800/60 dark:bg-transparent dark:text-emerald-300 dark:hover:bg-emerald-950/40"
    />
  );
}

/* ---------- 内部展示组件 ---------- */

interface BannerLinkProps {
  to: string;
  toneClass: string;
  iconWrapClass: string;
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  description: React.ReactNode;
  actionLabel: string;
  actionToneClass: string;
}

function BannerLink({
  to,
  toneClass,
  iconWrapClass,
  icon,
  title,
  badge,
  description,
  actionLabel,
  actionToneClass,
}: BannerLinkProps) {
  return (
    <Link
      to={to}
      className={cn(
        "group flex flex-wrap items-center gap-2.5 rounded-lg border bg-card p-3 shadow-sm transition sm:gap-4 sm:p-4",
        "hover:-translate-y-0.5 hover:shadow-md",
        toneClass,
      )}
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition sm:h-10 sm:w-10 group-hover:scale-105",
          iconWrapClass,
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {badge}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
      </div>
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium shadow-sm transition",
          "group-hover:gap-1.5",
          actionToneClass,
        )}
      >
        <span className="hidden sm:inline">{actionLabel}</span>
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
