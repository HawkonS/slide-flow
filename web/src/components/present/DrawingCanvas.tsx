import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

import { cn } from "@/lib/utils";

export type DrawingMode = "none" | "pen" | "laser" | "eraser";

export interface DrawingCanvasProps {
  mode: DrawingMode;
  penColor?: string;
  penWidth?: number;
  laserSize?: number;
  eraserRadius?: number;
  onPenDraw?: (
    points: { x: number; y: number }[],
    color: string,
    width: number,
  ) => void;
  onLaserMove?: (x: number, y: number, visible: boolean) => void;
  onPenErase?: (index: number) => void;
  onPenClear?: () => void;
  mirror?: boolean;
  className?: string;
  /** Optional image element for object-contain coordinate correction */
  imageElement?: HTMLImageElement | null;
}

export interface DrawingCanvasRef {
  drawRemotePen: (
    points: { x: number; y: number }[],
    color: string,
    width: number,
  ) => void;
  moveRemoteLaser: (x: number, y: number, visible: boolean) => void;
  clearAll: () => void;
  eraseStroke: (index: number) => void;
  getCanvas: () => HTMLCanvasElement | null;
}

interface Stroke {
  points: { x: number; y: number }[];
  color: string;
  width: number;
}

/** Calculate the actual rendered rectangle of an image using object-contain within its container */
function getImageContentRect(
  img: HTMLImageElement,
  containerRect: DOMRect,
): { offsetX: number; offsetY: number; width: number; height: number } {
  const imgRatio = img.naturalWidth / img.naturalHeight;
  const containerRatio = containerRect.width / containerRect.height;

  let width: number, height: number, offsetX: number, offsetY: number;

  if (imgRatio > containerRatio) {
    // Image is wider — letterbox (black bars top/bottom)
    width = containerRect.width;
    height = containerRect.width / imgRatio;
    offsetX = 0;
    offsetY = (containerRect.height - height) / 2;
  } else {
    // Image is taller — pillarbox (black bars left/right)
    height = containerRect.height;
    width = containerRect.height * imgRatio;
    offsetX = (containerRect.width - width) / 2;
    offsetY = 0;
  }

  return { offsetX, offsetY, width, height };
}

export const DrawingCanvas = forwardRef<DrawingCanvasRef, DrawingCanvasProps>(
  (
    {
      mode,
      penColor = "#ff0000",
      penWidth = 3,
      laserSize = 12,
      eraserRadius = 20,
      onPenDraw,
      onLaserMove,
      onPenErase,
      onPenClear,
      mirror = false,
      className,
      imageElement,
    },
    ref,
  ) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const strokesRef = useRef<Stroke[]>([]);
    const currentStrokeRef = useRef<Stroke | null>(null);
    const laserPosRef = useRef<{ x: number; y: number; visible: boolean } | null>(null);
    const isDrawingRef = useRef(false);

    /** Redraw all strokes and the laser dot onto the canvas */
    const redrawAll = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;

      // Calculate rendering area (image content region or full canvas)
      let renderRect = { offsetX: 0, offsetY: 0, width: rect.width, height: rect.height };
      if (imageElement && imageElement.naturalWidth > 0) {
        renderRect = getImageContentRect(imageElement, rect);
      }

      ctx.save();
      ctx.scale(scaleX, scaleY);

      const drawOneStroke = (stroke: Stroke) => {
        if (stroke.points.length === 0) return;

        if (stroke.points.length === 1) {
          // Single point — draw a dot
          const p = stroke.points[0];
          ctx.beginPath();
          ctx.fillStyle = stroke.color;
          ctx.arc(
            renderRect.offsetX + p.x * renderRect.width,
            renderRect.offsetY + p.y * renderRect.height,
            stroke.width / 2,
            0,
            Math.PI * 2,
          );
          ctx.fill();
          return;
        }

        ctx.beginPath();
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        const first = stroke.points[0];
        ctx.moveTo(
          renderRect.offsetX + first.x * renderRect.width,
          renderRect.offsetY + first.y * renderRect.height,
        );

        for (let i = 1; i < stroke.points.length; i++) {
          const p = stroke.points[i];
          ctx.lineTo(
            renderRect.offsetX + p.x * renderRect.width,
            renderRect.offsetY + p.y * renderRect.height,
          );
        }
        ctx.stroke();
      };

      for (const stroke of strokesRef.current) {
        drawOneStroke(stroke);
      }

      if (currentStrokeRef.current) {
        drawOneStroke(currentStrokeRef.current);
      }

      // Draw laser dot
      if (laserPosRef.current?.visible) {
        const { x, y } = laserPosRef.current;
        const radius = laserSize / 2;

        ctx.save();
        ctx.beginPath();
        ctx.arc(
          renderRect.offsetX + x * renderRect.width,
          renderRect.offsetY + y * renderRect.height,
          radius,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = "rgba(255, 0, 0, 0.8)";
        ctx.shadowColor = "rgba(255, 0, 0, 0.6)";
        ctx.shadowBlur = radius * scaleX * 1.5;
        ctx.fill();
        ctx.restore();
      }

      ctx.restore();
    }, [laserSize, imageElement]);

    /** Keep canvas pixel size in sync with container via ResizeObserver */
    useEffect(() => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      const resize = () => {
        const rect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const newWidth = Math.round(rect.width * dpr);
        const newHeight = Math.round(rect.height * dpr);

        if (canvas.width !== newWidth || canvas.height !== newHeight) {
          canvas.width = newWidth;
          canvas.height = newHeight;
          redrawAll();
        }
      };

      const ro = new ResizeObserver(resize);
      ro.observe(container);
      resize(); // initial sizing

      return () => ro.disconnect();
    }, [redrawAll]);

    /** Convert client coordinates to normalized [0,1] space */
    const getNormalizedPos = (
      clientX: number,
      clientY: number,
    ): { x: number; y: number } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();

      // When imageElement is available and loaded, normalize relative to image content area
      if (imageElement && imageElement.naturalWidth > 0) {
        const content = getImageContentRect(imageElement, rect);
        const x = (clientX - rect.left - content.offsetX) / content.width;
        const y = (clientY - rect.top - content.offsetY) / content.height;
        return { x, y };
      }

      // Fallback: normalize relative to the full canvas (object-fill or no image)
      return {
        x: (clientX - rect.left) / rect.width,
        y: (clientY - rect.top) / rect.height,
      };
    };

    /** Erase strokes near a normalized position */
    const eraseAtPosition = useCallback(
      (nx: number, ny: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        // Convert eraser radius from CSS pixels to normalized coordinates
        const canvasRect = canvas.getBoundingClientRect();
        const baseWidth =
          imageElement && imageElement.naturalWidth > 0
            ? getImageContentRect(imageElement, canvasRect).width
            : canvasRect.width;
        const eraserNormRadius = eraserRadius / baseWidth;

        for (let i = strokesRef.current.length - 1; i >= 0; i--) {
          const stroke = strokesRef.current[i];
          for (const pt of stroke.points) {
            const dx = pt.x - nx;
            const dy = pt.y - ny;
            if (dx * dx + dy * dy <= eraserNormRadius * eraserNormRadius) {
              strokesRef.current.splice(i, 1);
              onPenErase?.(i);
              redrawAll();
              break; // only erase one stroke per position check
            }
          }
        }
      },
      [eraserRadius, onPenErase, redrawAll],
    );

    const handlePointerDown = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (mirror) return;
        if (mode === "eraser") {
          e.preventDefault();
          const pos = getNormalizedPos(e.clientX, e.clientY);
          if (!pos) return;
          isDrawingRef.current = true;
          eraseAtPosition(pos.x, pos.y);
          return;
        }
        if (mode !== "pen") return;
        e.preventDefault();

        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);

        const pos = getNormalizedPos(e.clientX, e.clientY);
        if (!pos) return;

        isDrawingRef.current = true;
        currentStrokeRef.current = {
          points: [pos],
          color: penColor,
          width: penWidth,
        };
        redrawAll();
      },
      [mirror, mode, penColor, penWidth, redrawAll, eraseAtPosition],
    );

    const handlePointerMove = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (mirror) return;

        if (mode === "eraser" && isDrawingRef.current) {
          e.preventDefault();
          const pos = getNormalizedPos(e.clientX, e.clientY);
          if (!pos) return;
          eraseAtPosition(pos.x, pos.y);
        } else if (mode === "pen" && isDrawingRef.current) {
          e.preventDefault();
          const pos = getNormalizedPos(e.clientX, e.clientY);
          if (!pos || !currentStrokeRef.current) return;
          currentStrokeRef.current.points.push(pos);
          redrawAll();
        } else if (mode === "laser") {
          const pos = getNormalizedPos(e.clientX, e.clientY);
          if (!pos) return;
          laserPosRef.current = { x: pos.x, y: pos.y, visible: true };
          redrawAll();
          onLaserMove?.(pos.x, pos.y, true);
        }
      },
      [mirror, mode, redrawAll, onLaserMove, eraseAtPosition],
    );

    const handlePointerUp = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (mirror) return;
        if (mode === "eraser") {
          isDrawingRef.current = false;
          return;
        }
        if (mode !== "pen") return;
        if (!isDrawingRef.current || !currentStrokeRef.current) return;
        e.preventDefault();

        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // capture may already be released
        }

        const stroke = currentStrokeRef.current;
        strokesRef.current.push(stroke);
        currentStrokeRef.current = null;
        isDrawingRef.current = false;
        onPenDraw?.(stroke.points, stroke.color, stroke.width);
        redrawAll();
      },
      [mirror, mode, onPenDraw, redrawAll],
    );

    const handlePointerLeave = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (mirror) return;

        if (mode === "eraser" && isDrawingRef.current) {
          isDrawingRef.current = false;
        } else if (mode === "pen" && isDrawingRef.current) {
          // Finish the stroke when pointer leaves the canvas
          handlePointerUp(e);
        } else if (mode === "laser") {
          laserPosRef.current = null;
          redrawAll();
          onLaserMove?.(0, 0, false);
        }
      },
      [mirror, mode, handlePointerUp, redrawAll, onLaserMove],
    );

    const handleDoubleClick = useCallback(
      (e: React.MouseEvent<HTMLCanvasElement>) => {
        if (mirror || mode !== "pen") return;
        e.preventDefault();
        strokesRef.current = [];
        currentStrokeRef.current = null;
        onPenClear?.();
        redrawAll();
      },
      [mirror, mode, onPenClear, redrawAll],
    );

    /** Auto-commit active stroke when switching out of pen mode */
    useEffect(() => {
      if (mode !== "pen" && mode !== "eraser" && isDrawingRef.current && currentStrokeRef.current) {
        const stroke = currentStrokeRef.current;
        strokesRef.current.push(stroke);
        currentStrokeRef.current = null;
        isDrawingRef.current = false;
        onPenDraw?.(stroke.points, stroke.color, stroke.width);
        redrawAll();
      }
      if (mode !== "eraser" && isDrawingRef.current) {
        isDrawingRef.current = false;
      }
    }, [mode, onPenDraw, redrawAll]);

    /** Hide laser when switching out of laser mode */
    useEffect(() => {
      if (mode !== "laser" && laserPosRef.current) {
        laserPosRef.current = null;
        redrawAll();
      }
    }, [mode, redrawAll]);

    /** Imperative API for mirror / remote rendering */
    useImperativeHandle(ref, () => ({
      drawRemotePen: (points, color, width) => {
        strokesRef.current.push({ points, color, width });
        redrawAll();
      },
      moveRemoteLaser: (x, y, visible) => {
        laserPosRef.current = visible ? { x, y, visible } : null;
        redrawAll();
      },
      clearAll: () => {
        strokesRef.current = [];
        currentStrokeRef.current = null;
        laserPosRef.current = null;
        redrawAll();
      },
      eraseStroke: (index: number) => {
        if (index >= 0 && index < strokesRef.current.length) {
          strokesRef.current.splice(index, 1);
          redrawAll();
        }
      },
      getCanvas: () => canvasRef.current,
    }));

    return (
      <div ref={containerRef} className={cn("absolute inset-0", className)}>
        <canvas
          ref={canvasRef}
          className={cn(
            "absolute inset-0 h-full w-full",
            mode === "none" ? "pointer-events-none" : "pointer-events-auto",
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onDoubleClick={handleDoubleClick}
          style={{
            touchAction: mode === "none" ? "auto" : "none",
            cursor:
              mode === "eraser"
                ? "url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"10\" fill=\"none\" stroke=\"white\" stroke-width=\"2\"/></svg>') 12 12, crosshair"
                : undefined,
          }}
        />
      </div>
    );
  },
);

DrawingCanvas.displayName = "DrawingCanvas";
