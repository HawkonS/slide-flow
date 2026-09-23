import { LayoutGrid, LayoutList } from "lucide-react";

import { cn } from "@/lib/utils";

interface ViewModeSwitchProps {
  value: "card" | "list";
  onChange: (value: "card" | "list") => void;
  label?: string;
}

/** Neutral segmented control: selected state uses a soft surface, not the CTA color. */
export function ViewModeSwitch({ value, onChange, label = "素材视图" }: ViewModeSwitchProps) {
  return (
    <div className="inline-flex h-9 items-center gap-0.5 rounded-md border bg-muted/40 p-0.5" role="group" aria-label={label}>
      {([
        ["card", LayoutGrid, "卡片视图"],
        ["list", LayoutList, "列表视图"],
      ] as const).map(([mode, Icon, text]) => (
        <button
          key={mode}
          type="button"
          aria-label={text}
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-[4px] text-muted-foreground transition-colors",
            "hover:bg-background hover:text-foreground",
            value === mode && "bg-background text-foreground shadow-sm ring-1 ring-border",
          )}
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}

