import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UserPicker } from "@/components/resource/UserPicker";
import { api } from "@/lib/api";
import type { Department } from "@/lib/types";

export function AddMembersDialog({
  open,
  onOpenChange,
  department,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  department: Department | null;
  onSaved: () => void;
}) {
  const [userIds, setUserIds] = React.useState<number[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setUserIds([]);
      setLoading(false);
    }
  }, [open]);

  const submit = async () => {
    if (!department || userIds.length === 0) {
      toast.error("请选择要添加的成员");
      return;
    }
    setLoading(true);
    try {
      await api(`/api/departments/${department.id}/members`, {
        method: "POST",
        json: { user_ids: userIds },
      });
      toast.success(`已添加 ${userIds.length} 位成员`);
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast.error((error as Error).message || "添加成员失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-auto">
        <DialogHeader>
          <DialogTitle>添加成员</DialogTitle>
          <DialogDescription>
            {department ? `将成员加入「${department.name}」；一个用户可以同时属于多个部门。` : ""}
          </DialogDescription>
        </DialogHeader>
        <UserPicker
          value={userIds}
          onChange={setUserIds}
          showBulk={false}
          allowTagSelection={false}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={loading || userIds.length === 0}>
            {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            添加 {userIds.length ? `(${userIds.length})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
