import * as React from "react";
import { Loader2 } from "lucide-react";

export interface DownloadProgressState {
  label: string;
  percent: number | null;
}

/** 统一风格的下载进度条：文案 + 水平进度条（未知总长时显示定宽骨架） */
export function DownloadProgress({ progress }: { progress: DownloadProgressState | null }) {
  if (!progress) return null;
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm">
      <div className="mb-2 flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span>下载中 · {progress.label}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{
            width: progress.percent == null ? "40%" : `${Math.min(100, progress.percent)}%`,
          }}
        />
      </div>
    </div>
  );
}
