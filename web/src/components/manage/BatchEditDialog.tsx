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
import { TagInput } from "@/components/resource/TagInput";
import {
  DEFAULT_RESOURCE_SUBJECT,
  MANAGEMENT_SCOPE_OPTIONS,
  RESOURCE_STATUS_FORM_OPTIONS,
  SECRECY_LEVEL_FORM_OPTIONS,
  VISIBILITY_SCOPE_OPTIONS,
} from "@/lib/constants";
import { api } from "@/lib/api";
import { parseTags } from "@/lib/types";
import type {
  Resource,
  SecrecyLevel,
  ResourceStatus,
  VisibilityScope,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface BatchEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceIds: number[];
  resources: Resource[];
  onSuccess: () => void;
}

type TagMode = "replace" | "append" | "remove";

interface FieldsState {
  tags: { enabled: boolean; mode: TagMode; values: string[] };
  subject: { enabled: boolean; value: string };
  secrecy_level: { enabled: boolean; value: SecrecyLevel };
  status: { enabled: boolean; value: ResourceStatus };
  visibility_scope: { enabled: boolean; value: VisibilityScope; userIds: number[] };
  management_scope: { enabled: boolean; value: VisibilityScope; userIds: number[] };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function defaultFields(): FieldsState {
  return {
    tags: { enabled: false, mode: "replace", values: [] },
    subject: { enabled: false, value: DEFAULT_RESOURCE_SUBJECT },
    secrecy_level: { enabled: false, value: "public" },
    status: { enabled: false, value: "active" },
    visibility_scope: { enabled: false, value: "public", userIds: [] },
    management_scope: { enabled: false, value: "private", userIds: [] },
  };
}

function computeSummary(resources: Resource[], resourceIds: number[]) {
  const idSet = new Set(resourceIds);
  const matched = resources.filter((r) => idSet.has(r.id));

  // Tags: count unique
  const allTags = new Set<string>();
  matched.forEach((r) => parseTags(r.tags).forEach((t) => allTags.add(t)));

  // Subject distribution
  const subjectMap = new Map<string, number>();
  matched.forEach((r) => {
    const s = r.subject || "(无)";
    subjectMap.set(s, (subjectMap.get(s) || 0) + 1);
  });

  // Secrecy distribution
  const secrecyMap = new Map<string, number>();
  matched.forEach((r) => {
    secrecyMap.set(r.secrecy_level, (secrecyMap.get(r.secrecy_level) || 0) + 1);
  });

  // Status distribution
  const statusMap = new Map<string, number>();
  matched.forEach((r) => {
    statusMap.set(r.status, (statusMap.get(r.status) || 0) + 1);
  });

  // Visibility distribution
  const visMap = new Map<string, number>();
  matched.forEach((r) => {
    visMap.set(r.visibility_scope, (visMap.get(r.visibility_scope) || 0) + 1);
  });

  // Management distribution
  const mgmtMap = new Map<string, number>();
  matched.forEach((r) => {
    mgmtMap.set(r.management_scope, (mgmtMap.get(r.management_scope) || 0) + 1);
  });

  return { matched, allTags, subjectMap, secrecyMap, statusMap, visMap, mgmtMap };
}

function distributionText(
  map: Map<string, number>,
  labelMap: Record<string, string>,
): string {
  if (map.size === 0) return "";
  return Array.from(map.entries())
    .map(([k, v]) => `${labelMap[k] || k} ${v}`)
    .join(" / ");
}

const SECRECY_LABELS: Record<string, string> = { public: "公开", confidential: "保密", secret: "秘密" };
const STATUS_LABELS: Record<string, string> = { active: "正常", disabled: "停用" };
const SCOPE_LABELS: Record<string, string> = { public: "公开", partial: "部分", private: "仅自己" };

const TAG_MODE_OPTIONS: { value: TagMode; label: string }[] = [
  { value: "replace", label: "覆盖" },
  { value: "append", label: "追加" },
  { value: "remove", label: "移除" },
];

/* -------------------------------------------------------------------------- */
/*  Component                                                                  */
/* -------------------------------------------------------------------------- */

export function BatchEditDialog({
  open,
  onOpenChange,
  resourceIds,
  resources,
  onSuccess,
}: BatchEditDialogProps) {
  const [fields, setFields] = React.useState<FieldsState>(defaultFields);
  const [confirmStep, setConfirmStep] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setFields(defaultFields());
      setConfirmStep(false);
    }
  }, [open]);

  const summary = React.useMemo(
    () => computeSummary(resources, resourceIds),
    [resources, resourceIds],
  );

  const mutation = useMutation({
    mutationFn: async () => {
      const payloadFields: Record<string, unknown> = {};

      if (fields.tags.enabled) {
        payloadFields.tags = { mode: fields.tags.mode, values: fields.tags.values };
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
        json: { resource_ids: resourceIds, fields: payloadFields },
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

  const enabledFields = React.useMemo(() => {
    const list: string[] = [];
    if (fields.tags.enabled) list.push("标签");
    if (fields.subject.enabled) list.push("主体");
    if (fields.secrecy_level.enabled) list.push("密级");
    if (fields.status.enabled) list.push("状态");
    if (fields.visibility_scope.enabled) list.push("可见范围");
    if (fields.management_scope.enabled) list.push("管理范围");
    return list;
  }, [fields]);

  const changeSummaryText = React.useMemo(() => {
    const parts: string[] = [];
    if (fields.tags.enabled) {
      const modeLabel = TAG_MODE_OPTIONS.find((o) => o.value === fields.tags.mode)?.label || "";
      parts.push(`标签→${modeLabel} ${fields.tags.values.join(", ") || "(空)"}`);
    }
    if (fields.subject.enabled) parts.push(`主体→${fields.subject.value || "(空)"}`);
    if (fields.secrecy_level.enabled)
      parts.push(`密级→${SECRECY_LABELS[fields.secrecy_level.value]}`);
    if (fields.status.enabled) parts.push(`状态→${STATUS_LABELS[fields.status.value]}`);
    if (fields.visibility_scope.enabled)
      parts.push(`可见范围→${SCOPE_LABELS[fields.visibility_scope.value]}`);
    if (fields.management_scope.enabled)
      parts.push(`管理范围→${SCOPE_LABELS[fields.management_scope.value]}`);
    return parts.join("；");
  }, [fields]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (enabledFields.length === 0) {
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

    if (!confirmStep) {
      setConfirmStep(true);
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
    setConfirmStep(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-lg flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>批量编辑</DialogTitle>
          <p className="text-sm text-muted-foreground">
            共选中{" "}
            <span className="font-semibold text-foreground">{resourceIds.length}</span>{" "}
            项资源
          </p>
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto"
        >
          <div className="divide-y">
            {/* 标签 */}
            <FieldRow
              label="标签"
              checked={fields.tags.enabled}
              onCheckedChange={(v) => updateField("tags", { enabled: v })}
              summary={
                fields.tags.enabled && summary.allTags.size > 0
                  ? `当前共 ${summary.allTags.size} 种不同标签`
                  : undefined
              }
            >
              {fields.tags.enabled && (
                <div className="flex flex-col gap-2">
                  <div className="flex gap-0.5 rounded-md bg-muted p-0.5">
                    {TAG_MODE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors select-none ${
                          fields.tags.mode === opt.value
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                        onClick={() => updateField("tags", { mode: opt.value })}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <TagInput
                    value={fields.tags.values}
                    onChange={(next) => updateField("tags", { values: next })}
                    placeholder="选择或输入标签"
                  />
                </div>
              )}
            </FieldRow>

            {/* 主体 */}
            <FieldRow
              label="主体"
              checked={fields.subject.enabled}
              onCheckedChange={(v) => updateField("subject", { enabled: v })}
              summary={
                fields.subject.enabled && summary.subjectMap.size > 0
                  ? summary.subjectMap.size === 1
                    ? `统一为 ${Array.from(summary.subjectMap.keys())[0]}`
                    : Array.from(summary.subjectMap.entries())
                        .slice(0, 3)
                        .map(([k, v]) => `${k}（${v}项）`)
                        .join("、")
                  : undefined
              }
            >
              {fields.subject.enabled && (
                <>
                  <Input
                    value={fields.subject.value}
                    onChange={(e) => updateField("subject", { value: e.target.value })}
                    list="batch-subject-list"
                    className="h-8"
                  />
                  <datalist id="batch-subject-list">
                    <option value={DEFAULT_RESOURCE_SUBJECT} />
                  </datalist>
                </>
              )}
            </FieldRow>

            {/* 密级 */}
            <FieldRow
              label="密级"
              checked={fields.secrecy_level.enabled}
              onCheckedChange={(v) => updateField("secrecy_level", { enabled: v })}
              summary={
                fields.secrecy_level.enabled && summary.secrecyMap.size > 0
                  ? distributionText(summary.secrecyMap, SECRECY_LABELS)
                  : undefined
              }
            >
              {fields.secrecy_level.enabled && (
                <Select
                  value={fields.secrecy_level.value}
                  onValueChange={(v) =>
                    updateField("secrecy_level", { value: v as SecrecyLevel })
                  }
                >
                  <SelectTrigger className="h-8">
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
              )}
            </FieldRow>

            {/* 状态 */}
            <FieldRow
              label="状态"
              checked={fields.status.enabled}
              onCheckedChange={(v) => updateField("status", { enabled: v })}
              summary={
                fields.status.enabled && summary.statusMap.size > 0
                  ? distributionText(summary.statusMap, STATUS_LABELS)
                  : undefined
              }
            >
              {fields.status.enabled && (
                <Select
                  value={fields.status.value}
                  onValueChange={(v) =>
                    updateField("status", { value: v as ResourceStatus })
                  }
                >
                  <SelectTrigger className="h-8">
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
              )}
            </FieldRow>

            {/* 可见范围 */}
            <FieldRow
              label="可见范围"
              checked={fields.visibility_scope.enabled}
              onCheckedChange={(v) => updateField("visibility_scope", { enabled: v })}
              summary={
                fields.visibility_scope.enabled && summary.visMap.size > 0
                  ? distributionText(summary.visMap, SCOPE_LABELS)
                  : undefined
              }
            >
              {fields.visibility_scope.enabled && (
                <div className="flex flex-col gap-2">
                  <Select
                    value={fields.visibility_scope.value}
                    onValueChange={(v) =>
                      updateField("visibility_scope", { value: v as VisibilityScope })
                    }
                  >
                    <SelectTrigger className="h-8">
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
                  {fields.visibility_scope.value === "partial" && (
                    <div className="ml-4">
                      <Label className="mb-1 text-xs text-muted-foreground">
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
              )}
            </FieldRow>

            {/* 管理范围 */}
            <FieldRow
              label="管理范围"
              checked={fields.management_scope.enabled}
              onCheckedChange={(v) => updateField("management_scope", { enabled: v })}
              summary={
                fields.management_scope.enabled && summary.mgmtMap.size > 0
                  ? distributionText(summary.mgmtMap, SCOPE_LABELS)
                  : undefined
              }
            >
              {fields.management_scope.enabled && (
                <div className="flex flex-col gap-2">
                  <Select
                    value={fields.management_scope.value}
                    onValueChange={(v) =>
                      updateField("management_scope", { value: v as VisibilityScope })
                    }
                  >
                    <SelectTrigger className="h-8">
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
                  {fields.management_scope.value === "partial" && (
                    <div className="ml-4">
                      <Label className="mb-1 text-xs text-muted-foreground">
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
              )}
            </FieldRow>
          </div>

          {/* 确认摘要 */}
          {confirmStep && (
            <div className="mx-1 mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              将修改 {resourceIds.length} 项资源的 {enabledFields.length} 个字段：
              {changeSummaryText}
            </div>
          )}

          <DialogFooter className="mt-3 border-t pt-3">
            {confirmStep ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmStep(false)}
                  disabled={mutation.isPending}
                >
                  返回修改
                </Button>
                <Button type="submit" size="sm" disabled={mutation.isPending}>
                  {mutation.isPending && (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  )}
                  确认执行
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                >
                  取消
                </Button>
                <Button type="submit" size="sm">
                  确认修改
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  FieldRow helper                                                            */
/* -------------------------------------------------------------------------- */

interface FieldRowProps {
  label: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  summary?: string;
  children?: React.ReactNode;
}

function FieldRow({ label, checked, onCheckedChange, summary, children }: FieldRowProps) {
  return (
    <div className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        className="mt-0.5"
      />
      <div className="min-w-[60px] shrink-0 pt-0.5">
        <Label className="text-sm font-medium">{label}</Label>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {children}
        {summary && (
          <p className="text-[11px] leading-tight text-muted-foreground">{summary}</p>
        )}
      </div>
    </div>
  );
}
