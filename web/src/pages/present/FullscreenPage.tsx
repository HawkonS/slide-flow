import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Eraser,
  Loader2,
  Maximize,
  Minimize,
  Pen,
  Pointer,
  Trash2,
  X,
} from "lucide-react";

import { DrawingCanvas, type DrawingCanvasRef, type DrawingMode } from "@/components/present/DrawingCanvas";
import { usePresentChannel } from "@/lib/present-channel";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Show, ShowResource, ShowResourceAccessible } from "@/lib/types";
import { isOfflineMode, loadOfflineShowData, type OfflineSlideData } from "@/lib/offline-playback";

/* ---------- helpers ---------- */

function isAccessible(r: ShowResource): r is ShowResourceAccessible {
  return r.accessible === true;
}

/** Build the image URL for a resource slide using the session token */
function slideImageUrl(resourceId: number, sessionToken: string): string {
  return `/api/slides/${resourceId}/image?session_token=${encodeURIComponent(sessionToken)}`;
}

/* ---------- component ---------- */

export function FullscreenPage() {
  const { id } = useParams<{ id: string }>();
  const showId = Number(id);

  // ── Offline mode ──
  const offline = useMemo(() => isOfflineMode(), []);
  const [offlineData, setOfflineData] = useState<OfflineSlideData | null>(null);

  useEffect(() => {
    if (!offline || !showId) return;
    let cancelled = false;
    loadOfflineShowData(showId).then(data => {
      if (!cancelled) setOfflineData(data);
    });
    return () => { cancelled = true; };
  }, [offline, showId]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      if (offlineData) {
        offlineData.revokeAll();
      }
    };
  }, [offlineData]);

  /* ---- data state ---- */
  const [show, setShow] = useState<Show | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /* ---- slide state ---- */
  const [currentIndex, setCurrentIndex] = useState(0);
  const [fade, setFade] = useState(true); // true = visible
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- UI state ---- */
  const [drawingMode, setDrawingMode] = useState<DrawingMode>("none");
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [thumbBarVisible, setThumbBarVisible] = useState(false);
  const [cursorHidden, setCursorHidden] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [started, setStarted] = useState(false);
  const [currentOfflineSlideUrl, setCurrentOfflineSlideUrl] = useState<string | null>(null);
  const [pageJumpOpen, setPageJumpOpen] = useState(false);
  const [pageJumpValue, setPageJumpValue] = useState("");
  const pageJumpInputRef = useRef<HTMLInputElement>(null);
  const [thumbsReady, setThumbsReady] = useState(false);

  /* ---- refs ---- */
  const canvasRef = useRef<DrawingCanvasRef>(null);
  const slideImageRef = useRef<HTMLImageElement>(null);
  const toolbarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbBarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preloadedImagesRef = useRef<Set<number>>(new Set());
  const preloadedThumbsRef = useRef<Set<string>>(new Set());
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const channelRef = usePresentChannel(showId);

  /* ---- derived ---- */
  const accessibleResources = show ? show.resources.filter(isAccessible) : [];
  const currentResource = accessibleResources[currentIndex] ?? null;
  const currentImageUrl = useMemo(() => {
    if (offline && offlineData) {
      return currentOfflineSlideUrl;
    }
    return currentResource && sessionToken
      ? slideImageUrl(currentResource.id, sessionToken)
      : null;
  }, [offline, offlineData, currentOfflineSlideUrl, currentResource, sessionToken]);

  /* ========== Data loading ========== */

  useEffect(() => {
    if (!showId || Number.isNaN(showId)) {
      setError("无效的放映 ID");
      setLoading(false);
      return;
    }

    // Offline mode: use offline data instead of API
    if (offline) {
      if (offlineData) {
        // Build a pseudo Show object from offline data
        const pseudoShow: Show = {
          id: offlineData.showInfo.id,
          name: offlineData.showInfo.name,
          resources: offlineData.showInfo.resources.map((r) => ({
            id: r.id,
            name: r.name,
            accessible: true as const,
            hidden: false,
            secrecy_level: "internal",
            preview_url: "",
            original_preview_url: "",
          })),
        } as unknown as Show;
        setShow(pseudoShow);
        setSessionToken("__offline__");
        setLoading(false);
      }
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const [sessionRes, showRes] = await Promise.all([
          api<{ session_token: string; expires_in: number }>(
            `/api/shows/${showId}/present-session`,
            { method: "POST" },
          ),
          api<{ show: Show }>(`/api/shows/${showId}`),
        ]);

        if (cancelled) return;
        setSessionToken(sessionRes.session_token);
        setShow(showRes.show);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [showId, offline, offlineData]);

  /* ========== Preload next image ========== */

  useEffect(() => {
    // Offline mode: lazy load current slide + preload adjacent
    if (offline && offlineData) {
      let cancelled = false;
      const existingUrl = offlineData.slideUrls[currentIndex];
      if (existingUrl) {
        setCurrentOfflineSlideUrl(existingUrl);
      } else {
        setCurrentOfflineSlideUrl(null);
        offlineData.loadSlide(currentIndex).then(url => {
          if (!cancelled) setCurrentOfflineSlideUrl(url);
        });
      }
      // Preload adjacent slides
      const adjacent = [currentIndex - 2, currentIndex - 1, currentIndex + 1, currentIndex + 2];
      offlineData.preloadSlides(adjacent.filter(i => i >= 0 && i < accessibleResources.length));
      return () => { cancelled = true; };
    }

    // Online mode: preload current + next image
    if (!sessionToken) return;
    const indices = [currentIndex, currentIndex + 1];
    for (const idx of indices) {
      const res = accessibleResources[idx];
      if (res && !preloadedImagesRef.current.has(res.id)) {
        const img = new Image();
        img.src = slideImageUrl(res.id, sessionToken);
        preloadedImagesRef.current.add(res.id);
      }
    }
  }, [currentIndex, sessionToken, accessibleResources, offline, offlineData]);

  /* ========== Preload all thumbnails ========== */

  useEffect(() => {
    if (!show || accessibleResources.length === 0) {
      setThumbsReady(false);
      return;
    }

    const thumbUrls: string[] = [];
    for (let idx = 0; idx < accessibleResources.length; idx++) {
      const res = accessibleResources[idx];
      const url =
        offline && offlineData
          ? (offlineData.thumbUrls[idx] || offlineData.slideUrls[idx] || undefined)
          : (res.preview_url || res.original_preview_url || (sessionToken ? slideImageUrl(res.id, sessionToken) : undefined));
      if (url) thumbUrls.push(url);
    }

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

    return () => {
      cancelled = true;
    };
  }, [accessibleResources, offline, offlineData, sessionToken]);

  /* ========== Fullscreen state tracking ========== */

  useEffect(() => {
    const handleChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  /* ========== Start presentation (user gesture) ========== */

  const handleStart = useCallback(async () => {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // may fail, that's fine
    }
    setStarted(true);
  }, []);

  /* ========== Skip-hidden helpers ========== */

  const findNextVisible = useCallback((fromIndex: number): number => {
    for (let i = fromIndex + 1; i < accessibleResources.length; i++) {
      if (!accessibleResources[i].hidden) return i;
    }
    return fromIndex; // 没有找到，保持不动
  }, [accessibleResources]);

  const findPrevVisible = useCallback((fromIndex: number): number => {
    for (let i = fromIndex - 1; i >= 0; i--) {
      if (!accessibleResources[i].hidden) return i;
    }
    return fromIndex; // 没有找到，保持不动
  }, [accessibleResources]);

  /* ========== Keyboard navigation ========== */

  const goToSlide = useCallback(
    (index: number) => {
      const maxIdx = accessibleResources.length - 1;
      if (maxIdx < 0) return;
      const next = Math.max(0, Math.min(index, maxIdx));
      if (next === currentIndex) return;

      // Broadcast slide change
      const res = accessibleResources[next];
      if (res && isAccessible(res)) {
        channelRef.current?.send({ type: "slide-change", resourceId: res.id, index: next });
      }

      // fade out → switch → fade in
      setFade(false);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = setTimeout(() => {
        setCurrentIndex(next);
        setFade(true);
      }, 120);
    },
    [currentIndex, accessibleResources, channelRef],
  );

  const prevSlide = useCallback(() => {
    goToSlide(findPrevVisible(currentIndex));
  }, [currentIndex, goToSlide, findPrevVisible]);

  const nextSlide = useCallback(() => {
    goToSlide(findNextVisible(currentIndex));
  }, [currentIndex, goToSlide, findNextVisible]);

  /* ========== Page jump ========== */

  const openPageJump = useCallback(() => {
    setPageJumpValue(String(currentIndex + 1));
    setPageJumpOpen(true);
    setTimeout(() => pageJumpInputRef.current?.select(), 0);
  }, [currentIndex]);

  const commitPageJump = useCallback(() => {
    const num = parseInt(pageJumpValue, 10);
    if (!isNaN(num) && num >= 1 && num <= accessibleResources.length) {
      goToSlide(num - 1);
    }
    setPageJumpOpen(false);
  }, [pageJumpValue, accessibleResources.length, goToSlide]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 当页码跳转输入框打开时，只处理输入框内的按键
      if (pageJumpOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setPageJumpOpen(false);
        }
        return;
      }

      switch (e.key) {
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          e.preventDefault();
          prevSlide();
          break;
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
        case " ":
          e.preventDefault();
          nextSlide();
          break;
        case "Escape":
          // If we're in drawing mode, exit drawing mode first
          if (drawingMode !== "none") {
            setDrawingMode("none");
            e.preventDefault();
          }
          break;
        case "g":
        case "G":
          e.preventDefault();
          openPageJump();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [prevSlide, nextSlide, drawingMode, pageJumpOpen, openPageJump]);

  /* ========== Toolbar auto-hide (mouse movement) ========== */

  const showToolbar = useCallback(() => {
    setToolbarVisible(true);
    if (toolbarTimerRef.current) clearTimeout(toolbarTimerRef.current);
    toolbarTimerRef.current = setTimeout(() => {
      setToolbarVisible(false);
    }, 3000);
  }, []);

  useEffect(() => {
    const handleMouseMove = () => {
      // Don't show toolbar when in pen/laser/eraser mode (user is drawing)
      if (drawingMode !== "none") return;
      showToolbar();
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [showToolbar, drawingMode]);

  /* ========== Cursor auto-hide (when mode=none) ========== */

  useEffect(() => {
    if (drawingMode !== "none") {
      setCursorHidden(false);
      if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
      return;
    }

    const handleMouseMove = () => {
      setCursorHidden(false);
      if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = setTimeout(() => {
        setCursorHidden(true);
      }, 3000);
    };

    window.addEventListener("mousemove", handleMouseMove);
    // Start the initial timer
    cursorTimerRef.current = setTimeout(() => {
      setCursorHidden(true);
    }, 3000);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
    };
  }, [drawingMode]);

  /* ========== Thumb bar auto-hide ========== */

  const showThumbBar = useCallback(() => {
    setThumbBarVisible(true);
    if (thumbBarTimerRef.current) clearTimeout(thumbBarTimerRef.current);
    thumbBarTimerRef.current = setTimeout(() => {
      setThumbBarVisible(false);
    }, 3000);
  }, []);

  const hideThumbBar = useCallback(() => {
    setThumbBarVisible(false);
    if (thumbBarTimerRef.current) clearTimeout(thumbBarTimerRef.current);
  }, []);

  /* ========== Touch gestures ========== */

  useEffect(() => {
    const SWIPE_THRESHOLD = 50;
    const EDGE_ZONE = 40; // bottom edge for thumb bar trigger

    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      };
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!touchStartRef.current) return;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchStartRef.current.x;
      const dy = touch.clientY - touchStartRef.current.y;
      const dt = Date.now() - touchStartRef.current.time;
      touchStartRef.current = null;

      // Ignore very slow swipes
      if (dt > 1000) return;

      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      // Vertical swipe from bottom edge → show thumb bar
      if (
        dy < -SWIPE_THRESHOLD &&
        absDy > absDx &&
        touch.clientY > window.innerHeight - EDGE_ZONE
      ) {
        showThumbBar();
        return;
      }

      // Horizontal swipe → navigate slides
      if (absDx > SWIPE_THRESHOLD && absDx > absDy) {
        if (dx < 0) {
          nextSlide();
        } else {
          prevSlide();
        }
      }
    };

    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchend", handleTouchEnd);
    };
  }, [nextSlide, prevSlide, showThumbBar]);

  /* ========== Fullscreen exit confirmation ========== */

  useEffect(() => {
    const handleFullscreenChange = () => {
      // When user exits fullscreen (via ESC), confirm if they want to close
      if (!document.fullscreenElement && isFullscreen) {
        const shouldClose = window.confirm("是否结束放映？");
        if (shouldClose) {
          window.close();
        }
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [isFullscreen]);

  /* ========== Drawing mode toggle ========== */

  const toggleMode = useCallback(
    (mode: DrawingMode) => {
      if (drawingMode === mode) {
        setDrawingMode("none");
      } else {
        setDrawingMode(mode);
      }
      // Show toolbar briefly after mode change
      showToolbar();
    },
    [drawingMode, showToolbar],
  );

  /* ========== Click zone handler ========== */

  const handleMainClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Ignore clicks on the canvas when drawing
      if (drawingMode !== "none") return;

      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const width = rect.width;
      const relativeX = x / width;

      if (relativeX < 0.3) {
        prevSlide();
      } else if (relativeX > 0.7) {
        nextSlide();
      } else {
        // Middle zone: toggle thumb bar
        if (thumbBarVisible) {
          hideThumbBar();
        } else {
          showThumbBar();
        }
      }
    },
    [drawingMode, prevSlide, nextSlide, thumbBarVisible, showThumbBar, hideThumbBar],
  );

  /* ========== Drawing callbacks ========== */

  const handlePenDraw = useCallback(
    (points: { x: number; y: number }[], color: string, width: number) => {
      channelRef.current?.send({ type: "pen-draw", points, color, width });
    },
    [channelRef],
  );

  const handlePenErase = useCallback(
    (index: number) => {
      channelRef.current?.send({ type: "pen-erase", index });
    },
    [channelRef],
  );

  const handlePenClear = useCallback(() => {
    channelRef.current?.send({ type: "pen-clear" });
  }, [channelRef]);

  /* ========== Clear canvas handler ========== */

  const handleClearCanvas = useCallback(() => {
    canvasRef.current?.clearAll();
    handlePenClear();
  }, [handlePenClear]);

  /* ========== Toggle fullscreen ========== */

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    } else {
      await document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  /* ========== Exit handler ========== */

  const handleExit = useCallback(() => {
    const shouldClose = window.confirm("是否结束放映？");
    if (shouldClose) {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      window.close();
    }
  }, []);

  /* ========== Render: Loading ========== */

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black text-white">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (error || !show || !sessionToken) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-black text-white">
        <p className="text-lg">{error || "加载失败"}</p>
        <button
          onClick={() => window.close()}
          className="rounded bg-white/20 px-4 py-2 text-sm hover:bg-white/30"
        >
          关闭
        </button>
      </div>
    );
  }

  if (accessibleResources.length === 0) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-black text-white">
        <p className="text-lg">没有可访问的资源</p>
        <button
          onClick={() => window.close()}
          className="rounded bg-white/20 px-4 py-2 text-sm hover:bg-white/30"
        >
          关闭
        </button>
      </div>
    );
  }

  /* ========== Render: Start overlay ========== */

  if (!started) {
    return (
      <div
        className="fixed inset-0 flex flex-col items-center justify-center gap-6 bg-black text-white cursor-pointer"
        onClick={handleStart}
      >
        <p className="text-2xl font-light">点击开始放映</p>
        <p className="text-sm text-white/50">点击后将进入全屏模式</p>
      </div>
    );
  }

  /* ========== Render: Main ========== */

  return (
    <div
      className={cn(
        "fixed inset-0 bg-black select-none",
        cursorHidden && drawingMode === "none" && "cursor-none",
      )}
    >
      {/* Current slide image */}
      {currentImageUrl && (
        <img
          ref={slideImageRef}
          src={currentImageUrl}
          alt=""
          className={cn(
            "absolute inset-0 h-full w-full object-contain transition-opacity duration-150",
            fade ? "opacity-100" : "opacity-0",
          )}
          draggable={false}
        />
      )}

      {/* Drawing canvas overlay */}
      <DrawingCanvas
        ref={canvasRef}
        mode={drawingMode}
        className="absolute inset-0"
        mirror={false}
        onPenDraw={handlePenDraw}
        onPenErase={handlePenErase}
        onPenClear={handlePenClear}
        imageElement={slideImageRef.current}
      />

      {/* Click zones (only active when not drawing) */}
      {drawingMode === "none" && (
        <div
          className="absolute inset-0"
          onClick={handleMainClick}
        >
          {/* Left zone visual hint (subtle, only on hover) */}
          <div className="absolute left-0 top-0 h-full w-[30%]" />
          {/* Right zone */}
          <div className="absolute right-0 top-0 h-full w-[30%]" />
          {/* Center zone */}
          <div className="absolute left-[30%] top-0 h-full w-[40%]" />
        </div>
      )}

      {/* Floating toolbar (bottom-right) */}
      <div
        className={cn(
          "absolute bottom-4 right-4 z-40 flex items-center gap-1 rounded-lg bg-black/60 p-1.5 backdrop-blur-sm transition-opacity duration-300",
          toolbarVisible || drawingMode !== "none"
            ? "opacity-100"
            : "pointer-events-none opacity-0",
        )}
      >
        {/* Laser pointer */}
        <button
          onClick={() => toggleMode("laser")}
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
            drawingMode === "laser"
              ? "bg-red-500/80 text-white"
              : "text-white/70 hover:bg-white/10 hover:text-white",
          )}
          title="激光笔"
        >
          <Pointer className="h-4 w-4" />
        </button>

        {/* Pen */}
        <button
          onClick={() => toggleMode("pen")}
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
            drawingMode === "pen"
              ? "bg-blue-500/80 text-white"
              : "text-white/70 hover:bg-white/10 hover:text-white",
          )}
          title="钢笔"
        >
          <Pen className="h-4 w-4" />
        </button>

        {/* Eraser */}
        <button
          onClick={() => toggleMode("eraser")}
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
            drawingMode === "eraser"
              ? "bg-yellow-500/80 text-white"
              : "text-white/70 hover:bg-white/10 hover:text-white",
          )}
          title="橡皮擦"
        >
          <Eraser className="h-4 w-4" />
        </button>

        {/* Clear canvas */}
        <button
          onClick={handleClearCanvas}
          className="flex h-9 w-9 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          title="清屏"
        >
          <Trash2 className="h-4 w-4" />
        </button>

        {/* Divider */}
        <div className="mx-0.5 h-5 w-px bg-white/20" />

        {/* Toggle fullscreen */}
        <button
          onClick={toggleFullscreen}
          className="flex h-9 w-9 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          title={isFullscreen ? "退出全屏" : "全屏"}
        >
          {isFullscreen ? (
            <Minimize className="h-4 w-4" />
          ) : (
            <Maximize className="h-4 w-4" />
          )}
        </button>

        {/* Exit (close window) */}
        <button
          onClick={handleExit}
          className="flex h-9 w-9 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          title="结束放映"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Slide counter (top-left, subtle) */}
      <div
        className={cn(
          "absolute left-4 top-4 rounded bg-black/50 px-2.5 py-1 text-xs text-white/60 backdrop-blur-sm transition-opacity duration-300",
          toolbarVisible || drawingMode !== "none" ? "opacity-100" : "opacity-0",
        )}
      >
        {currentIndex + 1} / {accessibleResources.length}
      </div>

      {/* Page jump input (top-center, floating) */}
      {pageJumpOpen && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg bg-black/80 px-3 py-2 backdrop-blur-sm">
          <span className="text-xs text-white/60">跳转到</span>
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
            className="w-14 rounded bg-gray-800 px-2 py-1 text-center text-sm tabular-nums text-white outline-none ring-1 ring-blue-500"
            autoFocus
          />
          <span className="text-xs text-white/60">/ {accessibleResources.length}</span>
        </div>
      )}

      {/* Bottom thumbnail bar */}
      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 bg-black/80 px-3 py-3 backdrop-blur-sm transition-transform duration-300",
          thumbBarVisible ? "translate-y-0" : "translate-y-full",
        )}
        onMouseEnter={() => {
          // Keep thumb bar visible while hovering
          if (thumbBarTimerRef.current) clearTimeout(thumbBarTimerRef.current);
        }}
        onMouseLeave={() => {
          // Resume auto-hide timer on mouse leave
          thumbBarTimerRef.current = setTimeout(() => {
            setThumbBarVisible(false);
          }, 3000);
        }}
      >
        {!thumbsReady ? (
          <div className="flex items-center justify-center gap-2 py-2">
            <Loader2 className="h-5 w-5 animate-spin text-white/60" />
            <span className="text-xs text-white/60">缩略图加载中…</span>
          </div>
        ) : (
          <div className="flex gap-2 overflow-x-auto px-1 py-1">
            {accessibleResources.map((res, idx) => {
              const isCurrent = idx === currentIndex;
              // Use offline blob URL, or compressed preview_url for thumbnails, fall back to HD image
              const thumbUrl = offline && offlineData
                ? (offlineData.thumbUrls[idx] || offlineData.slideUrls[idx] || undefined)
                : (res.preview_url || res.original_preview_url || (sessionToken ? slideImageUrl(res.id, sessionToken) : undefined));

              return (
                <button
                  key={res.id}
                  onClick={() => goToSlide(idx)}
                  className={cn(
                    "relative flex-shrink-0 overflow-hidden rounded-md border-2 transition-all",
                    isCurrent
                      ? "border-white shadow-lg shadow-white/20"
                      : "border-white/20 hover:border-white/50",
                  )}
                >
                  <img
                    src={thumbUrl}
                    alt={res.name}
                    className="h-14 w-20 object-cover"
                    draggable={false}
                  />
                  {res.hidden && (
                    <div className="absolute inset-0 bg-gray-500/40 pointer-events-none" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
