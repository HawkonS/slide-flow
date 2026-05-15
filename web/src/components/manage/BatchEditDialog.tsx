import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserPicker } from "@/components/resource/UserPicker";
import {
  DEFAULT_RESOURCE_SUBJECT,
  MANAGEMENT_SCOPE_OPTIONS,
  RESOURCE_STATUS_FORM_OPTIONS,
  SECRECY_LEVEL_FORM_OPTIONS,
  VISIBILITY_SCOPE_OPTIONS,
} from "@/lib/constants";
import { api } from "@/lib/api";
import type { SecrecyLevel, ResourceStatus, VisibilityScope } from "@/lib/types";

export interface BatchEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceIds: number[];
  onSuccess: () => void;
}

type ScopeField = {
  enabled: boolean;
  value: VisibilityScope;
  userIds: number[];
};

interface FieldsState {
  tags: { enabled: boolean; value: string };
  subject: { enabled: boolean; value: string };
  secrecy_level: { enabled: boolean; value: SecrecyLevel };
  status: { enabled: boolean; value: ResourceStatus };
  visibility_scope: ScopeField;
  management_scope: ScopeField;
}

function defaultFields(): FieldsState {
  return {
    tags: { enabled: false, value: "" },
    subject: { enabled: false, value: DEFAULT_RESOURCE_SUBJECT },
    secrecy_level: { enabled: false, value: "public" },
    status: { enabled: false, value: "active" },
    visibility_scope: { enabled: false, value: "public", userIds: [] },
    management_scope: { enabled: false, value: "private", userIds: [] },
  };
}

export function BatchEditDialog({
  open,
  onOpenChange,
  resourceIds,
  onSuccess,
}: BatchEditDialogProps) {
  const [fields, setFields] = React.useState<FieldsState>(defaultFields);

  React.useEffect(() => {
    if (open) {
      setFields(defaultFields());
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: async () => {
      const payloadFields: Record<string, unknown> = {};

      if (fields.tags.enabled) {
        payloadFields.tags = fields.tags.value;
      }
      if (fields.subject.enabled) {
        payloadFields.subject = fields.subject.value;
      }
      if (fields.secrecy_level.enabled) {
        payloadFields.secrecy_level = fields.secrecy_level.value;
      }
      if (fields.status.enabled) {
        payloadFields.status = fields.status.value;
      }
      if (fields.visibility_scope.enabled) {
        payloadFields.visibility_scope = fields.visibility_scope.value;
        if (fields.visibility_scope.value === "partial") {
          payloadFields.visible_user_ids = fields.visibility_scope.userIds;
        }
      }
      if (fields.management_scope.enabled) {
        payloadFields.management_scope = fields.management_scope.value;
        if (fields.management_scope.value === "partial") {
          payloadFields.manage_user_ids = fields.management_scope.userIds;
        }
      }

      return api("/api/resources/batch", {
        method: "PUT",
        json: {
          resource_ids: resourceIds,
          fields: payloadFields,
        },
      });
    },
    onSuccess: () => {
      toast.success("批量编辑成功");
      onSuccess();
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error(err.message || "批量编辑失败");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const anyEnabled =
      fields.tags.enabled ||
      fields.subject.enabled ||
      fields.secrecy_level.enabled ||
      fields.status.enabled ||
      fields.visibility_scope.enabled ||
      fields.management_scope.enabled;

    if (!anyEnabled) {
      toast.error("请至少选择一个要修改的字段");
      return;
    }

    if (
      fields.visibility_scope.enabled &&
      fields.visibility_scope.value === "partial" &&
      fields.visibility_scope.userIds.length === 0
    ) {
      toast.error("可见范围为部分时请至少选择一位用户");
      return;
    }

    if (
      fields.management_scope.enabled &&
      fields.management_scope.value === "partial" &&
      fields.management_scope.userIds.length === 0
    ) {
      toast.error("管理范围为部分时请至少选择一位用户");
      return;
    }

    mutation.mutate();
  };

  const updateField = <K extends keyof FieldsState>(
    key: K,
    patch: Partial<FieldsState[K]>,
  ) => {
    setFields((prev) => ({
      ...prev,
      [key]: { ...prev[key], ...patch },
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>批量编辑</DialogTitle>
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-0.5 pb-1"
        >
          <p className="text-sm text-muted-foreground">
            共选中 <span className="font-semibold text-foreground">{resourceIds.length}</span> 项资源。
            勾选字段开关以启用修改，仅开启的字段会被批量更新。
          </p>

          {/* 标签 */}
          <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4">
            <Checkbox
              id="batch-tags"
              checked={fields.tags.enabled}
              onCheckedChange={(v) =>
                updateField("tags", { enabled: v === true })
              }
              className="mt-2"
            />
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="batch-tags-input">标签</Label>
              <Input
                id="batch-tags-input"
                value={fields.tags.value}
                onChange={(e) =>
                  updateField("tags", { value: e.target.value })
                }
                placeholder="多个标签用逗号分隔"
                disabled={!fields.tags.enabled}
              />
            </div>
          </div>

          {/* 主体 */}
          <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4">
            <Checkbox
              id="batch-subject"
              checked={fields.subject.enabled}
              onCheckedChange={(v) =>
                updateField("subject", { enabled: v === true })
              }
              className="mt-2"
            />
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="batch-subject-input">主体</Label>
              <Input
                id="batch-subject-input"
                list="batch-subject-list"
                value={fields.subject.value}
                onChange={(e) =>
                  updateField("subject", { value: e.target.value })
                }
                disabled={!fields.subject.enabled}
              />
              <datalist id="batch-subject-list">
                <option value={DEFAULT_RESOURCE_SUBJECT} />
              </datalist>
            </div>
          </div>

          {/* 密级 */}
          <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4">
            <Checkbox
              id="batch-secrecy"
              checked={fields.secrecy_level.enabled}
              onCheckedChange={(v) =>
                updateField("secrecy_level", { enabled: v === true })
              }
              className="mt-2"
            />
            <div className="grid flex-1 gap-1.5">
              <Label>密级</Label>
              <Select
                value={fields.secrecy_level.value}
                onValueChange={(v) =>
                  updateField("secrecy_level", {
                    value: v as SecrecyLevel,
                  })
                }
                disabled={!fields.secrecy_level.enabled}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SECRECY_LEVEL_FORM_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 状态 */}
          <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4">
            <Checkbox
              id="batch-status"
              checked={fields.status.enabled}
              onCheckedChange={(v) =>
                updateField("status", { enabled: v === true })
              }
              className="mt-2"
            />
            <div className="grid flex-1 gap-1.5">
              <Label>状态</Label>
              <Select
                value={fields.status.value}
                onValueChange={(v) =>
                  updateField("status", { value: v as ResourceStatus })
                }
                disabled={!fields.status.enabled}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESOURCE_STATUS_FORM_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 可见范围 */}
          <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4">
            <Checkbox
              id="batch-visibility"
              checked={fields.visibility_scope.enabled}
              onCheckedChange={(v) =>
                updateField("visibility_scope", { enabled: v === true })
              }
              className="mt-2"
            />
            <div className="grid flex-1 gap-1.5">
              <Label>可见范围</Label>
              <Select
                value={fields.visibility_scope.value}
                onValueChange={(v) =>
                  updateField("visibility_scope", {
                    value: v as VisibilityScope,
                  })
                }
                disabled={!fields.visibility_scope.enabled}
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
              {fields.visibility_scope.enabled &&
                fields.visibility_scope.value === "partial" && (
                  <div className="mt-2 grid gap-1.5">
                    <Label className="text-xs text-muted-foreground">
                      可见用户（必选至少 1 人）
                    </Label>
                    <UserPicker
                      value={fields.visibility_scope.userIds}
                      onChange={(ids) =>
                        updateField("visibility_scope", { userIds: ids })
                      }
                    />
                  </div>
                )}
            </div>
          </div>

          {/* 管理范围 */}
          <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4">
            <Checkbox
              id="batch-management"
              checked={fields.management_scope.enabled}
              onCheckedChange={(v) =>
                updateField("management_scope", { enabled: v === true })
              }
              className="mt-2"
            />
            <div className="grid flex-1 gap-1.5">
              <Label>管理范围</Label>
              <Select
                value={fields.management_scope.value}
                onValueChange={(v) =>
                  updateField("management_scope", {
                    value: v as VisibilityScope,
                  })
                }
                disabled={!fields.management_scope.enabled}
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
              {fields.management_scope.enabled &&
                fields.management_scope.value === "partial" && (
                  <div className="mt-2 grid gap-1.5">
                    <Label className="text-xs text-muted-foreground">
                      可管理用户（必选至少 1 人）
                    </Label>
                    <UserPicker
                      value={fields.management_scope.userIds}
                      onChange={(ids) =>
                        updateField("management_scope", { userIds: ids })
                      }
                    />
                  </div>
                )}
            </div>
          </div>

          <DialogFooter className="sticky bottom-0 -mx-0.5 border-t bg-background pt-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              取消
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              )}
              确认修改
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
