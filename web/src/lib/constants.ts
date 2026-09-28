export const DEFAULT_RESOURCE_SUBJECT = "";

/** 权限筛选（列表页用，内存筛选：created/managed/visible） */
export const RESOURCE_PERMISSION_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "created", label: "我创建的" },
  { value: "managed", label: "我管理的" },
  { value: "visible", label: "我可见的" },
] as const;

/** 备注筛选（列表页用）——每种备注独立三态 */
export const RESOURCE_REMARK_STATE_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "has", label: "有" },
  { value: "none", label: "无" },
] as const;

/** 列表排序选项（单页素材 / 标准放映通用） */
export type SortKey =
  | "updated_desc"
  | "updated_asc"
  | "created_desc"
  | "created_asc"
  | "name_asc"
  | "name_desc";

export const DEFAULT_SORT_KEY: SortKey = "updated_desc";

/** 可见/管理范围（编辑用） */
export const VISIBILITY_SCOPE_OPTIONS = [
  { value: "public", label: "公开（全体可见）" },
  { value: "partial", label: "部分（指定用户）" },
  { value: "private", label: "仅自己" },
] as const;

export const MANAGEMENT_SCOPE_OPTIONS = [
  { value: "public", label: "公开（全体可管理）" },
  { value: "partial", label: "部分（指定用户）" },
  { value: "private", label: "仅自己" },
] as const;

export const RESOURCE_SCOPE_LABEL: Record<string, string> = {
  public: "公开",
  partial: "部分",
  private: "仅自己",
};

/** 模板类型 */
export const TEMPLATE_TYPE_LABEL: Record<string, string> = {
  cover: "封面",
  catalog: "目录",
  content: "正文",
  other: "其他",
};

export const TEMPLATE_TYPE_OPTIONS = [
  { value: "cover", label: "封面" },
  { value: "catalog", label: "目录" },
  { value: "content", label: "正文" },
  { value: "other", label: "其他" },
] as const;

export const TEMPLATE_PLATFORM_LABEL: Record<string, string> = {
  wps: "WPS",
  microsoft: "Microsoft",
};

export const TEMPLATE_PLATFORM_OPTIONS = [
  { value: "wps", label: "WPS" },
  { value: "microsoft", label: "Microsoft" },
] as const;

export const TEMPLATE_RATIO_OPTIONS = [
  { value: "16:9", label: "16:9" },
  { value: "4:3", label: "4:3" },
] as const;

/** 用户角色 */
export const USER_ROLE_LABEL: Record<string, string> = {
  system_admin: "系统管理员",
  admin: "运营管理员",
  user: "普通用户",
};

export const USER_ROLE_OPTIONS = [
  { value: "user", label: "普通用户" },
  { value: "admin", label: "运营管理员" },
  { value: "system_admin", label: "系统管理员" },
] as const;
