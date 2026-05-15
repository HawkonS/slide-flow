import * as React from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import {
  Loader2,
  ChevronLeft,
  ChevronRight,
  SquareSlash,
  Settings2,
  Pen,
  CircleDot,
  ExternalLink,
  ArrowLeft,
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

import { api, fetchUserPreferences, updateUserPreferences } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { SECRECY_BADGE_TONE, RESOURCE_SECRECY_LABEL } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { isOfflineMode, loadOfflineShowData, type OfflineSlideData } from "@/lib/offline-playback";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
  PresentChannel,
  usePresentChannel,
  type PresentMessage,
} from "@/lib/present-channel";
import {
  DrawingCanvas,
  type DrawingMode,
  type DrawingCanvasRef,
} from "@/components/present/DrawingCanvas";
import { Show, ShowResource, ShowResourceAccessible, SecrecyLevel } from "@/lib/types";

// ─── Types ────────────────────────────────────────────────────────────

interface PresentSessionResponse {
  session_token: string;
}

interface LinkItem {
  id: number;
  name: string;
  url: string;
}

interface LinksResponse {
  links: LinkItem[];
}

interface ResourceDetailResponse {
  resource: {
    id: number;
    current: {
      common_remark_html: string | null;
    };
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
    // fallback to localStorage
    try {
      const v = localStorage.getItem(`presenter-font-${key}`);
      if (v) {
        const n = parseInt(v, 10);
        if (n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE) {
          sizes[key] = n;
          continue;
        }
      }
    } catch {
      /* ignore */
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
  try {
    const v = localStorage.getItem("presenter-panel-ratio");
    if (v) {
      const n = parseInt(v, 10);
      if (n >= MIN_PANEL_RATIO && n <= MAX_PANEL_RATIO) return n;
    }
  } catch {
    /* ignore */
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
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const showId = id ? parseInt(id, 10) : 0;

  // ── Offline mode ──
  const offline = React.useMemo(() => isOfflineMode(), []);
  const [offlineData, setOfflineData] = React.useState<OfflineSlideData | null>(null);
  const [offlineLoading, setOfflineLoading] = React.useState(offline);

  React.useEffect(() => {
    if (!offline || !showId) return;
    let cancelled = false;
    loadOfflineShowData(showId).then(data => {
      if (cancelled) return;
      setOfflineData(data);
      setOfflineLoading(false);
    });
    return () => { cancelled = true; };
  }, [offline, showId]);

  // Cleanup blob URLs on unmount
  React.useEffect(() => {
    return () => {
      if (offlineData) {
        offlineData.revokeAll();
      }
    };
  }, [offlineData]);

  // ── Preferences ──
  const { data: prefsData } = useQuery({
    queryKey: ["user-preferences"],
    queryFn: fetchUserPreferences,
    staleTime: 60_000,
  });
  const prefs = prefsData?.preferences ?? {};

  const prefsMutation = useMutation({
    mutationFn: updateUserPreferences,
    onError: (err: Error) => toast.error(err.message || "保存偏好失败"),
  });

  const pendingPrefsRef = React.useRef<Record<string, string> | null>(null);
  const prefsDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const savePrefs = React.useCallback(
    (updates: Record<string, string>) => {
      pendingPrefsRef.current = { ...(pendingPrefsRef.current ?? {}), ...updates };
      if (prefsDebounceRef.current) clearTimeout(prefsDebounceRef.current);
      prefsDebounceRef.current = setTimeout(() => {
        if (pendingPrefsRef.current) {
          prefsMutation.mutate(pendingPrefsRef.current);
          pendingPrefsRef.current = null;
        }
      }, 500);
    },
    [prefsMutation],
  );

  // ── State ──
  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [drawingMode, setDrawingMode] = React.useState<DrawingMode>("none");
  const [penColor, setPenColor] = React.useState("#ef4444");
  const [openLinkName, setOpenLinkName] = React.useState<string | null>(null);
  const [openLinkUrl, setOpenLinkUrl] = React.useState<string | null>(null);
  const [isMirroring, setIsMirroring] = React.useState(false);
  // mirrorStreamRef retained; no UI preview needed
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
  const [currentOfflineSlideUrl, setCurrentOfflineSlideUrl] = React.useState<string | null>(null);
  const [thumbsReady, setThumbsReady] = React.useState(false);
  const pageJumpInputRef = React.useRef<HTMLInputElement>(null);

  // Apply preferences when loaded (only once)
  const prefsAppliedRef = React.useRef(false);
  React.useEffect(() => {
    if (prefsData && !prefsAppliedRef.current) {
      prefsAppliedRef.current = true;
      setPanelRatio(getPanelRatioFromPrefs(prefs));
      setPanelSplitRatio(getPanelSplitRatioFromPrefs(prefs));
      setResourceViewMode(getResourceViewFromPrefs(prefs));
      setImageFit(getImageFitFromPrefs(prefs));
      setRemarkFontSizes(getRemarkFontSizesFromPrefs(prefs));
      setRemarksExpanded(getRemarkExpandedFromPrefs(prefs));
    }
  }, [prefsData, prefs]);

  const canvasRef = React.useRef<DrawingCanvasRef>(null);
  const slideImageRef = React.useRef<HTMLImageElement>(null);
  const displayWindowRef = React.useRef<Window | null>(null);
  const linkWindowRef = React.useRef<Window | null>(null);
  const mirrorStreamRef = React.useRef<MediaStream | null>(null);
  const handleReturnRef = React.useRef<() => void>(() => {});
  const channelRef = usePresentChannel(showId);
  const sessionStartRef = React.useRef(Date.now());
  const dragStartRef = React.useRef<{ x: number; ratio: number } | null>(null);
  const vDragStartRef = React.useRef<{ y: number; ratio: number } | null>(null);
  const rightPanelRef = React.useRef<HTMLDivElement>(null);
  const preloadedThumbsRef = React.useRef<Set<string>>(new Set());

  // ── Data loading ──

  // Session token
  const { data: sessionData } = useQuery({
    queryKey: ["present-session", showId],
    queryFn: () =>
      api<PresentSessionResponse>(
        `/api/shows/${showId}/present-session`,
        { method: "POST" },
      ),
    enabled: showId > 0 && !offline,
    staleTime: Infinity,
  });
  const sessionToken = sessionData?.session_token ?? "";

  // Show detail
  const { data: showData } = useQuery({
    queryKey: ["show", showId],
    queryFn: () => api<{ show: Show }>(`/api/shows/${showId}`),
    enabled: showId > 0 && !offline,
    staleTime: 30_000,
  });
  const show = showData?.show ?? null;
  const resources = React.useMemo(() => {
    if (offline && offlineData) {
      // Build pseudo-resources from offline data for navigation/display
      return offlineData.showInfo.resources.map((r, idx) => ({
        id: r.id,
        name: r.name,
        accessible: true as const,
        hidden: false,
        secrecy_level: "public" as SecrecyLevel,
        preview_url: offlineData.thumbUrls[idx] || offlineData.slideUrls[idx] || "",
        original_preview_url: null,
        version_no: 1,
        latest_version_no: 1,
      }));
    }
    return show?.resources ?? [];
  }, [offline, offlineData, show]);
  const canManage = offline ? false : (show?.can_manage ?? false);

  // Links (toolbar quick links)
  const { data: linksData } = useQuery({
    queryKey: ["my-links"],
    queryFn: () => api<LinksResponse>("/api/links/my-selection"),
    enabled: showId > 0 && !offline,
    staleTime: 60_000,
  });
  const links = linksData?.links ?? [];

  // Current resource
  const currentResource =
    resources.length > 0 ? resources[currentIndex] ?? null : null;

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
          sessionToken: offline ? "__offline__" : sessionToken,
          imageFit,
        });
      }
    });
    return unsub;
  }, [channelRef, currentResource, currentIndex, sessionToken, imageFit, offline]);

  // ── Open display window on mount ──
  React.useEffect(() => {
    if (!showId) return;
    const displayUrl = offline
      ? `/shows/${showId}/display?offline=true`
      : `/shows/${showId}/display`;
    const w = window.open(
      displayUrl,
      "slideflow-display",
      "popup=yes,width=1920,height=1080",
    );
    if (w) displayWindowRef.current = w;
  }, [showId, offline]);

  // ── Image loading reset ──
  React.useEffect(() => {
    setImageLoading(true);
  }, [currentIndex]);

  // ── Offline slide lazy loading ──
  React.useEffect(() => {
    if (!offline || !offlineData) return;
    let cancelled = false;

    // 检查是否已加载
    const existingUrl = offlineData.slideUrls[currentIndex];
    if (existingUrl) {
      setCurrentOfflineSlideUrl(existingUrl);
    } else {
      setCurrentOfflineSlideUrl(null);
      offlineData.loadSlide(currentIndex).then(url => {
        if (!cancelled) setCurrentOfflineSlideUrl(url);
      });
    }

    // 后台预加载相邻页面
    const adjacent = [currentIndex - 2, currentIndex - 1, currentIndex + 1, currentIndex + 2];
    offlineData.preloadSlides(adjacent.filter(i => i >= 0 && i < resources.length));

    return () => { cancelled = true; };
  }, [offline, offlineData, currentIndex, resources.length]);

  // ── Preload all thumbnails ──
  React.useEffect(() => {
    if (resources.length === 0) {
      setThumbsReady(false);
      return;
    }

    const thumbUrls = resources
      .filter((r) => isAccessible(r))
      .map((r) => r.preview_url)
      .filter(Boolean) as string[];

    if (thumbUrls.length === 0) {
      setThumbsReady(true);
      return;
    }

    const allPreloaded = thumbUrls.every((u) => preloadedThumbsRef.current.has(u));
    if (allPreloaded) {
      setThumbsReady(true);
      return;
    }

    setThumbsReady(false);
    let cancelled = false;

    Promise.all(
      thumbUrls.map((url) => {
        if (preloadedThumbsRef.current.has(url)) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            preloadedThumbsRef.current.add(url);
            resolve();
          };
          img.onerror = () => {
            preloadedThumbsRef.current.add(url);
            resolve();
          };
          img.src = url;
        });
      })
    ).then(() => {
      if (!cancelled) setThumbsReady(true);
    });

    return () => { cancelled = true; };
  }, [resources]);

  // ── Slide change helper ──
  const goToSlide = React.useCallback(
    (index: number) => {
      if (index < 0 || index >= resources.length) return;
      // Auto-return from link when navigating slides
      if (openLinkName || openLinkUrl) {
        if (mirrorStreamRef.current) {
          mirrorStreamRef.current.getTracks().forEach((t) => t.stop());
          mirrorStreamRef.current = null;
        }
        setIsMirroring(false);
        if (linkWindowRef.current && !linkWindowRef.current.closed) {
          linkWindowRef.current.close();
        }
        linkWindowRef.current = null;
        const helper = (window as any).__shareHelperWindow;
        if (helper && !helper.closed) {
          helper.close();
        }
        (window as any).__shareHelperWindow = null;
        delete (window as any).__onMirrorStream;
        delete (window as any).__onMirrorEnd;
        delete (window as any).__onMirrorFallback;
        channelRef.current?.send({ type: "close-link" });
        if (displayWindowRef.current && !displayWindowRef.current.closed) {
          (displayWindowRef.current as any).__mirrorStream = null;
          try {
            const loc = displayWindowRef.current.location.href;
            if (!loc.includes(`/shows/${showId}/display`)) {
              displayWindowRef.current.location.href = `/shows/${showId}/display`;
            }
          } catch {
            displayWindowRef.current.location.href = `/shows/${showId}/display`;
          }
        }
        setOpenLinkName(null);
        setOpenLinkUrl(null);
      }
      setCurrentIndex(index);
      const res = resources[index];
      if (!res || !isAccessible(res)) return;
      channelRef.current?.send({
        type: "slide-change",
        resourceId: res.id,
        index,
      });
    },
    [resources, channelRef, openLinkName, openLinkUrl, showId],
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
    // 外链清理
    if (mirrorStreamRef.current) {
      mirrorStreamRef.current.getTracks().forEach((t) => t.stop());
      mirrorStreamRef.current = null;
    }
    setIsMirroring(false);
    if (linkWindowRef.current && !linkWindowRef.current.closed) {
      linkWindowRef.current.close();
    }
    linkWindowRef.current = null;
    const helper = (window as any).__shareHelperWindow;
    if (helper && !helper.closed) {
      helper.close();
    }
    (window as any).__shareHelperWindow = null;
    delete (window as any).__onMirrorStream;
    delete (window as any).__onMirrorEnd;
    delete (window as any).__onMirrorFallback;
    if (displayWindowRef.current && !displayWindowRef.current.closed) {
      (displayWindowRef.current as any).__mirrorStream = null;
    }
    setOpenLinkName(null);
    setOpenLinkUrl(null);
    channelRef.current?.send({ type: "session-end" });
    if (displayWindowRef.current && !displayWindowRef.current.closed) {
      displayWindowRef.current.close();
    }
    navigate("/shows");
  }, [channelRef, navigate, showId]);

  // ── Link click handler ──
  const handleLinkClick = React.useCallback(
    async (link: LinkItem) => {
      // 1. 打开外部链接弹窗（以最大化尺寸打开，稍后推到后台）
      const sw = screen.availWidth;
      const sh = screen.availHeight;
      const popup = window.open(
        link.url,
        "presenter-link",
        `popup=yes,width=${sw},height=${sh},left=0,top=0`,
      );
      linkWindowRef.current = popup;

      // 2. 立即将演讲者视图拉回前台，弹窗去后台
      if (popup) popup.blur();
      window.focus();

      // 3. 等待窗口管理器处理焦点切换
      await new Promise((r) => setTimeout(r, 600));

      // 3. 更新状态
      setOpenLinkName(link.name);
      setOpenLinkUrl(link.url);

      // 4. 在演讲者视图调用 getDisplayMedia（选择器在此弹出，弹窗标签页已存在可选）
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: "browser" } as any,
          audio: false,
          selfBrowserSurface: "exclude",
          surfaceSwitching: "exclude",
        } as any);

        mirrorStreamRef.current = stream;
        setIsMirroring(true);

        // 传递流给观众窗口（先检查是否还在 display 路由）
        if (displayWindowRef.current && !displayWindowRef.current.closed) {
          let displayOk = true;
          try {
            const loc = displayWindowRef.current.location.href;
            if (!loc.includes(`/shows/${showId}/display`)) {
              // 观众窗口被导航走了，恢复它
              displayWindowRef.current.location.href = `/shows/${showId}/display`;
              displayOk = false;
            }
          } catch {
            // 跨域无法读取 location，说明已导航到外部URL，恢复它
            displayWindowRef.current.location.href = `/shows/${showId}/display`;
            displayOk = false;
          }

          if (displayOk) {
            (displayWindowRef.current as any).__mirrorStream = stream;
            channelRef.current?.send({ type: "open-link", url: link.url, name: link.name });
          } else {
            // 等观众窗口加载完再传流
            setTimeout(() => {
              if (displayWindowRef.current && !displayWindowRef.current.closed) {
                (displayWindowRef.current as any).__mirrorStream = stream;
                channelRef.current?.send({ type: "open-link", url: link.url, name: link.name });
              }
            }, 1500);
          }
        }

        // 5. 共享建立后，将弹窗置顶
        if (popup && !popup.closed) {
          popup.focus();
        }

        // 监听流结束（用户在浏览器中点击"停止共享"）
        stream.getVideoTracks()[0].onended = () => {
          handleReturnRef.current?.();
        };
      } catch (err) {
        console.warn("getDisplayMedia failed:", err);
        // 不导航观众窗口（避免破坏 DisplayPage），只把弹窗置顶让用户操作
        if (popup && !popup.closed) {
          popup.focus();
        }
      }

      // 6. 轮询检测弹窗关闭 → 自动返回
      const checkClosed = setInterval(() => {
        if (!linkWindowRef.current || linkWindowRef.current.closed) {
          clearInterval(checkClosed);
          handleReturnRef.current?.();
        }
      }, 500);
    },
    [showId],
  );

  const handleReturnFromLink = React.useCallback(() => {
    // 停止流
    if (mirrorStreamRef.current) {
      mirrorStreamRef.current.getTracks().forEach((t) => t.stop());
      mirrorStreamRef.current = null;
    }
    setIsMirroring(false);

    // 关闭外部链接弹窗
    if (linkWindowRef.current && !linkWindowRef.current.closed) {
      linkWindowRef.current.close();
    }
    linkWindowRef.current = null;

    // 清理辅助窗口（如果存在）
    const helper = (window as any).__shareHelperWindow;
    if (helper && !helper.closed) {
      helper.close();
    }
    (window as any).__shareHelperWindow = null;

    // 清理回调
    delete (window as any).__onMirrorStream;
    delete (window as any).__onMirrorEnd;
    delete (window as any).__onMirrorFallback;

    // 通知观众恢复
    channelRef.current?.send({ type: "close-link" });

    // 恢复观众窗口
    if (displayWindowRef.current && !displayWindowRef.current.closed) {
      (displayWindowRef.current as any).__mirrorStream = null;
      try {
        const loc = displayWindowRef.current.location.href;
        if (!loc.includes(`/shows/${showId}/display`)) {
          displayWindowRef.current.location.href = `/shows/${showId}/display`;
        }
      } catch {
        displayWindowRef.current.location.href = `/shows/${showId}/display`;
      }
    }

    setOpenLinkName(null);
    setOpenLinkUrl(null);
  }, [showId]);

  // Keep handleReturnRef up to date for use in onended callback
  React.useEffect(() => {
    handleReturnRef.current = handleReturnFromLink;
  }, [handleReturnFromLink]);

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

  // ── Image URL ──
  const currentImageUrl = React.useMemo(() => {
    if (offline && offlineData) {
      return currentOfflineSlideUrl;
    }
    return currentResource && isAccessible(currentResource) && sessionToken
      ? `/api/slides/${currentResource.id}/image?session_token=${sessionToken}`
      : null;
  }, [offline, offlineData, currentOfflineSlideUrl, currentResource, sessionToken]);

  // ── Next preview ──
  const nextResource =
    currentIndex < resources.length - 1 ? resources[currentIndex + 1] : null;
  const nextImageUrl = React.useMemo(() => {
    if (offline && offlineData) {
      // 使用缩略图作为预览（小图，已预加载）
      return offlineData.thumbUrls[currentIndex + 1] || offlineData.slideUrls[currentIndex + 1] || null;
    }
    return nextResource && isAccessible(nextResource) && sessionToken
      ? `/api/slides/${nextResource.id}/image?session_token=${sessionToken}`
      : null;
  }, [offline, offlineData, currentIndex, nextResource, sessionToken]);

  // ── Render ──

  if (!showId) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-900 text-white">
        无效的放映 ID
      </div>
    );
  }

  if (offlineLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-900 text-white">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400 mr-3" />
        正在加载离线数据…
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-gray-900 text-white overflow-hidden">
      {/* ── Top bar ── */}
      <header className="flex shrink-0 items-center justify-between border-b border-gray-700 bg-gray-800 px-4 py-2">
        <div className="flex items-center gap-6 text-sm font-mono tabular-nums">
          <span>{clock}</span>
          <span className="text-gray-400">已演讲 {elapsed}</span>
        </div>
        {/* Quick links (center) */}
        <div className="flex-1 flex items-center justify-center overflow-x-auto">
          {links.length > 0 && (
            <div className="flex items-center gap-1">
              {links.map((link) => (
                <button
                  key={link.id}
                  onClick={() => handleLinkClick(link)}
                  className={cn(
                    "flex items-center gap-1 rounded px-2 py-0.5 text-xs transition whitespace-nowrap",
                    openLinkName === link.name
                      ? "bg-blue-600 text-white"
                      : "bg-gray-700/50 text-gray-300 hover:bg-gray-600/70",
                  )}
                  title={link.url}
                >
                  <ExternalLink className="h-3 w-3" />
                  {link.name}
                </button>
              ))}
              {openLinkName && (
                <button
                  onClick={handleReturnFromLink}
                  className="flex items-center gap-1 rounded bg-amber-700 px-2 py-0.5 text-xs text-white hover:bg-amber-600 transition whitespace-nowrap"
                  title="返回放映"
                >
                  <ArrowLeft className="h-3 w-3" />
                  返回放映
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              window.open(
                `/shows/${showId}/display`,
                "slideflow-display-user",
                "popup=yes,width=1920,height=1080",
              );
            }}
            className="rounded bg-gray-700 px-3 py-1.5 text-sm hover:bg-gray-600 transition flex items-center gap-1.5"
            title="打开用户视图窗口"
          >
            <MonitorPlay className="inline h-4 w-4" />
            <span>用户视图</span>
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
                <span>固定比例</span>
              </>
            ) : (
              <>
                <Maximize className="inline h-4 w-4" />
                <span>自适应</span>
              </>
            )}
          </button>
          <button
            onClick={() => setConfirmEnd(true)}
            className="rounded bg-red-700 px-3 py-1.5 text-sm hover:bg-red-600 transition"
          >
            <SquareSlash className="mr-1 inline h-4 w-4" />
            结束放映
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
      <div className="flex min-h-0 flex-1">
        {/* Left: main display + toolbar */}
        <div
          className="flex min-w-0 flex-col"
          style={{ flex: `0 0 ${panelRatio}%` }}
        >
          {/* Main display */}
          <div className="relative min-h-0 flex-1 bg-black flex items-center justify-center">

            {openLinkUrl ? (
              <div className="absolute inset-0 z-30 bg-gray-900 flex flex-col items-center justify-center gap-6">
                <ExternalLink className="h-16 w-16 text-blue-400" />
                <div className="text-center space-y-2">
                  {isMirroring ? (
                    <>
                      <div className="h-3 w-3 bg-red-500 rounded-full animate-pulse" />
                      <h2 className="text-xl font-bold text-white">正在共享外部网页</h2>
                    </>
                  ) : (
                    <>
                      <div className="animate-spin h-8 w-8 border-4 border-blue-400 border-t-transparent rounded-full" />
                      <h2 className="text-xl font-bold text-white">请在弹出的对话框中选择要共享的标签页</h2>
                    </>
                  )}
                  {openLinkName && <p className="text-blue-300 text-base">{openLinkName}</p>}
                  {openLinkUrl && <p className="text-gray-400 text-sm break-all max-w-lg">{openLinkUrl}</p>}
                </div>
                <div className="flex gap-4 mt-4">
                  <Button
                    size="lg"
                    onClick={handleReturnFromLink}
                    className="bg-amber-600 hover:bg-amber-700 text-white"
                  >
                    <ArrowLeft className="h-5 w-5 mr-2" />
                    返回放映
                  </Button>
                </div>
              </div>
            ) : currentImageUrl ? (
              <>
                {/* 16:9 aspect-ratio container - centered in the left panel */}
                <div
                  className="relative w-full h-full max-w-full max-h-full"
                  style={{ aspectRatio: "16/9" }}
                >
                  {imageLoading && (
                    <div className="absolute inset-0 flex items-center justify-center z-10">
                      <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
                    </div>
                  )}
                  <img
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
                    onError={() => setImageLoading(false)}
                  />
                  <DrawingCanvas
                    ref={canvasRef}
                    mode={drawingMode}
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
            ) : (
              <div className="flex h-full items-center justify-center text-gray-500">
                {resources.length === 0 ? "无可用资源" : "加载中…"}
              </div>
            )}
          </div>

          {/* Toolbar */}
          <div className="flex shrink-0 items-center gap-3 border-t border-gray-700 bg-gray-800 px-4 py-2">
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
          className="shrink-0 cursor-col-resize bg-gray-700 hover:bg-blue-500 transition-colors"
          style={{ width: 4 }}
          onMouseDown={handleSplitterMouseDown}
        />

        {/* Right: next preview + resource list + remarks */}
        <aside ref={rightPanelRef} className="flex min-w-0 flex-1 flex-col border-l border-gray-700 bg-gray-800">
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
                      <Badge
                        variant={SECRECY_BADGE_TONE[r.secrecy_level] || "outline"}
                        className="shrink-0 text-[10px] px-1 py-0 leading-tight"
                      >
                        {RESOURCE_SECRECY_LABEL[r.secrecy_level] || r.secrecy_level}
                      </Badge>
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
                        <div className="absolute left-1 top-1">
                          <Badge
                            variant={SECRECY_BADGE_TONE[r.secrecy_level] || "outline"}
                            className="text-[9px] px-1 py-0 leading-tight shadow-sm"
                          >
                            {RESOURCE_SECRECY_LABEL[r.secrecy_level] || r.secrecy_level}
                          </Badge>
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
                    offlineHtml={offline && offlineData ? (offlineData.showInfo.resources[currentIndex]?.common_remark_html || '') : undefined}
                  />
                  <RemarkSection
                    key={`personal-${currentResource.id}`}
                    title="个人备注"
                    expanded={remarksExpanded.personal}
                    onToggle={() => toggleRemark("personal")}
                    resourceId={currentResource.id}
                    showId={showId}
                    type="personal"
                    canManage={true}
                    fontSize={remarkFontSizes.personal}
                    onChangeFontSize={(delta) =>
                      changeRemarkFontSize("personal", delta)
                    }
                    offlineHtml={offline && offlineData ? (offlineData.showInfo.resources[currentIndex]?.personal_remark_html || '') : undefined}
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
                    offlineHtml={offline && offlineData ? (offlineData.showInfo.resources[currentIndex]?.show_remark_html || '') : undefined}
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
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState(false);

  // Fetch remark content
  const queryKey =
    type === "common"
      ? ["resource", resourceId, "detail"]
      : type === "personal"
        ? ["resource", resourceId, "personal-remark"]
        : ["shows", showId, "remarks", resourceId];

  const { data } = useQuery({
    queryKey,
    queryFn: async () => {
      if (type === "common") {
        const res = await api<ResourceDetailResponse>(
          `/api/resources/${resourceId}`,
        );
        return { content_html: res.resource.current.common_remark_html ?? "" };
      }
      if (type === "personal") {
        const res = await api<PersonalRemarkResponse>(
          `/api/resources/${resourceId}/personal-remark`,
        );
        return { content_html: res.content_html ?? "" };
      }
      const res = await api<ShowRemarkResponse>(
        `/api/shows/${showId}/remarks/${resourceId}`,
      );
      return { content_html: res.content_html ?? "" };
    },
    enabled: resourceId > 0 && offlineHtml === undefined,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const serverHtml = offlineHtml !== undefined ? offlineHtml : (data?.content_html ?? "");
  const [draft, setDraft] = React.useState(serverHtml);
  const syncedRef = React.useRef(false);

  React.useEffect(() => {
    if (!syncedRef.current && data) {
      setDraft(serverHtml);
      syncedRef.current = true;
    }
  }, [data, serverHtml]);

  // Reset sync when resource changes
  React.useEffect(() => {
    syncedRef.current = false;
    setDraft("");
    setEditing(false);
  }, [resourceId]);

  // Save mutation
  const mutation = useMutation({
    mutationFn: async () => {
      if (type === "common") {
        return api(`/api/resources/${resourceId}/common-remark`, {
          method: "POST",
          json: { content_html: draft, apply_scope: "latest" },
        });
      }
      if (type === "personal") {
        return api(`/api/resources/${resourceId}/personal-remark`, {
          method: "PUT",
          json: { content_html: draft },
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
          {canManage && expanded && (
            <span
              onClick={(e) => {
                e.stopPropagation();
                if (editing && dirty) {
                  mutation.mutate();
                } else {
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
          {editing ? (
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
