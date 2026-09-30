import * as React from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Loader2,
  ChevronLeft,
  ChevronRight,
  SquareSlash,
  Settings2,
  Pen,
  CircleDot,
  Minus,
  Plus,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
  Pencil,
  Eraser,
  Trash2,
  LayoutGrid,
  LayoutList,
  GripHorizontal,
  Monitor,
  MonitorPlay,
  Maximize,
} from "lucide-react";
import { toast } from "sonner";

import { api, updateUserPreferences } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useShowPlayback } from "@/lib/use-show-playback";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
  PresentChannel,
  usePresentChannel,
  usePlaybackSessionId,
  type PresentMessage,
} from "@/lib/present-channel";
import {
  DrawingCanvas,
  type DrawingMode,
  type DrawingCanvasRef,
} from "@/components/present/DrawingCanvas";
import { Show, ShowResource, ShowResourceAccessible } from "@/lib/types";

// ─── Types ────────────────────────────────────────────────────────────

interface PresentSessionResponse {
  session_token: string;
}

interface ResourceDetailResponse {
  resource: {
    id: number;
    versions: Array<{
      id: number;
      version_no: number;
      common_remark_html: string | null;
    }>;
    can_manage: boolean;
  };
}

interface PersonalRemarkResponse {
  content_html: string | null;
}

interface ShowRemarkResponse {
  content_html: string | null;
}

function isAccessible(r: ShowResource): r is ShowResourceAccessible {
  return r.accessible === true;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function formatClock(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
}

// ─── Per-remark font size ─────────────────────────────────────────────

type RemarkKey = "common" | "personal" | "show";

const REMARK_FONT_KEYS: Record<RemarkKey, string> = {
  common: "presenter_font_common",
  personal: "presenter_font_personal",
  show: "presenter_font_show",
};

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 28;

function getRemarkFontSizesFromPrefs(prefs: Record<string, string>): Record<RemarkKey, number> {
  // prefs already combines server values and the current owner's local values.
  const sizes = {} as Record<RemarkKey, number>;
  for (const key of Object.keys(REMARK_FONT_KEYS) as RemarkKey[]) {
    const prefKey = REMARK_FONT_KEYS[key];
    if (prefs[prefKey]) {
      const n = parseInt(prefs[prefKey], 10);
      if (n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE) {
        sizes[key] = n;
        continue;
      }
    }
    sizes[key] = DEFAULT_FONT_SIZE;
  }
  return sizes;
}

function getRemarkExpandedFromPrefs(prefs: Record<string, string>): Record<RemarkKey, boolean> {
  return {
    common: prefs["presenter_expand_common"] !== "false",
    personal: prefs["presenter_expand_personal"] === "true",
    show: prefs["presenter_expand_show"] === "true",
  };
}

// ─── Panel ratio ──────────────────────────────────────────────────────

const PANEL_RATIO_KEY = "presenter_panel_ratio";
const DEFAULT_PANEL_RATIO = 70;
const MIN_PANEL_RATIO = 30;
const MAX_PANEL_RATIO = 80;

function getPanelRatioFromPrefs(prefs: Record<string, string>): number {
  if (prefs[PANEL_RATIO_KEY]) {
    const n = parseInt(prefs[PANEL_RATIO_KEY], 10);
    if (n >= MIN_PANEL_RATIO && n <= MAX_PANEL_RATIO) return n;
  }
  return DEFAULT_PANEL_RATIO;
}

const PANEL_SPLIT_RATIO_KEY = "presenter_split_ratio";
const DEFAULT_PANEL_SPLIT_RATIO = 50;
const MIN_PANEL_SPLIT_RATIO = 20;
const MAX_PANEL_SPLIT_RATIO = 80;

function getPanelSplitRatioFromPrefs(prefs: Record<string, string>): number {
  if (prefs[PANEL_SPLIT_RATIO_KEY]) {
    const n = parseInt(prefs[PANEL_SPLIT_RATIO_KEY], 10);
    if (n >= MIN_PANEL_SPLIT_RATIO && n <= MAX_PANEL_SPLIT_RATIO) return n;
  }
  return DEFAULT_PANEL_SPLIT_RATIO;
}

const RESOURCE_VIEW_KEY = "presenter_resource_view";
type ResourceViewMode = "list" | "grid";

function getResourceViewFromPrefs(prefs: Record<string, string>): ResourceViewMode {
  const v = prefs[RESOURCE_VIEW_KEY];
  if (v === "grid" || v === "list") return v;
  return "list";
}

// ─── Image fit mode ───────────────────────────────────────────────────

const IMAGE_FIT_KEY = "presenter_image_fit";
type ImageFitMode = "contain" | "fill";

function getImageFitFromPrefs(prefs: Record<string, string>): ImageFitMode {
  const v = prefs[IMAGE_FIT_KEY];
  if (v === "fill" || v === "contain") return v;
  return "contain"; // 默认固定比例
}

// ─── Colors ───────────────────────────────────────────────────────────

const PRESET_COLORS = [
  { color: "#ef4444", label: "红色" },
  { color: "#3b82f6", label: "蓝色" },
  { color: "#22c55e", label: "绿色" },
  { color: "#eab308", label: "黄色" },
  { color: "#ffffff", label: "白色" },
];

// ─── Main Component ───────────────────────────────────────────────────

export function PresenterPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const showId = id ? parseInt(id, 10) : 0;

  const [currentIndex, setCurrentIndex] = React.useState(0);
  const playback = useShowPlayback(showId, currentIndex);
  const { show, resources, offlineData, thumbsReady } = playback;
  const offline = playback.source === "cache";
  const playbackSession = usePlaybackSessionId();
  const writeAllowedRef = React.useRef(playback.canWrite);
  writeAllowedRef.current = playback.canWrite;
  const localPrefsKey = "slideflow-presenter-prefs:" + playback.ownerKey;
  const [localPrefs, setLocalPrefs] = React.useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(localPrefsKey) || "{}"); } catch { return {}; }
  });

  // ── Preferences ──
  const { data: prefsData } = useQuery({
    queryKey: ["user-preferences", playback.ownerKey],
    queryFn: ({ signal }) => api<{ preferences: Record<string, string> }>("/api/user/preferences", { signal }),
    enabled: playback.canWrite,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 60_000,
  });
  const prefs = React.useMemo(() => ({ ...localPrefs, ...prefsData?.preferences }), [localPrefs, prefsData]);

  const prefsMutation = useMutation({
    mutationFn: (updates: Record<string, string>) => {
      if (!writeAllowedRef.current) return Promise.resolve({ preferences: updates });
      return updateUserPreferences(updates);
    },
    onError: (err: Error) => toast.error(err.message || "保存偏好失败"),
  });

  const pendingPrefsRef = React.useRef<Record<string, string> | null>(null);
  const prefsDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const savePrefs = React.useCallback(
    (updates: Record<string, string>) => {
      setLocalPrefs(previous => {
        const next = { ...previous, ...updates };
        try { localStorage.setItem(localPrefsKey, JSON.stringify(next)); } catch { /* local quota */ }
        return next;
      });
      if (!writeAllowedRef.current) return;
      pendingPrefsRef.current = { ...(pendingPrefsRef.current ?? {}), ...updates };
      if (prefsDebounceRef.current) clearTimeout(prefsDebounceRef.current);
      prefsDebounceRef.current = setTimeout(() => {
        if (pendingPrefsRef.current && writeAllowedRef.current) prefsMutation.mutate(pendingPrefsRef.current);
        pendingPrefsRef.current = null;
      }, 500);
    },
    [prefsMutation, localPrefsKey],
  );
  React.useEffect(() => () => {
    if (prefsDebounceRef.current) clearTimeout(prefsDebounceRef.current);
    pendingPrefsRef.current = null;
    void queryClient.cancelQueries({ queryKey: ["user-preferences", playback.ownerKey] });
  }, [playback.canWrite, playback.ownerKey, queryClient]);

  // ── State ──
  const [drawingMode, setDrawingMode] = React.useState<DrawingMode>("none");
  const [penColor, setPenColor] = React.useState("#ef4444");
  const [remarkFontSizes, setRemarkFontSizes] = React.useState<Record<RemarkKey, number>>({
    common: DEFAULT_FONT_SIZE,
    personal: DEFAULT_FONT_SIZE,
    show: DEFAULT_FONT_SIZE,
  });
  const [remarksExpanded, setRemarksExpanded] = React.useState<Record<RemarkKey, boolean>>({
    common: true,
    personal: false,
    show: false,
  });
  const [confirmEnd, setConfirmEnd] = React.useState(false);
  const [imageLoading, setImageLoading] = React.useState(true);
  const [panelRatio, setPanelRatio] = React.useState(DEFAULT_PANEL_RATIO);
  const [panelSplitRatio, setPanelSplitRatio] = React.useState(DEFAULT_PANEL_SPLIT_RATIO);
  const [resourceViewMode, setResourceViewMode] = React.useState<ResourceViewMode>("list");
  const [imageFit, setImageFit] = React.useState<ImageFitMode>("contain");
  const [pageJumpOpen, setPageJumpOpen] = React.useState(false);
  const [pageJumpValue, setPageJumpValue] = React.useState("");
  const pageJumpInputRef = React.useRef<HTMLInputElement>(null);

  // Apply preferences when loaded (only once)
  // 设计意图：API 加载完成后同步写回 localStorage，使之作为本地回退缓存，
  // 下次冷启动/离线场景可以快速拿到最新偏好。仅同步读取到的有效值，
  // 避免后端未设置时覆盖本地已有的 fallback。
  const prefsAppliedRef = React.useRef(false);
  React.useEffect(() => {
    prefsAppliedRef.current = false;
    try { setLocalPrefs(JSON.parse(localStorage.getItem(localPrefsKey) || "{}")); } catch { setLocalPrefs({}); }
  }, [localPrefsKey]);
  React.useEffect(() => {
    if ((prefsData || offline) && !prefsAppliedRef.current) {
      prefsAppliedRef.current = true;
      const panel = getPanelRatioFromPrefs(prefs);
      const split = getPanelSplitRatioFromPrefs(prefs);
      const view = getResourceViewFromPrefs(prefs);
      const fit = getImageFitFromPrefs(prefs);
      const fontSizes = getRemarkFontSizesFromPrefs(prefs);
      const expanded = getRemarkExpandedFromPrefs(prefs);
      setPanelRatio(panel);
      setPanelSplitRatio(split);
      setResourceViewMode(view);
      setImageFit(fit);
      setRemarkFontSizes(fontSizes);
      setRemarksExpanded(expanded);
      // 同步 API 成功返回的值到 localStorage。
      try {
        localStorage.setItem(localPrefsKey, JSON.stringify(prefs));
      } catch {
        /* ignore quota / privacy mode errors */
      }
    }
  }, [prefsData, prefs, offline, localPrefsKey]);

  const canvasRef = React.useRef<DrawingCanvasRef>(null);
  const slideImageRef = React.useRef<HTMLImageElement>(null);
  const displayWindowRef = React.useRef<Window | null>(null);
  const channelRef = usePresentChannel(showId, show ? { ownerKey: playback.ownerKey, sessionId: playbackSession, packageId: playback.packageId } : undefined);
  const sessionStartRef = React.useRef(Date.now());
  const dragStartRef = React.useRef<{ x: number; ratio: number } | null>(null);
  const vDragStartRef = React.useRef<{ y: number; ratio: number } | null>(null);
  const rightPanelRef = React.useRef<HTMLDivElement>(null);

  const canManage = playback.canWrite && (show?.can_manage ?? false);
  const currentResource = resources[currentIndex] ?? null;

  // ── Time display ──
  const [clock, setClock] = React.useState(formatClock(new Date()));
  const [elapsed, setElapsed] = React.useState("00:00:00");

  React.useEffect(() => {
    const timer = setInterval(() => {
      setClock(formatClock(new Date()));
      const secs = Math.floor((Date.now() - sessionStartRef.current) / 1000);
      setElapsed(formatTime(secs));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // ── BroadcastChannel listener ──
  React.useEffect(() => {
    const ch = channelRef.current;
    if (!ch) return;
    const unsub = ch.onMessage((msg: PresentMessage) => {
      if (msg.type === "request-sync") {
        ch.send({
          type: "sync-state",
          resourceId: currentResource?.id ?? 0,
          index: currentIndex,
          source: playback.source,
          packageId: playback.packageId,
          snapshot: playback.snapshot,
          imageFit,
        });
      }
    });
    return unsub;
  }, [channelRef, currentResource, currentIndex, imageFit, playback.source, playback.packageId, playback.snapshot, playback.ownerKey]);

  const displayUrl = React.useMemo(() => {
    const params = new URLSearchParams({ playback_session: playbackSession, source: playback.source });
    if (playback.packageId) params.set("package_id", playback.packageId);
    if (playback.source === "cache") params.set("offline", "true");
    return "/shows/" + showId + "/display?" + params.toString();
  }, [showId, playbackSession, playback.source, playback.packageId]);
  const openDisplay = React.useCallback(() => {
    const display = window.open(displayUrl, "slideflow-display-" + playbackSession, "popup=yes,width=1920,height=1080");
    if (display) displayWindowRef.current = display;
    else toast.info("浏览器已拦截用户视图窗口，请点击“用户视图”重新打开");
  }, [displayUrl, playbackSession]);
  const openedRef = React.useRef(false);
  React.useEffect(() => {
    if (!show || playback.loading || playback.error || openedRef.current) return;
    openedRef.current = true;
    openDisplay();
  }, [show, playback.loading, playback.error, openDisplay]);
  // Push a full source snapshot after fallback as well as on first connection.
  React.useEffect(() => {
    if (!show || !currentResource) return;
    channelRef.current?.send({ type: "sync-state", resourceId: currentResource.id, index: currentIndex,
      source: playback.source, packageId: playback.packageId, snapshot: playback.snapshot, imageFit });
  }, [show, currentResource, currentIndex, playback.source, playback.packageId, playback.snapshot, imageFit, channelRef]);
  React.useEffect(() => { setImageLoading(true); }, [currentIndex, playback.imageUrl]);

  // ── Slide change helper ──
  const goToSlide = React.useCallback(
    (index: number) => {
      if (index < 0 || index >= resources.length) return;
      setCurrentIndex(index);
      const res = resources[index];
      if (!res || !isAccessible(res)) return;
      channelRef.current?.send({
        type: "slide-change",
        resourceId: res.id,
        index,
      });
    },
    [resources, channelRef],
  );

  const goNext = React.useCallback(() => {
    for (let i = currentIndex + 1; i < resources.length; i++) {
      if (!resources[i].hidden) {
        goToSlide(i);
        return;
      }
    }
  }, [currentIndex, resources, goToSlide]);

  const goPrev = React.useCallback(() => {
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (!resources[i].hidden) {
        goToSlide(i);
        return;
      }
    }
  }, [currentIndex, resources, goToSlide]);

  // ── Page jump ──
  const openPageJump = React.useCallback(() => {
    setPageJumpValue(String(currentIndex + 1));
    setPageJumpOpen(true);
    // Focus input on next tick (after render)
    setTimeout(() => pageJumpInputRef.current?.select(), 0);
  }, [currentIndex]);

  const commitPageJump = React.useCallback(() => {
    const num = parseInt(pageJumpValue, 10);
    if (!isNaN(num) && num >= 1 && num <= resources.length) {
      goToSlide(num - 1);
    }
    setPageJumpOpen(false);
  }, [pageJumpValue, resources.length, goToSlide]);

  // ── Drawing callbacks (send to Display via BroadcastChannel) ──
  const handlePenDraw = React.useCallback(
    (points: { x: number; y: number }[], color: string, width: number) => {
      channelRef.current?.send({ type: "pen-draw", points, color, width });
    },
    [channelRef],
  );

  const handleLaserMove = React.useCallback(
    (x: number, y: number, visible: boolean) => {
      channelRef.current?.send({ type: "laser-move", x, y, visible });
    },
    [channelRef],
  );

  const handlePenClear = React.useCallback(() => {
    channelRef.current?.send({ type: "pen-clear" });
  }, [channelRef]);

  const handlePenErase = React.useCallback(
    (index: number) => {
      channelRef.current?.send({ type: "pen-erase", index });
    },
    [channelRef],
  );

  // ── Clear all (clear screen button) ──
  const handleClearAll = React.useCallback(() => {
    canvasRef.current?.clearAll();
    channelRef.current?.send({ type: "pen-clear" });
  }, [channelRef]);

  // ── Keyboard shortcuts ──
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      switch (e.key) {
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          goPrev();
          break;
        case "ArrowRight":
        case "PageDown":
          e.preventDefault();
          goNext();
          break;
        case "l":
        case "L":
          e.preventDefault();
          setDrawingMode((prev) => (prev === "laser" ? "none" : "laser"));
          break;
        case "p":
        case "P":
          e.preventDefault();
          setDrawingMode((prev) => (prev === "pen" ? "none" : "pen"));
          break;
        case "e":
        case "E":
          e.preventDefault();
          setDrawingMode((prev) => (prev === "eraser" ? "none" : "eraser"));
          break;
        case "Escape":
          e.preventDefault();
          if (pageJumpOpen) {
            setPageJumpOpen(false);
          } else {
            setConfirmEnd(true);
          }
          break;
        case "g":
        case "G":
          e.preventDefault();
          openPageJump();
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goNext, goPrev, pageJumpOpen, openPageJump]);

  // ── End session ──
  const endPresentation = React.useCallback(() => {
    channelRef.current?.send({ type: "session-end" });
    if (displayWindowRef.current && !displayWindowRef.current.closed) {
      displayWindowRef.current.close();
    }
    navigate("/shows");
  }, [channelRef, navigate]);

  // ── Remark toggle (independent) ──
  const toggleRemark = React.useCallback(
    (key: RemarkKey) => {
      setRemarksExpanded((prev) => {
        const next = { ...prev, [key]: !prev[key] };
        savePrefs({ [`presenter_expand_${key}`]: String(next[key]) });
        return next;
      });
    },
    [savePrefs],
  );

  // ── Vertical panel drag (resource list vs remarks) ──
  const handleVSplitterMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      vDragStartRef.current = { y: e.clientY, ratio: panelSplitRatio };

      const onMouseMove = (ev: MouseEvent) => {
        if (!vDragStartRef.current) return;
        const dy = ev.clientY - vDragStartRef.current.y;
        const containerHeight = rightPanelRef.current?.clientHeight ?? window.innerHeight * 0.6;
        const newRatio = Math.max(
          MIN_PANEL_SPLIT_RATIO,
          Math.min(
            MAX_PANEL_SPLIT_RATIO,
            vDragStartRef.current.ratio + (dy / containerHeight) * 100,
          ),
        );
        setPanelSplitRatio(newRatio);
      };

      const onMouseUp = () => {
        vDragStartRef.current = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setPanelSplitRatio((r) => {
          savePrefs({ [PANEL_SPLIT_RATIO_KEY]: String(Math.round(r)) });
          return r;
        });
      };

      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [panelSplitRatio, savePrefs],
  );

  // ── Per-remark font size ──
  const changeRemarkFontSize = React.useCallback(
    (key: RemarkKey, delta: number) => {
      setRemarkFontSizes((prev) => {
        const next = {
          ...prev,
          [key]: Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, prev[key] + delta)),
        };
        savePrefs({ [REMARK_FONT_KEYS[key]]: String(next[key]) });
        return next;
      });
    },
    [savePrefs],
  );

  // ── Panel drag ──
  const handleSplitterMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragStartRef.current = { x: e.clientX, ratio: panelRatio };

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragStartRef.current) return;
        const dx = ev.clientX - dragStartRef.current.x;
        const containerWidth = window.innerWidth;
        const newRatio = Math.max(
          MIN_PANEL_RATIO,
          Math.min(
            MAX_PANEL_RATIO,
            dragStartRef.current.ratio + (dx / containerWidth) * 100,
          ),
        );
        setPanelRatio(newRatio);
      };

      const onMouseUp = () => {
        dragStartRef.current = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setPanelRatio((r) => {
          savePrefs({ [PANEL_RATIO_KEY]: String(r) });
          return r;
        });
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [panelRatio],
  );

  const currentImageUrl = playback.imageUrl;
  const nextIndex = resources.findIndex((resource, index) => index > currentIndex && !resource.hidden && resource.accessible);
  const nextResource = nextIndex >= 0 ? resources[nextIndex] : null;
  const nextImageUrl = nextResource?.accessible ? nextResource.preview_url : null;

  // ── Render ──

  if (!showId) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-900 text-white">
        无效的放映 ID
      </div>
    );
  }

  if (playback.loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-900 text-white">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400 mr-3" />
        正在加载放映…
      </div>
    );
  }

  if (playback.error || !show) {
    return <div className="flex h-screen flex-col items-center justify-center gap-4 bg-gray-900 text-white">
      <p role="alert">{playback.error || "放映不可用"}</p>
      <Button onClick={() => navigate("/shows")}>返回放映</Button>
    </div>;
  }

  return (
    <div className="flex h-screen flex-col bg-gray-900 text-white overflow-hidden">
      {/* ── Top bar ── */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-700 bg-gray-800 px-3 py-2 sm:px-4">
        <div className="flex items-center gap-6 text-sm font-mono tabular-nums">
          <span>{clock}</span>
          <span className="hidden text-gray-400 sm:inline">已演讲 {elapsed}</span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            onClick={openDisplay}
            className="rounded bg-gray-700 px-3 py-1.5 text-sm hover:bg-gray-600 transition flex items-center gap-1.5"
            title="打开用户视图窗口"
          >
            <MonitorPlay className="inline h-4 w-4" />
            <span className="hidden sm:inline">用户视图</span>
          </button>
          <button
            onClick={() => {
              const next: ImageFitMode = imageFit === "contain" ? "fill" : "contain";
              setImageFit(next);
              savePrefs({ [IMAGE_FIT_KEY]: next });
              channelRef.current?.send({ type: "image-fit-change", imageFit: next });
            }}
            className="rounded bg-gray-700 px-3 py-1.5 text-sm hover:bg-gray-600 transition flex items-center gap-1.5"
            title={imageFit === "contain" ? "当前：固定比例（点击切换为自适应）" : "当前：自适应（点击切换为固定比例）"}
          >
            {imageFit === "contain" ? (
              <>
                <Monitor className="inline h-4 w-4" />
                <span className="hidden sm:inline">固定比例</span>
              </>
            ) : (
              <>
                <Maximize className="inline h-4 w-4" />
                <span className="hidden sm:inline">自适应</span>
              </>
            )}
          </button>
          <button
            onClick={() => setConfirmEnd(true)}
            className="rounded bg-red-700 px-3 py-1.5 text-sm hover:bg-red-600 transition"
          >
            <SquareSlash className="mr-1 inline h-4 w-4" />
            <span className="hidden sm:inline">结束放映</span>
          </button>
          <Popover>
            <PopoverTrigger asChild>
              <button className="rounded bg-gray-700 px-3 py-1.5 text-sm hover:bg-gray-600 transition">
                <Settings2 className="inline h-4 w-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={6}
              className="w-80 border-gray-700 bg-gray-800 text-gray-100 shadow-xl"
            >
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-100">偏好设置</h3>

                {/* Left/Right panel ratio */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">左右面板比例</label>
                    <span className="text-xs tabular-nums text-gray-300">{panelRatio}%</span>
                  </div>
                  <input
                    type="range"
                    min={MIN_PANEL_RATIO}
                    max={MAX_PANEL_RATIO}
                    value={panelRatio}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      setPanelRatio(v);
                      savePrefs({ [PANEL_RATIO_KEY]: String(v) });
                    }}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded bg-gray-600 accent-blue-500"
                  />
                </div>

                {/* Resource/Remarks split ratio */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">资源列表与备注比例</label>
                    <span className="text-xs tabular-nums text-gray-300">{Math.round(panelSplitRatio)}%</span>
                  </div>
                  <input
                    type="range"
                    min={MIN_PANEL_SPLIT_RATIO}
                    max={MAX_PANEL_SPLIT_RATIO}
                    value={Math.round(panelSplitRatio)}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      setPanelSplitRatio(v);
                      savePrefs({ [PANEL_SPLIT_RATIO_KEY]: String(v) });
                    }}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded bg-gray-600 accent-blue-500"
                  />
                </div>

                {/* Resource view mode */}
                <div className="flex items-center justify-between">
                  <label className="text-xs text-gray-400">资源列表视图</label>
                  <div className="flex rounded bg-gray-700 p-0.5">
                    <button
                      onClick={() => {
                        setResourceViewMode("list");
                        savePrefs({ [RESOURCE_VIEW_KEY]: "list" });
                      }}
                      className={cn(
                        "flex items-center gap-1 rounded px-2 py-1 text-xs transition",
                        resourceViewMode === "list"
                          ? "bg-gray-600 text-white"
                          : "text-gray-400 hover:text-gray-200",
                      )}
                    >
                      <LayoutList className="h-3 w-3" />
                      列表
                    </button>
                    <button
                      onClick={() => {
                        setResourceViewMode("grid");
                        savePrefs({ [RESOURCE_VIEW_KEY]: "grid" });
                      }}
                      className={cn(
                        "flex items-center gap-1 rounded px-2 py-1 text-xs transition",
                        resourceViewMode === "grid"
                          ? "bg-gray-600 text-white"
                          : "text-gray-400 hover:text-gray-200",
                      )}
                    >
                      <LayoutGrid className="h-3 w-3" />
                      网格
                    </button>
                  </div>
                </div>

                {/* Image fit mode */}
                <div className="flex items-center justify-between">
                  <label className="text-xs text-gray-400">图片显示模式</label>
                  <div className="flex rounded bg-gray-700 p-0.5">
                    <button
                      onClick={() => {
                        setImageFit("contain");
                        savePrefs({ [IMAGE_FIT_KEY]: "contain" });
                        channelRef.current?.send({ type: "image-fit-change", imageFit: "contain" });
                      }}
                      className={cn(
                        "flex items-center gap-1 rounded px-2 py-1 text-xs transition",
                        imageFit === "contain"
                          ? "bg-gray-600 text-white"
                          : "text-gray-400 hover:text-gray-200",
                      )}
                    >
                      <Monitor className="h-3 w-3" />
                      固定比例
                    </button>
                    <button
                      onClick={() => {
                        setImageFit("fill");
                        savePrefs({ [IMAGE_FIT_KEY]: "fill" });
                        channelRef.current?.send({ type: "image-fit-change", imageFit: "fill" });
                      }}
                      className={cn(
                        "flex items-center gap-1 rounded px-2 py-1 text-xs transition",
                        imageFit === "fill"
                          ? "bg-gray-600 text-white"
                          : "text-gray-400 hover:text-gray-200",
                      )}
                    >
                      <Maximize className="h-3 w-3" />
                      自适应
                    </button>
                  </div>
                </div>

                {/* Default expand remarks */}
                <div className="space-y-2">
                  <label className="text-xs text-gray-400">默认展开备注</label>
                  {(["common", "personal", "show"] as RemarkKey[]).map((key) => (
                    <div key={key} className="flex items-center justify-between">
                      <span className="text-xs text-gray-300">
                        {key === "common" ? "通用备注" : key === "personal" ? "个人备注" : "放映备注"}
                      </span>
                      <Switch
                        checked={remarksExpanded[key]}
                        onCheckedChange={() => toggleRemark(key)}
                        className="data-[state=checked]:bg-blue-500"
                      />
                    </div>
                  ))}
                </div>

                {/* Remark font sizes */}
                <div className="space-y-2">
                  <label className="text-xs text-gray-400">备注字号</label>
                  {(["common", "personal", "show"] as RemarkKey[]).map((key) => (
                    <div key={key} className="flex items-center justify-between">
                      <span className="text-xs text-gray-300">
                        {key === "common" ? "通用备注" : key === "personal" ? "个人备注" : "放映备注"}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => changeRemarkFontSize(key, -1)}
                          className="rounded p-0.5 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <span className="w-5 text-center text-xs tabular-nums text-gray-300">
                          {remarkFontSizes[key]}
                        </span>
                        <button
                          onClick={() => changeRemarkFontSize(key, 1)}
                          className="rounded p-0.5 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

              </div>
            </PopoverContent>
          </Popover>
        </div>
      </header>

      {/* ── Main area ── */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Left: main display + toolbar */}
        <div
          className="presenter-main-panel flex min-h-0 min-w-0 flex-1 flex-col md:flex-none"
          style={{ flex: `0 0 ${panelRatio}%` }}
        >
          {/* Main display */}
          <div className="relative min-h-0 flex-1 bg-black flex items-center justify-center">

              <>
                {/* 16:9 aspect-ratio container - centered in the left panel */}
                <div
                  className="relative w-full h-full max-w-full max-h-full"
                  style={{ aspectRatio: "16/9" }}
                >
                  {!currentImageUrl && <div className="absolute inset-0 flex items-center justify-center text-gray-500">
                    {resources.length === 0 ? "无可用资源" : currentResource && !currentResource.accessible ? "无权限查看此幻灯片" : "加载中…"}
                  </div>}
                  {currentImageUrl && imageLoading && (
                    <div className="absolute inset-0 flex items-center justify-center z-10">
                      <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
                    </div>
                  )}
                  {currentImageUrl && <img
                    ref={slideImageRef}
                    src={currentImageUrl}
                    alt={
                      currentResource && isAccessible(currentResource)
                        ? currentResource.name
                        : "幻灯片"
                    }
                    className={`absolute inset-0 w-full h-full ${imageFit === "contain" ? "object-contain" : "object-fill"}`}
                    draggable={false}
                    onLoad={() => setImageLoading(false)}
                    onError={() => { setImageLoading(false); playback.reportImageError(); }}
                  />}
                  <DrawingCanvas
                    ref={canvasRef}
                    mode={currentImageUrl ? drawingMode : "none"}
                    penColor={penColor}
                    onPenDraw={handlePenDraw}
                    onLaserMove={handleLaserMove}
                    onPenErase={handlePenErase}
                    onPenClear={handlePenClear}
                    className="absolute inset-0"
                    imageElement={imageFit === "contain" ? slideImageRef.current : undefined}
                  />
                  {/* Click zones for navigation (only in none mode) */}
                  {drawingMode === "none" && (
                    <>
                      <div
                        className="absolute left-0 top-0 h-full w-1/4 z-10"
                        onClick={goPrev}
                      />
                      <div
                        className="absolute right-0 top-0 h-full w-1/4 z-10"
                        onClick={goNext}
                      />
                    </>
                  )}
                </div>
              </>
          </div>

          {/* Toolbar */}
          <div className="flex shrink-0 flex-wrap items-center gap-3 overflow-x-auto border-t border-gray-700 bg-gray-800 px-3 py-2 sm:px-4">
            {/* Drawing tools */}
            <button
              onClick={() =>
                setDrawingMode((prev) => (prev === "laser" ? "none" : "laser"))
              }
              className={cn(
                "flex items-center gap-1 rounded px-2.5 py-1.5 text-sm transition",
                drawingMode === "laser"
                  ? "bg-red-600 text-white"
                  : "bg-gray-700 text-gray-300 hover:bg-gray-600",
              )}
              title="激光笔 (L)"
            >
              <CircleDot className="h-4 w-4" />
              激光笔
            </button>
            <button
              onClick={() =>
                setDrawingMode((prev) => (prev === "pen" ? "none" : "pen"))
              }
              className={cn(
                "flex items-center gap-1 rounded px-2.5 py-1.5 text-sm transition",
                drawingMode === "pen"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-700 text-gray-300 hover:bg-gray-600",
              )}
              title="钢笔 (P)"
            >
              <Pen className="h-4 w-4" />
              钢笔
            </button>
            <button
              onClick={() =>
                setDrawingMode((prev) =>
                  prev === "eraser" ? "none" : "eraser",
                )
              }
              className={cn(
                "flex items-center gap-1 rounded px-2.5 py-1.5 text-sm transition",
                drawingMode === "eraser"
                  ? "bg-yellow-600 text-white"
                  : "bg-gray-700 text-gray-300 hover:bg-gray-600",
              )}
              title="橡皮擦 (E)"
            >
              <Eraser className="h-4 w-4" />
              橡皮擦
            </button>
            <button
              onClick={handleClearAll}
              className="flex items-center gap-1 rounded bg-gray-700 px-2.5 py-1.5 text-sm text-gray-300 hover:bg-gray-600 transition"
              title="清屏"
            >
              <Trash2 className="h-4 w-4" />
              清屏
            </button>

            {/* Color picker */}
            <div className="flex items-center gap-1.5 border-l border-gray-600 pl-3">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c.color}
                  onClick={() => setPenColor(c.color)}
                  className={cn(
                    "h-5 w-5 rounded-full border-2 transition",
                    penColor === c.color
                      ? "border-white scale-110"
                      : "border-gray-500 hover:border-gray-300",
                  )}
                  style={{ backgroundColor: c.color }}
                  title={c.label}
                />
              ))}
            </div>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Navigation */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={goPrev}
                disabled={currentIndex <= 0}
                className="rounded bg-gray-700 p-1.5 text-gray-300 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition"
                title="上一页"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              {pageJumpOpen ? (
                <input
                  ref={pageJumpInputRef}
                  type="text"
                  inputMode="numeric"
                  value={pageJumpValue}
                  onChange={(e) => setPageJumpValue(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); commitPageJump(); }
                    if (e.key === "Escape") { e.preventDefault(); setPageJumpOpen(false); }
                  }}
                  onBlur={commitPageJump}
                  className="w-12 rounded bg-gray-700 px-1.5 py-0.5 text-center text-sm tabular-nums text-white outline-none ring-1 ring-blue-500"
                  autoFocus
                />
              ) : (
                <button
                  onClick={openPageJump}
                  className="min-w-[60px] text-center text-sm tabular-nums text-gray-300 hover:text-white transition cursor-pointer"
                  title="点击跳转页码 (G)"
                >
                  {currentIndex + 1} / {resources.length}
                </button>
              )}
              <button
                onClick={goNext}
                disabled={currentIndex >= resources.length - 1}
                className="rounded bg-gray-700 p-1.5 text-gray-300 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition"
                title="下一页"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Draggable splitter */}
        <div
          className="hidden shrink-0 cursor-col-resize bg-gray-700 transition-colors hover:bg-blue-500 md:block"
          style={{ width: 4 }}
          onMouseDown={handleSplitterMouseDown}
        />

        {/* Right: next preview + resource list + remarks */}
        <aside ref={rightPanelRef} className="flex min-h-[min(28vh,260px)] min-w-0 flex-1 flex-col border-t border-gray-700 bg-gray-800 md:min-h-0 md:border-l md:border-t-0">
          {/* Next preview (moved to top) */}
          <div className="shrink-0 border-b border-gray-700 p-3">
            <div className="mb-1.5 text-xs text-gray-400">下一张预览</div>
            {nextResource && isAccessible(nextResource) && nextImageUrl ? (
              <div className="relative aspect-[16/9] w-full overflow-hidden rounded bg-gray-900">
                <img
                  src={nextImageUrl}
                  alt={nextResource.name}
                  className="absolute inset-0 h-full w-full object-contain"
                />
              </div>
            ) : (
              <div className="flex aspect-[16/9] w-full items-center justify-center rounded bg-gray-900 text-xs text-gray-500">
                {currentIndex >= resources.length - 1
                  ? "已是最后一页"
                  : "无预览"}
              </div>
            )}
          </div>

          {/* Resource list + splitter + remarks */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* Resource list */}
            <div
              className="flex min-h-0 flex-col overflow-hidden"
              style={{ flex: `0 0 ${panelSplitRatio}%` }}
            >
            <div className="flex shrink-0 items-center justify-between border-b border-gray-700 px-3 py-2">
              <span className="text-xs text-gray-400">资源列表</span>
              <div className="flex rounded bg-gray-700 p-0.5">
                <button
                  onClick={() => {
                    setResourceViewMode("list");
                    savePrefs({ [RESOURCE_VIEW_KEY]: "list" });
                  }}
                  className={cn(
                    "rounded p-1 transition",
                    resourceViewMode === "list" ? "bg-gray-600 text-white" : "text-gray-400 hover:text-gray-200",
                  )}
                  title="列表视图"
                >
                  <LayoutList className="h-3 w-3" />
                </button>
                <button
                  onClick={() => {
                    setResourceViewMode("grid");
                    savePrefs({ [RESOURCE_VIEW_KEY]: "grid" });
                  }}
                  className={cn(
                    "rounded p-1 transition",
                    resourceViewMode === "grid" ? "bg-gray-600 text-white" : "text-gray-400 hover:text-gray-200",
                  )}
                  title="网格视图"
                >
                  <LayoutGrid className="h-3 w-3" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {resourceViewMode === "list" ? (
                resources.map((r, idx) => {
                  const active = idx === currentIndex;
                  const accessible = isAccessible(r);
                  return (
                    <button
                      key={r.id}
                      onClick={() => goToSlide(idx)}
                      className={cn(
                        "flex w-full items-center gap-2 border-b border-gray-700/50 px-3 py-2 text-left transition",
                        active
                          ? "bg-blue-900/40 text-white"
                          : "text-gray-300 hover:bg-gray-700/50",
                      )}
                    >
                      <span className="w-5 shrink-0 text-center text-xs tabular-nums text-gray-500">
                        {idx + 1}
                      </span>
                      <div className="relative h-9 w-16 shrink-0 overflow-hidden rounded bg-gray-900">
                        {accessible ? (
                          thumbsReady ? (
                            <img
                              src={r.preview_url || ""}
                              loading="lazy"
                              alt={r.name}
                              className="absolute inset-0 h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center bg-gray-800">
                              <Loader2 className="h-3 w-3 animate-spin text-gray-500" />
                            </div>
                          )
                        ) : (
                          <div className="flex h-full items-center justify-center text-[10px] text-gray-600">
                            锁定
                          </div>
                        )}
                        {r.hidden && (
                          <div className="absolute inset-0 bg-gray-500/40 pointer-events-none rounded" />
                        )}
                      </div>
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {r.name}
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="grid grid-cols-3 gap-1 p-2">
                  {resources.map((r, idx) => {
                    const active = idx === currentIndex;
                    const accessible = isAccessible(r);
                    return (
                      <button
                        key={r.id}
                        onClick={() => goToSlide(idx)}
                        className={cn(
                          "group relative aspect-video overflow-hidden rounded bg-gray-900 transition",
                          active ? "ring-2 ring-blue-500" : "hover:ring-1 hover:ring-gray-500",
                        )}
                        title={r.name}
                      >
                        {accessible ? (
                          thumbsReady ? (
                            <img
                              src={r.preview_url || ""}
                              loading="lazy"
                              alt={r.name}
                              className="absolute inset-0 h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center bg-gray-800">
                              <Loader2 className="h-4 w-4 animate-spin text-gray-500" />
                            </div>
                          )
                        ) : (
                          <div className="flex h-full items-center justify-center text-[10px] text-gray-600">
                            锁定
                          </div>
                        )}
                        <div className="absolute bottom-0 left-0 right-0 truncate bg-black/60 px-1 py-0.5 text-[10px] text-gray-200 opacity-0 transition group-hover:opacity-100">
                          {idx + 1}. {r.name}
                        </div>
                        {active && (
                          <div className="absolute right-1 top-1 rounded bg-blue-600 px-1 py-0.5 text-[9px] text-white">
                            当前
                          </div>
                        )}
                        {r.hidden && (
                          <div className="absolute inset-0 bg-gray-500/40 pointer-events-none rounded" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Vertical splitter */}
          <div
            className="shrink-0 cursor-row-resize bg-gray-700 hover:bg-blue-500 transition-colors flex items-center justify-center"
            style={{ height: 4 }}
            onMouseDown={handleVSplitterMouseDown}
          >
            <GripHorizontal className="h-3 w-3 text-gray-500 hover:text-white" />
          </div>

          {/* Remarks */}
          <div
            className="flex min-h-0 flex-col border-t border-gray-700"
            style={{ flex: `1 1 ${100 - panelSplitRatio}%` }}
          >
            <div className="flex items-center justify-between border-b border-gray-700 px-3 py-2">
              <span className="text-xs text-gray-400">备注</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {currentResource && isAccessible(currentResource) ? (
                <>
                  <RemarkSection
                    key={`common-${currentResource.id}`}
                    title="通用备注"
                    expanded={remarksExpanded.common}
                    onToggle={() => toggleRemark("common")}
                    resourceId={currentResource.id}
                    showId={showId}
                    type="common"
                    canManage={canManage}
                    fontSize={remarkFontSizes.common}
                    onChangeFontSize={(delta) =>
                      changeRemarkFontSize("common", delta)
                    }
                    networkEnabled={playback.canWrite}
                    ownerKey={playback.ownerKey}
                    resourceVersion={currentResource.version_no}
                    offlineHtml={offlineData ? (offlineData.showInfo.resources[currentIndex]?.common_remark_html || '') : !playback.canWrite ? '' : undefined}
                  />
                  <RemarkSection
                    key={`personal-${currentResource.id}`}
                    title="个人备注"
                    expanded={remarksExpanded.personal}
                    onToggle={() => toggleRemark("personal")}
                    resourceId={currentResource.id}
                    showId={showId}
                    type="personal"
                    canManage={playback.canWrite}
                    fontSize={remarkFontSizes.personal}
                    onChangeFontSize={(delta) =>
                      changeRemarkFontSize("personal", delta)
                    }
                    networkEnabled={playback.canWrite}
                    ownerKey={playback.ownerKey}
                    resourceVersion={currentResource.version_no}
                    offlineHtml={offlineData ? (offlineData.showInfo.resources[currentIndex]?.personal_remark_html || '') : !playback.canWrite ? '' : undefined}
                  />
                  <RemarkSection
                    key={`show-${showId}-${currentResource.id}`}
                    title="放映备注"
                    expanded={remarksExpanded.show}
                    onToggle={() => toggleRemark("show")}
                    resourceId={currentResource.id}
                    showId={showId}
                    type="show"
                    canManage={canManage}
                    fontSize={remarkFontSizes.show}
                    onChangeFontSize={(delta) =>
                      changeRemarkFontSize("show", delta)
                    }
                    networkEnabled={playback.canWrite}
                    ownerKey={playback.ownerKey}
                    resourceVersion={currentResource.version_no}
                    offlineHtml={offlineData ? (offlineData.showInfo.resources[currentIndex]?.show_remark_html || '') : !playback.canWrite ? '' : undefined}
                  />
                </>
              ) : (
                <div className="px-3 py-4 text-center text-xs text-gray-500">
                  {currentResource
                    ? "无权限查看备注"
                    : "选择资源以查看备注"}
                </div>
              )}
            </div>
          </div>
          </div>
        </aside>
      </div>

      {/* ── Confirm end dialog ── */}
      {confirmEnd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-80 rounded-lg bg-gray-800 p-6 shadow-2xl">
            <h3 className="text-lg font-medium">结束放映</h3>
            <p className="mt-2 text-sm text-gray-400">
              确定要结束本次放映吗？
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setConfirmEnd(false)}
                className="rounded bg-gray-700 px-4 py-2 text-sm hover:bg-gray-600 transition"
              >
                取消
              </button>
              <button
                onClick={endPresentation}
                className="rounded bg-red-600 px-4 py-2 text-sm hover:bg-red-500 transition"
              >
                确认结束
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Remark Section Component ─────────────────────────────────────────

type RemarkType = "common" | "personal" | "show";

function RemarkSection({
  title,
  expanded,
  onToggle,
  resourceId,
  showId,
  type,
  canManage,
  fontSize,
  onChangeFontSize,
  offlineHtml,
  networkEnabled,
  ownerKey,
  resourceVersion,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  resourceId: number;
  showId: number;
  type: RemarkType;
  canManage: boolean;
  fontSize: number;
  onChangeFontSize: (delta: number) => void;
  offlineHtml?: string;
  networkEnabled: boolean;
  ownerKey: string;
  resourceVersion: number;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState(false);

  // Fetch remark content
  const queryKey = React.useMemo(() => ["playback-remark", ownerKey, showId, resourceId, resourceVersion, type],
    [ownerKey, showId, resourceId, resourceVersion, type]);
  React.useEffect(() => () => { void queryClient.cancelQueries({ queryKey }); }, [queryClient, queryKey, networkEnabled]);

  const { data } = useQuery<{ content_html: string; version_id?: number }>({
    queryKey,
    queryFn: async ({ signal }) => {
      if (type !== "show") {
        const detail = await api<ResourceDetailResponse>(
          `/api/resources/${resourceId}`,
          { signal },
        );
        const version = detail.resource.versions?.find(item => item.version_no === resourceVersion);
        if (!version || !Number.isInteger(version.id) || version.id <= 0) {
          throw new Error("放映所用素材版本不存在，无法读取或编辑备注");
        }
        if (type === "common") {
          return { content_html: version.common_remark_html ?? "", version_id: version.id };
        }
        const res = await api<PersonalRemarkResponse>(
          `/api/resources/${resourceId}/personal-remark`,
          { signal, params: { version_id: version.id } },
        );
        return { content_html: res.content_html ?? "", version_id: version.id };
      }
      const res = await api<ShowRemarkResponse>(
        `/api/shows/${showId}/remarks/${resourceId}`,
        { signal },
      );
      return { content_html: res.content_html ?? "" };
    },
    enabled: resourceId > 0 && offlineHtml === undefined && networkEnabled,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 30_000,
  });

  const serverHtml = offlineHtml !== undefined ? offlineHtml : (data?.content_html ?? "");
  const [draft, setDraft] = React.useState(serverHtml);

  // Discard edits when the playback identity, version or write access changes.
  React.useEffect(() => {
    setDraft("");
    setEditing(false);
  }, [resourceId, resourceVersion, ownerKey, networkEnabled]);

  // Save mutation
  const mutation = useMutation({
    mutationFn: async () => {
      if (!networkEnabled || offlineHtml !== undefined) throw new Error("离线播放期间备注只读");
      if (type !== "show" && !data?.version_id) throw new Error("素材版本尚未就绪，无法保存备注");
      if (type === "common") {
        return api(`/api/resources/${resourceId}/common-remark`, {
          method: "POST",
          json: { content_html: draft, apply_scope: "selected", version_id: data!.version_id },
        });
      }
      if (type === "personal") {
        return api(`/api/resources/${resourceId}/personal-remark`, {
          method: "PUT",
          json: { content_html: draft, version_id: data!.version_id },
        });
      }
      return api(`/api/shows/${showId}/remarks/${resourceId}`, {
        method: "PUT",
        json: { content_html: draft },
      });
    },
    onSuccess: () => {
      toast.success(`${title}已保存`);
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast.error(err.message || "保存失败"),
  });

  const dirty = draft !== serverHtml;

  return (
    <div className="border-b border-gray-700/50">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3 py-2 text-xs text-gray-300 hover:bg-gray-700/30 transition"
      >
        <span className="flex items-center gap-1.5">
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRightIcon className="h-3 w-3" />
          )}
          {title}
        </span>
        <span
          className="flex items-center gap-0.5"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => onChangeFontSize(-1)}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition"
            title="缩小字号"
          >
            <Minus className="h-2.5 w-2.5" />
          </button>
          <span className="w-4 text-center text-[10px] tabular-nums text-gray-500">
            {fontSize}
          </span>
          <button
            onClick={() => onChangeFontSize(1)}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition"
            title="放大字号"
          >
            <Plus className="h-2.5 w-2.5" />
          </button>
          {canManage && networkEnabled && offlineHtml === undefined && data && expanded && (
            <span
              onClick={(e) => {
                e.stopPropagation();
                if (editing && dirty) {
                  mutation.mutate();
                } else {
                  if (!editing) setDraft(serverHtml);
                  setEditing(!editing);
                }
              }}
              className={cn(
                "ml-1 rounded px-1.5 py-0.5 transition",
                editing && dirty
                  ? "bg-blue-600 text-white"
                  : "text-gray-500 hover:text-gray-300",
              )}
            >
              {editing && dirty ? "保存" : <Pencil className="h-3 w-3" />}
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-2">
          {editing && networkEnabled && offlineHtml === undefined ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full resize-none rounded border border-gray-600 bg-gray-900 px-2 py-1.5 text-gray-200 outline-none focus:border-blue-500"
              style={{ fontSize: `${fontSize}px`, minHeight: 80 }}
            />
          ) : serverHtml ? (
            <div
              className="prose prose-sm prose-invert max-w-none text-gray-300"
              style={{ fontSize: `${fontSize}px` }}
              dangerouslySetInnerHTML={{ __html: serverHtml }}
            />
          ) : (
            <p className="text-gray-600" style={{ fontSize: `${fontSize}px` }}>
              暂无{title}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
