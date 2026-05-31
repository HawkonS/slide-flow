import { Check, ChevronDown, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type SortKey } from "@/lib/constants";
import { cn } from "@/lib/utils";

export interface ChipOption {
  value: string;
  label: string;
}

/** 紧凑模式样式（用于资源选择器等空间受限场景） */
const CHIP_TRIGGER_BASE =
  "group inline-flex items-center rounded-full border bg-background transition";
const CHIP_TRIGGER_NORMAL = "h-8 gap-1.5 px-3 text-sm";
const CHIP_TRIGGER_COMPACT = "h-7 gap-1 px-2.5 text-xs";
const CHIP_CHEVRON_NORMAL = "h-3.5 w-3.5";
const CHIP_CHEVRON_COMPACT = "h-3 w-3";

/* ─────────────────────────────────────────────
   通用单选下拉 chip
   ───────────────────────────────────────────── */
export function FilterChip({
  label,
  options,
  value,
  onChange,
  baseValue,
  compact = false,
}: {
  label: string;
  options: readonly ChipOption[];
  value: string;
  onChange: (v: string) => void;
  /** 用于判定 "未筛选" 的基准值，默认取 options[0].value */
  baseValue?: string;
  /** 紧凑模式：更小高度、字号、间距 */
  compact?: boolean;
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
            CHIP_TRIGGER_BASE,
            compact ? CHIP_TRIGGER_COMPACT : CHIP_TRIGGER_NORMAL,
            "hover:border-primary/40 hover:bg-primary/5",
            dirty && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          <span className={cn("text-muted-foreground", dirty && "text-primary/80")}>
            {label}
          </span>
          <span className="font-medium">{current?.label ?? ""}</span>
          <ChevronDown
            className={cn(
              compact ? CHIP_CHEVRON_COMPACT : CHIP_CHEVRON_NORMAL,
              "opacity-60 transition",
              dirty && "opacity-80",
            )}
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

/* ─────────────────────────────────────────────
   多选 + 与/或 模式 标签 chip
   ───────────────────────────────────────────── */
export function TagFilterChip({
  label,
  emptyText = "暂无数据",
  tags,
  selected,
  mode,
  onToggle,
  onClear,
  onChangeMode,
  compact = false,
}: {
  label: string;
  emptyText?: string;
  tags: string[];
  selected: string[];
  mode: "any" | "all";
  onToggle: (t: string) => void;
  onClear: () => void;
  onChangeMode: (v: "any" | "all") => void;
  compact?: boolean;
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
            CHIP_TRIGGER_BASE,
            compact ? CHIP_TRIGGER_COMPACT : CHIP_TRIGGER_NORMAL,
            "hover:border-primary/40 hover:bg-primary/5",
            dirty && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          <span className={cn("text-muted-foreground", dirty && "text-primary/80")}>{label}</span>
          <span className="font-medium">{summary}</span>
          <ChevronDown
            className={cn(
              compact ? CHIP_CHEVRON_COMPACT : CHIP_CHEVRON_NORMAL,
              "opacity-60",
              dirty && "opacity-80",
            )}
          />
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

/* ─────────────────────────────────────────────
   备注 chip：合并通用/个人，每组三态
   ───────────────────────────────────────────── */
type RemarkState = "all" | "has" | "none";

export function RemarkFilterChip({
  common,
  personal,
  onChangeCommon,
  onChangePersonal,
  compact = false,
}: {
  common: RemarkState;
  personal: RemarkState;
  onChangeCommon: (v: RemarkState) => void;
  onChangePersonal: (v: RemarkState) => void;
  compact?: boolean;
}) {
  const dirty = common !== "all" || personal !== "all";
  const formatOne = (v: RemarkState, name: string) =>
    v === "all" ? null : `${name}${v === "has" ? "有" : "无"}`;
  const pieces = [formatOne(common, "通用"), formatOne(personal, "个人")].filter(Boolean) as string[];
  const summary = pieces.length === 0 ? "全部" : pieces.join(" · ");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            CHIP_TRIGGER_BASE,
            compact ? CHIP_TRIGGER_COMPACT : CHIP_TRIGGER_NORMAL,
            "hover:border-primary/40 hover:bg-primary/5",
            dirty && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          <span className={cn("text-muted-foreground", dirty && "text-primary/80")}>备注</span>
          <span className="font-medium">{summary}</span>
          <ChevronDown
            className={cn(
              compact ? CHIP_CHEVRON_COMPACT : CHIP_CHEVRON_NORMAL,
              "opacity-60",
              dirty && "opacity-80",
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <div className="space-y-2">
          <RemarkGroup label="通用备注" value={common} onChange={onChangeCommon} />
          <RemarkGroup label="个人备注" value={personal} onChange={onChangePersonal} />
        </div>
        {dirty && (
          <div className="mt-2 flex justify-end border-t pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                onChangeCommon("all");
                onChangePersonal("all");
              }}
            >
              清空
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function RemarkGroup({
  label,
  value,
  onChange,
}: {
  label: string;
  value: RemarkState;
  onChange: (v: RemarkState) => void;
}) {
  const items: { v: RemarkState; label: string }[] = [
    { v: "all", label: "全部" },
    { v: "has", label: "有" },
    { v: "none", label: "无" },
  ];
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="grid grid-cols-3 gap-1">
        {items.map((it) => {
          const active = it.v === value;
          return (
            <button
              key={it.v}
              type="button"
              onClick={() => onChange(it.v)}
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
  );
}

/* ─────────────────────────────────────────────
   排序 chip：方向 + 字段
   ───────────────────────────────────────────── */
const SORT_FIELD_OPTIONS = [
  { v: "updated", label: "修改时间" },
  { v: "created", label: "创建时间" },
  { v: "name", label: "文件名称" },
] as const;

type SortField = (typeof SORT_FIELD_OPTIONS)[number]["v"];
type SortDir = "asc" | "desc";

export function splitSortKey(key: SortKey): { field: SortField; direction: SortDir } {
  const idx = key.lastIndexOf("_");
  return {
    field: key.slice(0, idx) as SortField,
    direction: key.slice(idx + 1) as SortDir,
  };
}

export function joinSortKey(field: SortField, direction: SortDir): SortKey {
  return `${field}_${direction}` as SortKey;
}

export function SortFilterChip({
  value,
  onChange,
  baseValue,
  compact = false,
}: {
  value: SortKey;
  onChange: (v: SortKey) => void;
  baseValue: SortKey;
  compact?: boolean;
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
            CHIP_TRIGGER_BASE,
            compact ? CHIP_TRIGGER_COMPACT : CHIP_TRIGGER_NORMAL,
            "hover:border-primary/40 hover:bg-primary/5",
            dirty && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          <span className={cn("text-muted-foreground", dirty && "text-primary/80")}>排序</span>
          <span className="font-medium">{summary}</span>
          <ChevronDown
            className={cn(
              compact ? CHIP_CHEVRON_COMPACT : CHIP_CHEVRON_NORMAL,
              "opacity-60",
              dirty && "opacity-80",
            )}
          />
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

/* ─────────────────────────────────────────────
   筛选分组 chip：将多个单选维度合并为一个下拉面板
   ───────────────────────────────────────────── */
export interface FilterGroup {
  key: string;
  label: string;
  options: readonly ChipOption[];
  value: string;
  onChange: (v: string) => void;
}

export interface FilterRemarkGroup {
  common: RemarkState;
  personal: RemarkState;
  onChangeCommon: (v: RemarkState) => void;
  onChangePersonal: (v: RemarkState) => void;
}

export function FilterGroupChip({
  groups,
  remark,
  dirtyCount,
  onReset,
  compact = false,
}: {
  groups: FilterGroup[];
  remark?: FilterRemarkGroup;
  dirtyCount: number;
  onReset: () => void;
  compact?: boolean;
}) {
  const dirty = dirtyCount > 0;
  const summary =
    dirtyCount === 0
      ? "全部"
      : `${dirtyCount} 项已选`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            CHIP_TRIGGER_BASE,
            compact ? CHIP_TRIGGER_COMPACT : CHIP_TRIGGER_NORMAL,
            "hover:border-primary/40 hover:bg-primary/5",
            dirty && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          <span className={cn("text-muted-foreground", dirty && "text-primary/80")}>
            属性
          </span>
          <span className="font-medium">{summary}</span>
          <ChevronDown
            className={cn(
              compact ? CHIP_CHEVRON_COMPACT : CHIP_CHEVRON_NORMAL,
              "opacity-60",
              dirty && "opacity-80",
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-h-[70vh] w-64 overflow-y-auto p-2" align="start">
        <div className="space-y-3">
          {groups.map((group) => (
            <FilterGroupSection
              key={group.key}
              label={group.label}
              options={group.options}
              value={group.value}
              onChange={group.onChange}
            />
          ))}
          {remark && (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">备注</div>
              <div className="space-y-1.5">
                <RemarkGroup label="通用备注" value={remark.common} onChange={remark.onChangeCommon} />
                <RemarkGroup label="个人备注" value={remark.personal} onChange={remark.onChangePersonal} />
              </div>
            </div>
          )}
        </div>
        {dirty && (
          <div className="mt-2 border-t pt-1.5">
            <button
              type="button"
              onClick={onReset}
              className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-primary"
            >
              <RotateCcw className="h-3 w-3" />
              重置
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function FilterGroupSection({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly ChipOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={cn(
                "h-7 rounded-md border px-2.5 text-xs transition",
                active
                  ? "border-primary/40 bg-primary/10 font-medium text-primary"
                  : "border-transparent bg-muted/50 hover:border-primary/30 hover:bg-primary/5",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   主体 chip：动态扩展的单选下拉，列表样式
   ───────────────────────────────────────────── */
export function SubjectFilterChip({
  options,
  value,
  onChange,
  compact = false,
}: {
  options: readonly ChipOption[];
  value: string;
  onChange: (v: string) => void;
  compact?: boolean;
}) {
  const current = options.find((o) => o.value === value) || options[0];
  const dirty = value !== "all";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            CHIP_TRIGGER_BASE,
            compact ? CHIP_TRIGGER_COMPACT : CHIP_TRIGGER_NORMAL,
            "hover:border-primary/40 hover:bg-primary/5",
            dirty && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          <span className={cn("text-muted-foreground", dirty && "text-primary/80")}>
            主体
          </span>
          <span className="font-medium">{current?.label ?? "全部"}</span>
          <ChevronDown
            className={cn(
              compact ? CHIP_CHEVRON_COMPACT : CHIP_CHEVRON_NORMAL,
              "opacity-60",
              dirty && "opacity-80",
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-1" align="start">
        <div className="max-h-60 overflow-auto">
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
