import * as React from "react";
import { RotateCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DEFAULT_RESOURCE_SUBJECT,
  DEFAULT_SORT_KEY,
  RESOURCE_PERMISSION_OPTIONS,
} from "@/lib/constants";
import { useMetadataTagOptions } from "@/components/resource/MetadataTagSelect";
import { cn } from "@/lib/utils";
import { useShowFilters } from "@/stores/show-filters";
import {
  FilterGroupChip,
  SortFilterChip,
  SubjectFilterChip,
  TagFilterChip,
  type ChipOption,
  type FilterGroup,
} from "@/components/resource/filter-chips";

export interface ShowFiltersProps {
  subjects: string[];
  tags: string[];
  /** 右侧插槽：如"创建放映"按钮 */
  actions?: React.ReactNode;
}

export function ShowFilters({ subjects, tags, actions }: ShowFiltersProps) {
  const s = useShowFilters();
  const { options: statusTags } = useMetadataTagOptions("status");
  const statusOptions = React.useMemo<ChipOption[]>(
    () => [{ value: "all", label: "全部" }, ...statusTags],
    [statusTags],
  );

  const subjectOptions = React.useMemo<ChipOption[]>(() => {
    const set = new Set<string>([DEFAULT_RESOURCE_SUBJECT, ...subjects.filter(Boolean)]);
    const sorted = Array.from(set).sort((a, b) => {
      if (a === DEFAULT_RESOURCE_SUBJECT) return -1;
      if (b === DEFAULT_RESOURCE_SUBJECT) return 1;
      return a.localeCompare(b, "zh-Hans-CN");
    });
    return [{ value: "all", label: "全部" }, ...sorted.map((x) => ({ value: x, label: x }))];
  }, [subjects]);

  const groups = React.useMemo<FilterGroup[]>(
    () => [
      {
        key: "status",
        label: "状态",
        options: statusOptions,
        value: s.status,
        onChange: (v) => s.setStatus(v as typeof s.status),
      },
      {
        key: "permission",
        label: "权限",
        options: RESOURCE_PERMISSION_OPTIONS,
        value: s.permission,
        onChange: (v) => s.setPermission(v as typeof s.permission),
      },
    ],
    [s.status, s.permission, s, statusOptions],
  );

  const filterDirtyCount = [
    s.status !== "all",
    s.permission !== "all",
  ].filter(Boolean).length;

  const isDirty =
    s.query.trim() !== "" ||
    filterDirtyCount > 0 ||
    s.subject !== "all" ||
    s.tags.length > 0 ||
    s.sort !== DEFAULT_SORT_KEY;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* 搜索 */}
      <div className="relative min-w-0 flex-1 sm:flex-none">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={s.query}
          onChange={(e) => s.setQuery(e.target.value)}
          placeholder="搜索标题、关键词"
          className={cn(
            "h-8 w-full rounded-md border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition sm:w-56",
            "placeholder:text-muted-foreground",
            "focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
            s.query.trim() !== "" && "border-primary/40 bg-primary/5",
          )}
        />
      </div>

      {/* 筛选（分组下拉） */}
      <FilterGroupChip
        groups={groups}
        dirtyCount={filterDirtyCount}
        onReset={() => s.reset()}
      />

      {/* 主体（独立 chip，可扩展） */}
      <SubjectFilterChip
        options={subjectOptions}
        value={s.subject}
        onChange={(v) => s.setSubject(v)}
      />

      {/* 标签（独立 chip） */}
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

      {/* 排序 */}
      <SortFilterChip
        value={s.sort}
        onChange={(v) => s.setSort(v)}
        baseValue={DEFAULT_SORT_KEY}
      />

      {/* 重置 */}
      {isDirty && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => s.reset()}
          className="h-8 gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          重置
        </Button>
      )}

      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}
