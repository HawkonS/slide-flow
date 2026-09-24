import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Camera, Copy, KeyRound, Loader2, Pencil, Search, Shield, Tag, Trash2, Upload, User, UserPlus, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { AdminUser, AdminUsersResponse, UserRole } from "@/lib/types";
import { useUrlPage } from "@/lib/use-url-page";
import { cn } from "@/lib/utils";
import { TagInput } from "@/components/resource/TagInput";
import { parseTags, serializeTags } from "@/lib/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useAuth } from "@/lib/auth";
import { UserSearchSelect } from "@/components/resource/UserSearchSelect";

export function AdminUsersPage() {
  const qc = useQueryClient();
  const { user: currentUser, setUser } = useAuth();
  const [tagFilter, setTagFilter] = React.useState("all");

  const [editing, setEditing] = React.useState<AdminUser | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [transferUser, setTransferUser] = React.useState<AdminUser | null>(null);
  const [resetUser, setResetUser] = React.useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = React.useState("");
  const [resettingPassword, setResettingPassword] = React.useState(false);
  const [queryInput, setQueryInput] = React.useState("");
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  const delMut = useMutation({
    mutationFn: async (id: number) => api(`/api/admin/users/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("用户已删除");
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["users", "options"] });
    },
    onError: (err: Error) => toast.error(err.message || "删除失败"),
  });

  const [selected, setSelected] = React.useState<Set<number>>(new Set());

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
    if (!window.confirm(`为 ${user.username} 生成新的临时密码？该用户现有登录会话会立即失效。`)) return;
    setResettingPassword(true);
    try {
      const result = await api<{ user: AdminUser; plain_password: string }>(
        `/api/admin/users/${user.id}/reset-password`,
        { method: "POST" },
      );
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
      qc.invalidateQueries({ queryKey: ["users", "options"] });
    },
    onError: (err: Error) => toast.error(err.message || "批量删除失败"),
  });

  // 动态分页
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = React.useState(0);
  React.useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const compute = () => {
      const H = el.clientHeight;
      if (!H) return;
      const headerH = 45;
      const rowH = 49;
      const rows = Math.min(100, Math.max(5, Math.floor((H - headerH) / rowH)));
      setPageSize((prev) => (prev === rows ? prev : rows));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [page, setPage] = useUrlPage();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["admin", "users", page, pageSize, query, tagFilter],
    queryFn: () => api<AdminUsersResponse>("/api/admin/users", {
      params: {
        page,
        page_size: pageSize,
        search: query || undefined,
        tag: tagFilter !== "all" ? tagFilter : undefined,
      },
    }),
    enabled: pageSize > 0,
  });
  const users = data?.users ?? [];
  const availableTags = data?.available_tags ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const handleUserSaved = React.useCallback((savedUser: AdminUser) => {
    qc.invalidateQueries({ queryKey: ["admin", "users"] });
    qc.invalidateQueries({ queryKey: ["users", "options"] });
    if (currentUser?.id === savedUser.id) {
      setUser({ ...currentUser, ...savedUser });
    }
  }, [currentUser, qc, setUser]);
  React.useEffect(() => {
    if (pageSize > 0 && data && page > totalPages) setPage(totalPages);
  }, [data, page, pageSize, totalPages, setPage]);
  React.useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [query, tagFilter, setPage]);
  React.useEffect(() => {
    const visible = new Set(users.filter(canDeleteUser).map((user) => user.id));
    setSelected((previous) => {
      const next = new Set(Array.from(previous).filter((id) => visible.has(id)));
      if (next.size === previous.size && Array.from(next).every((id) => previous.has(id))) return previous;
      return next;
    });
  }, [users, canDeleteUser]);
  const pageStart = (page - 1) * pageSize;
  const pageItemIds = React.useMemo(
    () => users.filter(canDeleteUser).map((u) => u.id),
    [users, canDeleteUser],
  );
  const allSelected = pageItemIds.length > 0 && pageItemIds.every((id) => selected.has(id));
  const someSelected = pageItemIds.some((id) => selected.has(id)) && !allSelected;

  return (
    <div className="page-shell">
      <PageHeader
        title="用户管理"
        count={tagFilter !== "all" ? `标签「${tagFilter}」 · ${total} 条` : query ? `搜索到 ${total} 条` : `共 ${total} 条`}
      />

      {/* 筛选行 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="搜索姓名、用户名、标签、飞书 ID"
            className={cn(
              "h-8 w-full rounded-md border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition sm:w-56",
              "placeholder:text-muted-foreground",
              "focus:border-foreground/40 focus:ring-2 focus:ring-ring/20",
              queryInput.trim() !== "" && "border-foreground/25 bg-primary-weak",
            )}
          />
        </div>
        <Select value={tagFilter} onValueChange={setTagFilter}>
          <SelectTrigger className="h-8 w-full text-xs sm:w-44">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Tag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <SelectValue placeholder="按标签筛选" />
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部标签</SelectItem>
            {availableTags.map((tag) => (
              <SelectItem key={tag} value={tag}>
                {tag}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {tagFilter !== "all" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs text-muted-foreground"
            onClick={() => setTagFilter("all")}
          >
            <X className="mr-1 h-3.5 w-3.5" />
            清除筛选
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <span className="text-xs text-muted-foreground">
              已选 <span className="font-medium text-primary">{selected.size}</span> 项
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            disabled={selected.size === 0 || bulkDelMut.isPending}
            onClick={() => {
              if (!window.confirm(`确认删除选中的 ${selected.size} 个用户？`)) return;
              bulkDelMut.mutate(Array.from(selected));
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            批量删除
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1.5 px-3 text-sm"
            onClick={() => setCreateOpen(true)}
          >
            <UserPlus className="h-3.5 w-3.5" />
            新增用户
          </Button>
        </div>
      </div>

      {/* 内容区 */}
      <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
        {pageSize === 0 || isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
          </div>
        ) : isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            加载失败：{(error as Error)?.message || "未知错误"}
          </div>
        ) : users.length === 0 ? (
          <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">
            暂无用户
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <div className="flex items-center gap-0.5">
                      <Checkbox
                        checked={allSelected ? true : someSelected ? "indeterminate" : false}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelected(new Set(pageItemIds));
                          } else {
                            setSelected(new Set());
                          }
                        }}
                      />
                    </div>
                  </TableHead>
                  <TableHead>姓名</TableHead>
                  <TableHead>用户名</TableHead>
                  <TableHead className="w-32">角色</TableHead>
                  <TableHead>用户标签</TableHead>
                  <TableHead>飞书 ID</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="w-32 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => {
                  const canManageTarget = canManageUser(u);
                  const canDeleteTarget = canDeleteUser(u);
                  return (
                  <TableRow key={u.id}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(u.id)}
                        onCheckedChange={() => toggleOne(u.id)}
                        disabled={!canDeleteTarget}
                      />
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-2">
                        <UserAvatar name={u.name} username={u.username} url={u.avatar_url} size="sm" />
                        <span>{u.name || "-"}</span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        {u.username}
                        {u.must_change_pwd && (
                          <Badge variant="outline" className="border-amber-400 text-amber-600 text-[10px] px-1 py-0">
                            需改密
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className="whitespace-nowrap"
                        variant={
                          u.role === "system_admin"
                            ? "default"
                            : u.role === "admin"
                              ? "default"
                              : "secondary"
                        }
                      >
                        {USER_ROLE_LABEL[u.role] || u.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-52 text-sm text-muted-foreground">
                      <div className="flex flex-wrap gap-1">
                        {parseTags(u.tags).map((tag) => <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>)}
                        {!u.tags && <span>-</span>}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{u.feishu_id || "-"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{u.created_at}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" disabled={!canManageTarget} title={!canManageTarget ? "系统管理员账号仅可由系统管理员管理" : "编辑用户"} onClick={() => setEditing(u)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="生成新的临时密码"
                          disabled={resettingPassword || currentUser?.id === u.id || !canManageTarget}
                          onClick={() => requestPasswordReset(u)}
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-primary"
                          title="转移数据并删除"
                          disabled={!canDeleteTarget || delMut.isPending}
                          onClick={() => setTransferUser(u)}
                        >
                          <ArrowRightLeft className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          title="删除用户"
                          disabled={!canDeleteTarget || delMut.isPending}
                          onClick={() => {
                            if (window.confirm(`确认删除用户 ${u.username}？`)) {
                              delMut.mutate(u.id);
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* 分页条 */}
      {pageSize > 0 && !isLoading && !isError && total > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t pt-3 text-sm text-muted-foreground select-none">
          <span>
            显示 {pageStart + 1}-{Math.min(pageStart + users.length, total)}，共 {total} 条
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <span className="min-w-[52px] text-center text-foreground select-none">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一页
            </Button>
          </div>
        </div>
      )}

      <UserFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        user={null}
        canManageSystemAdmin={currentUser?.role === "system_admin"}
        onSuccess={handleUserSaved}
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
              onClick={() => navigator.clipboard.writeText(resetPassword).then(() => toast.success("已复制到剪贴板"))}
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
      <UserFormDialog
        open={editing != null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        user={editing}
        canManageSystemAdmin={currentUser?.role === "system_admin"}
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
          qc.invalidateQueries({ queryKey: ["users", "options"] });
        }}
      />
    </div>
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
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  user: AdminUser | null;
  canManageSystemAdmin: boolean;
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
  const [loading, setLoading] = React.useState(false);
  const [generatedPwd, setGeneratedPwd] = React.useState("");

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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success("已复制到剪贴板"),
      () => toast.error("复制失败，请手动复制"),
    );
  };

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
