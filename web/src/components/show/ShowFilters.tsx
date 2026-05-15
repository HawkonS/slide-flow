import * as React from "react";
import { Check, ChevronDown, RotateCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DEFAULT_RESOURCE_SUBJECT,
  DEFAULT_SORT_KEY,
  RESOURCE_PERMISSION_OPTIONS,
  RESOURCE_SECRECY_OPTIONS,
  RESOURCE_STATUS_OPTIONS,
  type SortKey,
} from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useShowFilters } from "@/stores/show-filters";

export interface ShowFiltersProps {
  subjects: string[];
  tags: string[];
  /** 右侧插槽：如"创建放映"按钮 */
  actions?: React.ReactNode;
}

interface Option {
  value: string;
  label: string;
}

/** 胶囊形筛选 chip */
function FilterChip({
  label,
  options,
  value,
  onChange,
  baseValue,
}: {
  label: string;
  options: readonly Option[];
  value: string;
  onChange: (v: string) => void;
  /** 用于判定 "未筛选" 的基准值，默认取 options[0].value */
  baseValue?: string;
}) {
  const current = options.find((o) => o.value === value) || options[0];
  const base = baseValue ?? options[0]?.value;
  const dirty = current?.value !== base;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "group inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm transition",
            "hover:border-primary/40 hover:bg-primary/5",
            dirty && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          <span className={cn("text-muted-foreground", dirty && "text-primary/80")}>
            {label}
          </span>
          <span className="font-medium">{current?.label ?? ""}</span>
          <ChevronDown
            className={cn("h-3.5 w-3.5 opacity-60 transition", dirty && "opacity-80")}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-1" align="start">
        <div className="max-h-72 overflow-auto">
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChange(opt.value)}
                className={cn(
                  "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm transition hover:bg-accent",
                  active && "text-primary",
                )}
              >
                <span className="truncate">{opt.label}</span>
                {active && <Check className="h-3.5 w-3.5" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TagFilterChip({
  label,
  emptyText = "暂无数据",
  tags,
  selected,
  mode,
  onToggle,
  onClear,
  onChangeMode,
}: {
  label: string;
  emptyText?: string;
  tags: string[];
  selected: string[];
  mode: "any" | "all";
  onToggle: (t: string) => void;
  onClear: () => void;
  onChangeMode: (v: "any" | "all") => void;
}) {
  const dirty = selected.length > 0;
  const modeLabel = mode === "all" ? "与" : "或";
  const summary =
    selected.length === 0
      ? "全部"
      : selected.length === 1
        ? selected[0]
        : `${modeLabel} · 已选 ${selected.length} 项`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm transition",
            "hover:border-primary/40 hover:bg-primary/5",
            dirty && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          <span className={cn("text-muted-foreground", dirty && "text-primary/80")}>{label}</span>
          <span className="font-medium">{summary}</span>
          <ChevronDown className={cn("h-3.5 w-3.5 opacity-60", dirty && "opacity-80")} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-1" align="start">
        <div className="mb-1 border-b px-1 pb-2 pt-1">
          <div className="mb-1 text-xs text-muted-foreground">匹配方式</div>
          <div className="grid grid-cols-2 gap-1">
            {([
              { v: "all", label: "与（全部满足）" },
              { v: "any", label: "或（任一满足）" },
            ] as const).map((it) => {
              const active = it.v === mode;
              return (
                <button
                  key={it.v}
                  type="button"
                  onClick={() => onChangeMode(it.v)}
                  className={cn(
                    "h-7 rounded-md border text-xs transition",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "bg-background hover:border-primary/40 hover:bg-primary/5",
                  )}
                >
                  {it.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="max-h-72 overflow-auto">
          {tags.length === 0 ? (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground">{emptyText}</div>
          ) : (
            tags.map((tag) => {
              const checked = selected.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => onToggle(tag)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <Checkbox checked={checked} className="pointer-events-none" />
                  <span className="flex-1 truncate text-left">{tag}</span>
                </button>
              );
            })
          )}
        </div>
        {selected.length > 0 && (
          <div className="flex justify-end border-t pt-1">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClear}>
              清空
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** 排序 chip：上方两个方向胶囊（顺序/倒序），下方字段单选（修改时间/创建时间/文件名称） */
const SORT_FIELD_OPTIONS = [
  { v: "updated", label: "修改时间" },
  { v: "created", label: "创建时间" },
  { v: "name", label: "文件名称" },
] as const;

type SortField = (typeof SORT_FIELD_OPTIONS)[number]["v"];
type SortDir = "asc" | "desc";

function splitSortKey(key: SortKey): { field: SortField; direction: SortDir } {
  const idx = key.lastIndexOf("_");
  return {
    field: key.slice(0, idx) as SortField,
    direction: key.slice(idx + 1) as SortDir,
  };
}

function joinSortKey(field: SortField, direction: SortDir): SortKey {
  return `${field}_${direction}` as SortKey;
}

function SortFilterChip({
  value,
  onChange,
  baseValue,
}: {
  value: SortKey;
  onChange: (v: SortKey) => void;
  baseValue: SortKey;
}) {
  const dirty = value !== baseValue;
  const { field, direction } = splitSortKey(value);
  const fieldLabel = SORT_FIELD_OPTIONS.find((o) => o.v === field)?.label ?? "修改时间";
  const dirLabel = direction === "asc" ? "顺序" : "倒序";
  const summary = `${fieldLabel} · ${dirLabel}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-sm transition",
            "hover:border-primary/40 hover:bg-primary/5",
            dirty && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          <span className={cn("text-muted-foreground", dirty && "text-primary/80")}>排序</span>
          <span className="font-medium">{summary}</span>
          <ChevronDown className={cn("h-3.5 w-3.5 opacity-60", dirty && "opacity-80")} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        <div className="mb-1 border-b px-1 pb-2 pt-1">
          <div className="mb-1 text-xs text-muted-foreground">排序方向</div>
          <div className="grid grid-cols-2 gap-1">
            {(
              [
                { v: "asc", label: "顺序" },
                { v: "desc", label: "倒序" },
              ] as const
            ).map((it) => {
              const active = it.v === direction;
              return (
                <button
                  key={it.v}
                  type="button"
                  onClick={() => onChange(joinSortKey(field, it.v))}
                  className={cn(
                    "h-7 rounded-md border text-xs transition",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "bg-background hover:border-primary/40 hover:bg-primary/5",
                  )}
                >
                  {it.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="max-h-72 overflow-auto">
          {SORT_FIELD_OPTIONS.map((it) => {
            const active = it.v === field;
            return (
              <button
                key={it.v}
                type="button"
                onClick={() => onChange(joinSortKey(it.v, direction))}
                className={cn(
                  "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm transition hover:bg-accent",
                  active && "text-primary",
                )}
              >
                <span className="truncate">{it.label}</span>
                {active && <Check className="h-3.5 w-3.5" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ShowFilters({ subjects, tags, actions }: ShowFiltersProps) {
  const s = useShowFilters();

  const subjectOptions = React.useMemo<Option[]>(() => {
    const set = new Set<string>([DEFAULT_RESOURCE_SUBJECT, ...subjects.filter(Boolean)]);
    const sorted = Array.from(set).sort((a, b) => {
      if (a === DEFAULT_RESOURCE_SUBJECT) return -1;
      if (b === DEFAULT_RESOURCE_SUBJECT) return 1;
      return a.localeCompare(b, "zh-Hans-CN");
    });
    return [{ value: "all", label: "全部" }, ...sorted.map((x) => ({ value: x, label: x }))];
  }, [subjects]);

  const isDirty =
    s.query.trim() !== "" ||
    s.status !== "active" ||
    s.subject !== "all" ||
    s.secrecy !== "all" ||
    s.permission !== "all" ||
    s.tags.length > 0 ||
    s.sort !== DEFAULT_SORT_KEY;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={s.query}
          onChange={(e) => s.setQuery(e.target.value)}
          placeholder="搜索标题、关键词"
          className={cn(
            "h-8 w-56 rounded-full border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition",
            "placeholder:text-muted-foreground",
            "focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
            s.query.trim() !== "" && "border-primary/40 bg-primary/5",
          )}
        />
      </div>
      <FilterChip
        label="状态"
        options={RESOURCE_STATUS_OPTIONS}
        value={s.status}
        onChange={(v) => s.setStatus(v as typeof s.status)}
      />
      <FilterChip
        label="主体"
        options={subjectOptions}
        value={s.subject}
        onChange={(v) => s.setSubject(v)}
      />
      <FilterChip
        label="密级"
        options={RESOURCE_SECRECY_OPTIONS}
        value={s.secrecy}
        onChange={(v) => s.setSecrecy(v as typeof s.secrecy)}
      />
      <FilterChip
        label="权限"
        options={RESOURCE_PERMISSION_OPTIONS}
        value={s.permission}
        onChange={(v) => s.setPermission(v as typeof s.permission)}
      />
      <TagFilterChip
        label="标签"
        emptyText="暂无标签"
        tags={tags}
        selected={s.tags}
        mode={s.tagsMode}
        onToggle={(t) => s.toggleTag(t)}
        onClear={() => s.setTags([])}
        onChangeMode={(v) => s.setTagsMode(v)}
      />
      <SortFilterChip
        value={s.sort}
        onChange={(v) => s.setSort(v)}
        baseValue={DEFAULT_SORT_KEY}
      />

      {isDirty && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => s.reset()}
          className="h-8 gap-1 rounded-full text-xs text-muted-foreground hover:text-primary"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          重置筛选
        </Button>
      )}

      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}
