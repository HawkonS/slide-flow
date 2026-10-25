import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const detailClassName = "max-h-64 max-w-[min(24rem,calc(100vw-2rem))] overflow-y-auto whitespace-normal break-words [overflow-wrap:anywhere] rounded-lg border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-lg";

/** Constrain text to its column; expose overflow on hover or keyboard focus. */
export function TableText({ text, className, children }: {
  text: string | number;
  className?: string;
  children?: React.ReactElement;
}) {
  const ref = React.useRef<HTMLElement>(null);
  const [truncated, setTruncated] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setTruncated(element.scrollWidth > element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  const textClassName = cn("block min-w-0 max-w-full truncate", className);
  return (
    <Tooltip open={truncated && open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        {children ? (
          <Slot ref={ref} className={textClassName}>{children}</Slot>
        ) : (
          <span ref={ref} tabIndex={truncated ? 0 : undefined} className={cn(textClassName, truncated && "cursor-default rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}>
            {text}
          </span>
        )}
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent side="top" align="start" className={detailClassName}>{text}</TooltipContent>
      </TooltipPortal>
    </Tooltip>
  );
}

const tagClassName = "shrink-0 whitespace-nowrap rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px] leading-4 text-secondary-foreground";

function FittingTableTags({ tags }: { tags: string[] }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const measureRef = React.useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = React.useState(0);

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const measurement = measureRef.current;
    if (!container || !measurement) return;

    const measure = () => {
      const available = container.clientWidth;
      const gap = Number.parseFloat(window.getComputedStyle(measurement).columnGap) || 0;
      let used = 0;
      let count = 0;
      for (const tag of Array.from(measurement.children)) {
        const next = used + (count ? gap : 0) + tag.getBoundingClientRect().width;
        if (next > available) break;
        used = next;
        count++;
      }
      setVisibleCount(count);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(measurement);
    return () => observer.disconnect();
  }, [tags]);

  return (
    <div ref={containerRef} className="relative min-h-[22px] w-full min-w-0 overflow-hidden">
      <div className="flex items-center gap-1">
        {tags.slice(0, visibleCount).map((tag, index) => <span key={`${tag}-${index}`} className={tagClassName}>{tag}</span>)}
      </div>
      <div ref={measureRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 flex w-max items-center gap-1">
        {tags.map((tag, index) => <span key={`${tag}-${index}`} className={tagClassName}>{tag}</span>)}
      </div>
    </div>
  );
}

/** Keep tags on one line; optionally show every complete tag that fits. */
export function TableTags({ tags, emptyText = "-", fitToWidth = false }: { tags: string[]; emptyText?: string; fitToWidth?: boolean }) {
  if (!tags.length) return <span className="text-muted-foreground">{emptyText}</span>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div tabIndex={0} aria-label={tags.join("、")} className="flex min-w-0 max-w-full cursor-default items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {fitToWidth ? <FittingTableTags tags={tags} /> : (
            <>
              <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                {tags.slice(0, 2).map((tag, index) => (
                  <span key={`${tag}-${index}`} className="min-w-0 max-w-24 truncate rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px] leading-4 text-secondary-foreground">{tag}</span>
                ))}
              </div>
              {tags.length > 2 && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">+{tags.length - 2}</span>}
            </>
          )}
        </div>
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent side="top" align="start" className={detailClassName}>
          <div className="mb-1.5 text-[11px] text-muted-foreground">全部标签 · {tags.length}</div>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag, index) => <span key={`${tag}-${index}`} className="max-w-full rounded-md border bg-muted/40 px-2 py-0.5">{tag}</span>)}
          </div>
        </TooltipContent>
      </TooltipPortal>
    </Tooltip>
  );
}
