import * as React from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  FolderOpen,
  HardDrive,
  Loader2,
  ShieldAlert,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  getDirectoryHandle,
  isFileSystemAccessSupported,
  isSecureContext,
  readManifest,
} from "@/lib/offline-cache";

type BannerState =
  | { kind: "loading" }
  | { kind: "unsupported"; reason: "insecure" | "browser" }
  | { kind: "no-folder" }
  | { kind: "no-permission"; dirName: string }
  | { kind: "configured"; dirName: string; cachedCount: number };

const TARGET = "/manage/offline-cache";

/**
 * 首页离线缓存维护提示横幅。
 * - 未配置目录：amber 警示色，主 CTA 引导用户去维护
 * - 已配置：emerald 成功色，展示已缓存放映数与目录名
 * - 待授权：中性提示，引导前往授权
 * - 不支持环境：低存在感的信息条（hide 也可，但保留以便用户理解原因）
 */
export function OfflineCacheBanner() {
  const [state, setState] = React.useState<BannerState>({ kind: "loading" });

  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!isFileSystemAccessSupported()) {
        if (cancelled) return;
        setState({
          kind: "unsupported",
          reason: !isSecureContext() ? "insecure" : "browser",
        });
        return;
      }

      try {
        const handle = await getDirectoryHandle();
        if (cancelled) return;
        if (!handle) {
          setState({ kind: "no-folder" });
          return;
        }
        // 仅查询，不主动 request，避免触发权限弹窗
        const perm = await handle.queryPermission({ mode: "read" });
        if (cancelled) return;
        if (perm !== "granted") {
          setState({ kind: "no-permission", dirName: handle.name });
          return;
        }
        const manifest = await readManifest(handle);
        if (cancelled) return;
        const cachedCount = manifest ? Object.keys(manifest.shows ?? {}).length : 0;
        setState({ kind: "configured", dirName: handle.name, cachedCount });
      } catch {
        if (!cancelled) setState({ kind: "no-folder" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-3 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在检测离线缓存配置…
      </div>
    );
  }

  if (state.kind === "unsupported") {
    const text =
      state.reason === "insecure"
        ? "当前为非安全连接，离线缓存功能不可用（需通过 HTTPS 或 localhost 访问）"
        : "当前浏览器不支持离线缓存功能，建议使用 Chrome 86+ / Edge 86+";
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed bg-muted/40 p-3 text-xs text-muted-foreground">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span className="flex-1">{text}</span>
      </div>
    );
  }

  if (state.kind === "no-folder") {
    return (
      <BannerLink
        to={TARGET}
        toneClass="border-amber-200/80 bg-gradient-to-r from-amber-50 via-amber-50/60 to-orange-50/30 hover:border-amber-300 dark:border-amber-900/50 dark:from-amber-950/30 dark:via-amber-950/20 dark:to-orange-950/10"
        iconWrapClass="bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300"
        icon={<FolderOpen className="h-5 w-5" />}
        title="尚未维护离线缓存本地目录"
        badge={
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
            建议设置
          </span>
        }
        description="选择一个本地文件夹用于离线缓存，断网或异地放映时也能流畅播放。"
        actionLabel="前往维护"
        actionToneClass="bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
      />
    );
  }

  if (state.kind === "no-permission") {
    return (
      <BannerLink
        to={TARGET}
        toneClass="border-sky-200/80 bg-gradient-to-r from-sky-50 via-sky-50/60 to-indigo-50/30 hover:border-sky-300 dark:border-sky-900/50 dark:from-sky-950/30 dark:via-sky-950/20 dark:to-indigo-950/10"
        iconWrapClass="bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300"
        icon={<ShieldAlert className="h-5 w-5" />}
        title="离线缓存目录待重新授权"
        description={
          <>
            目录{" "}
            <span className="font-medium text-foreground">{state.dirName}</span>{" "}
            已绑定，但浏览器需要重新授权访问权限。
          </>
        }
        actionLabel="前往授权"
        actionToneClass="bg-sky-600 text-white hover:bg-sky-700 dark:bg-sky-500 dark:hover:bg-sky-600"
      />
    );
  }

  // configured
  return (
    <BannerLink
      to={TARGET}
      toneClass="border-emerald-200/70 bg-gradient-to-r from-emerald-50/80 via-emerald-50/40 to-teal-50/20 hover:border-emerald-300 dark:border-emerald-900/40 dark:from-emerald-950/30 dark:via-emerald-950/20 dark:to-teal-950/10"
      iconWrapClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
      icon={<HardDrive className="h-5 w-5" />}
      title="离线缓存已就绪"
      badge={
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200/60 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-800/60">
          <CheckCircle2 className="h-3 w-3" />
          已缓存 {state.cachedCount} 个放映
        </span>
      }
      description={
        <>
          目录：
          <span
            className="font-medium text-foreground"
            title={state.dirName}
          >
            {state.dirName}
          </span>
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
        "group flex items-center gap-4 rounded-lg border bg-card p-4 shadow-sm transition",
        "hover:-translate-y-0.5 hover:shadow-md",
        toneClass,
      )}
    >
      <div
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition group-hover:scale-105",
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
        {actionLabel}
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
