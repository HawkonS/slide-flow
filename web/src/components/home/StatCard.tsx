import * as React from "react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface StatCardProps {
  /** 标题（如：资源、放映） */
  label: string;
  /** 主数值 */
  value: number | string;
  /** 副标，如「我的 N」 */
  hint?: string;
  /** 图标 */
  icon?: LucideIcon;
  /** 点击跳转路径 */
  to?: string;
  className?: string;
}

export function StatCard({ label, value, hint, icon: Icon, to, className }: StatCardProps) {
  const inner = (
    <div
      className={cn(
        "group flex items-center gap-4 rounded-lg border bg-card p-4 shadow-sm transition",
        to && "cursor-pointer hover:-translate-y-0.5 hover:shadow-md",
        className,
      )}
    >
      {Icon && (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition group-hover:bg-primary/10 group-hover:text-primary">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-0.5 flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </div>
      </div>
    </div>
  );
  return to ? <Link to={to}>{inner}</Link> : inner;
}
