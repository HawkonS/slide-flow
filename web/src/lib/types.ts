export type UserRole = "system_admin" | "admin" | "user";

/** 角色语义：system_admin=系统管理员，admin=运营管理员，user=普通用户。 */

/** 是否为运营管理员或系统管理员 */
export const isAdminRole = (role?: UserRole | string | null): boolean =>
  role === "system_admin" || role === "admin";

/** 是否为系统管理员 */
export const isSystemAdminRole = (role?: UserRole | string | null): boolean =>
  role === "system_admin";

export interface CurrentUser {
  id: number;
  session_version?: number;
  username: string;
  name: string | null;
  role: UserRole;
  feishu_id?: string | null;
  avatar_url?: string | null;
  tags?: string;
  must_change_pwd?: boolean;
  temporary_password_expires_at?: string | null;
}

export interface UserOption {
  id: number;
  username: string;
  name: string | null;
  avatar_url?: string | null;
  tags?: string;
}

export type VisibilityScope = "public" | "partial" | "private";
export type ResourceStatus = string;

export interface ResourceVersion {
  archived?: boolean;
  id: number;
  version_no: number;
  font_names: string[];
  font_aliases?: Record<string, string[]>;
  missing_fonts?: string[];
  common_remark_html: string | null;
  change_note: string | null;
  created_by: number | null;
  created_at: string;
  preview_url: string | null;
  original_preview_url: string | null;
}

export interface Resource {
  id: number;
  /** 不可枚举的详情页地址 key */
  detail_token: string;
  name: string;
  owner_id: number;
  subject: string | null;
  /** 逗号/空格分隔的标签字符串 */
  tags: string;
  status: ResourceStatus;
  visibility_scope: VisibilityScope;
  management_scope: VisibilityScope;
  current_version: number;
  version_count?: number;
  created_at: string;
  updated_at: string;

  owner: { id: number; username: string; name: string | null } | null;
  updated_by?: { id: number; username: string; name: string | null } | null;
  can_manage: boolean;
  visible_user_ids?: number[];
  visible_user_tags?: string[];
  manage_user_ids?: number[];
  manage_user_tags?: string[];
  current: ResourceVersion;
  /** 仅在详情接口返回，列表接口不包含 */
  versions?: ResourceVersion[];
  /** 当前用户在该资源的任一版本下是否有个人备注 */
  has_personal_remark?: boolean;
  /** 当前用户是否已将该资源添加到首页 */
  is_pinned?: boolean;
}

export interface TemplateItem {
  id: number;
  name: string;
  subject: string | null;
  series: string | null;
  platform: string | null;
  ratio: string | null;
  template_type: string | null;
  order_index?: number;
  sort_order?: number;
  visibility_scope?: VisibilityScope;
  management_scope?: VisibilityScope;
  office_file_name?: string | null;
  font_names?: string[];
  font_aliases?: Record<string, string[]>;
  missing_fonts?: string[];
  preview_url: string | null;
  original_preview_url: string | null;
  download_url: string | null;
  can_manage?: boolean;
  owner?: { id: number; name: string | null; username: string } | null;
  visible_user_ids?: number[];
  manage_user_ids?: number[];
  manage_user_tags?: string[];
  visible_user_tags?: string[];
  updated_at: string;
  created_at: string;
}

export interface FontItem {
  id: number;
  family: string;
  aliases?: string[];
  file_name: string;
  download_url: string;
  uploaded_by?: string;
  installed_on_server?: boolean;
  created_at?: string;
}

export interface AdminUser {
  id: number;
  username: string;
  name: string | null;
  feishu_id: string | null;
  avatar_url?: string | null;
  tags?: string;
  role: UserRole;
  must_change_pwd?: boolean;
  temporary_password_expires_at?: string | null;
  last_login_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminUsersResponse {
  users: AdminUser[];
  available_tags: string[];
  page: number;
  page_size: number;
  total: number;
  stats: {
    total_users: number;
    active_week: number;
    active_today: number;
  };
}

/** 把 tags 字符串切成数组（逗号/空格分隔） */
export function parseTags(value: string | null | undefined): string[] {
  return (value || "")
    .split(/[，,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 把标签数组拼回后端期望的字符串（用逗号分隔） */
export function serializeTags(tags: string[]): string {
  return tags.filter(Boolean).join(",");
}

/** 放映中的资源项（可访问时） */
export interface ShowResourceAccessible {
  id: number;
  accessible: true;
  name: string;
  hidden: boolean;
  version_no: number;
  latest_version_no: number;
  preview_url: string | null;
  original_preview_url: string | null;
}

/** 放映中的资源项（不可访问时） */
export interface ShowResourceInaccessible {
  unavailable_reason?: "missing_resource" | "missing_version";
  version_no?: number;
  id: number;
  accessible: false;
  name: string;
  hidden: boolean;
  managers: { id: number; name: string | null; username: string }[];
}

export type ShowResource = ShowResourceAccessible | ShowResourceInaccessible;

export interface Show {
  id: number;
  name: string;
  owner_id: number;
  owner: { id: number; username: string; name: string | null } | null;
  updated_by?: { id: number; username: string; name: string | null } | null;
  subject: string | null;
  tags: string;
  status: ResourceStatus;
  visibility_scope: VisibilityScope;
  management_scope: VisibilityScope;
  is_standard: boolean;
  can_manage: boolean;
  visible_user_ids?: number[];
  visible_user_tags?: string[];
  manage_user_ids?: number[];
  manage_user_tags?: string[];
  /** 列表接口仅返回前2个资源预览 */
  resources: ShowResource[];
  /** 列表接口附带的完整资源 ID 列表（用于判断某资源是否已在该放映中） */
  all_resource_ids?: number[];
  series_id: string;
  version_no: number;
  /** 放映系列的版本总数（含自身） */
  version_count?: number;
  /** 放映系列的最新版本号 */
  latest_version_no?: number;
  change_note?: string;
  has_other_versions: boolean;
  created_at: string;
  updated_at: string;
  /** 当前用户是否已将该放映添加到首页 */
  is_pinned?: boolean;
}

export interface ShowVersionItem {
  id: number;
  version_no: number;
  name: string;
  change_note: string;
  resource_count: number;
  created_at: string;
  owner: { id: number; username: string; name: string | null };
}

// 资源变更对比数据（resource-diff 接口返回）
export interface ResourceDiff {
  resource_id: number;
  resource_name: string;
  current_version_no: number;
  latest_version_no: number;
  current_preview_url: string | null;
  latest_preview_url: string | null;
  current_original_preview_url: string | null;
  latest_original_preview_url: string | null;
  versions_between: Array<{
    version_no: number;
    change_note: string;
    created_at: string;
  }>;
  common_remark_diff: {
    current_html: string;
    latest_html: string;
  };
  show_remark_html: string;
}

// 迭代升级请求体
export interface IterateUpgradeRequest {
  resource_ids: number[];
  remarks: Record<string, string>;
  change_note: string;
  name?: string;
}

// 迭代升级响应
export interface IterateUpgradeResponse {
  show: Show;
  upgraded: Array<{
    resource_id: number;
    name: string;
    old_version_no: number;
    new_version_no: number;
  }>;
}

export interface UpdateInfo {
  resource_id: number;
  current_version_no: number;
  latest_version_no: number;
  name: string;
  preview_url: string | null;
  has_remark_change: boolean;
  version_gap: number;
  current_preview_url: string | null;
}

export interface CheckUpdatesResponse {
  updates: UpdateInfo[];
}
