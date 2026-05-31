import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

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

export function ForceChangePassword() {
  const { user, setUser } = useAuth();
  const [oldPwd, setOldPwd] = React.useState("");
  const [newPwd, setNewPwd] = React.useState("");
  const [confirmPwd, setConfirmPwd] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  const mustChange = !!user?.must_change_pwd;

  const submit = async () => {
    if (!oldPwd.trim()) {
      toast.error("请输入原密码");
      return;
    }
    if (!newPwd.trim()) {
      toast.error("请输入新密码");
      return;
    }
    if (newPwd.length < 6) {
      toast.error("新密码长度不能少于 6 位");
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
      // 更新用户状态，关闭弹窗
      setUser({ ...res.user });
    } catch (err) {
      toast.error((err as Error).message || "修改密码失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={mustChange} onOpenChange={() => { /* 不允许关闭 */ }}>
      <DialogContent
        className="max-w-sm"
        hideClose
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>修改密码</DialogTitle>
          <DialogDescription>
            管理员已要求您在首次登录时修改密码，请设置新密码后继续使用。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>原密码</Label>
            <Input
              type="password"
              value={oldPwd}
              onChange={(e) => setOldPwd(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label>新密码</Label>
            <Input
              type="password"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label>确认新密码</Label>
            <Input
              type="password"
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={loading} className="w-full">
            {loading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            确认修改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
