import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  Loader2,
  Maximize,
  Minimize,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

/* ---------- types ---------- */

interface ResourceSlide {
  id: number;
  name: string;
  previewUrl: string;
  thumbUrl: string;
}

/* ---------- component ---------- */

export function ResourceFullscreenPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();

  const startId = Number(id);

  // Parse IDs from query param: ?ids=1,2,3
  const resourceIds = useMemo(() => {
    const idsParam = searchParams.get("ids");
    if (idsParam) {
      return idsParam
        .split(",")
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
    }
    return [startId];
  }, [searchParams, startId]);

  /* ---- data state ---- */
  const [slides, setSlides] = useState<ResourceSlide[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /* ---- slide state ---- */
  const [currentIndex, setCurrentIndex] = useState(0);
  const [fade, setFade] = useState(true);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- UI state ---- */
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [thumbBarVisible, setThumbBarVisible] = useState(false);
  const [cursorHidden, setCursorHidden] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [started, setStarted] = useState(false);
  const [thumbsReady, setThumbsReady] = useState(false);
  const [pageJumpOpen, setPageJumpOpen] = useState(false);
  const [pageJumpValue, setPageJumpValue] = useState("");
  const pageJumpInputRef = useRef<HTMLInputElement>(null);

  /* ---- refs ---- */
  const toolbarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbBarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preloadedImagesRef = useRef<Set<number>>(new Set());
  const preloadedThumbsRef = useRef<Set<string>>(new Set());
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  /* ========== Load resource data ========== */

  useEffect(() => {
    if (resourceIds.length === 0) {
      setError("无可浏览的资源");
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        // Fetch resource detail for each ID (limited concurrency)
        const CONCURRENT = 6;
        const results: ResourceSlide[] = new Array(resourceIds.length);
        let nextIdx = 0;

        await Promise.all(
          Array.from({ length: CONCURRENT }, async () => {
            while (true) {
              const idx = nextIdx++;
              if (idx >= resourceIds.length) return;
              const rid = resourceIds[idx]!;
              try {
                const res = await api<{
                  resource: {
                    id: number;
                    name: string;
                    current: {
                      id: number;
                      preview_url: string | null;
                      original_preview_url: string | null;
                    } | null;
                  };
                }>(`/api/resources/${rid}`);
                const r = res.resource;
                const versionId = r.current?.id;
                results[idx] = {
                  id: r.id,
                  name: r.name,
                  previewUrl: versionId
                    ? `/api/resources/${r.id}/preview?version_id=${versionId}`
                    : r.current?.original_preview_url || r.current?.preview_url || "",
                  thumbUrl: versionId
                    ? `/api/resources/${r.id}/preview-thumb?version_id=${versionId}`
                    : r.current?.preview_url || r.current?.original_preview_url || "",
                };
              } catch {
                results[idx] = {
                  id: rid,
                  name: `资源 #${rid}`,
                  previewUrl: "",
                  thumbUrl: "",
                };
              }
            }
          }),
        );

        if (cancelled) return;

        // Filter out slides without preview
        const validSlides = results.filter((s) => s && s.previewUrl);
        if (validSlides.length === 0) {
          setError("没有可预览的资源（可能缺少预览图）");
          setLoading(false);
          return;
        }

        setSlides(validSlides);

        // Set starting index
        const startIdx = validSlides.findIndex((s) => s.id === startId);
        setCurrentIndex(startIdx >= 0 ? startIdx : 0);
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
  }, [resourceIds, startId]);

  /* ========== Preload adjacent images ========== */

  useEffect(() => {
    const indices = [currentIndex, currentIndex + 1, currentIndex - 1];
    for (const idx of indices) {
      const slide = slides[idx];
      if (slide && !preloadedImagesRef.current.has(slide.id)) {
        const img = new Image();
        img.src = slide.previewUrl;
        preloadedImagesRef.current.add(slide.id);
      }
    }
  }, [currentIndex, slides]);

  /* ========== Preload all thumbnails ========== */

  useEffect(() => {
    if (slides.length === 0) {
      setThumbsReady(false);
      return;
    }

    const thumbUrls = slides.map((s) => s.thumbUrl).filter(Boolean);
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
      }),
    ).then(() => {
      if (!cancelled) setThumbsReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [slides]);

  /* ========== Fullscreen state tracking ========== */

  useEffect(() => {
    const handleChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  /* ========== Start presentation ========== */

  const handleStart = useCallback(async () => {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // may fail, that's fine
    }
    setStarted(true);
  }, []);

  /* ========== Navigation ========== */

  const goToSlide = useCallback(
    (index: number) => {
      const maxIdx = slides.length - 1;
      if (maxIdx < 0) return;
      const next = Math.max(0, Math.min(index, maxIdx));
      if (next === currentIndex) return;

      setFade(false);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = setTimeout(() => {
        setCurrentIndex(next);
        setFade(true);
      }, 120);
    },
    [currentIndex, slides.length],
  );

  const prevSlide = useCallback(() => {
    if (currentIndex > 0) goToSlide(currentIndex - 1);
  }, [currentIndex, goToSlide]);

  const nextSlide = useCallback(() => {
    if (currentIndex < slides.length - 1) goToSlide(currentIndex + 1);
  }, [currentIndex, slides.length, goToSlide]);

  /* ========== Page jump ========== */

  const openPageJump = useCallback(() => {
    setPageJumpValue(String(currentIndex + 1));
    setPageJumpOpen(true);
    setTimeout(() => pageJumpInputRef.current?.select(), 0);
  }, [currentIndex]);

  const commitPageJump = useCallback(() => {
    const num = parseInt(pageJumpValue, 10);
    if (!isNaN(num) && num >= 1 && num <= slides.length) {
      goToSlide(num - 1);
    }
    setPageJumpOpen(false);
  }, [pageJumpValue, slides.length, goToSlide]);

  /* ========== Keyboard navigation ========== */

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
  }, [prevSlide, nextSlide, pageJumpOpen, openPageJump]);

  /* ========== Toolbar auto-hide ========== */

  const showToolbar = useCallback(() => {
    setToolbarVisible(true);
    if (toolbarTimerRef.current) clearTimeout(toolbarTimerRef.current);
    toolbarTimerRef.current = setTimeout(() => {
      setToolbarVisible(false);
    }, 3000);
  }, []);

  useEffect(() => {
    const handleMouseMove = () => {
      showToolbar();
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [showToolbar]);

  /* ========== Cursor auto-hide ========== */

  useEffect(() => {
    const handleMouseMove = () => {
      setCursorHidden(false);
      if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = setTimeout(() => {
        setCursorHidden(true);
      }, 3000);
    };

    window.addEventListener("mousemove", handleMouseMove);
    cursorTimerRef.current = setTimeout(() => {
      setCursorHidden(true);
    }, 3000);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
    };
  }, []);

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
    const EDGE_ZONE = 40;

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

      // Horizontal swipe → navigate
      if (absDx > SWIPE_THRESHOLD && absDx > absDy) {
        if (dx < 0) nextSlide();
        else prevSlide();
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

  /* ========== Click zone handler ========== */

  const handleMainClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const width = rect.width;
      const relativeX = x / width;

      if (relativeX < 0.3) {
        prevSlide();
      } else if (relativeX > 0.7) {
        nextSlide();
      } else {
        if (thumbBarVisible) {
          hideThumbBar();
        } else {
          showThumbBar();
        }
      }
    },
    [prevSlide, nextSlide, thumbBarVisible, showThumbBar, hideThumbBar],
  );

  /* ---- current slide ---- */
  const currentSlide = slides[currentIndex] ?? null;

  /* ========== Render: Loading ========== */

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black text-white">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (error || slides.length === 0) {
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

  /* ========== Render: Start overlay ========== */

  if (!started) {
    return (
      <div
        className="fixed inset-0 flex cursor-pointer flex-col items-center justify-center gap-6 bg-black text-white"
        onClick={handleStart}
      >
        <p className="text-2xl font-light">点击开始放映</p>
        <p className="text-sm text-white/50">
          共 {slides.length} 张 · 点击后将进入全屏模式
        </p>
      </div>
    );
  }

  /* ========== Render: Main ========== */

  return (
    <div
      className={cn(
        "fixed inset-0 select-none bg-black",
        cursorHidden && "cursor-none",
      )}
    >
      {/* Current slide image */}
      {currentSlide?.previewUrl && (
        <img
          src={currentSlide.previewUrl}
          alt={currentSlide.name}
          className={cn(
            "absolute inset-0 h-full w-full object-contain transition-opacity duration-150",
            fade ? "opacity-100" : "opacity-0",
          )}
          draggable={false}
        />
      )}

      {/* Click zones */}
      <div className="absolute inset-0" onClick={handleMainClick} />

      {/* Floating toolbar (bottom-right) */}
      <div
        className={cn(
          "absolute bottom-4 right-4 z-40 flex items-center gap-1 rounded-lg bg-black/60 p-1.5 backdrop-blur-sm transition-opacity duration-300",
          toolbarVisible
            ? "opacity-100"
            : "pointer-events-none opacity-0",
        )}
      >
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

        {/* Exit */}
        <button
          onClick={handleExit}
          className="flex h-9 w-9 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          title="结束放映"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Slide counter + resource name (top-left) */}
      <div
        className={cn(
          "absolute left-4 top-4 flex items-center gap-2 rounded bg-black/50 px-2.5 py-1 backdrop-blur-sm transition-opacity duration-300",
          toolbarVisible ? "opacity-100" : "opacity-0",
        )}
      >
        <span className="text-xs text-white/60">
          {currentIndex + 1} / {slides.length}
        </span>
        {currentSlide && (
          <span className="max-w-[200px] truncate text-xs text-white/40">
            {currentSlide.name}
          </span>
        )}
      </div>

      {/* Page jump input (top-center, floating) */}
      {pageJumpOpen && (
        <div className="absolute left-1/2 top-6 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg bg-black/80 px-3 py-2 backdrop-blur-sm">
          <span className="text-xs text-white/60">跳转到</span>
          <input
            ref={pageJumpInputRef}
            type="text"
            inputMode="numeric"
            value={pageJumpValue}
            onChange={(e) => setPageJumpValue(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitPageJump();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setPageJumpOpen(false);
              }
            }}
            onBlur={commitPageJump}
            className="w-14 rounded bg-gray-800 px-2 py-1 text-center text-sm tabular-nums text-white outline-none ring-1 ring-blue-500"
            autoFocus
          />
          <span className="text-xs text-white/60">/ {slides.length}</span>
        </div>
      )}

      {/* Bottom thumbnail bar */}
      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 bg-black/80 px-3 py-3 backdrop-blur-sm transition-transform duration-300",
          thumbBarVisible ? "translate-y-0" : "translate-y-full",
        )}
        onMouseEnter={() => {
          if (thumbBarTimerRef.current) clearTimeout(thumbBarTimerRef.current);
        }}
        onMouseLeave={() => {
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
            {slides.map((slide, idx) => {
              const isCurrent = idx === currentIndex;
              return (
                <button
                  key={slide.id}
                  onClick={() => goToSlide(idx)}
                  className={cn(
                    "relative flex-shrink-0 overflow-hidden rounded-md border-2 transition-all",
                    isCurrent
                      ? "border-white shadow-lg shadow-white/20"
                      : "border-white/20 hover:border-white/50",
                  )}
                >
                  <img
                    src={slide.thumbUrl || slide.previewUrl}
                    alt={slide.name}
                    className="h-14 w-20 object-cover"
                    draggable={false}
                  />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
