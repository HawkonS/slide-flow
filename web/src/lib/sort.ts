import type { SortKey } from "./constants";

export interface SortableItem {
  name: string;
  created_at?: string | null;
  updated_at?: string | null;
}

const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

function cmpStr(a?: string | null, b?: string | null): number {
  const av = a || "";
  const bv = b || "";
  if (av === bv) return 0;
  // 空值排到最后
  if (!av) return 1;
  if (!bv) return -1;
  return av < bv ? -1 : 1;
}

/**
 * 按指定排序键对列表进行稳定排序（不修改入参）。
 * 时间字段使用字符串字典序比较（后端为 ISO 时间戳，字典序 == 时间序）。
 */
export function sortListItems<T extends SortableItem>(items: T[], key: SortKey): T[] {
  const arr = items.slice();
  arr.sort((a, b) => {
    switch (key) {
      case "name_asc":
        return collator.compare(a.name || "", b.name || "");
      case "name_desc":
        return collator.compare(b.name || "", a.name || "");
      case "created_asc":
        return cmpStr(a.created_at, b.created_at);
      case "created_desc":
        return cmpStr(b.created_at, a.created_at);
      case "updated_asc":
        return cmpStr(a.updated_at, b.updated_at);
      case "updated_desc":
      default:
        return cmpStr(b.updated_at, a.updated_at);
    }
  });
  return arr;
}
