import * as React from "react";
import type { SceneFilters } from "@/lib/tag-defaults";
import { useSearchInput } from "@/lib/use-search-input";
import { RotateCcw, Search, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  viewSwitch?: React.ReactNode;
}

export function ResourceFilters({ filters: s, subjects, tags, actions, viewSwitch }: ResourceFiltersProps) {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const searchInput = useSearchInput(s.query, s.setQuery);
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
  const activeCount =
    (s.query.trim() ? 1 : 0) +
    filterDirtyCount +
    (s.subject !== "all" ? 1 : 0) +
    (s.tags.length > 0 ? 1 : 0) +
    (s.sort !== DEFAULT_SORT_KEY ? 1 : 0);

  const filterControls = (
    <>
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
      <SubjectFilterChip options={subjectOptions} value={s.subject} onChange={(v) => s.setSubject(v)} />
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
      <SortFilterChip value={s.sort} onChange={(v) => s.setSort(v)} baseValue={DEFAULT_SORT_KEY} />
    </>
  );

  return (
    <>
    <div className="hidden flex-wrap items-center gap-2 sm:flex">
      {/* 搜索 */}
      <div className="relative min-w-0 flex-1 sm:flex-none">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          {...searchInput}
          placeholder="搜索标题、关键词"
          className={cn(
            "h-8 w-full rounded-md border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition sm:w-56",
            "placeholder:text-muted-foreground",
            "focus:border-foreground/40 focus:ring-2 focus:ring-ring/20",
            s.query.trim() !== "" && "border-foreground/25 bg-primary-weak",
          )}
        />
      </div>

      {filterControls}

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

    <div className="flex items-center gap-2 sm:hidden">
      {viewSwitch}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 shrink-0 gap-1.5 px-2.5"
        onClick={() => setMobileOpen(true)}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        筛选
        {activeCount > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[9px] font-semibold text-background">
            {activeCount}
          </span>
        )}
      </Button>
      {actions && <div className="ml-auto flex min-w-0 items-center gap-1.5">{actions}</div>}
    </div>

    <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
      <DialogContent className="flex max-h-[min(760px,calc(100vh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-5 py-4 pr-12 text-left">
          <DialogTitle>筛选素材</DialogTitle>
          <DialogDescription>搜索标题、关键词，或按状态、主体、标签和排序筛选。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <MobileSearch value={s.query} onChange={s.setQuery} />
          <div className="flex flex-wrap gap-2">{filterControls}</div>
          {isDirty && (
            <Button variant="ghost" size="sm" onClick={() => s.clear()} className="h-8 gap-1 px-0 text-xs text-muted-foreground">
              <RotateCcw className="h-3.5 w-3.5" />
              清空筛选
            </Button>
          )}
        </div>
        <DialogFooter className="flex-row justify-end border-t px-5 py-3">
          <Button variant="outline" onClick={() => setMobileOpen(false)}>取消</Button>
          <Button onClick={() => setMobileOpen(false)}>查看结果</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

function MobileSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const input = useSearchInput(value, onChange);
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        {...input}
        placeholder="搜索标题、关键词"
        className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus:border-foreground/40 focus:ring-2 focus:ring-ring/20"
      />
    </div>
  );
}
