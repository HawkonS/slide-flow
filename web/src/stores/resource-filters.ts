import { create } from "zustand";
import { DEFAULT_SORT_KEY, type SortKey } from "@/lib/constants";

/** 资源列表的筛选状态（前端内存过滤） */
export interface ResourceFiltersState {
  query: string;
  subject: string;            // "all" = 全部
  status: string;
  permission: "all" | "created" | "managed" | "visible";
  /** 通用备注状态 */
  remarkCommon: "all" | "has" | "none";
  /** 个人备注状态 */
  remarkPersonal: "all" | "has" | "none";
  tags: string[];             // 选中的标签
  /** 标签匹配模式：any=满足任一即可（OR），all=需全部满足（AND） */
  tagsMode: "any" | "all";
  /** 排序方式 */
  sort: SortKey;

  setQuery: (value: string) => void;
  setSubject: (value: string) => void;
  setStatus: (value: string) => void;
  setPermission: (value: "all" | "created" | "managed" | "visible") => void;
  setRemarkCommon: (value: "all" | "has" | "none") => void;
  setRemarkPersonal: (value: "all" | "has" | "none") => void;
  setTags: (value: string[]) => void;
  toggleTag: (tag: string) => void;
  setTagsMode: (value: "any" | "all") => void;
  setSort: (value: SortKey) => void;
  /** 从 /api/config 加载的默认筛选值初始化 */
  initDefaults: (config: {
    default_filters?: {
      resource_tags?: string[];
      subject?: string;
      status?: string;
    };
  }) => void;
  reset: () => void;
}

// 保存配置默认值，用于 reset 时恢复
let _defaultStatus = "all";
let _defaultSubject: string = "all";
let _defaultTags: string[] = [];
// URL 状态已恢复时跳过 initDefaults 覆写
let _urlRestored = false;
export const markResourceFiltersUrlRestored = () => { _urlRestored = true; };

export const useResourceFilters = create<ResourceFiltersState>((set) => ({
  query: "",
  subject: "all",
  status: "all",
  permission: "all",
  remarkCommon: "all",
  remarkPersonal: "all",
  tags: [],
  tagsMode: "all",
  sort: DEFAULT_SORT_KEY,
  setQuery: (value) => set({ query: value }),
  setSubject: (value) => set({ subject: value }),
  setStatus: (value) => set({ status: value }),
  setPermission: (value) => set({ permission: value }),
  setRemarkCommon: (value) => set({ remarkCommon: value }),
  setRemarkPersonal: (value) => set({ remarkPersonal: value }),
  setTags: (value) => set({ tags: value }),
  toggleTag: (tag) =>
    set((s) => {
      const next = s.tags.includes(tag) ? s.tags.filter((t) => t !== tag) : [...s.tags, tag];
      return { tags: next };
    }),
  setTagsMode: (value) => set({ tagsMode: value }),
  setSort: (value) => set({ sort: value }),
  initDefaults: (config) => {
    const defaults = config.default_filters;
    const status = defaults?.status || "all";
    const subject = defaults?.subject || "all";
    const tags = Array.from(new Set(defaults?.resource_tags ?? []));
    _defaultStatus = status;
    _defaultSubject = subject;
    _defaultTags = tags;
    // URL 状态已恢复时跳过，避免配置默认值覆写用户保存的筛选
    if (_urlRestored) return;
    // 仅在实际值变化时才 set，避免无意义的引用变化触发下游 effect
    set((s) => (
      s.status === status
      && s.subject === subject
      && s.tags.length === tags.length
      && s.tags.every((tag, index) => tag === tags[index])
        ? {}
        : { status, subject, tags }
    ));
  },
  reset: () =>
    set({
      query: "",
      subject: _defaultSubject,
      status: _defaultStatus,
      permission: "all",
      remarkCommon: "all",
      remarkPersonal: "all",
      tags: [..._defaultTags],
      tagsMode: "all",
      sort: DEFAULT_SORT_KEY,
    }),
}));
