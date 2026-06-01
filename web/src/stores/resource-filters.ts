import { create } from "zustand";
import { DEFAULT_SORT_KEY, type SortKey } from "@/lib/constants";

/** 资源列表的筛选状态（前端内存过滤） */
export interface ResourceFiltersState {
  query: string;
  subject: string;            // "all" = 全部
  secrecy: "all" | "public" | "confidential" | "secret";
  status: "all" | "active" | "disabled";
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
  setSecrecy: (value: "all" | "public" | "confidential" | "secret") => void;
  setStatus: (value: "all" | "active" | "disabled") => void;
  setPermission: (value: "all" | "created" | "managed" | "visible") => void;
  setRemarkCommon: (value: "all" | "has" | "none") => void;
  setRemarkPersonal: (value: "all" | "has" | "none") => void;
  setTags: (value: string[]) => void;
  toggleTag: (tag: string) => void;
  setTagsMode: (value: "any" | "all") => void;
  setSort: (value: SortKey) => void;
  /** 从 /api/config 加载的默认筛选值初始化 */
  initDefaults: (config: { default_filter_status?: string; default_filter_subject?: string }) => void;
  reset: () => void;
}

// 保存配置默认值，用于 reset 时恢复
let _defaultStatus: "all" | "active" | "disabled" = "all";
let _defaultSubject: string = "all";
// URL 状态已恢复时跳过 initDefaults 覆写
let _urlRestored = false;
export const markResourceFiltersUrlRestored = () => { _urlRestored = true; };

export const useResourceFilters = create<ResourceFiltersState>((set) => ({
  query: "",
  subject: "all",
  secrecy: "all",
  status: "all",
  permission: "all",
  remarkCommon: "all",
  remarkPersonal: "all",
  tags: [],
  tagsMode: "all",
  sort: DEFAULT_SORT_KEY,
  setQuery: (value) => set({ query: value }),
  setSubject: (value) => set({ subject: value }),
  setSecrecy: (value) => set({ secrecy: value }),
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
    const status = (config.default_filter_status || "all") as "all" | "active" | "disabled";
    const subject = config.default_filter_subject || "all";
    _defaultStatus = status;
    _defaultSubject = subject;
    // URL 状态已恢复时跳过，避免配置默认值覆写用户保存的筛选
    if (_urlRestored) return;
    // 仅在实际值变化时才 set，避免无意义的引用变化触发下游 effect
    set((s) => (s.status === status && s.subject === subject ? {} : { status, subject }));
  },
  reset: () =>
    set({
      query: "",
      subject: _defaultSubject,
      secrecy: "all",
      status: _defaultStatus,
      permission: "all",
      remarkCommon: "all",
      remarkPersonal: "all",
      tags: [],
      tagsMode: "all",
      sort: DEFAULT_SORT_KEY,
    }),
}));
