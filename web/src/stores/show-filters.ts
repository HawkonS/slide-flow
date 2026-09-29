import { create } from "zustand";
import { DEFAULT_SORT_KEY, type SortKey } from "@/lib/constants";

/** 放映列表的筛选状态（前端内存过滤） */
export interface ShowFiltersState {
  query: string;
  subject: string;            // "all" = 全部
  status: string;
  permission: "all" | "created" | "managed" | "visible";
  tags: string[];             // 选中的标签
  /** 标签匹配模式：any=满足任一即可（OR），all=需全部满足（AND） */
  tagsMode: "any" | "all";
  /** 排序方式 */
  sort: SortKey;

  setQuery: (value: string) => void;
  setSubject: (value: string) => void;
  setStatus: (value: string) => void;
  setPermission: (value: "all" | "created" | "managed" | "visible") => void;
  setTags: (value: string[]) => void;
  toggleTag: (tag: string) => void;
  setTagsMode: (value: "any" | "all") => void;
  setSort: (value: SortKey) => void;
  reset: () => void;
}

export const useShowFilters = create<ShowFiltersState>((set) => ({
  query: "",
  subject: "all",
  status: "all",
  permission: "all",
  tags: [],
  tagsMode: "all",
  sort: DEFAULT_SORT_KEY,
  setQuery: (value) => set({ query: value }),
  setSubject: (value) => set({ subject: value }),
  setStatus: (value) => set({ status: value }),
  setPermission: (value) => set({ permission: value }),
  setTags: (value) => set({ tags: value }),
  toggleTag: (tag) =>
    set((s) => {
      const next = s.tags.includes(tag) ? s.tags.filter((t) => t !== tag) : [...s.tags, tag];
      return { tags: next };
    }),
  setTagsMode: (value) => set({ tagsMode: value }),
  setSort: (value) => set({ sort: value }),
  reset: () =>
    set({
      query: "",
      subject: "all",
      status: "all",
      permission: "all",
      tags: [],
      tagsMode: "all",
      sort: DEFAULT_SORT_KEY,
    }),
}));
