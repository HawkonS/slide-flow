import * as React from "react";
import { Check, ChevronDown, ChevronRight, Tags, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

interface PresetTag {
  id: number;
  name: string;
  label: string;
  sort_order: number;
}

interface PresetTagGroup {
  category: string;
  tags: PresetTag[];
}

interface PresetTagsResponse {
  groups: PresetTagGroup[];
}

interface ConfigResponse {
  user_custom_tags?: boolean;
}

function splitInput(raw: string): string[] {
  return raw
    .split(/[，,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 二级标签输入组件：
 * - user_custom_tags=false：仅预设模式，主输入框模糊搜索 + 下方建议面板（不可自定义）
 * - user_custom_tags=true ：自由输入 + 按分类分组的建议
 * - API 加载中：退回到自由输入模式（fallback）
 */
export function TagInput(props: TagInputProps) {
  const {
    value,
    onChange,
    placeholder = "输入后按回车或空格添加",
    disabled,
    className,
  } = props;

  const { data: configData } = useQuery({
    queryKey: ["config"],
    queryFn: () => api<ConfigResponse>("/api/config"),
    staleTime: 60_000,
  });

  const { data: tagsData, isLoading: tagsLoading } = useQuery({
    queryKey: ["preset-tags"],
    queryFn: () => api<PresetTagsResponse>("/api/tags"),
    staleTime: 30_000,
  });

  const allowCustom = configData?.user_custom_tags ?? true;
  const groups = tagsData?.groups ?? [];

  if (configData === undefined || tagsLoading) {
    return (
      <FreeInputTagInput
        value={value}
        onChange={onChange}
        suggestions={props.suggestions}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
      />
    );
  }

  if (allowCustom) {
    return (
      <FreeInputTagInput
        value={value}
        onChange={onChange}
        suggestions={props.suggestions}
        groups={groups}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
      />
    );
  }

  return (
    <PresetSelectorTagInput
      value={value}
      onChange={onChange}
      groups={groups}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
    />
  );
}

function useClickOutside(
  ref: React.RefObject<HTMLElement>,
  handler: () => void,
  enabled: boolean,
) {
  React.useEffect(() => {
    if (!enabled) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) handler();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ref, handler, enabled]);
}

function labelOf(tagName: string, groups: PresetTagGroup[]): string | null {
  for (const g of groups) {
    const t = g.tags.find((x) => x.name === tagName);
    if (t) return t.label;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  模式 A：仅预设标签 — 主输入框模糊搜索 + 下方建议面板                       */
/* -------------------------------------------------------------------------- */

interface PresetSelectorProps {
  value: string[];
  onChange: (next: string[]) => void;
  groups: PresetTagGroup[];
  placeholder: string;
  disabled?: boolean;
  className?: string;
}

function PresetSelectorTagInput({
  value,
  onChange,
  groups,
  placeholder,
  disabled,
  className,
}: PresetSelectorProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [entry, setEntry] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});

  useClickOutside(
    containerRef,
    () => {
      setOpen(false);
      setEntry("");
    },
    open,
  );

  const removeTag = (tag: string) => {
    onChange(value.filter((t) => t !== tag));
  };

  const toggleTag = (tagName: string) => {
    if (value.includes(tagName)) {
      onChange(value.filter((t) => t !== tagName));
    } else {
      onChange([...value, tagName]);
    }
  };

  const filteredGroups = React.useMemo(() => {
    const q = entry.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        tags: g.tags.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            t.label.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.tags.length > 0);
  }, [groups, entry]);

  const totalAvailable = groups.reduce((acc, g) => acc + g.tags.length, 0);

  // 仅当输入与某个预设标签 label/name 精确匹配（忽略大小写）时才允许添加
  const findExactMatch = (q: string): string | null => {
    const lo = q.trim().toLowerCase();
    if (!lo) return null;
    for (const g of groups) {
      for (const t of g.tags) {
        if (t.label.toLowerCase() === lo || t.name.toLowerCase() === lo) {
          return t.name;
        }
      }
    }
    return null;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const isAddKey =
      event.key === "Enter" ||
      event.key === " " ||
      event.key === "," ||
      event.key === "，";
    if (isAddKey) {
      // 始终阻止默认（空格也不作为分隔符）— 不允许自定义
      if (entry.trim()) {
        event.preventDefault();
        const matched = findExactMatch(entry);
        if (matched && !value.includes(matched)) {
          onChange([...value, matched]);
          setEntry("");
        } else if (matched) {
          // 已选中：清空输入即可
          setEntry("");
        }
        // 无精确匹配：什么也不做（不允许新增），保持当前 entry
      } else if (event.key === " ") {
        // 空 entry 时不需要额外处理
      }
    } else if (event.key === "Backspace" && !entry && value.length) {
      event.preventDefault();
      removeTag(value[value.length - 1]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setEntry("");
    }
  };

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div
        className={cn(
          "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-sm ring-offset-background transition-colors",
          open
            ? "border-ring ring-[3px] ring-ring/25"
            : "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25 hover:border-ring/60",
          disabled && "cursor-not-allowed opacity-50",
        )}
        onClick={() => {
          if (disabled) return;
          setOpen(true);
          inputRef.current?.focus();
        }}
      >
        {value.length === 0 && !entry && (
          <Tags className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        {value.map((tag) => (
          <Badge
            key={tag}
            variant="secondary"
            className="max-w-full gap-1 px-2 py-0.5 font-normal"
          >
            <span className="max-w-[160px] truncate">
              {labelOf(tag, groups) ?? tag}
            </span>
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                if (!disabled) removeTag(tag);
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
          onChange={(e) => {
            setEntry(e.target.value);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setOpen(true)}
          placeholder={
            value.length ? "" : placeholder || "搜索并选择标签…"
          }
          disabled={disabled}
          className="min-w-[120px] flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            if (disabled) return;
            const next = !open;
            setOpen(next);
            if (next) inputRef.current?.focus();
          }}
          className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          aria-label={open ? "收起" : "展开"}
        >
          <ChevronDown
            className={cn(
              "h-4 w-4 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      </div>

      {open && (
        <div className="absolute left-0 top-full z-[120] mt-1 w-full min-w-[280px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
          <div className="max-h-[300px] overflow-y-auto p-1">
            {totalAvailable === 0 ? (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                暂无可选标签
              </div>
            ) : filteredGroups.length === 0 ? (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                没有匹配的标签
              </div>
            ) : (
              filteredGroups.map((group) => {
                // 搜索时强制展开
                const isCollapsed = !entry && collapsed[group.category];
                const selectedCount = group.tags.filter((t) =>
                  value.includes(t.name),
                ).length;
                return (
                  <div key={group.category} className="mb-1 last:mb-0">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (entry) return; // 搜索时不允许折叠
                        setCollapsed((prev) => ({
                          ...prev,
                          [group.category]: !prev[group.category],
                        }));
                      }}
                      className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-3 w-3 shrink-0" />
                      ) : (
                        <ChevronDown className="h-3 w-3 shrink-0" />
                      )}
                      <span className="flex-1 truncate text-left">
                        {group.category}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                        {selectedCount}/{group.tags.length}
                      </span>
                    </button>
                    {!isCollapsed && (
                      <div className="mt-0.5">
                        {group.tags.map((tag) => {
                          const checked = value.includes(tag.name);
                          return (
                            <button
                              key={tag.id}
                              type="button"
                              onMouseDown={(e) => {
                                // 防止 input 失焦导致面板关闭
                                e.preventDefault();
                                toggleTag(tag.name);
                                inputRef.current?.focus();
                              }}
                              className={cn(
                                "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                                checked && "bg-accent/40",
                              )}
                            >
                              <span
                                className={cn(
                                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
                                  checked
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-input bg-background",
                                )}
                              >
                                {checked && <Check className="h-3 w-3" />}
                              </span>
                              <span className="min-w-0 flex-1 truncate">
                                {tag.label}
                              </span>
                              {tag.label !== tag.name && (
                                <span className="shrink-0 truncate text-xs text-muted-foreground/70">
                                  {tag.name}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
          {value.length > 0 && (
            <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5 text-xs text-muted-foreground">
              <span>已选 {value.length} 项</span>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange([]);
                }}
                className="rounded-sm px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground"
              >
                清空
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  模式 B：自由输入 + 分组建议                                                */
/* -------------------------------------------------------------------------- */

interface FreeInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
  groups?: PresetTagGroup[];
  placeholder: string;
  disabled?: boolean;
  className?: string;
}

function FreeInputTagInput({
  value,
  onChange,
  suggestions = [],
  groups = [],
  placeholder,
  disabled,
  className,
}: FreeInputProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [entry, setEntry] = React.useState("");
  const [open, setOpen] = React.useState(false);

  useClickOutside(containerRef, () => setOpen(false), open);

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

  // 优先用预设标签分组生成建议；若没有分组数据，则回退到 suggestions 平铺列表
  const suggestionGroups = React.useMemo(() => {
    const q = entry.trim().toLowerCase();
    if (groups.length > 0) {
      return groups
        .map((g) => ({
          category: g.category,
          tags: g.tags
            .filter((t) => !tags.includes(t.name))
            .filter(
              (t) =>
                !q ||
                t.name.toLowerCase().includes(q) ||
                t.label.toLowerCase().includes(q),
            )
            .slice(0, 8),
        }))
        .filter((g) => g.tags.length > 0);
    }
    const filtered = suggestions
      .filter((s) => !tags.includes(s) && (!q || s.toLowerCase().includes(q)))
      .slice(0, 5);
    if (!filtered.length) return [];
    return [
      {
        category: "建议",
        tags: filtered.map((s, i) => ({
          id: -1 - i,
          name: s,
          label: s,
          sort_order: i,
        })),
      },
    ];
  }, [entry, groups, suggestions, tags]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if ([" ", "Enter", ",", "，"].includes(event.key)) {
      event.preventDefault();
      addTags(splitInput(entry));
    } else if (event.key === "Backspace" && !entry && tags.length) {
      event.preventDefault();
      onChange(tags.slice(0, -1));
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    if (/[，,\s]$/.test(next)) {
      addTags(splitInput(next));
      return;
    }
    setEntry(next);
    setOpen(true);
  };

  const showPanel = open && suggestionGroups.length > 0;

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div
        className={cn(
          "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-sm ring-offset-background transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25",
          disabled && "cursor-not-allowed opacity-50",
        )}
        onClick={() => {
          if (disabled) return;
          setOpen(true);
          inputRef.current?.focus();
        }}
      >
        {tags.map((tag) => (
          <Badge
            key={tag}
            variant="secondary"
            className="max-w-full gap-1 px-2 py-0.5 font-normal"
          >
            <span className="max-w-[160px] truncate">
              {labelOf(tag, groups) ?? tag}
            </span>
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
          onFocus={() => setOpen(true)}
          placeholder={tags.length ? "" : placeholder}
          disabled={disabled}
          className="min-w-[120px] flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </div>
      {showPanel && (
        <div className="absolute left-0 top-full z-[120] mt-1 w-full min-w-[240px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
          <div className="max-h-[300px] overflow-y-auto p-1">
            {suggestionGroups.map((group) => (
              <div key={group.category} className="mb-1 last:mb-0">
                <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
                  {group.category}
                </div>
                {group.tags.map((s) => (
                  <button
                    key={`${group.category}-${s.id}-${s.name}`}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      addTags([s.name]);
                      inputRef.current?.focus();
                    }}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate">{s.label}</span>
                    {s.label !== s.name && (
                      <span className="shrink-0 truncate text-xs text-muted-foreground/70">
                        {s.name}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
