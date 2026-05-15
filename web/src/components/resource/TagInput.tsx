import * as React from "react";
import { X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

function splitInput(raw: string): string[] {
  return raw
    .split(/[，,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 类似旧版 .tag-input-field 的 chip-in-input 组件 */
export function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder = "输入后按回车或空格添加",
  disabled,
  className,
}: TagInputProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [entry, setEntry] = React.useState("");
  const [focused, setFocused] = React.useState(false);

  const tags = value;

  const addTags = (values: string[]) => {
    const incoming = values.map((t) => t.trim()).filter(Boolean);
    if (!incoming.length) return;
    const merged = Array.from(new Set([...tags, ...incoming]));
    setEntry("");
    onChange(merged);
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  const filteredSuggestions = React.useMemo(() => {
    const q = entry.trim().toLowerCase();
    return suggestions
      .filter((s) => !tags.includes(s) && (!q || s.toLowerCase().includes(q)))
      .slice(0, 5);
  }, [entry, suggestions, tags]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if ([" ", "Enter", ",", "，"].includes(event.key)) {
      event.preventDefault();
      addTags(splitInput(entry));
    } else if (event.key === "Backspace" && !entry && tags.length) {
      event.preventDefault();
      onChange(tags.slice(0, -1));
    }
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    if (/[，,\s]$/.test(next)) {
      addTags(splitInput(next));
      return;
    }
    setEntry(next);
  };

  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-sm ring-offset-background transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25",
          disabled && "cursor-not-allowed opacity-50"
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map((tag) => (
          <Badge
            key={tag}
            variant="secondary"
            className="gap-1 px-2 py-0.5 font-normal"
          >
            {tag}
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                removeTag(tag);
              }}
              className="ml-0.5 rounded-sm hover:bg-muted-foreground/20"
              aria-label={`移除 ${tag}`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        <input
          ref={inputRef}
          value={entry}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 160)}
          placeholder={tags.length ? "" : placeholder}
          disabled={disabled}
          className="flex-1 min-w-[120px] bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </div>
      {focused && filteredSuggestions.length > 0 && (
        <div className="absolute left-0 top-full z-[100] mt-1 w-full overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {filteredSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                addTags([s]);
                inputRef.current?.focus();
              }}
              className="block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
