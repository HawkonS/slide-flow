import * as React from "react";
import { History, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getShowVersions } from "@/lib/api";
import { Show, ShowVersionItem } from "@/lib/types";

interface ShowVersionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  show: Show;
  onSwitchVersion: (showId: number) => void;
}

function formatVersionDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function ShowVersionsDialog({
  open,
  onOpenChange,
  show,
  onSwitchVersion,
}: ShowVersionsDialogProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["shows", show.id, "versions"],
    queryFn: () => getShowVersions(show.id),
    enabled: open,
    staleTime: 0,
  });

  const versions = data?.versions ?? [];
  const currentVersionNo = data?.current_version_no ?? show.version_no;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">
            <History className="mr-2 inline-block h-5 w-5 align-text-bottom" />
            版本历史 — {show.name}
          </DialogTitle>
          <DialogDescription className="sr-only">
            查看 {show.name} 的版本迭代历史
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto py-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载中…
            </div>
          ) : versions.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              暂无其他版本
            </div>
          ) : (
            <div className="space-y-1">
              {versions.map((v: ShowVersionItem) => {
                const isCurrent = v.version_no === currentVersionNo;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => {
                      if (!isCurrent) onSwitchVersion(v.id);
                    }}
                    disabled={isCurrent}
                    className={`w-full rounded-lg border px-4 py-3 text-left transition ${
                      isCurrent
                        ? "border-primary/40 bg-primary/5"
                        : "border-border hover:border-muted-foreground hover:bg-muted/50 cursor-pointer"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold ${
                              isCurrent
                                ? "bg-primary/10 text-primary"
                                : "bg-muted text-muted-foreground"
                            }`}
                          >
                            v{v.version_no}
                          </span>
                          <span className="truncate text-sm font-medium">
                            {v.name}
                          </span>
                          {isCurrent && (
                            <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                              当前
                            </span>
                          )}
                        </div>
                        {v.change_note && (
                          <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                            {v.change_note}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
                      <span>{formatVersionDate(v.created_at)}</span>
                      <span>{v.owner?.name || v.owner?.username || "—"}</span>
                      <span>{v.resource_count} 项资源</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
