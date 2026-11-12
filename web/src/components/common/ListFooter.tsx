import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ListFooterProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  unit?: string;
  totalPages?: number;
  loading?: boolean;
  reserve?: boolean;
  className?: string;
}

/** Shared list footer: range summary plus previous/next pagination. */
export function ListFooter({
  page,
  pageSize,
  total,
  onPageChange,
  unit = "条",
  totalPages,
  loading = false,
  reserve = false,
  className,
}: ListFooterProps) {
  if (total <= 0) {
    return reserve ? <div className="h-12 shrink-0" /> : null;
  }
  const pages = Math.max(1, totalPages ?? Math.ceil(total / Math.max(1, pageSize)));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * pageSize + 1;
  const end = Math.min(current * pageSize, total);
  return (
    <nav
      aria-label="分页"
      className={cn(
        "flex shrink-0 select-none flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm text-muted-foreground",
        className,
      )}
    >
      <span>
        显示 {start}-{end}，共 {total} {unit}
      </span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || current <= 1}
          onClick={() => onPageChange(current - 1)}
        >
          上一页
        </Button>
        <span className="min-w-[52px] text-center text-foreground select-none">
          {current} / {pages}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || current >= pages}
          onClick={() => onPageChange(current + 1)}
        >
          下一页
        </Button>
      </div>
    </nav>
  );
}

export default ListFooter;
