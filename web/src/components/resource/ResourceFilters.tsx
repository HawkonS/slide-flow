import * as React from "react";
import type { SceneFilters } from "@/lib/tag-defaults";
import { RotateCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DEFAULT_SORT_KEY,
  RESOURCE_PERMISSION_OPTIONS,
} from "@/lib/constants";
import { useMetadataTagOptions } from "@/components/resource/MetadataTagSelect";
import { cn } from "@/lib/utils";
import {
  FilterGroupChip,
  SortFilterChip,
  SubjectFilterChip,
  TagFilterChip,
  type ChipOption,
  type FilterGroup,
} from "./filter-chips";

export interface ResourceFiltersProps {
  filters: SceneFilters;
  subjects: string[];
  tags: string[];
  actions?: React.ReactNode;
}

export function ResourceFilters({ filters: s, subjects, tags, actions }: ResourceFiltersProps) {
  const { options: statusTags } = useMetadataTagOptions("status");
  const statusOptions = React.useMemo<ChipOption[]>(
    () => [{ value: "all", label: "全部" }, ...statusTags],
    [statusTags],
  );

  const subjectOptions = React.useMemo<ChipOption[]>(() => {
    const items = subjects.filter(Boolean);
    const sorted = Array.from(new Set(items)).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
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
    s.remarkCommon !== "all",
    s.remarkPersonal !== "all",
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
            "focus:border-foreground/40 focus:ring-2 focus:ring-ring/20",
            s.query.trim() !== "" && "border-foreground/25 bg-primary-weak",
          )}
        />
      </div>

      {/* 筛选（分组下拉） */}
      <FilterGroupChip
        groups={groups}
        remark={{
          common: s.remarkCommon,
          personal: s.remarkPersonal,
          onChangeCommon: (v) => s.setRemarkCommon(v),
          onChangePersonal: (v) => s.setRemarkPersonal(v),
        }}
        dirtyCount={filterDirtyCount}
        onReset={() => s.clear()}
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
          onClick={() => s.clear()}
          className="h-8 gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          清空筛选
        </Button>
      )}

      {/* 操作按钮 */}
      <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => s.reset()}>恢复默认</Button>

      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}
