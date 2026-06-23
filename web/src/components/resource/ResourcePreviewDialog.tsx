import * as React from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Resource } from "@/lib/types";

interface ResourcePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: Resource | null;
}

const MAX_ZOOM = 5;

export function ResourcePreviewDialog({
  open,
  onOpenChange,
  resource,
}: ResourcePreviewDialogProps) {
  const [zoom, setZoom] = React.useState(1);
  const [panOffset, setPanOffset] = React.useState({ x: 0, y: 0 });
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Reset zoom when dialog opens/closes or resource changes
  React.useEffect(() => {
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
  }, [open, resource?.id]);

  const previewUrl = React.useMemo(() => {
    if (!resource?.current) return null;
    return resource.current.original_preview_url || resource.current.preview_url;
  }, [resource]);

  /* ---- Zoom helpers ---- */
  const zoomIn = React.useCallback(() => {
    setZoom((z) => Math.min(z + 1, MAX_ZOOM));
  }, []);
  const zoomOut = React.useCallback(() => {
    setZoom((z) => {
      const next = Math.max(z - 1, 1);
      if (next === 1) setPanOffset({ x: 0, y: 0 });
      return next;
    });
  }, []);
  const resetZoom = React.useCallback(() => {
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
  }, []);

  /* ---- Keyboard shortcuts ---- */
  React.useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "+":
        case "=":
          e.preventDefault();
          zoomIn();
          break;
        case "-":
          e.preventDefault();
          zoomOut();
          break;
        case "z":
        case "Z":
          e.preventDefault();
          if (zoom > 1) resetZoom();
          else setZoom(2);
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, zoom, zoomIn, zoomOut, resetZoom]);

  /* ---- Scroll wheel zoom ---- */
  const handleWheel = React.useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        setZoom((z) => Math.min(z + 1, MAX_ZOOM));
      } else {
        setZoom((z) => {
          const next = Math.max(z - 1, 1);
          if (next === 1) setPanOffset({ x: 0, y: 0 });
          return next;
        });
      }
    },
    [],
  );

  /* ---- Mouse panning when zoomed ---- */
  const handleMouseMove = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (zoom <= 1) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
      const ny = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
      const maxPanX = (rect.width * (zoom - 1)) / 2;
      const maxPanY = (rect.height * (zoom - 1)) / 2;
      setPanOffset({ x: -nx * maxPanX, y: -ny * maxPanY });
    },
    [zoom],
  );

  /* ---- Click to reset zoom ---- */
  const handleClick = React.useCallback(() => {
    if (zoom > 1) resetZoom();
  }, [zoom, resetZoom]);

  if (!resource) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-black/80" />
        <div
          role="dialog"
          className="fixed inset-2 z-50 flex flex-col overflow-hidden rounded-lg bg-neutral-950 shadow-2xl"
        >
          {/* Top bar */}
          <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2">
            <DialogTitle className="truncate text-sm font-medium text-white/80">
              {resource.name}
            </DialogTitle>
            <div className="flex items-center gap-1">
              {/* Zoom controls */}
              <button
                onClick={zoomOut}
                disabled={zoom <= 1}
                className="flex h-7 w-7 items-center justify-center rounded text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
                title="缩小 (-)"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={zoom > 1 ? resetZoom : () => setZoom(2)}
                className="min-w-[44px] rounded px-1 py-0.5 text-center text-xs tabular-nums text-white/70 transition hover:bg-white/10 hover:text-white"
                title="Z 键切换"
              >
                {zoom}x
              </button>
              <button
                onClick={zoomIn}
                disabled={zoom >= MAX_ZOOM}
                className="flex h-7 w-7 items-center justify-center rounded text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
                title="放大 (+)"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              {zoom > 1 && (
                <button
                  onClick={resetZoom}
                  className="ml-1 flex h-7 items-center gap-1 rounded px-1.5 text-xs text-white/50 transition hover:bg-white/10 hover:text-white"
                  title="复位缩放"
                >
                  <RotateCcw className="h-3 w-3" />
                  复位
                </button>
              )}
              {/* Close button */}
              <button
                onClick={() => onOpenChange(false)}
                className="ml-2 flex h-7 items-center rounded px-2 text-xs text-white/50 transition hover:bg-white/10 hover:text-white"
              >
                关闭
              </button>
            </div>
          </div>

          {/* Image area */}
          <div
            ref={containerRef}
            className={cn(
              "relative flex-1 overflow-hidden",
              zoom > 1 ? "cursor-grab" : "cursor-default",
            )}
            onWheel={handleWheel}
            onMouseMove={handleMouseMove}
            onClick={handleClick}
          >
            {previewUrl && (
              <img
                src={previewUrl}
                alt={resource.name}
                className={cn(
                  "h-full w-full",
                  zoom > 1 ? "object-cover" : "object-contain",
                )}
                style={{
                  transform:
                    zoom > 1
                      ? `scale(${zoom}) translate(${panOffset.x / zoom}px, ${panOffset.y / zoom}px)`
                      : undefined,
                  transition: "transform 0.15s ease-out",
                }}
                draggable={false}
              />
            )}
          </div>

          {/* Bottom hint */}
          {zoom <= 1 && (
            <div className="shrink-0 py-1.5 text-center text-[11px] text-white/30">
              滚轮缩放 · +/- 调节 · Z 切换 · 点击画面复位
            </div>
          )}
        </div>
      </DialogPortal>
    </Dialog>
  );
}
