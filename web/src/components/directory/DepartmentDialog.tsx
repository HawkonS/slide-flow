import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { Switch } from "@/components/ui/switch";
import { UserPicker } from "@/components/resource/UserPicker";
import { api } from "@/lib/api";
import type { Department } from "@/lib/types";

export function DepartmentDialog({
  open,
  onOpenChange,
  department,
  parentId,
  rootId,
  departments,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  department: Department | null;
  parentId: number | null;
  rootId: number;
  departments: Department[];
  onSaved: () => void;
}) {
  const editing = department != null;
  const [name, setName] = React.useState("");
  const [parent, setParent] = React.useState(String(rootId));
  const [sortOrder, setSortOrder] = React.useState("0");
  const [active, setActive] = React.useState(true);
  const [leaders, setLeaders] = React.useState<number[]>([]);
  const [primaryLeader, setPrimaryLeader] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);

  const { data: leaderOptions } = useQuery({
    queryKey: ["directory", "leader-options", leaders],
    queryFn: () => api<{ users: Array<{ id: number; name: string | null; username: string }> }>(
      "/api/users/options",
      { params: { ids: leaders.slice(0, 100).join(","), limit: 0 } },
    ),
    enabled: open && leaders.length > 0,
    staleTime: 30_000,
  });
  const leaderNameById = React.useMemo(
    () => new Map((leaderOptions?.users ?? []).map((user) => [user.id, user.name || user.username])),
    [leaderOptions],
  );

  React.useEffect(() => {
    if (!open) return;
    setName(department?.name || "");
    setParent(String(department?.parent_id ?? parentId ?? rootId));
    setSortOrder(String(department?.sort_order ?? 0));
    setActive(department?.is_active ?? true);
    const leaderIds = (department?.leaders || []).map((leader) => leader.user_id);
    setLeaders(leaderIds);
    setPrimaryLeader(
      department?.leaders?.find((leader) => leader.is_primary)?.user_id ?? leaderIds[0] ?? null,
    );
    setLoading(false);
  }, [open, department, parentId, rootId]);

  const descendantPrefix = department?.path || "";
  const parentOptions = React.useMemo(
    () =>
      departments
        .filter((item) => item.parent_id != null)
        .filter((item) => !descendantPrefix || !item.path.startsWith(descendantPrefix) || item.id === department?.id)
        .filter((item) => item.id !== department?.id)
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path, "zh-CN")),
    [departments, department?.id, descendantPrefix],
  );

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("请填写部门名称");
      return;
    }
    setLoading(true);
    try {
      let departmentId = department?.id ?? 0;
      if (editing) {
        await api(`/api/departments/${departmentId}`, {
          method: "PATCH",
          json: {
            name: trimmed,
            parent_id: Number(parent),
            sort_order: Number(sortOrder) || 0,
            is_active: active,
          },
        });
      } else {
        const response = await api<{ department: Department }>("/api/departments", {
          method: "POST",
          json: {
            parent_id: Number(parent),
            name: trimmed,
            sort_order: Number(sortOrder) || 0,
          },
        });
        departmentId = response.department.id;
      }
      const initialLeaders = (department?.leaders || []).map((leader) => leader.user_id);
      const initialPrimary =
        department?.leaders?.find((leader) => leader.is_primary)?.user_id ?? null;
      const leadersChanged =
        !editing
        || [...leaders].sort((a, b) => a - b).join(",") !== [...initialLeaders].sort((a, b) => a - b).join(",")
        || primaryLeader !== initialPrimary;
      if (leadersChanged) {
        await api(`/api/departments/${departmentId}/leaders`, {
          method: "PUT",
          json: {
            user_ids: leaders,
            primary_user_id: primaryLeader && leaders.includes(primaryLeader) ? primaryLeader : null,
          },
        });
      }
      toast.success(editing ? "部门已更新" : "部门已创建");
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast.error((error as Error).message || "保存部门失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑部门" : "新建部门"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="department-name">部门名称</Label>
            <Input
              id="department-name"
              value={name}
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：产品研发 / 前端组"
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>上级部门</Label>
              <Select value={parent} onValueChange={setParent}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={String(rootId)}>顶级部门</SelectItem>
                  {parentOptions.map((item) => (
                    <SelectItem key={item.id} value={String(item.id)}>
                      {"　".repeat(Math.max(0, item.depth - 1))}
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="department-sort">排序</Label>
              <Input
                id="department-sort"
                type="number"
                min={0}
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value)}
              />
            </div>
          </div>
          {editing ? (
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <p className="text-sm font-medium">启用部门</p>
                <p className="text-xs text-muted-foreground">停用后从选择器隐藏，但不会撤销已有权限。</p>
              </div>
              <Switch checked={active} onCheckedChange={setActive} aria-label="启用部门" />
            </div>
          ) : null}
          <div className="grid gap-2">
            <Label>负责人</Label>
            <UserPicker
              value={leaders}
              onChange={(next) => {
                setLeaders(next);
                if (primaryLeader != null && !next.includes(primaryLeader)) {
                  setPrimaryLeader(next[0] ?? null);
                }
              }}
              showBulk={false}
              allowTagSelection={false}
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>主负责人</Label>
                <Select
                  value={primaryLeader == null ? "" : String(primaryLeader)}
                  onValueChange={(value) => setPrimaryLeader(value ? Number(value) : null)}
                  disabled={leaders.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="从负责人中选择" />
                  </SelectTrigger>
                  <SelectContent>
                    {leaders.map((userId) => (
                      <SelectItem key={userId} value={String(userId)}>
                        {leaderNameById.get(userId) || `用户 #${userId}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="self-end pb-2 text-xs text-muted-foreground">
                负责人只做展示和排序，不会自动获得部门权限。
              </p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={loading}>
            {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
