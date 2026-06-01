import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Check, ChevronDown, Copy, KeyRound, Loader2, Pencil, Search, Shield, Trash2, User, UserPlus, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { AdminUser, UserRole } from "@/lib/types";
import { useUrlPage } from "@/lib/use-url-page";
import { cn } from "@/lib/utils";

interface UsersResponse {
  users: AdminUser[];
}

export function AdminUsersPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => api<UsersResponse>("/api/admin/users"),
  });

  const [editing, setEditing] = React.useState<AdminUser | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [transferUser, setTransferUser] = React.useState<AdminUser | null>(null);
  const [query, setQuery] = React.useState("");

  const delMut = useMutation({
    mutationFn: async (id: number) => api(`/api/admin/users/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("用户已删除");
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onError: (err: Error) => toast.error(err.message || "删除失败"),
  });

  const [selected, setSelected] = React.useState<Set<number>>(new Set());

  const users = data?.users ?? [];
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      `${u.name || ""} ${u.username} ${u.feishu_id || ""}`.toLowerCase().includes(q),
    );
  }, [users, query]);

  const filteredIds = React.useMemo(() => filtered.map((u) => u.id), [filtered]);

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
    },
    onError: (err: Error) => toast.error(err.message || "批量删除失败"),
  });

  // 动态分页
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = React.useState(10);
  React.useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const compute = () => {
      const H = el.clientHeight;
      if (!H) return;
      const headerH = 45;
      const rowH = 49;
      const rows = Math.max(5, Math.floor((H - headerH) / rowH));
      setPageSize((prev) => (prev === rows ? prev : rows));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [page, setPage] = useUrlPage();
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  React.useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);
  React.useEffect(() => {
    setPage(1);
  }, [query]);
  const pageStart = (page - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);
  const pageItemIds = React.useMemo(() => pageItems.map((u) => u.id), [pageItems]);
  const allSelected = pageItemIds.length > 0 && pageItemIds.every((id) => selected.has(id));
  const someSelected = pageItemIds.some((id) => selected.has(id)) && !allSelected;

  return (
    <div className="flex h-full flex-col gap-4">
      {/* 页头 */}
      <header className="flex items-end justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">用户管理</h1>
          <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground">
            {filtered.length === users.length
              ? `共 ${users.length} 条`
              : `筛选后 ${filtered.length} / ${users.length} 条`}
          </span>
        </div>
      </header>

      {/* 筛选行 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索姓名、用户名、飞书 ID"
            className={cn(
              "h-8 w-full sm:w-56 rounded-full border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition",
              "placeholder:text-muted-foreground",
              "focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              query.trim() !== "" && "border-primary/40 bg-primary/5",
            )}
          />
        </div>
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
            className="h-8 gap-1.5 rounded-full px-3 text-sm"
            onClick={() => setCreateOpen(true)}
          >
            <UserPlus className="h-3.5 w-3.5" />
            新增用户
          </Button>
        </div>
      </div>

      {/* 内容区 */}
      <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
          </div>
        ) : isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            加载失败：{(error as Error)?.message || "未知错误"}
          </div>
        ) : filtered.length === 0 ? (
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
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button type="button" className="ml-0.5 rounded p-0.5 hover:bg-accent">
                            <ChevronDown className="h-3 w-3 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-40">
                          <DropdownMenuItem onClick={() => setSelected(new Set(pageItemIds))}>
                            <Check className="mr-2 h-3.5 w-3.5" />
                            全选本页
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setSelected(new Set(filteredIds))}>
                            <Check className="mr-2 h-3.5 w-3.5" />
                            选择全部 ({filteredIds.length})
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setSelected(new Set())}>
                            <X className="mr-2 h-3.5 w-3.5" />
                            取消选择
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableHead>
                  <TableHead>姓名</TableHead>
                  <TableHead>用户名</TableHead>
                  <TableHead className="w-32">角色</TableHead>
                  <TableHead>飞书 ID</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="w-32 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(u.id)}
                        onCheckedChange={() => toggleOne(u.id)}
                      />
                    </TableCell>
                    <TableCell>{u.name || "-"}</TableCell>
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
                          u.role === "super_admin"
                            ? "default"
                            : u.role === "admin"
                              ? "default"
                              : "secondary"
                        }
                      >
                        {USER_ROLE_LABEL[u.role] || u.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {u.feishu_id || "-"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{u.created_at}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setEditing(u)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-primary"
                          title="转移数据并删除"
                          onClick={() => setTransferUser(u)}
                        >
                          <ArrowRightLeft className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
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
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* 分页条 */}
      {!isLoading && !isError && filtered.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t pt-3 text-sm text-muted-foreground">
          <span>
            显示 {pageStart + 1}-{Math.min(pageStart + pageSize, filtered.length)}，共{" "}
            {filtered.length} 条
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
            <span className="min-w-[52px] text-center text-foreground">
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
        onSuccess={() => qc.invalidateQueries({ queryKey: ["admin", "users"] })}
      />
      <UserFormDialog
        open={editing != null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        user={editing}
        onSuccess={() => qc.invalidateQueries({ queryKey: ["admin", "users"] })}
      />
      <TransferDeleteDialog
        open={transferUser != null}
        onOpenChange={(o) => {
          if (!o) setTransferUser(null);
        }}
        sourceUser={transferUser}
        allUsers={users.filter((u) => u.id !== transferUser?.id)}
        onSuccess={() => {
          qc.invalidateQueries({ queryKey: ["admin", "users"] });
        }}
      />
    </div>
  );
}

function TransferDeleteDialog({
  open,
  onOpenChange,
  sourceUser,
  allUsers,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sourceUser: AdminUser | null;
  allUsers: AdminUser[];
  onSuccess: () => void;
}) {
  const [targetId, setTargetId] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setTargetId("");
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
        json: { target_user_id: Number(targetId) },
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
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger>
                <SelectValue placeholder="请选择…" />
              </SelectTrigger>
              <SelectContent>
                {allUsers.map((u) => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.name || u.username}（{u.username}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  user: AdminUser | null;
  onSuccess: () => void;
}) {
  const editing = !!user;
  const [name, setName] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [useRandomPwd, setUseRandomPwd] = React.useState(false);
  const [feishu, setFeishu] = React.useState("");
  const [role, setRole] = React.useState<UserRole>("user");
  const [loading, setLoading] = React.useState(false);
  const [generatedPwd, setGeneratedPwd] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setName(user?.name || "");
      setUsername(user?.username || "");
      setPassword("");
      setUseRandomPwd(false);
      setFeishu(user?.feishu_id || "");
      setRole((user?.role as UserRole) || "user");
      setLoading(false);
      setGeneratedPwd("");
    }
  }, [open, user]);

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
            password: useRandomPwd ? null : password || null,
            feishu_id: feishu.trim(),
            role,
            need_change_pwd: !editing && useRandomPwd,
          },
        },
      );

      if (!editing && useRandomPwd && res.plain_password) {
        // 展示随机密码弹窗
        setGeneratedPwd(res.plain_password);
      } else if (!editing && !password && !useRandomPwd) {
        toast.success("用户已创建，密码为系统默认密码");
      } else {
        toast.success("用户已保存");
      }
      onSuccess();
      if (!(useRandomPwd && res.plain_password)) {
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              {editing ? <Pencil className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
            </span>
            {editing ? "编辑用户" : "新增用户"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "修改用户的基本信息与角色权限"
              : "创建一个新用户账号并分配角色"}
          </DialogDescription>
        </DialogHeader>

        {generatedPwd ? (
          /* 随机密码展示视图 */
          <div className="space-y-4">
            <div className="rounded-lg border border-emerald-300/60 bg-emerald-50 p-5 dark:border-emerald-800/50 dark:bg-emerald-950/30">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-emerald-800 dark:text-emerald-300">
                <KeyRound className="h-4 w-4" />
                随机密码已生成
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
            <div className="grid gap-4">
              {/* 基本信息 */}
              <section className="rounded-lg border bg-muted/20 p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <User className="h-4 w-4 text-muted-foreground" />
                  基本信息
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="user-name">姓名</Label>
                    <Input
                      id="user-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="输入用户姓名"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="user-username">用户名</Label>
                    <Input
                      id="user-username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="登录使用的用户名"
                    />
                  </div>
                </div>
              </section>

              {/* 安全设置 */}
              <section className="rounded-lg border bg-muted/20 p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  密码设置
                </div>
                <div className="grid gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="user-password">
                      密码
                      <span className="ml-1 text-xs text-muted-foreground">
                        {editing ? "（留空不修改）" : "（留空使用系统默认密码）"}
                      </span>
                    </Label>
                    <Input
                      id="user-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={!editing && useRandomPwd}
                      placeholder={!editing && useRandomPwd ? "将自动生成随机密码" : "输入密码"}
                    />
                  </div>
                  {!editing && (
                    <div className="flex items-center gap-2.5 rounded-md border border-dashed px-3 py-2.5">
                      <Checkbox
                        id="useRandomPwd"
                        checked={useRandomPwd}
                        onCheckedChange={(checked) => setUseRandomPwd(!!checked)}
                      />
                      <Label htmlFor="useRandomPwd" className="cursor-pointer text-sm leading-tight">
                        自动生成随机密码
                        <span className="block text-xs text-muted-foreground">首次登录时强制要求修改密码</span>
                      </Label>
                    </div>
                  )}
                </div>
              </section>

              {/* 角色与飞书 */}
              <section className="rounded-lg border bg-muted/20 p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  角色与集成
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label>角色</Label>
                    <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {USER_ROLE_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="user-feishu">
                      飞书 ID
                      <span className="ml-1 text-xs text-muted-foreground">（可选）</span>
                    </Label>
                    <Input
                      id="user-feishu"
                      value={feishu}
                      onChange={(e) => setFeishu(e.target.value)}
                      placeholder="关联飞书账号"
                    />
                  </div>
                </div>
              </section>
            </div>
            <DialogFooter>
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
