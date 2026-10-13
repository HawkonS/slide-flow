import type { CSSProperties } from "react";

export function ResultsLoadingSkeleton({
  viewMode = "card", count = 6, gridStyle,
}: { viewMode?: "card" | "list"; count?: number; gridStyle?: CSSProperties }) {
  return (
    <div role="status" aria-label="正在加载列表" className="min-w-0">
      <span className="sr-only">正在加载列表…</span>
      <div aria-hidden="true" className={viewMode === "list" ? "space-y-2" : "grid grid-cols-2 gap-4 lg:grid-cols-3"} style={viewMode === "card" ? gridStyle : undefined}>
        {Array.from({ length: count }, (_, index) => viewMode === "list" ? (
          <div key={index} className="flex h-[60px] items-center gap-3 rounded-md border p-3 motion-safe:animate-pulse">
            <div className="h-9 w-16 rounded bg-muted" />
            <div className="h-4 w-1/3 rounded bg-muted" />
          </div>
        ) : (
          <div key={index} className="overflow-hidden rounded-lg border motion-safe:animate-pulse">
            <div className="aspect-video bg-muted" />
            <div className="px-3 py-3"><div className="h-4 w-2/3 rounded bg-muted" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PageLoadingSkeleton() {
  return (
    <div className="page-shell" aria-busy="true">
      <div aria-hidden="true" className="space-y-3 motion-safe:animate-pulse">
        <div className="h-7 w-32 rounded bg-muted" />
        <div className="h-4 w-2/3 max-w-sm rounded bg-muted" />
        <div className="h-8 w-full rounded bg-muted" />
      </div>
      <ResultsLoadingSkeleton />
    </div>
  );
}
