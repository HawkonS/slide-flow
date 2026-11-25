import { useSceneFilters } from "@/lib/tag-defaults";
import { copyText } from "@/lib/clipboard";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Building2, Camera, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Clock, CloudDownload, Copy, Crown, KeyRound, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Shield, Tag, Trash2, Upload, User, UserPlus, Users, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { USER_ROLE_LABEL, USER_ROLE_OPTIONS } from "@/lib/constants";
import type {
  AdminUser,
  AdminUsersResponse,
  Department,
  DirectoryResponse,
  EmploymentStatus,
  UserRole,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { ListFooter } from "@/components/common/ListFooter";
import { TableNumberCell, TableNumberHead, TableText } from "@/components/common/TableContent";
import { PageHeader } from "@/components/common/PageHeader";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { TagInput } from "@/components/resource/TagInput";
import { FilterChip, TagFilterChip } from "@/components/resource/filter-chips";
import { parseTags, serializeTags } from "@/lib/types";
import { useAuth } from "@/lib/auth";
import { UserSearchSelect } from "@/components/resource/UserSearchSelect";
import { DepartmentPicker } from "@/components/directory/DepartmentPicker";
import { DepartmentDialog } from "@/components/directory/DepartmentDialog";
import { AddMembersDialog } from "@/components/directory/AddMembersDialog";
import { UserProfileModal } from "@/components/directory/UserProfileModal";
import { DirectorySyncScheduleDialog } from "@/components/directory/DirectorySyncScheduleDialog";

const userDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatUserDateTime(value: string | null | undefined, emptyText = "-") {
  if (!value) return emptyText;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : userDateTimeFormatter.format(date).split("/").join("-");
}

type LoginSort = "" | "asc" | "desc";

const USER_FILTER_BASE = { q: "", sub: "all", sta: "all", tags: [] as string[], tm: "any", p: 1, role: "all", login: "" as LoginSort, dept: "" as string, children: true, emp: "all" as string };

export function AdminUsersPage() {
  const qc = useQueryClient();
  const { user: currentUser, setUser } = useAuth();
  const { state: userFilterState, setState: setUserFilterState, filters: defaultFilters } = useSceneFilters("user_list", USER_FILTER_BASE);
  const { tags: tagFilters, tagsMode: tagFilterMode, setTags: setTagFilters, setTagsMode: setTagFilterMode } = defaultFilters;
  const roleFilter = userFilterState.role as UserRole | "all";
  const loginSort = userFilterState.login as LoginSort;
  const setRoleFilter = (role: UserRole | "all") => setUserFilterState((prev) => ({ ...prev, role, p: 1 }));
  const setLoginSort = (login: LoginSort) => setUserFilterState((prev) => ({ ...prev, login, p: 1 }));
  const selectedDepartment = (userFilterState.dept as string) || "";
  const includeChildren = userFilterState.children !== false;
  const employmentFilter = (userFilterState.emp as string) || "all";
  const setIncludeChildren = (value: boolean) =>
    setUserFilterState((prev) => ({ ...prev, children: value, p: 1 }));
  const setEmploymentFilter = (emp: string) =>
    setUserFilterState((prev) => ({ ...prev, emp, p: 1 }));

  const directoryQuery = useQuery({
    queryKey: ["admin", "directory"],
    queryFn: () => api<DirectoryResponse>("/api/admin/directory"),
    staleTime: 15_000,
  });
  const departments = directoryQuery.data?.departments ?? [];
  const directoryStats = directoryQuery.data?.stats;
  const rootDepartmentId = directoryStats?.root_id ?? 0;
  const departmentById = React.useMemo(
    () => new Map<number, Department>(departments.map((department) => [department.id, department])),
    [departments],
  );
  const childrenByParent = React.useMemo(() => {
    const map = new Map<number, Department[]>();
    for (const department of departments) {
      if (department.parent_id == null) continue;
      const list = map.get(department.parent_id) ?? [];
      list.push(department);
      map.set(department.parent_id, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "zh-CN"));
    }
    return map;
  }, [departments]);
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set());
  const [departmentSearch, setDepartmentSearch] = React.useState("");
  const [profileUser, setProfileUser] = React.useState<AdminUser | null>(null);
  const [scheduleOpen, setScheduleOpen] = React.useState(false);
  const [departmentDialog, setDepartmentDialog] = React.useState<{
    open: boolean;
    department: Department | null;
    parentId: number | null;
  }>({ open: false, department: null, parentId: null });
  const [addMembersOpen, setAddMembersOpen] = React.useState(false);
  const [deleteDepartment, setDeleteDepartment] = React.useState<Department | null>(null);
  const [deleteDepartmentUsage, setDeleteDepartmentUsage] = React.useState<{
    grants: number;
    members: number;
    children: number;
  } | null>(null);
  const expandedInitialized = React.useRef(false);

  React.useEffect(() => {
    if (!directoryQuery.data || expandedInitialized.current) return;
    const topLevel = (childrenByParent.get(rootDepartmentId) ?? []).map((department) => department.id);
    setExpanded(new Set(topLevel));
    expandedInitialized.current = true;
  }, [directoryQuery.data, childrenByParent, rootDepartmentId]);

  const [editing, setEditing] = React.useState<AdminUser | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [bulkTagsOpen, setBulkTagsOpen] = React.useState(false);
  const [transferUser, setTransferUser] = React.useState<AdminUser | null>(null);
  const [resetUser, setResetUser] = React.useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = React.useState("");
  const [resettingPassword, setResettingPassword] = React.useState(false);
  const [resetConfirmUser, setResetConfirmUser] = React.useState<AdminUser | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<AdminUser | null>(null);
  const queryInput = defaultFilters.query;
  const setQueryInput = defaultFilters.setQuery;
  const [query, setQuery] = React.useState(queryInput);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [filterSelectionIds, setFilterSelectionIds] = React.useState<number[] | null>(null);

  const delMut = useMutation({
    mutationFn: async (id: number) => api(`/api/admin/users/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("用户已删除");
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["users", "options"] });
      qc.invalidateQueries({ queryKey: ["admin", "directory"] });
    },
    onError: (err: Error) => toast.error(err.message || "删除失败"),
  });

  const deleteDepartmentMut = useMutation({
    mutationFn: async (department: Department) => {
      const force = Boolean(
        deleteDepartmentUsage && (deleteDepartmentUsage.grants > 0 || deleteDepartmentUsage.members > 0),
      );
      return api(`/api/departments/${department.id}?force=${force ? "true" : "false"}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      toast.success("部门已删除");
      setDeleteDepartment(null);
      setDeleteDepartmentUsage(null);
      qc.invalidateQueries({ queryKey: ["admin", "directory"] });
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["users", "options"] });
    },
    onError: (err: Error) => toast.error(err.message || "删除部门失败"),
  });

  const importFeishuMut = useMutation({
    mutationFn: async () => api<{ task_id: number; status: string }>(
      "/api/tasks/feishu-sync",
      { method: "POST" },
    ),
    onSuccess: (result) => {
      toast.success(`同步任务已提交（#${result.task_id}），可在任务管理查看进度`);
      qc.invalidateQueries({ queryKey: ["tasks"] });
      // Let the background task finish before refreshing the live directory.
      window.setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["admin", "users"] });
        qc.invalidateQueries({ queryKey: ["admin", "directory"] });
        qc.invalidateQueries({ queryKey: ["users", "options"] });
      }, 5000);
      window.setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["admin", "users"] });
        qc.invalidateQueries({ queryKey: ["admin", "directory"] });
        qc.invalidateQueries({ queryKey: ["users", "options"] });
      }, 20000);
      window.setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["admin", "users"] });
        qc.invalidateQueries({ queryKey: ["admin", "directory"] });
        qc.invalidateQueries({ queryKey: ["users", "options"] });
      }, 45000);
    },
    onError: (err: Error) => toast.error(err.message || "提交同步任务失败"),
  });

  const canManageUser = React.useCallback(
    (u: AdminUser) => currentUser?.role === "system_admin" || u.role !== "system_admin",
    [currentUser?.role],
  );
  const canDeleteUser = React.useCallback(
    (u: AdminUser) => canManageUser(u) && currentUser?.id !== u.id,
    [canManageUser, currentUser?.id],
  );
  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const requestPasswordReset = async (user: AdminUser) => {
    setResetConfirmUser(user);
  };

  const confirmPasswordReset = async () => {
    const user = resetConfirmUser;
    if (!user || resettingPassword) return;
    setResettingPassword(true);
    try {
      const result = await api<{ user: AdminUser; plain_password: string }>(
        `/api/admin/users/${user.id}/reset-password`,
        { method: "POST" },
      );
      setResetConfirmUser(null);
      setResetUser(result.user);
      setResetPassword(result.plain_password);
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (error) {
      toast.error((error as Error).message || "重置密码失败");
    } finally {
      setResettingPassword(false);
    }
  };


  const bulkDelMut = useMutation({
    mutationFn: async (ids: number[]) =>
      api<{ deleted: number }>("/api/admin/users/bulk-delete", {
        method: "POST",
        json: { user_ids: ids },
      }),
    onSuccess: (data) => {
      toast.success(`已删除 ${data.deleted} 个用户`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["admin", "directory"] });
      qc.invalidateQueries({ queryKey: ["users", "options"] });
    },
    onError: (err: Error) => toast.error(err.message || "批量删除失败"),
  });

  const selectionIdsMut = useMutation({
    mutationFn: async () => api<{ user_ids: number[]; total: number }>(
      "/api/admin/users/selection-ids",
      {
        params: {
          search: query || undefined,
          tags: tagFilters.length > 0 ? serializeTags(tagFilters) : undefined,
          tags_mode: tagFilterMode,
          role: roleFilter === "all" ? undefined : roleFilter,
          department_id: selectedDepartment || undefined,
          include_descendants: includeChildren,
          employment_status: employmentFilter === "all" ? undefined : employmentFilter,
        },
      },
    ),
    onSuccess: (result) => setFilterSelectionIds(result.user_ids),
    onError: (err: Error) => toast.error(err.message || "加载可选用户失败"),
  });

  const pageSize = 20;
  const page = userFilterState.p;
  const setPage = React.useCallback((action: React.SetStateAction<number>) => {
    setUserFilterState((prev) => ({ ...prev, p: typeof action === "function" ? action(prev.p) : action }));
  }, [setUserFilterState]);
  const { data, isLoading, isError, error, dataUpdatedAt, isFetching } = useQuery({
    queryKey: [
      "admin", "users", page, pageSize, query, tagFilters, tagFilterMode, roleFilter, loginSort,
      selectedDepartment, includeChildren, employmentFilter,
    ],
    queryFn: () => api<AdminUsersResponse>("/api/admin/users", {
      params: {
        page,
        page_size: pageSize,
        search: query || undefined,
        tags: tagFilters.length > 0 ? serializeTags(tagFilters) : undefined,
        tags_mode: tagFilterMode,
        role: roleFilter === "all" ? undefined : roleFilter,
        login_sort: loginSort || undefined,
        sort: loginSort ? undefined : "name",
        department_id: selectedDepartment || undefined,
        include_descendants: includeChildren,
        employment_status: employmentFilter === "all" ? undefined : employmentFilter,
      },
    }),
    placeholderData: (previous) => previous,
  });
  const users = data?.users ?? [];
  const availableTags = data?.available_tags ?? [];
  const total = data?.total ?? 0;
  const stats = data?.stats ?? { total_users: total, active_week: 0, active_today: 0 };
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const hasActiveFilters =
    queryInput.trim() !== "" || query.trim() !== "" || tagFilters.length > 0
    || roleFilter !== "all" || employmentFilter !== "all" || selectedDepartment !== "";
  const filtersKey = React.useMemo(
    () => JSON.stringify([
      query, tagFilters, tagFilterMode, roleFilter, employmentFilter,
      selectedDepartment, includeChildren,
    ]),
    [query, tagFilters, tagFilterMode, roleFilter, employmentFilter, selectedDepartment, includeChildren],
  );
  const previousFiltersKey = React.useRef(filtersKey);
  const handleUserSaved = React.useCallback((savedUser: AdminUser) => {
    qc.invalidateQueries({ queryKey: ["admin", "users"] });
    qc.invalidateQueries({ queryKey: ["admin", "directory"] });
    qc.invalidateQueries({ queryKey: ["users", "options"] });
    if (currentUser?.id === savedUser.id) {
      setUser({ ...currentUser, ...savedUser });
    }
  }, [currentUser, qc, setUser]);
  React.useEffect(() => {
    if (data && page > totalPages) setPage(totalPages);
  }, [data, page, pageSize, totalPages, setPage]);
  React.useEffect(() => {
    // Filter setters already reset the page; selection is cleared only when values change.
    if (previousFiltersKey.current === filtersKey) return;
    previousFiltersKey.current = filtersKey;
    setSelected(new Set());
    setFilterSelectionIds(null);
  }, [filtersKey, setPage]);
  React.useEffect(() => {
    setSelected((previous) => {
      const next = new Set(previous);
      users.forEach((user) => {
        if (!canDeleteUser(user)) next.delete(user.id);
      });
      if (next.size === previous.size && Array.from(next).every((id) => previous.has(id))) return previous;
      return next;
    });
  }, [users, canDeleteUser]);
  React.useEffect(() => {
    setFilterSelectionIds(null);
  }, [dataUpdatedAt]);
  const pageItemIds = React.useMemo(
    () => users.filter(canDeleteUser).map((u) => u.id),
    [users, canDeleteUser],
  );
  const allSelected = pageItemIds.length > 0 && pageItemIds.every((id) => selected.has(id));
  const someSelected = pageItemIds.some((id) => selected.has(id)) && !allSelected;
  const setPageSelection = (checked: boolean, ids: number[]) => {
    setSelected((current) => {
      const next = new Set(current);
      ids.forEach((id) => (checked ? next.add(id) : next.delete(id)));
      return next;
    });
  };

  const selectedDepartmentRow =
    selectedDepartment && selectedDepartment !== "none"
      ? departmentById.get(Number(selectedDepartment))
      : undefined;
  const selectedPath =
    selectedDepartment === "none" ? "公司直属" : selectedDepartmentRow?.path_names || "全部人员";
  const departmentFilter = departmentSearch.trim().toLowerCase();
  const allDepartmentIds = React.useMemo(
    () => departments.filter((department) => department.parent_id != null).map((department) => department.id),
    [departments],
  );
  const allExpanded = allDepartmentIds.length > 0 && allDepartmentIds.every((id) => expanded.has(id));
  const visibleDepartmentIds = React.useMemo(() => {
    if (!departmentFilter) return null;
    const visible = new Set<number>();
    const addSubtree = (id: number) => {
      if (visible.has(id)) return;
      visible.add(id);
      for (const child of childrenByParent.get(id) ?? []) addSubtree(child.id);
    };
    for (const department of departments) {
      if (department.parent_id == null) continue;
      if (
        !department.name.toLowerCase().includes(departmentFilter)
        && !(department.path_names || department.path).toLowerCase().includes(departmentFilter)
      ) {
        continue;
      }
      let current: Department | undefined = department;
      while (current && current.parent_id != null) {
        visible.add(current.id);
        current = departmentById.get(current.parent_id);
      }
      addSubtree(department.id);
    }
    return visible;
  }, [childrenByParent, departmentById, departmentFilter, departments]);
  const departmentSearchResults = React.useMemo(() => {
    if (!departmentFilter) return [];
    return departments
      .filter(
        (department) =>
          department.parent_id != null
          && (department.name.toLowerCase().includes(departmentFilter)
            || (department.path_names || department.path).toLowerCase().includes(departmentFilter)),
      )
      .sort((a, b) => (a.path_names || a.path).localeCompare(b.path_names || b.path, "zh-CN"));
  }, [departmentFilter, departments]);

  const selectDepartment = (department: Department | null) => {
    // Update the department and page in one navigation. Two separate
    // setSearchParams calls can race and leave the previous department active.
    setUserFilterState((prev) => ({
      ...prev,
      dept: department ? String(department.id) : "",
      p: 1,
    }));
    setDepartmentSearch("");
    if (department) {
      setExpanded((previous) => {
        const next = new Set(previous);
        let current: Department | undefined = department;
        while (current) {
          next.add(current.id);
          current = current.parent_id != null ? departmentById.get(current.parent_id) : undefined;
        }
        return next;
      });
    }
  };
  const toggleDepartment = (id: number) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const handleDepartmentSaved = () => {
    qc.invalidateQueries({ queryKey: ["admin", "directory"] });
    qc.invalidateQueries({ queryKey: ["admin", "users"] });
    qc.invalidateQueries({ queryKey: ["users", "options"] });
  };
  const requestDeleteDepartment = async (department: Department) => {
    try {
      const usage = await api<{ grants: number; members: number; children: number }>(
        `/api/departments/${department.id}/usage`,
      );
      if (usage.children > 0) {
        toast.error("该部门仍有下级部门，请先移动或删除下级部门");
        return;
      }
      setDeleteDepartmentUsage({ grants: usage.grants, members: usage.members, children: usage.children });
      setDeleteDepartment(department);
    } catch (err) {
      toast.error((err as Error).message || "读取部门使用情况失败");
    }
  };

  const renderDepartmentNode = (department: Department, depth: number): React.ReactNode => {
    if (visibleDepartmentIds && !visibleDepartmentIds.has(department.id)) return null;
    const kids = childrenByParent.get(department.id) ?? [];
    const isOpen = visibleDepartmentIds ? true : expanded.has(department.id);
    const active = selectedDepartment === String(department.id);
    const top = depth === 0;
    const primaryLeader = department.leaders.find((leader) => leader.is_primary) || department.leaders[0];
    const actionMenu = (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`部门操作 ${department.name}`}
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem
            onClick={() => setDepartmentDialog({ open: true, department: null, parentId: department.id })}
          >
            <Plus className="mr-2 h-3.5 w-3.5" />新建子部门
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setDepartmentDialog({ open: true, department, parentId: null })}
          >
            <Pencil className="mr-2 h-3.5 w-3.5" />编辑/负责人
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => void requestDeleteDepartment(department)}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />删除部门
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    return (
      <div key={department.id}>
        <div
          className={cn(
            "group relative flex h-8 cursor-pointer items-center rounded-md pr-1 transition-colors",
            top && "mt-1",
            active
              ? "bg-primary/10 text-foreground"
              : top
                ? "text-foreground/90 hover:bg-muted/60"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            !department.is_active && "opacity-50",
          )}
          style={{ paddingLeft: `${8 + depth * 15}px` }}
          onClick={() => selectDepartment(department)}
          title={department.path_names || department.path}
        >
          {kids.length ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                toggleDepartment(department.id);
              }}
              aria-label={isOpen ? "收起下级部门" : "展开下级部门"}
              className="mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-muted"
            >
              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")} />
            </button>
          ) : (
            <span className="mr-0.5 w-5 shrink-0" />
          )}
          {top ? <Building2 className="mr-1.5 h-3.5 w-3.5 shrink-0 opacity-70" /> : null}
          <span className={cn("min-w-0 flex-1 truncate text-[13px]", top && "font-medium")}>
            {department.name}
          </span>
          {top && primaryLeader ? (
            <span
              className="mr-1 shrink-0 text-amber-600"
              title={`主负责人 ${primaryLeader.name || primaryLeader.username}`}
            >
              <Crown className="h-3 w-3" />
            </span>
          ) : null}
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {department.member_count}
          </span>
          <div
            className={cn(
              "ml-1 shrink-0 transition-opacity",
              active ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            )}
          >
            {actionMenu}
          </div>
        </div>
        {kids.length && isOpen ? (
          <div>{kids.map((child) => renderDepartmentNode(child, depth + 1))}</div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="page-shell">
      <PageHeader
        title="组织架构"
        description={
          directoryStats
            ? `${directoryStats.last_synced_at ? `最近同步 ${formatUserDateTime(directoryStats.last_synced_at)} · ` : "本地组织架构 · "}`
              + `${directoryStats.people_count} 人 · ${directoryStats.department_count} 个部门`
            : "正在加载组织架构…"
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => {
                void directoryQuery.refetch();
                qc.invalidateQueries({ queryKey: ["admin", "users"] });
              }}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", (directoryQuery.isFetching || isFetching) && "animate-spin")} />
              刷新
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              disabled={importFeishuMut.isPending}
              onClick={() => importFeishuMut.mutate()}
            >
              {importFeishuMut.isPending
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <CloudDownload className="h-3.5 w-3.5" />}
              {importFeishuMut.isPending ? "提交中…" : "同步飞书"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => setScheduleOpen(true)}
            >
              <Clock className="h-3.5 w-3.5" />定时同步
            </Button>
            <Button size="sm" className="h-9 gap-1.5" onClick={() => setCreateOpen(true)}>
              <UserPlus className="h-3.5 w-3.5" />新增用户
            </Button>
          </>
        }
      />

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="flex max-h-[420px] min-h-0 min-w-0 flex-col overflow-hidden lg:max-h-none">
          <div className="flex shrink-0 items-start justify-between gap-2 border-b px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                部门
              </div>
            </div>
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title={allExpanded ? "收起全部部门" : "展开全部部门"}
                aria-label={allExpanded ? "收起全部部门" : "展开全部部门"}
                onClick={() => setExpanded(allExpanded ? new Set() : new Set(allDepartmentIds))}
              >
                {allExpanded ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="新建顶级部门"
                aria-label="新建顶级部门"
                onClick={() => setDepartmentDialog({ open: true, department: null, parentId: rootDepartmentId })}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="shrink-0 px-3 pb-2.5 pt-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={departmentSearch}
                onChange={(event) => setDepartmentSearch(event.target.value)}
                placeholder="搜索部门"
                className="h-8 w-full rounded-md border bg-background pl-8 pr-3 text-xs outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <div className="space-y-0.5">
              <button
                type="button"
                onClick={() => selectDepartment(null)}
                className={cn(
                  "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left transition-colors",
                  selectedDepartment === ""
                    ? "bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <Users className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">全部人员</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {directoryStats?.people_count ?? stats.total_users}
                </span>
              </button>
              <button
                type="button"
                onClick={() =>
                  setUserFilterState((prev) => ({ ...prev, dept: "none", p: 1 }))
                }
                className={cn(
                  "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left transition-colors",
                  selectedDepartment === "none"
                    ? "bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
                title="未分配部门的用户"
              >
                <Building2 className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">公司直属</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {directoryStats?.unassigned_count ?? 0}
                </span>
              </button>
            </div>
            <div className="my-2 h-px bg-border" />
            {departmentFilter ? (
              <>
                <p className="px-2 pb-2 pt-1 text-[11px] text-muted-foreground">
                  {departmentSearchResults.length ? `找到 ${departmentSearchResults.length} 个部门` : "没有匹配的部门"}
                </p>
                {departmentSearchResults.map((department) => (
                  <button
                    key={department.id}
                    type="button"
                    onClick={() => selectDepartment(department)}
                    className={cn(
                      "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors",
                      selectedDepartment === String(department.id)
                        ? "bg-primary/10 text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                    title={department.path_names || department.path}
                  >
                    <Building2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{department.name}</span>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {department.member_count}
                    </span>
                  </button>
                ))}
              </>
            ) : (
              <>
                {(childrenByParent.get(rootDepartmentId) ?? []).map((department) => renderDepartmentNode(department, 0))}
                {departments.length <= 1 ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    还没有部门。点击右上角 + 新建，或使用“同步飞书”导入组织架构。
                  </div>
                ) : null}
              </>
            )}
          </div>
        </Card>

        <Card className="flex min-h-[480px] min-w-0 flex-col overflow-hidden">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-semibold">{selectedPath}</p>
                <Badge variant="secondary">{total} 人</Badge>
                {selectedDepartment && selectedDepartment !== "none" ? (
                  <button
                    type="button"
                    onClick={() => setIncludeChildren(!includeChildren)}
                    title="切换是否包含所有子部门成员"
                    className={cn(
                      "rounded border px-1.5 py-0.5 text-[10px] transition-colors",
                      includeChildren
                        ? "border-primary/30 bg-primary/5 text-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {includeChildren ? "含子部门" : "仅直属"}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  className="h-8 w-60 rounded-md border bg-background pl-8 pr-3 text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
                  title="支持姓名、邮箱、工号、职位的模糊搜索"
                  placeholder="模糊搜索姓名 / 用户名 / 工号"
                  value={queryInput}
                  onChange={(event) => setQueryInput(event.target.value)}
                />
              </div>
              {selectedDepartment && selectedDepartment !== "none" ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5"
                  onClick={() => setAddMembersOpen(true)}
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  添加成员
                </Button>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
            <FilterChip
              label="角色"
              options={[{ value: "all", label: "全部" }, ...USER_ROLE_OPTIONS]}
              value={roleFilter}
              baseValue="all"
              onChange={(value) => setRoleFilter(value as UserRole | "all")}
              compact
            />
            <FilterChip
              label="状态"
              options={[
                { value: "all", label: "全部" },
                { value: "active", label: "在职" },
                { value: "resigned", label: "离职" },
                { value: "frozen", label: "冻结" },
                { value: "unknown", label: "未知" },
              ]}
              value={employmentFilter}
              baseValue="all"
              onChange={(value) => setEmploymentFilter(value)}
              compact
            />
            <TagFilterChip
              label="标签"
              emptyText="暂无用户标签"
              tags={availableTags}
              selected={tagFilters}
              mode={tagFilterMode}
              onToggle={(tag) => defaultFilters.toggleTag(tag)}
              onClear={() => setTagFilters([])}
              onChangeMode={setTagFilterMode}
              compact
            />
            <FilterChip
              label="排序"
              options={[
                { value: "", label: "默认（姓名）" },
                { value: "asc", label: "最后登录 · 升序" },
                { value: "desc", label: "最后登录 · 降序" },
              ]}
              value={loginSort}
              baseValue=""
              onChange={(value) => setLoginSort(value as LoginSort)}
              compact
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs text-muted-foreground"
              onClick={() => defaultFilters.reset()}
            >
              恢复默认
            </Button>
            {hasActiveFilters ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs text-muted-foreground"
                onClick={() => defaultFilters.clear()}
              >
                <X className="mr-1 h-3.5 w-3.5" />
                清空筛选
              </Button>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              {selected.size > 0 ? (
                <span className="text-xs text-muted-foreground">
                  已选 <span className="font-medium text-primary">{selected.size}</span> 项
                </span>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                disabled={selected.size === 0}
                onClick={() => setBulkTagsOpen(true)}
              >
                <Tag className="h-3.5 w-3.5" />
                批量设置标签
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                disabled={selected.size === 0 || bulkDelMut.isPending}
                onClick={() => setBulkDeleteOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                批量删除
              </Button>
            </div>
          </div>

          {selectedDepartmentRow && selectedDepartmentRow.leaders.length > 0 ? (
            <div className="shrink-0 border-b bg-amber-50/30 px-4 py-2 dark:bg-amber-950/10">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-medium text-muted-foreground">负责人</span>
                {selectedDepartmentRow.leaders.map((leader) => (
                  <span
                    key={leader.user_id}
                    className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-xs"
                    title={leader.is_primary ? "主负责人" : "负责人"}
                  >
                    <Crown className={cn("h-3 w-3", leader.is_primary ? "text-amber-600" : "text-muted-foreground")} />
                    {leader.name || leader.username}
                    {leader.is_primary ? <span className="text-[10px] text-amber-700">主负责人</span> : null}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div
            className={cn("min-h-0 min-w-0 flex-1 overflow-auto transition-opacity", isFetching && "opacity-70")}
            aria-busy={isFetching}
          >
            {isLoading ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
              </div>
            ) : isError ? (
              <div className="m-4 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
                加载失败：{(error as Error)?.message || "未知错误"}
              </div>
            ) : users.length === 0 ? (
              <div className="flex h-full min-h-52 flex-col items-center justify-center gap-2 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Users className="h-5 w-5" />
                </div>
                <p className="text-sm text-muted-foreground">
                  {hasActiveFilters ? "没有匹配的人员" : String(selectedDepartment) === "none" ? "没有公司直属人员" : "该部门下没有人员"}
                </p>
              </div>
            ) : (
              <Table className="w-full min-w-[680px] table-fixed">
                <colgroup>
                  <col className="w-10" />
                  <col className="w-14" />
                  <col className="w-[14%]" />
                  <col className="w-[16%]" />
                  <col className="w-28" />
                  <col className="w-36" />
                  <col className="w-28" />
                </colgroup>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="w-12">
                      <div className="flex items-center gap-0.5">
                        <Checkbox
                          checked={allSelected ? true : someSelected ? "indeterminate" : false}
                          aria-label="选择当前页用户"
                          onCheckedChange={(checked) => setPageSelection(Boolean(checked), pageItemIds)}
                        />
                        <DropdownMenu
                          onOpenChange={(open) => {
                            if (open && filterSelectionIds === null && !selectionIdsMut.isPending) {
                              selectionIdsMut.mutate();
                            }
                          }}
                        >
                          <DropdownMenuTrigger asChild>
                            <button type="button" className="rounded p-0.5 hover:bg-accent" aria-label="选择更多用户">
                              <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="w-44">
                            <DropdownMenuItem
                              disabled={pageItemIds.length === 0}
                              onClick={() => setSelected(new Set(pageItemIds))}
                            >
                              <Check className="mr-2 h-3.5 w-3.5" />全选本页
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={selectionIdsMut.isPending || filterSelectionIds === null || filterSelectionIds.length === 0}
                              onClick={() => setSelected(new Set(filterSelectionIds ?? []))}
                            >
                              {selectionIdsMut.isPending
                                ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                : <Check className="mr-2 h-3.5 w-3.5" />}
                              {selectionIdsMut.isPending
                                ? "加载筛选结果…"
                                : "选择筛选结果" + (filterSelectionIds === null ? "" : " (" + filterSelectionIds.length + ")")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setSelected(new Set())}>
                              <X className="mr-2 h-3.5 w-3.5" />取消选择
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableHead>
                    <TableHead>头像</TableHead>
                    <TableHead>姓名</TableHead>
                    <TableHead>用户名</TableHead>
                    <TableHead>角色</TableHead>
                    <TableNumberHead>最后登录时间</TableNumberHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((u) => {
                    const canManageTarget = canManageUser(u);
                    const canDeleteTarget = canDeleteUser(u);
                    const selectedLeaders = selectedDepartment && selectedDepartment !== "none"
                      ? (selectedDepartmentRow?.leaders || [])
                      : [];
                    const leaderHere = selectedLeaders.find((leader) => leader.user_id === u.id);
                    const anyLeader = (u.leader_of || []).length > 0;
                    const isLeader = leaderHere != null || (selectedDepartment === "" && anyLeader);
                    const primary = leaderHere?.is_primary
                      || (selectedDepartment === "" && (u.leader_of || []).some((leader) => leader.is_primary));
                    return (
                      <TableRow
                        key={u.id}
                        className="h-12 cursor-pointer [&>td]:h-12 [&>td]:py-0"
                        onClick={() => setProfileUser(u)}
                      >
                        <TableCell onClick={(event) => event.stopPropagation()}>
                          <Checkbox
                            checked={selected.has(u.id)}
                            aria-label={`选择用户 ${u.username}`}
                            onCheckedChange={() => toggleOne(u.id)}
                            disabled={!canDeleteTarget}
                          />
                        </TableCell>
                        <TableCell>
                          <UserAvatar name={u.name} username={u.username} url={u.avatar_url} size="sm" />
                        </TableCell>
                        <TableCell>
                          <div className="flex min-w-0 items-center gap-1.5">
                            <TableText className="text-sm font-medium" text={u.name || "-"} />
                            {isLeader ? (
                              <Crown
                                className="h-3 w-3 shrink-0 text-amber-600"
                                aria-label={primary ? "主负责人" : "负责人"}
                              />
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <TableText className="text-sm text-muted-foreground" text={u.username} />
                        </TableCell>
                        <TableCell>
                          <Badge
                            className="whitespace-nowrap"
                            variant={u.role === "user" ? "secondary" : "default"}
                          >
                            {USER_ROLE_LABEL[u.role] || u.role}
                          </Badge>
                        </TableCell>
                        <TableNumberCell>
                          <TableText
                            className="text-right text-sm text-muted-foreground"
                            text={formatUserDateTime(u.last_login_at, "从未登录")}
                          />
                        </TableNumberCell>
                        <TableCell onClick={(event) => event.stopPropagation()}>
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label={"编辑用户 " + u.username}
                              disabled={!canManageTarget}
                              title={!canManageTarget ? "系统管理员账号仅可由系统管理员管理" : "编辑用户"}
                              onClick={() => setEditing(u)}
                            >
                              <Pencil className="mr-1 h-3.5 w-3.5" />编辑
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  aria-label={"更多用户操作 " + u.username}
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-44">
                                <DropdownMenuItem
                                  disabled={resettingPassword || currentUser?.id === u.id || !canManageTarget}
                                  onClick={() => requestPasswordReset(u)}
                                >
                                  <KeyRound className="mr-2 h-3.5 w-3.5" />重置密码
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={!canDeleteTarget || delMut.isPending}
                                  onClick={() => setTransferUser(u)}
                                >
                                  <ArrowRightLeft className="mr-2 h-3.5 w-3.5" />转移并删除
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  disabled={!canDeleteTarget || delMut.isPending}
                                  onClick={() => setDeleteTarget(u)}
                                >
                                  <Trash2 className="mr-2 h-3.5 w-3.5" />删除用户
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>

          <ListFooter
            page={page}
            pageSize={pageSize}
            total={!isLoading && !isError && total > 0 ? total : 0}
            onPageChange={setPage}
            loading={isFetching}
            unit="人"
            className="px-4 pb-3"
          />
        </Card>
      </div>

      <DirectorySyncScheduleDialog open={scheduleOpen} onOpenChange={setScheduleOpen} />
      <DepartmentDialog
        open={departmentDialog.open}
        onOpenChange={(open) => setDepartmentDialog((prev) => ({ ...prev, open }))}
        department={departmentDialog.department}
        parentId={departmentDialog.parentId}
        rootId={rootDepartmentId}
        departments={departments}
        onSaved={handleDepartmentSaved}
      />
      <AddMembersDialog
        open={addMembersOpen}
        onOpenChange={setAddMembersOpen}
        department={selectedDepartmentRow ?? null}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["admin", "users"] });
          qc.invalidateQueries({ queryKey: ["admin", "directory"] });
        }}
      />
      <UserProfileModal
        user={profileUser}
        onOpenChange={(open) => { if (!open) setProfileUser(null); }}
        onEdit={(target) => { setProfileUser(null); setEditing(target); }}
        onResetPassword={(target) => { setProfileUser(null); void requestPasswordReset(target); }}
        onTransferDelete={(target) => { setProfileUser(null); setTransferUser(target); }}
        onDelete={(target) => { setProfileUser(null); setDeleteTarget(target); }}
        canManage={profileUser ? canManageUser(profileUser) : false}
        canDelete={profileUser ? canDeleteUser(profileUser) : false}
      />
      <ConfirmDialog
        open={deleteDepartment != null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteDepartment(null);
            setDeleteDepartmentUsage(null);
          }
        }}
        title="删除部门"
        description={
          deleteDepartment
            ? `确定删除「${deleteDepartment.name}」吗？`
              + (deleteDepartmentUsage
                ? ` 当前成员 ${deleteDepartmentUsage.members} 人、授权 ${deleteDepartmentUsage.grants} 项。`
                : "")
              + " 删除后部门标签和相关授权会立即失效。"
            : ""
        }
        confirmLabel={deleteDepartmentUsage && (deleteDepartmentUsage.members > 0 || deleteDepartmentUsage.grants > 0)
          ? "强制删除"
          : "删除"}
        destructive
        loading={deleteDepartmentMut.isPending}
        onConfirm={() => {
          if (deleteDepartment) deleteDepartmentMut.mutate(deleteDepartment);
        }}
      />

      <UserFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        user={null}
        canManageSystemAdmin={currentUser?.role === "system_admin"}
        departments={departments}
        onSuccess={handleUserSaved}
      />
      <BulkUserTagsDialog
        open={bulkTagsOpen}
        onOpenChange={setBulkTagsOpen}
        userIds={Array.from(selected)}
      />
      <Dialog open={!!resetPassword} onOpenChange={(open) => { if (!open) { setResetPassword(""); setResetUser(null); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>临时密码已重置</DialogTitle>
            <DialogDescription>
              {resetUser?.username} 的旧会话已失效。此密码 24 小时内有效且只展示一次。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all rounded-md border bg-muted/30 px-3 py-2.5 font-mono text-sm font-semibold">
              {resetPassword}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyText(resetPassword)}
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              复制
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => { setResetPassword(""); setResetUser(null); }}>完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={resetConfirmUser !== null}
        onOpenChange={(open) => { if (!open && !resettingPassword) setResetConfirmUser(null); }}
        title="重置用户密码"
        description={resetConfirmUser ? `确定为 ${resetConfirmUser.username} 生成新的临时密码吗？该用户现有登录会话会立即失效。` : ""}
        confirmLabel="生成临时密码"
        destructive
        loading={resettingPassword}
        onConfirm={() => void confirmPasswordReset()}
      />
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title="批量删除用户"
        description={`确定删除选中的 ${selected.size} 个用户吗？删除后无法恢复，相关权限和会话也会失效。`}
        confirmLabel="删除用户"
        destructive
        loading={bulkDelMut.isPending}
        onConfirm={() => {
          bulkDelMut.mutate(Array.from(selected), { onSuccess: () => setBulkDeleteOpen(false) });
        }}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="删除用户"
        description={deleteTarget ? `确定删除用户「${deleteTarget.username}」吗？删除后无法恢复。` : ""}
        confirmLabel="删除用户"
        destructive
        loading={delMut.isPending}
        onConfirm={() => {
          const target = deleteTarget;
          if (target) delMut.mutate(target.id, { onSuccess: () => setDeleteTarget(null) });
        }}
      />
      <UserFormDialog
        open={editing != null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        user={editing}
        canManageSystemAdmin={currentUser?.role === "system_admin"}
        departments={departments}
        onSuccess={handleUserSaved}
      />
      <TransferDeleteDialog
        open={transferUser != null}
        onOpenChange={(o) => {
          if (!o) setTransferUser(null);
        }}
        sourceUser={transferUser}
        onSuccess={() => {
          qc.invalidateQueries({ queryKey: ["admin", "users"] });
          qc.invalidateQueries({ queryKey: ["admin", "directory"] });
          qc.invalidateQueries({ queryKey: ["users", "options"] });
        }}
      />
    </div>
  );
}

function BulkUserTagsDialog({
  open,
  onOpenChange,
  userIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userIds: number[];
}) {
  const qc = useQueryClient();
  const [mode, setMode] = React.useState<"add" | "remove" | "replace">("add");
  const [tags, setTags] = React.useState<string[]>([]);
  const [clearConfirmOpen, setClearConfirmOpen] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setMode("add");
      setTags([]);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => api<{ matched: number; updated: number }>("/api/admin/users/bulk-tags", {
      method: "POST",
      json: { user_ids: userIds, tags: serializeTags(tags), mode },
    }),
    onSuccess: (result) => {
      toast.success(result.updated > 0
        ? "已更新 " + result.updated + " 个用户的标签"
        : "所选用户的标签无需变更");
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["users", "options"] });
      qc.invalidateQueries({ queryKey: ["admin", "user-tags"] });
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || "批量设置标签失败"),
  });

  const submit = () => {
    if (userIds.length === 0) return;
    if (mode !== "replace" && tags.length === 0) {
      toast.error("请至少选择一个用户标签");
      return;
    }
    if (
      mode === "replace"
      && tags.length === 0
    ) {
      setClearConfirmOpen(true);
      return;
    }
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>批量设置用户标签</DialogTitle>
          <DialogDescription>
            将对已选的 {userIds.length} 个用户生效。标签定义在“标签管理 → 用户标签”维护，这里负责批量分配。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="grid gap-1.5">
            <Label htmlFor="bulk-user-tag-mode">设置方式</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as "add" | "remove" | "replace")}>
              <SelectTrigger id="bulk-user-tag-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="add">追加标签（保留已有标签）</SelectItem>
                <SelectItem value="remove">移除标签</SelectItem>
                <SelectItem value="replace">替换全部标签</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>用户标签</Label>
            <TagInput
              domain="user"
              value={tags}
              onChange={setTags}
              placeholder={mode === "remove" ? "选择要移除的标签" : "搜索或选择用户标签"}
              disabled={mutation.isPending}
            />
            <p className="text-xs leading-5 text-muted-foreground">
              {mode === "add" && "仅追加所选标签，不会删除用户现有标签。"}
              {mode === "remove" && "仅移除所选标签，其他标签保持不变。"}
              {mode === "replace" && "用户现有标签将被所选标签完全替换；不选标签则清空。"}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>取消</Button>
          <Button onClick={submit} disabled={mutation.isPending || userIds.length === 0}>
            {mutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            应用到 {userIds.length} 个用户
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={clearConfirmOpen}
        onOpenChange={setClearConfirmOpen}
        title="清空用户标签"
        description={`确定清空所选 ${userIds.length} 个用户的全部标签吗？此操作会立即影响按标签控制的访问权限。`}
        confirmLabel="清空标签"
        destructive
        loading={mutation.isPending}
        onConfirm={() => {
          mutation.mutate(undefined, { onSuccess: () => setClearConfirmOpen(false) });
        }}
      />
    </Dialog>
  );
}

function TransferDeleteDialog({
  open,
  onOpenChange,
  sourceUser,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sourceUser: AdminUser | null;
  onSuccess: () => void;
}) {
  const [targetId, setTargetId] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setTargetId(null);
      setLoading(false);
    }
  }, [open]);

  const submit = async () => {
    if (!targetId) {
      toast.error("请选择接收数据的用户");
      return;
    }
    setLoading(true);
    try {
      await api(`/api/admin/users/${sourceUser!.id}/transfer-and-delete`, {
        method: "POST",
        json: { target_user_id: targetId },
      });
      toast.success(`已将 ${sourceUser!.username} 的数据转移并删除用户`);
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || "操作失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
              <ArrowRightLeft className="h-4 w-4" />
            </span>
            转移数据并删除用户
          </DialogTitle>
          <DialogDescription>
            将该用户的关联数据转移给另一位用户后删除账号。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-amber-300/60 bg-amber-50 p-4 dark:border-amber-800/50 dark:bg-amber-950/30">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-200/70 text-amber-700 dark:bg-amber-800/50 dark:text-amber-300">
              <X className="h-3 w-3" />
            </span>
            <p className="text-sm leading-relaxed text-amber-800 dark:text-amber-300">
              用户 <strong>{sourceUser?.name || sourceUser?.username}</strong> 的所有关联数据（资源、放映、模板、任务等）将转移给接收者，然后删除该账号。下载记录将保留但不再关联。
            </p>
          </div>
          <div className="rounded-lg border bg-muted/20 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <User className="h-4 w-4 text-muted-foreground" />
              接收数据的用户
            </div>
            <UserSearchSelect
              value={targetId}
              onChange={setTargetId}
              excludeIds={sourceUser ? [sourceUser.id] : []}
              placeholder="搜索并选择接收用户"
              disabled={loading}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            取消
          </Button>
          <Button variant="destructive" onClick={submit} disabled={loading || !targetId}>
            {loading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            确认转移并删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserFormDialog({
  open,
  onOpenChange,
  user,
  canManageSystemAdmin,
  departments,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  user: AdminUser | null;
  canManageSystemAdmin: boolean;
  departments: Department[];
  onSuccess: (user: AdminUser) => void;
}) {
  const editing = !!user;
  const roleOptions = USER_ROLE_OPTIONS.filter((option) => canManageSystemAdmin || option.value !== "system_admin");
  const [name, setName] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [feishu, setFeishu] = React.useState("");
  const [avatarUrl, setAvatarUrl] = React.useState("");
  const [avatarFile, setAvatarFile] = React.useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = React.useState("");
  const [removeAvatar, setRemoveAvatar] = React.useState(false);
  const [tags, setTags] = React.useState<string[]>([]);
  const [role, setRole] = React.useState<UserRole>("user");
  const [email, setEmail] = React.useState("");
  const [jobTitle, setJobTitle] = React.useState("");
  const [employeeNo, setEmployeeNo] = React.useState("");
  const [employmentStatus, setEmploymentStatus] = React.useState<EmploymentStatus>("active");
  const [departmentIds, setDepartmentIds] = React.useState<number[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [generatedPwd, setGeneratedPwd] = React.useState("");
  const feishuManaged = Boolean(user?.feishu_id);

  React.useEffect(() => {
    if (open) {
      setName(user?.name || "");
      setUsername(user?.username || "");
      setPassword("");
      setFeishu(user?.feishu_id || "");
      setAvatarUrl(user?.avatar_url || "");
      setAvatarFile(null);
      setAvatarPreview("");
      setRemoveAvatar(false);
      setTags(parseTags(user?.tags));
      setRole((user?.role as UserRole) || "user");
      setEmail(user?.email || "");
      setJobTitle(user?.job_title || "");
      setEmployeeNo(user?.employee_no || "");
      setEmploymentStatus((user?.employment_status as EmploymentStatus) || "active");
      setDepartmentIds((user?.departments || []).map((department) => department.id));
      setLoading(false);
      setGeneratedPwd("");
    }
  }, [open, user]);

  React.useEffect(() => {
    if (!avatarFile) {
      setAvatarPreview("");
      return;
    }
    const objectUrl = URL.createObjectURL(avatarFile);
    setAvatarPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [avatarFile]);

  const chooseAvatar = (file: File | null) => {
    if (!file) return;
    const suffix = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || "";
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type)
      && ![".png", ".jpg", ".jpeg", ".webp"].includes(suffix)
    ) {
      toast.error("头像仅支持 PNG、JPG 或 WebP 图片");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("头像文件不能超过 2 MB");
      return;
    }
    setAvatarFile(file);
    setRemoveAvatar(false);
  };

  const submit = async () => {
    if (!name.trim() || !username.trim()) {
      toast.error("姓名和用户名必填");
      return;
    }
    setLoading(true);
    try {
      const res = await api<{ user: AdminUser; plain_password?: string }>(
        editing ? `/api/admin/users/${user!.id}` : "/api/admin/users",
        {
          method: editing ? "PUT" : "POST",
          json: {
            name: name.trim(),
            username: username.trim(),
            password: editing ? null : password || null,
            feishu_id: feishu.trim(),
            avatar_url: editing ? avatarUrl.trim() : "",
            tags: serializeTags(tags),
            role,
            need_change_pwd: true,
            email: email.trim(),
            job_title: jobTitle.trim(),
            employee_no: employeeNo.trim(),
            employment_status: employmentStatus,
            department_ids: departmentIds,
          },
        },
      );

      let savedUser = res.user;
      let avatarError: Error | null = null;
      try {
        if (avatarFile) {
          const body = new FormData();
          body.set("avatar", avatarFile);
          const avatarResult = await api<{ user: AdminUser }>(
            `/api/admin/users/${res.user.id}/avatar`,
            { method: "POST", body },
          );
          savedUser = avatarResult.user;
        } else if (editing && removeAvatar && avatarUrl) {
          const avatarResult = await api<{ user: AdminUser }>(
            `/api/admin/users/${res.user.id}/avatar`,
            { method: "DELETE" },
          );
          savedUser = avatarResult.user;
        }
      } catch (error) {
        avatarError = error as Error;
      }

      setAvatarUrl(savedUser.avatar_url || "");
      setAvatarFile(null);
      setRemoveAvatar(false);

      if (!editing && res.plain_password) {
        // 未手工指定密码时，后端生成只展示一次的临时密码。
        setGeneratedPwd(res.plain_password);
      } else {
        toast.success(editing ? "用户资料已保存" : "用户已创建");
      }
      if (avatarError) {
        toast.error(`用户资料已保存，但头像处理失败：${avatarError.message || "未知错误"}`);
      }
      onSuccess(savedUser);
      if (!res.plain_password) {
        onOpenChange(false);
      }
    } catch (err) {
      toast.error((err as Error).message || "保存失败");
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => { void copyText(text); };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setGeneratedPwd("");
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[92vh] max-w-2xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <div className="flex items-center gap-3">
            <UserAvatar name={name} username={username} url={avatarPreview || (removeAvatar ? "" : avatarUrl)} size="lg" />
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2">
                {editing ? "编辑用户" : "新增用户"}
              </DialogTitle>
              <DialogDescription className="mt-1">
                {editing ? `${user?.name || user?.username} · 修改账号资料与标签` : "创建账号并设置角色与用户标签"}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {generatedPwd ? (
          /* 随机密码展示视图 */
          <div className="space-y-4 px-6 py-5">
            <div className="rounded-lg border border-emerald-300/60 bg-emerald-50 p-5 dark:border-emerald-800/50 dark:bg-emerald-950/30">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-emerald-800 dark:text-emerald-300">
                <KeyRound className="h-4 w-4" />
                临时密码已生成
              </div>
              <p className="mb-3 text-xs leading-relaxed text-emerald-700 dark:text-emerald-400">
                请妥善保存以下密码并告知用户，用户首次登录时将被强制要求修改。
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md border border-emerald-200 bg-white px-3 py-2.5 text-sm font-mono font-semibold tracking-wide select-all dark:border-emerald-800 dark:bg-gray-900">
                  {generatedPwd}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => copyToClipboard(generatedPwd)}
                >
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  复制
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  setGeneratedPwd("");
                  onOpenChange(false);
                }}
              >
                完成
              </Button>
            </DialogFooter>
          </div>
        ) : (
          /* 表单视图 */
          <>
            <div className="max-h-[calc(92vh-145px)] overflow-y-auto px-6 py-5">
              <div className="grid gap-6">
                <section className="space-y-3">
                  <div className="flex items-center gap-2 border-b pb-2 text-sm font-semibold">
                    <User className="h-4 w-4 text-muted-foreground" />
                    账号信息
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="user-name">姓名 <span className="text-destructive">*</span></Label>
                      <Input id="user-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：张三" />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="user-username">用户名 <span className="text-destructive">*</span></Label>
                      <Input id="user-username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="用于登录" />
                    </div>
                  </div>
                </section>

                {!editing && <section className="space-y-3">
                  <div className="flex items-center gap-2 border-b pb-2 text-sm font-semibold">
                    <KeyRound className="h-4 w-4 text-muted-foreground" />
                    初始密码
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="user-password">临时密码 <span className="text-xs font-normal text-muted-foreground">（留空自动生成）</span></Label>
                    <Input id="user-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="可手工指定临时密码" />
                    <p className="text-xs leading-5 text-muted-foreground">临时密码 24 小时内有效，首次登录必须修改。</p>
                  </div>
                </section>}

                <section className="space-y-3">
                  <div className="flex items-center gap-2 border-b pb-2 text-sm font-semibold">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    角色与联系方式
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="user-role">角色</Label>
                      <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
                        <SelectTrigger id="user-role"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {roleOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="user-feishu">飞书 ID <span className="text-xs font-normal text-muted-foreground">（可选）</span></Label>
                      <Input id="user-feishu" value={feishu} onChange={(e) => setFeishu(e.target.value)} placeholder="关联飞书账号" />
                    </div>
                  </div>
                </section>

                <section className="space-y-3">
                  <div className="flex items-center gap-2 border-b pb-2 text-sm font-semibold">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    组织与资料
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="user-email">邮箱</Label>
                      <Input
                        id="user-email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="name@example.com"
                        disabled={feishuManaged}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="user-job-title">职位</Label>
                      <Input
                        id="user-job-title"
                        value={jobTitle}
                        onChange={(e) => setJobTitle(e.target.value)}
                        placeholder="例如：测试工程师"
                        disabled={feishuManaged}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="user-employee-no">工号</Label>
                      <Input
                        id="user-employee-no"
                        value={employeeNo}
                        onChange={(e) => setEmployeeNo(e.target.value)}
                        placeholder="可选"
                        disabled={feishuManaged}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label>在职状态</Label>
                      <Select
                        value={employmentStatus}
                        onValueChange={(value) => setEmploymentStatus(value as EmploymentStatus)}
                        disabled={feishuManaged}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">在职</SelectItem>
                          <SelectItem value="resigned">离职</SelectItem>
                          <SelectItem value="frozen">冻结</SelectItem>
                          <SelectItem value="unknown">未知</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="grid gap-1.5">
                    <Label>所属部门</Label>
                    <DepartmentPicker
                      departments={departments}
                      value={departmentIds}
                      onChange={setDepartmentIds}
                    />
                    <p className="text-xs leading-5 text-muted-foreground">
                      可同时属于多个部门；部门权限会自动包含所有上级部门。
                    </p>
                  </div>
                  {feishuManaged ? (
                    <p className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-300">
                      该用户由飞书同步维护，邮箱、职位、工号和在职状态以飞书为准；部门归属可手工补充，飞书同步的成员关系会在下次同步时恢复。
                    </p>
                  ) : null}
                </section>

                <section className="space-y-3">
                  <div className="flex items-center gap-2 border-b pb-2 text-sm font-semibold">
                    <Tag className="h-4 w-4 text-muted-foreground" />
                    用户标签
                  </div>
                  <TagInput domain="user" value={tags} onChange={setTags} placeholder="搜索或选择用户标签" />
                  <p className="text-xs leading-5 text-muted-foreground">用户标签用于人员分类和用户列表筛选；请在“标签管理 → 用户标签”中维护。</p>
                </section>

                <section className="space-y-3">
                  <div className="flex items-center gap-2 border-b pb-2 text-sm font-semibold">
                    <Camera className="h-4 w-4 text-muted-foreground" />
                    头像
                  </div>
                  <div className="flex flex-col gap-4 rounded-lg border bg-muted/20 p-4 sm:flex-row sm:items-center">
                    <UserAvatar name={name} username={username} url={avatarPreview || (removeAvatar ? "" : avatarUrl)} size="lg" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="text-sm font-medium">上传头像图片</div>
                      <p className="text-xs leading-5 text-muted-foreground">
                        支持 PNG、JPG、WebP，文件不超过 2 MB；系统会自动缩放并转换为 PNG。
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="outline" size="sm" asChild disabled={loading}>
                          <label htmlFor={`user-avatar-${user?.id || "new"}`} className="cursor-pointer">
                            <Upload className="mr-1.5 h-3.5 w-3.5" />
                            {avatarFile ? "重新选择" : "选择图片"}
                          </label>
                        </Button>
                        {(avatarFile || (!removeAvatar && avatarUrl)) && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={loading}
                            onClick={() => {
                              setAvatarFile(null);
                              setRemoveAvatar(Boolean(avatarUrl));
                            }}
                          >
                            移除头像
                          </Button>
                        )}
                      </div>
                      <input
                        id={`user-avatar-${user?.id || "new"}`}
                        type="file"
                        className="sr-only"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(event) => {
                          chooseAvatar(event.target.files?.[0] ?? null);
                          event.currentTarget.value = "";
                        }}
                      />
                    </div>
                  </div>
                  {avatarFile && <p className="text-xs text-muted-foreground">已选择：{avatarFile.name}</p>}
                  {removeAvatar && <p className="text-xs text-amber-600">保存后将移除当前头像。</p>}
                </section>
              </div>
            </div>
            <DialogFooter className="border-t bg-muted/15 px-6 py-4">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                取消
              </Button>
              <Button onClick={submit} disabled={loading}>
                {loading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {editing ? "保存修改" : "创建用户"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UserAvatar({
  name,
  username,
  url,
  size = "sm",
}: {
  name?: string | null;
  username: string;
  url?: string | null;
  size?: "sm" | "lg";
}) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [url]);
  const label = (name || username || "用户").trim();
  const dimensions = size === "lg" ? "h-16 w-16 text-xl" : "h-7 w-7 text-xs";

  if (url && !failed) {
    return (
      <img
        src={url}
        alt={`${label}头像`}
        className={cn("shrink-0 rounded-full object-cover ring-1 ring-border", dimensions)}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary ring-1 ring-primary/10", dimensions)}>
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}
