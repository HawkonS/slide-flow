import * as React from "react";
import { Building2 } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import type { Department } from "@/lib/types";
import { cn } from "@/lib/utils";

export function DepartmentPicker({
  departments,
  value,
  onChange,
  disabled = false,
  emptyText = "暂无部门",
  className,
}: {
  departments: Department[];
  value: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
  emptyText?: string;
  className?: string;
}) {
  const rows = React.useMemo(
    () =>
      departments
        .filter((department) => department.parent_id != null)
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path, "zh-CN")),
    [departments],
  );
  const selected = new Set(value);
  if (!rows.length) {
    return <div className={cn("rounded-md border px-3 py-4 text-sm text-muted-foreground", className)}>{emptyText}</div>;
  }
  return (
    <div className={cn("max-h-52 overflow-auto rounded-md border bg-background p-2", className)}>
      {rows.map((department) => {
        const checked = selected.has(department.id);
        const locked = disabled || (!department.is_active && !checked);
        return (
          <label
            key={department.id}
            className={cn(
              "flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
              locked ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-accent",
            )}
            style={{ paddingLeft: `${8 + Math.max(0, department.depth - 1) * 14}px` }}
          >
            <Checkbox
              checked={checked}
              disabled={locked}
              aria-label={`选择部门 ${department.name}`}
              onCheckedChange={() => {
                if (locked) return;
                onChange(checked ? value.filter((id) => id !== department.id) : [...value, department.id]);
              }}
            />
            <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className={cn("min-w-0 flex-1 truncate", !department.is_active && "line-through")}>
              {department.name}
            </span>
            {!department.is_active ? <span className="text-[10px] text-muted-foreground">已停用</span> : null}
          </label>
        );
      })}
    </div>
  );
}
