import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  FolderOpen,
  Layers,
  Loader2,
  Maximize,
  MonitorPlay,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
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
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  type OfflineManifest,
  type OfflinePackageData,
  type OfflineShowEntry,
  cacheShowToDirectory,
  deleteShowCache,
  ensurePermission,
  getDirectoryHandle,
  isFileSystemAccessSupported,
  isSecureContext,
  pickDirectory,
  readManifest,
  saveDirectoryHandle,
  writeManifest,
} from "@/lib/offline-cache";

/* ---------- types ---------- */

interface OfflineVersionResponse {
  // 系列中最新版本的 show_id（可能与前端请求时传入的 queried_show_id 不同）
  show_id: number;
  // 前端请求时传入的 show_id（即缓存 manifest 中的 key）
  queried_show_id?: number;
  series_id?: string;
  name?: string;
  version_no: number;
  updated_at: string;
  resource_versions: Record<string, number>;
}

type UpdateStatus = "idle" | "checking" | "done";

interface ShowUpdateInfo {
  hasUpdate: boolean;
  remoteVersion?: number;
  // 系列中最新版本的 show_id，更新时需要用它拉取 offline-package
  latestShowId?: number;
  checking?: boolean;
  updating?: boolean;
  progress?: { current: number; total: number };
}

/* ---------- Filter Types ---------- */

interface OfflineFilters {
  query: string;
  subject: string;
  status: string;
  secrecy: string;
  tags: string[];
  tagsMode: "any" | "all";
}

const DEFAULT_FILTERS: OfflineFilters = {
  query: "",
  subject: "all",
  status: "all",
  secrecy: "all",
  tags: [],
  tagsMode: "all",
};

/* ---------- Filter Options ---------- */

const OFFLINE_STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "active", label: "正常" },
  { value: "disabled", label: "停用" },
] as const;

const OFFLINE_SECRECY_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "public", label: "公开" },
  { value: "confidential", label: "保密" },
  { value: "secret", label: "秘密" },
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
            "group inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm transition",
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
            "inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm transition",
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

function useCoverThumbnail(
  dirHandle: FileSystemDirectoryHandle | null,
  showId: string
): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!dirHandle) return;
    let revoked = false;
    let objectUrl: string | null = null;

    (async () => {
      try {
        const showsDir = await dirHandle.getDirectoryHandle("shows");
        const showDir = await showsDir.getDirectoryHandle(showId);
        const fileHandle = await showDir.getFileHandle("cover_thumb.jpg");
        const file = await fileHandle.getFile();
        objectUrl = URL.createObjectURL(file);
        if (!revoked) {
          setUrl(objectUrl);
        } else {
          URL.revokeObjectURL(objectUrl);
        }
      } catch {
        // File doesn't exist, keep null
      }
    })();

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [dirHandle, showId]);

  return url;
}

/* ---------- CacheCard Component ---------- */

interface CacheCardProps {
  showId: string;
  entry: OfflineShowEntry;
  dirHandle: FileSystemDirectoryHandle | null;
  updateInfo?: ShowUpdateInfo;
  onFullscreen: () => void;
  onPresent: () => void;
  onDelete: () => void;
}

function CacheCard({
  showId,
  entry,
  dirHandle,
  updateInfo,
  onFullscreen,
  onPresent,
  onDelete,
}: CacheCardProps) {
  const thumbUrl = useCoverThumbnail(dirHandle, showId);
  const isUpdating = updateInfo?.updating;
  const hasUpdate = updateInfo?.hasUpdate;
  const progress = updateInfo?.progress;

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
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
          <span className="absolute right-2 top-2 inline-flex items-center rounded bg-amber-500/90 px-1.5 py-0.5 text-[11px] font-medium text-white">
            有更新
          </span>
        )}

        {/* Progress overlay during update */}
        {isUpdating && progress && (
          <div className="absolute inset-x-0 bottom-0 bg-black/60 px-2 py-1">
            <div className="h-1 overflow-hidden rounded-full bg-white/30">
              <div
                className="h-full rounded-full bg-white transition-all duration-300"
                style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }}
              />
            </div>
            <div className="mt-0.5 text-center text-[10px] text-white/80">
              {progress.current}/{progress.total}
            </div>
          </div>
        )}

        {/* Top-right dropdown menu (delete) - appears on hover */}
        {!hasUpdate && (
          <div className="absolute right-2 top-2 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
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
      </div>

      {/* Action buttons */}
      <div className="mt-1.5 flex items-center gap-1 border-t bg-muted/30 px-2 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onFullscreen}
          disabled={isUpdating}
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
          disabled={isUpdating}
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
  const [supported] = useState(() => isFileSystemAccessSupported());
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [manifest, setManifest] = useState<OfflineManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [showUpdates, setShowUpdates] = useState<Record<string, ShowUpdateInfo>>({});
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [updatesDialogOpen, setUpdatesDialogOpen] = useState(false);
  const [filters, setFilters] = useState<OfflineFilters>(DEFAULT_FILTERS);

  // Load saved directory handle on mount
  useEffect(() => {
    if (!supported) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const handle = await getDirectoryHandle();
        if (handle) {
          setDirHandle(handle);
          const granted = await ensurePermission(handle);
          if (granted) {
            const m = await readManifest(handle);
            setManifest(m);
          }
        }
      } catch (err) {
        console.error("Failed to load directory handle:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [supported]);

  // Pick / change directory
  const handlePickDirectory = useCallback(async () => {
    try {
      const handle = await pickDirectory();
      if (!handle) return;
      await saveDirectoryHandle(handle);
      setDirHandle(handle);
      const granted = await ensurePermission(handle);
      if (granted) {
        const m = await readManifest(handle);
        setManifest(m);
      } else {
        toast.error("未获得文件夹读写权限");
      }
    } catch (err) {
      toast.error("选择文件夹失败: " + (err instanceof Error ? err.message : "未知错误"));
    }
  }, []);

  // Refresh manifest from disk
  const refreshManifest = useCallback(async () => {
    if (!dirHandle) return;
    try {
      const granted = await ensurePermission(dirHandle);
      if (!granted) {
        toast.error("未获得文件夹读写权限");
        return;
      }
      const m = await readManifest(dirHandle);
      setManifest(m);
    } catch (err) {
      console.error("refresh manifest error:", err);
    }
  }, [dirHandle]);

  // Check single show for update
  const checkShowUpdate = useCallback(async (showId: string) => {
    setShowUpdates((prev) => ({
      ...prev,
      [showId]: { ...prev[showId], hasUpdate: prev[showId]?.hasUpdate ?? false, checking: true },
    }));
    try {
      const data = await api<OfflineVersionResponse>(`/api/shows/${showId}/offline-version`);
      const entry = manifest?.shows[showId];
      const hasUpdate = entry ? data.version_no > entry.version_no : false;
      setShowUpdates((prev) => ({
        ...prev,
        [showId]: {
          hasUpdate,
          remoteVersion: data.version_no,
          latestShowId: data.show_id,
          checking: false,
        },
      }));
      return hasUpdate;
    } catch (err) {
      toast.error(`检查更新失败 (ID:${showId}): ` + (err instanceof Error ? err.message : "未知错误"));
      setShowUpdates((prev) => ({
        ...prev,
        [showId]: { ...prev[showId], hasUpdate: false, checking: false },
      }));
      return false;
    }
  }, [manifest]);

  // Check all shows for updates
  const checkAllUpdates = useCallback(async () => {
    if (!manifest || !manifest.shows) return;
    const showIds = Object.keys(manifest.shows);
    if (showIds.length === 0) return;

    setUpdateStatus("checking");
    let updatesFound = 0;
    for (const showId of showIds) {
      const hasUpdate = await checkShowUpdate(showId);
      if (hasUpdate) updatesFound++;
    }
    setUpdateStatus("done");
    if (updatesFound === 0) {
      toast.success("全部已是最新版本");
    } else {
      // 发现更新时，弹出对话框让用户自行决定是否缓存新版
      setUpdatesDialogOpen(true);
    }
  }, [manifest, checkShowUpdate]);

  // Update a single show (downloads latest as a separate cache entry, keeps the old one)
  const updateShow = useCallback(async (showId: string, entry: OfflineShowEntry) => {
    if (!dirHandle) return;
    setShowUpdates((prev) => ({
      ...prev,
      [showId]: { ...prev[showId], hasUpdate: prev[showId]?.hasUpdate ?? false, updating: true, progress: undefined },
    }));
    try {
      const granted = await ensurePermission(dirHandle);
      if (!granted) {
        toast.error("未获得文件夹读写权限");
        return;
      }
      // 系列里最新版本的 show_id 可能与缓存的 showId 不同，
      // 优先使用检查更新时得到的 latestShowId 去拉取离线包。
      const latestShowId = showUpdates[showId]?.latestShowId ?? Number(showId);
      const packageData = await api<OfflinePackageData>(
        `/api/shows/${latestShowId}/offline-package`,
        { params: { auth_mode: entry.auth_mode } },
      );
      await cacheShowToDirectory(dirHandle, packageData, window.location.origin, (current, total) => {
        setShowUpdates((prev) => ({
          ...prev,
          [showId]: { ...prev[showId], hasUpdate: false, updating: true, progress: { current, total } },
        }));
      });
      // 新版本作为独立条目缓存：旧条目保持不动，由用户自行决定是否删除
      const m = await readManifest(dirHandle);
      setManifest(m);
      setShowUpdates((prev) => {
        const next = { ...prev };
        // 旧条目：标记已无更新（最新版本已被独立缓存）
        next[showId] = { hasUpdate: false, updating: false };
        // 新条目：刚下载完成，亦无更新
        if (String(latestShowId) !== showId) {
          next[String(latestShowId)] = { hasUpdate: false, updating: false };
        }
        return next;
      });
      if (String(latestShowId) !== showId) {
        toast.success(`已下载「${packageData.name}」新版本 v${packageData.version_no}，旧版本仍保留`);
      } else {
        toast.success(`「${packageData.name}」更新成功`);
      }
    } catch (err) {
      toast.error(`更新失败: ` + (err instanceof Error ? err.message : "未知错误"));
      setShowUpdates((prev) => ({
        ...prev,
        [showId]: { ...prev[showId], updating: false },
      }));
    }
  }, [dirHandle, showUpdates]);

  // Delete a cached show
  const handleDelete = useCallback(async (showId: string) => {
    if (!dirHandle || !manifest) return;
    try {
      const granted = await ensurePermission(dirHandle);
      if (!granted) {
        toast.error("未获得文件夹读写权限");
        return;
      }
      await deleteShowCache(dirHandle, Number(showId));
      const newManifest = { ...manifest, shows: { ...manifest.shows } };
      delete newManifest.shows[showId];
      newManifest.generated_at = new Date().toISOString();
      await writeManifest(dirHandle, newManifest);
      setManifest(newManifest);
      setDeleteConfirm(null);
      toast.success("缓存已删除");
    } catch (err) {
      toast.error("删除失败: " + (err instanceof Error ? err.message : "未知错误"));
    }
  }, [dirHandle, manifest]);

  // Derived data: all shows as entries
  const shows = useMemo(() => {
    return manifest?.shows ? Object.entries(manifest.shows) : [];
  }, [manifest]);

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

      // Secrecy filter
      if (filters.secrecy !== "all") {
        const entrySecrecy = entry.secrecy_level || "public";
        if (entrySecrecy !== filters.secrecy) return false;
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
  const [grid, setGrid] = useState({ cols: 5, rows: 3 });
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const compute = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (!W || !H) return;
      const cols = W >= 1024 ? 5 : W >= 768 ? 4 : W >= 640 ? 3 : 2;
      const gapX = W >= 1280 ? 24 : W >= 1024 ? 20 : 16;
      const gapY = W >= 1280 ? 28 : W >= 1024 ? 24 : 20;
      const titleH = 88;
      const cardW = (W - gapX * (cols - 1)) / cols;
      const cardH = (cardW * 9) / 16 + titleH;
      const rows = Math.max(2, Math.min(4, Math.floor((H + gapY) / (cardH + gapY))));
      setGrid((prev) => (prev.cols === cols && prev.rows === rows ? prev : { cols, rows }));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pageSize = Math.max(6, grid.cols * grid.rows);
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);
  const pageStart = (page - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);

  // Filter helpers
  const isDirty =
    filters.query.trim() !== "" ||
    filters.status !== "all" ||
    filters.subject !== "all" ||
    filters.secrecy !== "all" ||
    filters.tags.length > 0;

  const resetFilters = () => setFilters(DEFAULT_FILTERS);
  const toggleTag = (t: string) => {
    setFilters((f) => ({
      ...f,
      tags: f.tags.includes(t) ? f.tags.filter((x) => x !== t) : [...f.tags, t],
    }));
  };

  // Browser not supported
  if (!supported) {
    const insecure = !isSecureContext();
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
        <AlertTriangle className="h-12 w-12 text-yellow-500" />
        {insecure ? (
          <>
            <h1 className="text-xl font-semibold">需要安全连接</h1>
            <div className="max-w-md text-center text-sm text-muted-foreground space-y-2">
              <p>离线缓存功能需要通过 HTTPS 或 localhost 访问站点才能使用。当前为非安全连接，请通过以下方式访问：</p>
              <ul className="list-disc list-inside text-left space-y-1">
                <li>https://your-domain.com</li>
                <li>http://localhost:端口号</li>
                <li>http://127.0.0.1:端口号</li>
              </ul>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold">浏览器不兼容</h1>
            <p className="max-w-md text-center text-sm text-muted-foreground">
              您的浏览器不支持 File System Access API，请使用 Chrome 86+ 或 Edge 86+ 浏览器访问此功能。
            </p>
          </>
        )}
      </div>
    );
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // No directory selected - guide user
  if (!dirHandle) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 p-6">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
          <FolderOpen className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="space-y-2 text-center">
          <h1 className="text-xl font-semibold">选择缓存文件夹</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            请选择一个本地文件夹用于存储离线缓存数据。选择后，您可以管理已缓存的放映仓库。
          </p>
        </div>
        <Button onClick={handlePickDirectory} className="gap-2">
          <FolderOpen className="h-4 w-4" />
          选择文件夹
        </Button>
      </div>
    );
  }

  const updatesAvailableCount = Object.values(showUpdates).filter((s) => s.hasUpdate).length;

  return (
    <div className="flex h-full flex-col gap-8">
      {/* Page header */}
      <header className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">离线缓存</h1>
          <p className="text-xs text-muted-foreground">
            管理本地缓存的放映仓库，使用筛选快速定位。
          </p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FolderOpen className="h-3.5 w-3.5" />
            <span>当前缓存目录：</span>
            <span
              className="max-w-[420px] truncate font-medium text-foreground"
              title={dirHandle.name}
            >
              {dirHandle.name}
            </span>
          </p>
        </div>
        <span className="inline-flex h-6 items-center rounded-full bg-muted px-2.5 text-xs text-muted-foreground">
          {filtered.length === shows.length
            ? `共 ${shows.length} 条`
            : `筛选后 ${filtered.length} / ${shows.length} 条`}
        </span>
      </header>

      {/* Filters bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filters.query}
            onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
            placeholder="搜索名称、关键词"
            className={cn(
              "h-8 w-56 rounded-full border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition",
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
        <FilterChip
          label="密级"
          options={OFFLINE_SECRECY_OPTIONS}
          value={filters.secrecy}
          onChange={(v) => setFilters((f) => ({ ...f, secrecy: v }))}
        />
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
            className="h-8 gap-1 rounded-full text-xs text-muted-foreground hover:text-primary"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            重置筛选
          </Button>
        )}

        {/* Right actions */}
        <div className="ml-auto flex items-center gap-2">
          {updateStatus === "checking" && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在检查...
            </span>
          )}
          {updateStatus === "done" && updatesAvailableCount > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-amber-600">
              {updatesAvailableCount} 个有更新
            </span>
          )}
          {updateStatus === "done" && updatesAvailableCount === 0 && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-600">
              <CheckCircle2 className="h-3.5 w-3.5" />
              全部最新
            </span>
          )}
          {shows.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={checkAllUpdates}
              disabled={updateStatus === "checking"}
              className="h-8 gap-1.5 rounded-full px-3 text-sm"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", updateStatus === "checking" && "animate-spin")} />
              检查全部更新
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handlePickDirectory}
            className="h-8 gap-1.5 rounded-full px-3 text-sm"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            更换文件夹
          </Button>
        </div>
      </div>

      {/* Content area */}
      <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">
            {shows.length === 0 ? "暂无缓存仓库" : "没有匹配的缓存项"}
          </div>
        ) : (
          <div className="grid grid-cols-2 content-start gap-x-4 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 lg:gap-x-5 lg:gap-y-6 xl:gap-x-6 xl:gap-y-7">
            {pageItems.map(([showId, entry]) => (
              <CacheCard
                key={showId}
                showId={showId}
                entry={entry}
                dirHandle={dirHandle}
                updateInfo={showUpdates[showId]}
                onFullscreen={() => {
                  window.open(
                    `/shows/${entry.id}/fullscreen?offline=true`,
                    "_blank",
                    "popup=yes,width=1920,height=1080"
                  );
                }}
                onPresent={() => {
                  window.open(
                    `/shows/${entry.id}/display?offline=true`,
                    "slideflow-display",
                    "popup=yes,width=1920,height=1080"
                  );
                  window.location.href = `/shows/${entry.id}/present?offline=true`;
                }}
                onDelete={() => setDeleteConfirm(showId)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {filtered.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t pt-3 text-sm text-muted-foreground">
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
            <span className="min-w-[52px] text-center text-foreground">
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
                  确定要删除「{manifest?.shows[deleteConfirm]?.name}」的离线缓存吗？此操作不可撤销。
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(null)}>
                  取消
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => handleDelete(deleteConfirm)}
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
              以下已缓存的放映库存在新版本，您可以选择是否将新版本缓存到本地。
            </DialogDescription>
          </DialogHeader>
          {(() => {
            const updatableEntries = Object.entries(showUpdates)
              .filter(([sid, info]) => info.hasUpdate && manifest?.shows[sid])
              .map(([sid, info]) => ({
                showId: sid,
                info,
                entry: manifest!.shows[sid],
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
                          <span className="text-amber-600">新版 v{info.remoteVersion}</span>
                        </div>
                        {info.updating && info.progress && (
                          <div className="mt-1.5 flex items-center gap-2">
                            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary transition-all duration-300"
                                style={{
                                  width: `${Math.round((info.progress.current / info.progress.total) * 100)}%`,
                                }}
                              />
                            </div>
                            <span className="text-[10px] text-muted-foreground">
                              {info.progress.current}/{info.progress.total}
                            </span>
                          </div>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={info.updating}
                        onClick={() => updateShow(showId, entry)}
                        className="shrink-0"
                      >
                        {info.updating ? (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            更新中
                          </>
                        ) : (
                          "更新此项"
                        )}
                      </Button>
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
                    disabled={anyUpdating}
                    onClick={async () => {
                      for (const { showId, entry } of updatableEntries) {
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
