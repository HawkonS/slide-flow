import * as React from "react";
import { RotateCcw, Search, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSearchInput } from "@/lib/use-search-input";

interface MobileFilterSheetProps {
  title: string;
  description: string;
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  filters: React.ReactNode;
  activeCount: number;
  dirty: boolean;
  onClear: () => void;
  onReset?: () => void;
  actions?: React.ReactNode;
  viewSwitch?: React.ReactNode;
  triggerLabel?: string;
}

/**
 * Phone-only entry point for list filters. The desktop toolbar stays in each
 * page; this component merges search and filters into one tap target and keeps
 * the same controlled filter state, so changes are reflected immediately.
 */
export function MobileFilterSheet({
  title,
  description,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  filters,
  activeCount,
  dirty,
  onClear,
  onReset,
  actions,
  viewSwitch,
  triggerLabel = "筛选",
}: MobileFilterSheetProps) {
  const [open, setOpen] = React.useState(false);
  const searchInput = useSearchInput(searchValue, onSearchChange);
  const triggerName = activeCount > 0 ? `${triggerLabel}，${activeCount} 项已选` : triggerLabel;

  return (
    <>
      <div className="flex min-w-0 items-center gap-2 sm:hidden">
        {viewSwitch}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 px-2.5"
          aria-label={triggerName}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {triggerLabel}
          {activeCount > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[9px] font-semibold text-background">
              {activeCount}
            </span>
          )}
        </Button>
        {actions && <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">{actions}</div>}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[min(760px,calc(100vh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
          <DialogHeader className="border-b px-5 py-4 pr-12 text-left">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                {...searchInput}
                placeholder={searchPlaceholder}
                className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus:border-foreground/40 focus:ring-2 focus:ring-ring/20"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">{filters}</div>
            {dirty && (
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onClear}
                  className="h-8 gap-1 px-2 text-xs text-muted-foreground"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  清空筛选
                </Button>
                {onReset && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onReset}
                    className="h-8 px-2 text-xs text-muted-foreground"
                  >
                    恢复默认
                  </Button>
                )}
              </div>
            )}
          </div>
          <DialogFooter className="flex-row justify-end border-t px-5 py-3">
            <Button variant="outline" onClick={() => setOpen(false)}>关闭</Button>
            <Button onClick={() => setOpen(false)}>查看结果</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
