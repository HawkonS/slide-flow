import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { PresentChannel, PresentMessage } from "@/lib/present-channel";
import {
  DrawingCanvas,
  type DrawingCanvasRef,
} from "@/components/present/DrawingCanvas";
import { isOfflineMode, loadOfflineShowData, type OfflineSlideData } from "@/lib/offline-playback";

export function DisplayPage() {
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
      if (offlineData) offlineData.revokeAll();
    };
  }, [offlineData]);

  const channelRef = useRef<PresentChannel | null>(null);
  const canvasRef = useRef<DrawingCanvasRef>(null);
  const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slideImageRef = useRef<HTMLImageElement>(null);

  // Slide state (synced from Presenter via BroadcastChannel)
  const [sessionToken, setSessionToken] = useState<string>("");
  const [resourceId, setResourceId] = useState<number>(0);
  const [currentSlide, setCurrentSlide] = useState<number>(0);
  const [imageFit, setImageFit] = useState<"contain" | "fill">("contain");

  const [mirrorActive, setMirrorActive] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // UI state
  const [ended, setEnded] = useState(false);
  const [cursorHidden, setCursorHidden] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [currentOfflineSlideUrl, setCurrentOfflineSlideUrl] = useState<string | null>(null);

  // Build image URL from synced state
  const imageUrl = useMemo(() => {
    if (offline && offlineData) {
      return currentOfflineSlideUrl;
    }
    return resourceId > 0 && sessionToken
      ? `/api/slides/${resourceId}/image?session_token=${sessionToken}`
      : null;
  }, [offline, offlineData, currentOfflineSlideUrl, resourceId, sessionToken]);

  // Offline: lazy load current slide
  useEffect(() => {
    if (!offline || !offlineData) return;
    let cancelled = false;
    const existingUrl = offlineData.slideUrls[currentSlide];
    if (existingUrl) {
      setCurrentOfflineSlideUrl(existingUrl);
    } else {
      setCurrentOfflineSlideUrl(null);
      offlineData.loadSlide(currentSlide).then(url => {
        if (!cancelled) setCurrentOfflineSlideUrl(url);
      });
    }
    // Preload adjacent slides
    const adjacent = [currentSlide - 1, currentSlide + 1, currentSlide + 2];
    offlineData.preloadSlides(adjacent.filter(i => i >= 0 && i < offlineData.showInfo.resources.length));
    return () => { cancelled = true; };
  }, [offline, offlineData, currentSlide]);

  // Reset imageLoaded when slide changes
  useEffect(() => {
    setImageLoaded(false);
  }, [resourceId]);

  // Initialize PresentChannel and request sync
  useEffect(() => {
    if (!showId || Number.isNaN(showId)) return;

    const ch = new PresentChannel(showId);
    channelRef.current = ch;

    // Request current state from the presenter
    ch.send({ type: "request-sync" });

    // Try auto fullscreen
    try {
      document.documentElement.requestFullscreen();
    } catch {
      // Browser may block, ignore
    }

    return () => {
      ch.close();
      channelRef.current = null;
    };
  }, [showId]);

  // Listen for messages from Presenter
  useEffect(() => {
    const ch = channelRef.current;
    if (!ch) return;

    const unsubscribe = ch.onMessage((msg: PresentMessage) => {
      switch (msg.type) {
        case "sync-state": {
          setSessionToken(msg.sessionToken);
          setResourceId(msg.resourceId);
          setCurrentSlide(msg.index);
          if (msg.imageFit) setImageFit(msg.imageFit);
          break;
        }
        case "slide-change": {
          setResourceId(msg.resourceId);
          setCurrentSlide(msg.index);
          break;
        }
        case "pen-draw": {
          canvasRef.current?.drawRemotePen(msg.points, msg.color, msg.width);
          break;
        }
        case "pen-clear": {
          canvasRef.current?.clearAll();
          break;
        }
        case "pen-erase": {
          canvasRef.current?.eraseStroke(msg.index);
          break;
        }
        case "laser-move": {
          canvasRef.current?.moveRemoteLaser(msg.x, msg.y, msg.visible);
          break;
        }
        case "image-fit-change": {
          setImageFit(msg.imageFit);
          break;
        }
        case "open-link": {
          // 读取从 PresenterPage 传递的流
          const stream = (window as any).__mirrorStream as MediaStream | null;
          if (stream) {
            setMirrorActive(true);
            // 使用 setTimeout 确保 video 元素已渲染
            setTimeout(() => {
              if (videoRef.current && stream.active) {
                videoRef.current.srcObject = stream;
              }
            }, 50);
          }
          break;
        }
        case "close-link": {
          if (videoRef.current) {
            videoRef.current.srcObject = null;
          }
          (window as any).__mirrorStream = null;
          setMirrorActive(false);
          break;
        }
        case "session-end": {
          if (videoRef.current) {
            videoRef.current.srcObject = null;
          }
          (window as any).__mirrorStream = null;
          setMirrorActive(false);
          setEnded(true);
          setTimeout(() => {
            window.close();
          }, 3000);
          break;
        }
      }
    });

    return unsubscribe;
  }, []);

  // Hide cursor after 3 seconds of inactivity
  const resetCursorTimer = useCallback(() => {
    setCursorHidden(false);
    if (cursorTimerRef.current) {
      clearTimeout(cursorTimerRef.current);
    }
    cursorTimerRef.current = setTimeout(() => {
      setCursorHidden(true);
    }, 3000);
  }, []);

  useEffect(() => {
    resetCursorTimer();
    return () => {
      if (cursorTimerRef.current) {
        clearTimeout(cursorTimerRef.current);
      }
    };
  }, [resetCursorTimer]);

  return (
    <div
      className="fixed inset-0 bg-black flex items-center justify-center overflow-hidden"
      style={{ cursor: cursorHidden ? "none" : "default" }}
      onMouseMove={resetCursorTimer}
    >
      {/* 16:9 aspect-ratio container - centered, adapts to screen size */}
      <div
        className="relative w-full h-full max-w-full max-h-full"
        style={{ aspectRatio: "16/9" }}
      >
        {mirrorActive ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-contain bg-black"
          />
        ) : (
          <>
            {/* Slide image - fills the 16:9 container exactly */}
            {imageUrl && (
              <img
                ref={slideImageRef}
                src={imageUrl}
                alt={`幻灯片 ${currentSlide + 1}`}
                className={`absolute inset-0 w-full h-full ${imageFit === "contain" ? "object-contain" : "object-fill"}`}
                draggable={false}
                onLoad={() => setImageLoaded(true)}
                onError={() => setImageLoaded(false)}
              />
            )}

            {/* DrawingCanvas overlay - exact match with image area */}
            <DrawingCanvas
              ref={canvasRef}
              mode="none"
              mirror={true}
              className="absolute inset-0"
              imageElement={imageFit === "contain" ? slideImageRef.current : undefined}
            />
          </>
        )}
      </div>

      {/* Waiting state */}
      {(!imageUrl || !imageLoaded) && !ended && (
        <div className="absolute inset-0 flex items-center justify-center z-40 pointer-events-none">
          <p className="text-white/50 text-lg animate-pulse">
            等待主控连接…
          </p>
        </div>
      )}


      {/* Session ended overlay */}
      {ended && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-50">
          <p className="text-white text-2xl">放映已结束</p>
        </div>
      )}
    </div>
  );
}
