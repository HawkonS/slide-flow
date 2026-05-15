import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserPicker } from "@/components/resource/UserPicker";
import {
  VISIBILITY_SCOPE_OPTIONS,
  MANAGEMENT_SCOPE_OPTIONS,
  NETWORK_ENV_OPTIONS,
} from "@/lib/constants";
import { createLink, updateLink, deleteLink } from "@/lib/api";
import { Link } from "@/lib/types";

export interface LinkEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 为 null 表示创建模式 */
  link: Link | null;
}

type ScopeValue = "public" | "partial" | "private";

interface FormState {
  name: string;
  url: string;
  memo: string;
  visibility_scope: ScopeValue;
  management_scope: ScopeValue;
  visible_user_ids: number[];
  manage_user_ids: number[];
  network_env: string;
}

function defaultForm(link: Link | null): FormState {
  if (!link) {
    return {
      name: "",
      url: "",
      memo: "",
      visibility_scope: "public",
      management_scope: "private",
      visible_user_ids: [],
      manage_user_ids: [],
      network_env: "public_net",
    };
  }
  return {
    name: link.name,
    url: link.url,
    memo: link.memo,
    visibility_scope: link.visibility_scope as ScopeValue,
    management_scope: link.management_scope as ScopeValue,
    visible_user_ids: link.visible_user_ids ?? [],
    manage_user_ids: link.manage_user_ids ?? [],
    network_env: link.network_env ?? "public_net",
  };
}

export function LinkEditDialog({
  open,
  onOpenChange,
  link,
}: LinkEditDialogProps) {
  const isCreate = link == null;
  const [form, setForm] = React.useState<FormState>(() => defaultForm(link));
  const queryClient = useQueryClient();

  React.useEffect(() => {
    if (open) setForm(defaultForm(link));
  }, [open, link]);

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        url: form.url.trim(),
        memo: form.memo.trim(),
        visibility_scope: form.visibility_scope,
        management_scope: form.management_scope,
        visible_user_ids:
          form.visibility_scope === "partial" ? form.visible_user_ids : [],
        manage_user_ids:
          form.management_scope === "partial" ? form.manage_user_ids : [],
        network_env: form.network_env,
      };

      if (isCreate) {
        return createLink(payload);
      }
      return updateLink(link!.id, payload);
    },
    onSuccess: () => {
      toast.success(isCreate ? "链接已创建" : "链接已更新");
      queryClient.invalidateQueries({ queryKey: ["links"] });
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg || "提交失败");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!link) throw new Error("链接不存在");
      return deleteLink(link.id);
    },
    onSuccess: () => {
      toast.success("链接已删除");
      queryClient.invalidateQueries({ queryKey: ["links"] });
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg || "删除失败");
    },
  });

  const handleDelete = () => {
    if (!link) return;
    const ok = window.confirm(
      `确定要删除链接「${link.name}」吗？此操作不可恢复。`,
    );
    if (!ok) return;
    deleteMutation.mutate();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("请填写链接名称");
      return;
    }
    if (!form.url.trim()) {
      toast.error("请填写网址");
      return;
    }
    try {
      new URL(form.url.trim());
    } catch {
      toast.error("请输入有效的网址格式");
      return;
    }
    if (form.visibility_scope === "partial" && form.visible_user_ids.length === 0) {
      toast.error("可见范围为部分时请至少选择一位用户");
      return;
    }
    if (form.management_scope === "partial" && form.manage_user_ids.length === 0) {
      toast.error("管理范围为部分时请至少选择一位用户");
      return;
    }
    mutation.mutate();
  };

  const ownerId = link?.owner_id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{isCreate ? "新建链接" : "编辑链接"}</DialogTitle>
          <DialogDescription>
            {isCreate
              ? "添加一个新的链接到链接仓库"
              : "修改链接信息与访问范围"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-0.5 pb-1">
          {/* 名称 */}
          <div className="grid gap-1.5">
            <Label htmlFor="link-name">链接名称</Label>
            <Input
              id="link-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例如：公司官网"
              required
            />
          </div>

          {/* 网址 */}
          <div className="grid gap-1.5">
            <Label htmlFor="link-url">网址</Label>
            <Input
              id="link-url"
              type="url"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://example.com"
              required
            />
          </div>

          {/* 网络环境 */}
          <div className="grid gap-1.5">
            <Label>网络环境</Label>
            <Select
              value={form.network_env}
              onValueChange={(v) => setForm({ ...form, network_env: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NETWORK_ENV_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 备注 */}
          <div className="grid gap-1.5">
            <Label htmlFor="link-memo">备注</Label>
            <Textarea
              id="link-memo"
              value={form.memo}
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
              placeholder="可选：对链接的补充说明"
              rows={3}
            />
          </div>

          {/* 可见 / 管理 范围 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>可见范围</Label>
              <Select
                value={form.visibility_scope}
                onValueChange={(v) =>
                  setForm({ ...form, visibility_scope: v as ScopeValue })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VISIBILITY_SCOPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>管理范围</Label>
              <Select
                value={form.management_scope}
                onValueChange={(v) =>
                  setForm({ ...form, management_scope: v as ScopeValue })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MANAGEMENT_SCOPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {form.visibility_scope === "partial" && (
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">可见用户（必选至少 1 人）</Label>
              <UserPicker
                value={form.visible_user_ids}
                onChange={(ids) => setForm({ ...form, visible_user_ids: ids })}
                excludeIds={ownerId ? [ownerId] : undefined}
              />
            </div>
          )}
          {form.management_scope === "partial" && (
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">可管理用户（必选至少 1 人）</Label>
              <UserPicker
                value={form.manage_user_ids}
                onChange={(ids) => setForm({ ...form, manage_user_ids: ids })}
                excludeIds={ownerId ? [ownerId] : undefined}
              />
            </div>
          )}

          <DialogFooter className="sticky bottom-0 -mx-0.5 flex flex-col-reverse gap-3 border-t bg-background pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            {!isCreate && link?.can_manage ? (
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={deleteMutation.isPending}
                  onClick={handleDelete}
                >
                  删除链接
                </Button>
              </div>
            ) : (
              <span className="hidden sm:block" />
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={deleteMutation.isPending}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={mutation.isPending || deleteMutation.isPending}
              >
                {mutation.isPending ? "提交中…" : isCreate ? "创建" : "保存"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
