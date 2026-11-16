import * as React from "react";
import { ArrowRightLeft, Crown, KeyRound, Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmploymentStatusBadge } from "@/components/directory/EmploymentStatusBadge";
import { USER_ROLE_LABEL } from "@/lib/constants";
import type { AdminUser } from "@/lib/types";
import { parseTags } from "@/lib/types";

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

export function UserProfileModal({
  user,
  onOpenChange,
  onEdit,
  onResetPassword,
  onTransferDelete,
  onDelete,
  canManage,
  canDelete,
}: {
  user: AdminUser | null;
  onOpenChange: (open: boolean) => void;
  onEdit: (user: AdminUser) => void;
  onResetPassword: (user: AdminUser) => void;
  onTransferDelete: (user: AdminUser) => void;
  onDelete: (user: AdminUser) => void;
  canManage: boolean;
  canDelete: boolean;
}) {
  return (
    <Dialog open={user != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-auto">
        {user ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-3">
                {user.avatar_url ? (
                  <img src={user.avatar_url} alt="" className="h-10 w-10 rounded-full object-cover" />
                ) : (
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-sm font-medium">
                    {(user.name || user.username || "?").slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate">{user.name || user.username}</span>
                  <span className="block text-xs font-normal text-muted-foreground">@{user.username}</span>
                </span>
              </DialogTitle>
              <DialogDescription>
                {user.email || "未填写邮箱"} · {user.job_title || "未填写职位"}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 text-sm sm:grid-cols-2">
              <Field label="角色">
                <Badge variant={user.role === "user" ? "secondary" : "default"}>
                  {USER_ROLE_LABEL[user.role] || user.role}
                </Badge>
              </Field>
              <Field label="在职状态">
                <EmploymentStatusBadge status={user.employment_status} />
              </Field>
              <Field label="工号">{user.employee_no || "-"}</Field>
              <Field label="飞书 ID">{user.feishu_id || "-"}</Field>
              <Field label="最后登录">{formatDateTime(user.last_login_at)}</Field>
              <Field label="创建时间">{formatDateTime(user.created_at)}</Field>
            </div>
            <div className="grid gap-2">
              <p className="text-xs font-medium text-muted-foreground">所属部门</p>
              <div className="flex flex-wrap gap-1.5">
                {(user.departments || []).length ? (
                  user.departments!.map((department) => (
                    <Badge key={department.id} variant="soft" title={department.path_names || department.path}>
                      {department.path_names || department.path}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">未分配部门（公司直属）</span>
                )}
              </div>
            </div>
            {(user.leader_of || []).length ? (
              <div className="grid gap-2">
                <p className="text-xs font-medium text-muted-foreground">负责人</p>
                <div className="flex flex-wrap gap-1.5">
                  {user.leader_of!.map((leader) => (
                    <Badge key={leader.department_id} variant="warning">
                      <Crown className="mr-1 h-3 w-3" />
                      {leader.name}
                      {leader.is_primary ? " · 主负责人" : ""}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="grid gap-2">
              <p className="text-xs font-medium text-muted-foreground">用户标签</p>
              <div className="flex flex-wrap gap-1.5">
                {parseTags(user.tags).length ? (
                  parseTags(user.tags).map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)
                ) : (
                  <span className="text-sm text-muted-foreground">暂无标签</span>
                )}
              </div>
            </div>
            <DialogFooter className="flex-wrap gap-2 border-t pt-4">
              <Button variant="outline" size="sm" disabled={!canManage} onClick={() => onEdit(user)}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" />编辑
              </Button>
              <Button variant="outline" size="sm" disabled={!canManage} onClick={() => onResetPassword(user)}>
                <KeyRound className="mr-1.5 h-3.5 w-3.5" />重置密码
              </Button>
              <Button variant="outline" size="sm" disabled={!canDelete} onClick={() => onTransferDelete(user)}>
                <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />转移并删除
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={!canDelete}
                onClick={() => onDelete(user)}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />删除
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-sm">{children}</span>
    </div>
  );
}
