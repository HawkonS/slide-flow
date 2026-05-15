import * as React from "react";
import { RotateCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DEFAULT_SORT_KEY,
  RESOURCE_PERMISSION_OPTIONS,
  RESOURCE_SECRECY_OPTIONS,
  RESOURCE_STATUS_OPTIONS,
} from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useResourceFilters } from "@/stores/resource-filters";
import {
  FilterChip,
  RemarkFilterChip,
  SortFilterChip,
  TagFilterChip,
  type ChipOption,
} from "./filter-chips";

export interface ResourceFiltersProps {
  subjects: string[];
  tags: string[];
  /** 右侧插槽：如"拆分导入 / 上传资源"按钮组 */
  actions?: React.ReactNode;
}

export function ResourceFilters({ subjects, tags, actions }: ResourceFiltersProps) {
  const s = useResourceFilters();

  const subjectOptions = React.useMemo<ChipOption[]>(() => {
    const items = subjects.filter(Boolean);
    const sorted = Array.from(new Set(items)).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
    return [{ value: "all", label: "全部" }, ...sorted.map((x) => ({ value: x, label: x }))];
  }, [subjects]);

  const isDirty =
    s.query.trim() !== "" ||
    s.status !== "all" ||
    s.subject !== "all" ||
    s.secrecy !== "all" ||
    s.permission !== "all" ||
    s.remarkCommon !== "all" ||
    s.remarkPersonal !== "all" ||
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
        baseValue="all"
      />
      <FilterChip
        label="主体"
        options={subjectOptions}
        value={s.subject}
        onChange={(v) => s.setSubject(v)}
        baseValue="all"
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
      <RemarkFilterChip
        common={s.remarkCommon}
        personal={s.remarkPersonal}
        onChangeCommon={(v) => s.setRemarkCommon(v)}
        onChangePersonal={(v) => s.setRemarkPersonal(v)}
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
