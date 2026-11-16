import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { CurrentUser } from "@/lib/types";

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Temporary-password flow: cannot be dismissed. */
  force?: boolean;
}

export function ChangePasswordDialog({ open, onOpenChange, force = false }: ChangePasswordDialogProps) {
  const { setUser } = useAuth();
  const queryClient = useQueryClient();
  const [oldPwd, setOldPwd] = React.useState("");
  const [newPwd, setNewPwd] = React.useState("");
  const [confirmPwd, setConfirmPwd] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setOldPwd("");
    setNewPwd("");
    setConfirmPwd("");
    setLoading(false);
  }, [open]);

  const requestClose = (next: boolean) => {
    if (!next && force) return;
    onOpenChange(next);
  };

  const submit = async () => {
    if (!oldPwd.trim()) {
      toast.error("请输入原密码");
      return;
    }
    if (!newPwd.trim()) {
      toast.error("请输入新密码");
      return;
    }
    if (newPwd.trim().length < 10) {
      toast.error("新密码长度不能少于 10 位");
      return;
    }
    if (newPwd !== confirmPwd) {
      toast.error("两次输入的新密码不一致");
      return;
    }
    if (oldPwd === newPwd) {
      toast.error("新密码不能与原密码相同");
      return;
    }
    setLoading(true);
    try {
      const res = await api<{ user: CurrentUser }>("/api/auth/change-password", {
        method: "PUT",
        json: { old_password: oldPwd, new_password: newPwd },
      });
      toast.success("密码修改成功");
      setUser({ ...res.user });
      await queryClient.invalidateQueries();
      requestClose(false);
    } catch (err) {
      toast.error((err as Error).message || "修改密码失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        className="max-w-sm"
        hideClose={force}
        onPointerDownOutside={(event) => { if (force) event.preventDefault(); }}
        onEscapeKeyDown={(event) => { if (force) event.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle>修改密码</DialogTitle>
          <DialogDescription>
            {force
              ? "当前使用的是临时密码。请设置至少 10 位的新密码后继续使用。"
              : "修改后当前会话保持登录，其他已登录设备需要使用新密码重新登录。"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="change-password-old">原密码</Label>
            <Input
              id="change-password-old"
              type="password"
              value={oldPwd}
              onChange={(event) => setOldPwd(event.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="change-password-new">新密码</Label>
            <Input
              id="change-password-new"
              type="password"
              value={newPwd}
              onChange={(event) => setNewPwd(event.target.value)}
              autoComplete="new-password"
            />
            <p className="text-[11px] leading-5 text-muted-foreground">至少 10 位，不能与用户名相同，并避免常见密码。</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="change-password-confirm">确认新密码</Label>
            <Input
              id="change-password-confirm"
              type="password"
              value={confirmPwd}
              onChange={(event) => setConfirmPwd(event.target.value)}
              autoComplete="new-password"
            />
          </div>
        </div>
        <DialogFooter>
          {!force && (
            <Button variant="outline" onClick={() => requestClose(false)} disabled={loading}>
              取消
            </Button>
          )}
          <Button onClick={() => void submit()} disabled={loading} className={force ? "w-full" : undefined}>
            {loading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            确认修改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
