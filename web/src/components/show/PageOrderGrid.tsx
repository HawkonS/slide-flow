import * as React from "react";

import {
  CircleHelp,
  ExternalLink,
  GripVertical,
  ImageOff,
  Minus,
  Plus,
  Trash2,
  ZoomIn,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface OrderGridResource {
  id: number;
  name: string;
  preview_url: string | null;
}

export interface PageOrderGridProps {
  /** 可见标题；迭代页由步骤条承担标题，可省略。 */
  title?: string;
  /** 网格的无障碍名称，默认取 title。 */
  ariaLabel?: string;
  resources: OrderGridResource[];
  onChange: (ids: number[]) => void;
  /** 传入时在卡片上显示移除按钮；版本迭代只调整顺序，不传此项。 */
  onRemove?: (id: number) => void;
  disabled?: boolean;
  emptyHint?: string;
  className?: string;
}

/** 与「创建放映 → 确认播放顺序」一致的卡片网格：整卡拖拽、按页码移动、缩略图缩放。
 *  只负责展示和顺序计算，是否保存由父组件决定。 */
export function PageOrderGrid({
  title,
  ariaLabel,
  resources,
  onChange,
  onRemove,
  disabled,
  emptyHint = "还没有页面。",
  className,
}: PageOrderGridProps) {
  const ids = React.useMemo(() => resources.map((resource) => resource.id), [resources]);
  const formId = React.useId();
  const [draggingId, setDraggingId] = React.useState<number | null>(null);
  const [dragOverId, setDragOverId] = React.useState<number | null>(null);
  const [dragOverSide, setDragOverSide] = React.useState<"before" | "after" | null>(null);
  const [moveFromPage, setMoveFromPage] = React.useState("");
  const [moveToPosition, setMoveToPosition] = React.useState("1");
  const [cardWidth, setCardWidth] = React.useState(190);
  const [previewResourceId, setPreviewResourceId] = React.useState<number | null>(null);
  const gridRef = React.useRef<HTMLOListElement>(null);
  const autoScrollRef = React.useRef<{ clientY: number; frame: number | null }>({ clientY: 0, frame: null });
  const previewResource = resources.find((resource) => resource.id === previewResourceId) ?? null;
  const minCardWidth = 140;
  const maxCardWidth = 320;

  const stopAutoScroll = React.useCallback(() => {
    const frame = autoScrollRef.current.frame;
    if (frame != null) window.cancelAnimationFrame(frame);
    autoScrollRef.current.frame = null;
  }, []);

  const autoScroll = React.useCallback((clientY: number) => {
    autoScrollRef.current.clientY = clientY;
    if (autoScrollRef.current.frame != null) return;
    const tick = () => {
      const container = gridRef.current;
      if (!container) return stopAutoScroll();
      const rect = container.getBoundingClientRect();
      const edge = Math.min(96, rect.height * 0.2);
      const y = autoScrollRef.current.clientY;
      const distance = y < rect.top + edge
        ? (rect.top + edge - y) / edge
        : y > rect.bottom - edge
          ? (y - (rect.bottom - edge)) / edge
          : 0;
      if (distance <= 0) return stopAutoScroll();
      const direction = y < rect.top + edge ? -1 : 1;
      container.scrollTop += direction * Math.min(28, Math.max(2, Math.round(distance * 24)));
      autoScrollRef.current.frame = window.requestAnimationFrame(tick);
    };
    autoScrollRef.current.frame = window.requestAnimationFrame(tick);
  }, [stopAutoScroll]);

  React.useEffect(() => stopAutoScroll, [stopAutoScroll]);

  const startDrag = (id: number) => (event: React.DragEvent<HTMLElement>) => {
    if (disabled) return;
    setDraggingId(id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(id));
  };

  const dropDrag = (targetId: number) => (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    stopAutoScroll();
    const sourceId = draggingId ?? Number(event.dataTransfer.getData("text/plain"));
    setDraggingId(null);
    setDragOverId(null);
    setDragOverSide(null);
    if (!Number.isInteger(sourceId) || sourceId === targetId) return;
    const from = ids.indexOf(sourceId);
    const target = ids.indexOf(targetId);
    if (from < 0 || target < 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const insertAfter = event.clientX > rect.left + rect.width / 2;
    const next = [...ids];
    next.splice(from, 1);
    const destination = next.indexOf(targetId) + (insertAfter ? 1 : 0);
    next.splice(Math.max(0, destination), 0, sourceId);
    onChange(next);
  };

  const moveToPagePosition = () => {
    const from = Number(moveFromPage);
    const to = Number(moveToPosition);
    if (!Number.isInteger(from) || from < 1 || from > ids.length) {
      toast.error(`起始页码需在 1 到 ${ids.length} 之间`);
      return;
    }
    if (!Number.isInteger(to) || to < 1 || to > ids.length) {
      toast.error(`目标位置需在 1 到 ${ids.length} 之间`);
      return;
    }
    const next = [...ids];
    const [moved] = next.splice(from - 1, 1);
    next.splice(to - 1, 0, moved);
    onChange(next);
    setMoveFromPage("");
  };

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="mb-3 flex shrink-0 flex-col gap-2 border-b pb-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {title
            ? <h2 className="min-w-0 truncate text-base font-semibold">{title}</h2>
            : <span className="shrink-0 text-sm font-medium">共 {resources.length} 页</span>}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="查看排序规则">
                <CircleHelp className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" className="space-y-1 text-xs">
              <p>拖到卡片左半部：插入到该页之前</p>
              <p>拖到卡片右半部：插入到该页之后</p>
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:shrink-0 sm:justify-end">
          <div className="flex w-full items-center gap-2 rounded-lg border bg-muted/30 px-2 py-1.5 shadow-sm sm:w-auto">
            <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">移动页面</span>
            <div className="flex items-center gap-1">
              <Input
                id={`${formId}-move-from`}
                type="number"
                min={1}
                max={ids.length || undefined}
                value={moveFromPage}
                disabled={disabled}
                onChange={(event) => setMoveFromPage(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") moveToPagePosition(); }}
                className="h-8 w-14 bg-muted/30 text-center"
                aria-label="当前页码"
                placeholder="原页"
              />
              <span className="px-0.5 text-muted-foreground">→</span>
              <Input
                id={`${formId}-move-to`}
                type="number"
                min={1}
                max={ids.length || undefined}
                value={moveToPosition}
                disabled={disabled}
                onChange={(event) => setMoveToPosition(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") moveToPagePosition(); }}
                className="h-8 w-14 bg-muted/30 text-center"
                aria-label="目标位置"
                placeholder="目标"
              />
              <Button type="button" size="sm" className="h-8 px-2.5" disabled={disabled || ids.length === 0} onClick={moveToPagePosition}>移动</Button>
            </div>
          </div>
          <div className="hidden items-center gap-1.5 rounded-lg border bg-muted/30 px-2 py-1.5 shadow-sm sm:flex">
            <span className="mr-0.5 text-xs font-medium text-muted-foreground">缩略图</span>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 border-0 shadow-none"
              title="缩小缩略图"
              aria-label="缩小缩略图"
              disabled={cardWidth <= minCardWidth}
              onClick={() => setCardWidth((width) => Math.max(minCardWidth, width - 10))}
            ><Minus className="h-4 w-4" /></Button>
            <input
              type="range"
              min={minCardWidth}
              max={maxCardWidth}
              step={10}
              value={cardWidth}
              onChange={(event) => setCardWidth(Number(event.target.value))}
              className="w-24 accent-primary"
              aria-label="缩略图大小"
              title="缩略图大小"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 border-0 shadow-none"
              title="放大缩略图"
              aria-label="放大缩略图"
              disabled={cardWidth >= maxCardWidth}
              onClick={() => setCardWidth((width) => Math.min(maxCardWidth, width + 10))}
            ><Plus className="h-4 w-4" /></Button>
          </div>
        </div>
      </div>
      {resources.length === 0 ? (
        <div className="surface flex flex-1 items-center justify-center text-sm text-muted-foreground">{emptyHint}</div>
      ) : (
        <ol
          ref={gridRef}
          aria-label={ariaLabel ?? title ?? "页面顺序"}
          className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 gap-3 overflow-x-hidden overflow-y-auto overscroll-contain pb-1 pr-1"
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))` }}
        >
          {resources.map((resource, index) => (
            <li
              key={resource.id}
              data-sort-resource-id={resource.id}
              draggable={!disabled}
              onDragStart={startDrag(resource.id)}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const rect = event.currentTarget.getBoundingClientRect();
                setDragOverId(resource.id);
                setDragOverSide(event.clientX > rect.left + rect.width / 2 ? "after" : "before");
                autoScroll(event.clientY);
              }}
              onDrop={dropDrag(resource.id)}
              onDragEnd={() => { stopAutoScroll(); setDraggingId(null); setDragOverId(null); setDragOverSide(null); }}
              className={cn(
                "group relative min-w-0 cursor-grab select-none overflow-hidden rounded-md border bg-background text-left transition active:cursor-grabbing",
                "hover:border-primary/50 hover:shadow-sm",
                draggingId === resource.id && "opacity-40",
                dragOverId === resource.id && "ring-1 ring-primary/50",
                disabled && "cursor-default",
              )}
            >
              {dragOverId === resource.id && dragOverSide === "before" && (
                <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 z-20 w-1 bg-primary" />
              )}
              {dragOverId === resource.id && dragOverSide === "after" && (
                <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 z-20 w-1 bg-primary" />
              )}
              <div className="relative aspect-video min-h-28 w-full bg-muted">
                {resource.preview_url ? (
                  <img src={resource.preview_url} alt={resource.name} loading="lazy" decoding="async" className="h-full w-full object-contain" />
                ) : (
                  <div className="flex h-full items-center justify-center text-muted-foreground"><ImageOff className="h-8 w-8" /></div>
                )}
                <div className="absolute right-1.5 top-1.5 z-10 flex gap-1 transition sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                  <button
                    type="button"
                    onMouseDown={(event) => event.stopPropagation()}
                    className="hidden h-7 w-7 items-center justify-center rounded-md bg-black/55 text-white/90 shadow-sm backdrop-blur-sm transition hover:bg-black/80 sm:flex"
                    aria-label={`拖动第 ${index + 1} 页调整顺序`}
                    title="按住卡片拖动排序"
                  ><GripVertical className="h-3.5 w-3.5" /></button>
                  <button
                    type="button"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => setPreviewResourceId(resource.id)}
                    className="flex h-7 w-7 items-center justify-center rounded-md bg-black/55 text-white shadow-sm backdrop-blur-sm transition hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    aria-label={`放大查看 ${resource.name}`}
                    title="放大查看"
                  ><ZoomIn className="h-3.5 w-3.5" /></button>
                  {onRemove && (
                    <button
                      type="button"
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemove(resource.id);
                      }}
                      disabled={disabled}
                      className="flex h-7 w-7 items-center justify-center rounded-md bg-black/55 text-white shadow-sm backdrop-blur-sm transition hover:bg-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:pointer-events-none disabled:opacity-50"
                      aria-label={`移除 ${resource.name}`}
                      title="从放映中移除"
                    ><Trash2 className="h-3.5 w-3.5" /></button>
                  )}
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-2 px-2.5 py-2">
                <span className="flex h-5 min-w-6 shrink-0 items-center justify-center rounded bg-primary/10 px-1 text-[11px] font-semibold tabular-nums text-primary">{String(index + 1).padStart(2, "0")}</span>
                <p className="min-w-0 flex-1 truncate text-sm font-medium" title={resource.name}>{resource.name}</p>
              </div>
            </li>
          ))}
        </ol>
      )}

      <Dialog open={previewResource != null} onOpenChange={(open) => { if (!open) setPreviewResourceId(null); }}>
        <DialogContent className="flex h-[min(92vh,900px)] w-[min(96vw,1440px)] max-w-none flex-col gap-0 p-0">
          {previewResource && (
            <>
              <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 pr-12">
                <div className="min-w-0">
                  <DialogTitle className="truncate text-sm">{previewResource.name}</DialogTitle>
                  <DialogDescription className="mt-1">第 {ids.indexOf(previewResource.id) + 1} / {ids.length} 页 · 素材 ID {previewResource.id}</DialogDescription>
                </div>
                <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => window.open(`/api/resources/${previewResource.id}/preview`, "_blank", "noopener,noreferrer")}>
                  <ExternalLink className="h-4 w-4" />打开原图
                </Button>
              </div>
              <div className="flex min-h-0 flex-1 items-center justify-center bg-black/90 p-2 sm:p-5">
                {previewResource.preview_url ? (
                  <img src={`/api/resources/${previewResource.id}/preview`} alt={previewResource.name} className="max-h-full max-w-full object-contain" />
                ) : (
                  <div className="flex flex-col items-center gap-2 text-white/70"><ImageOff className="h-10 w-10" /><span>暂无预览图</span></div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
