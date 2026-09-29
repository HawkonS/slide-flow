import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface PageMetric {
  label: string;
  value: number | string;
  icon?: LucideIcon;
  tone?: "default" | "success" | "warning" | "destructive";
}

const toneClasses: Record<NonNullable<PageMetric["tone"]>, string> = {
  default: "text-foreground",
  success: "text-emerald-600",
  warning: "text-amber-600",
  destructive: "text-destructive",
};

export function PageMetrics({
  items,
  ariaLabel,
}: {
  items: PageMetric[];
  ariaLabel: string;
}) {
  if (items.length === 0) return null;

  const [primary, ...secondary] = items;
  const PrimaryIcon = primary.icon;

  return (
    <section
      className="surface flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-5"
      aria-label={ariaLabel}
    >
      <div className="flex min-w-[9rem] items-baseline gap-2 border-b pb-2 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-6">
        {PrimaryIcon && <PrimaryIcon className={cn("h-3.5 w-3.5", toneClasses[primary.tone || "default"])} />}
        <span className="text-xs text-muted-foreground">{primary.label}</span>
        <span className={cn("text-2xl font-semibold leading-none tabular-nums", toneClasses[primary.tone || "default"])}>
          {primary.value}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-2">
        {secondary.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="flex items-center gap-2 text-sm">
              {Icon && <Icon className={cn("h-3.5 w-3.5", toneClasses[item.tone || "default"])} />}
              <span className="text-muted-foreground">{item.label}</span>
              <span className={cn("font-semibold tabular-nums", toneClasses[item.tone || "default"])}>
                {item.value}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
