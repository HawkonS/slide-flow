import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { TagInput } from "@/components/resource/TagInput";
import { useMetadataTagOptions } from "@/components/resource/MetadataTagSelect";
import { UserPicker } from "@/components/resource/UserPicker";
import {
  MANAGEMENT_SCOPE_OPTIONS,
  VISIBILITY_SCOPE_OPTIONS,
} from "@/lib/constants";
import { api } from "@/lib/api";
import { parseTags } from "@/lib/types";
import type { Resource, ResourceStatus, VisibilityScope } from "@/lib/types";

export interface BatchEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceIds: number[];
  resources: Resource[];
  onSuccess: () => void;
}

type NameMode = "prefix" | "suffix" | "replace";
type TagMode = "replace" | "append" | "remove";

interface FieldsState {
  name: {
    enabled: boolean;
    mode: NameMode;
    value: string;
    search: string;
  };
  tags: { enabled: boolean; mode: TagMode; values: string[] };
  status: { enabled: boolean; value: ResourceStatus };
  visibility_scope: {
    enabled: boolean;
    value: VisibilityScope;
    userIds: number[];
    userTags: string[];
  };
  management_scope: {
    enabled: boolean;
    value: VisibilityScope;
    userIds: number[];
    userTags: string[];
  };
}

const NAME_MODE_OPTIONS: Array<{ value: NameMode; label: string }> = [
  { value: "prefix", label: "添加前缀" },
  { value: "suffix", label: "添加后缀" },
  { value: "replace", label: "查找替换" },
];

const TAG_MODE_OPTIONS: Array<{ value: TagMode; label: string }> = [
  { value: "replace", label: "覆盖" },
  { value: "append", label: "追加" },
  { value: "remove", label: "移除" },
];

const SCOPE_LABELS: Record<string, string> = {
  public: "公开",
  partial: "部分用户或用户标签",
  private: "仅自己",
};

function defaultFields(): FieldsState {
  return {
    name: { enabled: false, mode: "prefix", value: "", search: "" },
    tags: { enabled: false, mode: "replace", values: [] },
    status: { enabled: false, value: "" },
    visibility_scope: {
      enabled: false,
      value: "public",
      userIds: [],
      userTags: [],
    },
    management_scope: {
      enabled: false,
      value: "private",
      userIds: [],
      userTags: [],
    },
  };
}

function countDistribution(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  values.forEach((value) => result.set(value, (result.get(value) || 0) + 1));
  return result;
}

function distributionText(
  distribution: Map<string, number>,
  labels: Record<string, string> = {},
): string {
  return Array.from(distribution.entries())
    .map(([value, count]) => (labels[value] || value || "未设置") + " " + count + " 项")
    .join(" / ");
}

function transformName(name: string, field: FieldsState["name"]): string {
  if (field.mode === "prefix") return field.value + name;
  if (field.mode === "suffix") return name + field.value;
  return field.search ? name.split(field.search).join(field.value) : name;
}

export function BatchEditDialog({
  open,
  onOpenChange,
  resourceIds,
  resources,
  onSuccess,
}: BatchEditDialogProps) {
  const [fields, setFields] = React.useState<FieldsState>(defaultFields);
  const { options: statusOptions } = useMetadataTagOptions("status");

  React.useEffect(() => {
    if (open) setFields(defaultFields());
  }, [open]);

  React.useEffect(() => {
    if (!open || !statusOptions[0]?.value) return;
    setFields((current) => {
      if (current.status.value) return current;
      return {
        ...current,
        status: { ...current.status, value: statusOptions[0].value },
      };
    });
  }, [open, statusOptions]);

  const selectedResources = React.useMemo(() => {
    const selectedIds = new Set(resourceIds);
    return resources.filter((resource) => selectedIds.has(resource.id));
  }, [resourceIds, resources]);

  const currentTagCount = React.useMemo(() => {
    const tags = new Set<string>();
    selectedResources.forEach((resource) => {
      parseTags(resource.tags).forEach((tag) => tags.add(tag));
    });
    return tags.size;
  }, [selectedResources]);

  const statusLabels = React.useMemo(
    () => Object.fromEntries(statusOptions.map((option) => [option.value, option.label])),
    [statusOptions],
  );
  const statusDistribution = React.useMemo(
    () => countDistribution(selectedResources.map((resource) => resource.status)),
    [selectedResources],
  );
  const visibilityDistribution = React.useMemo(
    () => countDistribution(selectedResources.map((resource) => resource.visibility_scope)),
    [selectedResources],
  );
  const managementDistribution = React.useMemo(
    () => countDistribution(selectedResources.map((resource) => resource.management_scope)),
    [selectedResources],
  );
  const namePreviews = React.useMemo(
    () => selectedResources.slice(0, 3).map((resource) => ({
      before: resource.name,
      after: transformName(resource.name, fields.name),
    })),
    [fields.name, selectedResources],
  );

  const updateField = <K extends keyof FieldsState>(
    key: K,
    patch: Partial<FieldsState[K]>,
  ) => {
    setFields((previous) => ({
      ...previous,
      [key]: { ...previous[key], ...patch },
    }));
  };

  const enabledFieldLabels = React.useMemo(() => {
    const labels: string[] = [];
    if (fields.name.enabled) labels.push("名称");
    if (fields.tags.enabled) labels.push("标签");
    if (fields.status.enabled) labels.push("状态");
    if (fields.visibility_scope.enabled) labels.push("可见范围");
    if (fields.management_scope.enabled) labels.push("管理范围");
    return labels;
  }, [fields]);

  const mutation = useMutation({
    mutationFn: async () => {
      const payloadFields: Record<string, unknown> = {};

      if (fields.name.enabled) {
        payloadFields.name = {
          mode: fields.name.mode,
          value: fields.name.value,
          search: fields.name.search,
        };
      }
      if (fields.tags.enabled) {
        payloadFields.tags = { mode: fields.tags.mode, values: fields.tags.values };
      }
      if (fields.status.enabled) payloadFields.status = fields.status.value;
      if (fields.visibility_scope.enabled) {
        payloadFields.visibility_scope = fields.visibility_scope.value;
        payloadFields.visible_user_ids = fields.visibility_scope.value === "partial"
          ? fields.visibility_scope.userIds
          : [];
        payloadFields.visible_user_tags = fields.visibility_scope.value === "partial"
          ? fields.visibility_scope.userTags
          : [];
      }
      if (fields.management_scope.enabled) {
        payloadFields.management_scope = fields.management_scope.value;
        payloadFields.manage_user_ids = fields.management_scope.value === "partial"
          ? fields.management_scope.userIds
          : [];
        payloadFields.manage_user_tags = fields.management_scope.value === "partial"
          ? fields.management_scope.userTags
          : [];
      }

      return api("/api/resources/batch", {
        method: "PUT",
        json: { resource_ids: resourceIds, fields: payloadFields },
      });
    },
    onSuccess: () => {
      toast.success("已更新 " + resourceIds.length + " 项单页素材");
      onSuccess();
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast.error(error.message || "批量编辑失败");
    },
  });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (enabledFieldLabels.length === 0) {
      toast.error("请至少启用一项修改");
      return;
    }
    if (fields.name.enabled) {
      if (fields.name.mode === "replace") {
        if (!fields.name.search.trim()) {
          toast.error("请输入要查找的名称内容");
          return;
        }
      } else if (!fields.name.value.trim()) {
        toast.error(fields.name.mode === "prefix" ? "请输入名称前缀" : "请输入名称后缀");
        return;
      }
    }
    if (fields.tags.enabled && fields.tags.mode !== "replace" && fields.tags.values.length === 0) {
      toast.error(fields.tags.mode === "append" ? "请选择要追加的标签" : "请选择要移除的标签");
      return;
    }
    if (fields.status.enabled && !fields.status.value) {
      toast.error("请选择状态");
      return;
    }
    if (
      fields.visibility_scope.enabled &&
      fields.visibility_scope.value === "partial" &&
      fields.visibility_scope.userIds.length === 0 &&
      fields.visibility_scope.userTags.length === 0
    ) {
      toast.error("可见范围为部分时，请至少选择一位用户或一个用户标签");
      return;
    }
    if (
      fields.management_scope.enabled &&
      fields.management_scope.value === "partial" &&
      fields.management_scope.userIds.length === 0 &&
      fields.management_scope.userTags.length === 0
    ) {
      toast.error("管理范围为部分时，请至少选择一位用户或一个用户标签");
      return;
    }
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>批量编辑单页素材</DialogTitle>
          <DialogDescription>
            已选择 {resourceIds.length} 项。只启用需要统一修改的内容，未启用的字段保持不变。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-0.5 pb-1">
            <EditSection
              id="batch-name"
              title="名称"
              description="按原名称批量添加前后缀，或查找并替换指定内容"
              checked={fields.name.enabled}
              onCheckedChange={(enabled) => updateField("name", { enabled })}
            >
              <ModeSelector
                options={NAME_MODE_OPTIONS}
                value={fields.name.mode}
                onChange={(mode) => updateField("name", { mode })}
              />
              {fields.name.mode === "replace" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="batch-name-search">查找内容</Label>
                    <Input
                      id="batch-name-search"
                      value={fields.name.search}
                      onChange={(event) => updateField("name", { search: event.target.value })}
                      placeholder="例如：旧版"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="batch-name-value">替换为</Label>
                    <Input
                      id="batch-name-value"
                      value={fields.name.value}
                      onChange={(event) => updateField("name", { value: event.target.value })}
                      placeholder="留空表示删除查找内容"
                    />
                  </div>
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <Label htmlFor="batch-name-value">
                    {fields.name.mode === "prefix" ? "名称前缀" : "名称后缀"}
                  </Label>
                  <Input
                    id="batch-name-value"
                    value={fields.name.value}
                    onChange={(event) => updateField("name", { value: event.target.value })}
                    placeholder={fields.name.mode === "prefix" ? "例如：[2026] " : "例如：- 已审核"}
                  />
                </div>
              )}
              {namePreviews.length > 0 && (
                <div className="grid gap-1.5 rounded-md border bg-background p-3 text-xs">
                  <span className="font-medium text-foreground">名称预览</span>
                  {namePreviews.map((item, index) => (
                    <div key={item.before + "-" + index} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
                      <span className="truncate text-muted-foreground" title={item.before}>{item.before}</span>
                      <span className="hidden text-muted-foreground sm:block">→</span>
                      <span className="truncate text-foreground" title={item.after}>{item.after || "（空名称，无效）"}</span>
                    </div>
                  ))}
                </div>
              )}
            </EditSection>

            <EditSection
              id="batch-tags"
              title="分类标签"
              description={currentTagCount ? "当前选中素材共包含 " + currentTagCount + " 种标签" : "覆盖可用于清空全部标签"}
              checked={fields.tags.enabled}
              onCheckedChange={(enabled) => updateField("tags", { enabled })}
            >
              <ModeSelector
                options={TAG_MODE_OPTIONS}
                value={fields.tags.mode}
                onChange={(mode) => updateField("tags", { mode })}
              />
              <TagInput
                value={fields.tags.values}
                onChange={(values) => updateField("tags", { values })}
                placeholder={fields.tags.mode === "remove" ? "选择要移除的标签" : "选择或输入标签"}
              />
              {fields.tags.mode === "replace" && fields.tags.values.length === 0 && (
                <p className="text-xs text-muted-foreground">保持为空将清空所选素材的全部标签。</p>
              )}
            </EditSection>

            <EditSection
              id="batch-status"
              title="状态"
              description={distributionText(statusDistribution, statusLabels) || "统一修改素材状态"}
              checked={fields.status.enabled}
              onCheckedChange={(enabled) => updateField("status", { enabled })}
            >
              <Select value={fields.status.value} onValueChange={(value) => updateField("status", { value })}>
                <SelectTrigger><SelectValue placeholder="请选择状态" /></SelectTrigger>
                <SelectContent>
                  {statusOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </EditSection>

            <EditSection
              id="batch-visibility"
              title="可见范围"
              description={distributionText(visibilityDistribution, SCOPE_LABELS) || "设置谁可以查看这些素材"}
              checked={fields.visibility_scope.enabled}
              onCheckedChange={(enabled) => updateField("visibility_scope", { enabled })}
            >
              <Select
                value={fields.visibility_scope.value}
                onValueChange={(value) => updateField("visibility_scope", {
                  value: value as VisibilityScope,
                  ...(value === "partial" ? {} : { userIds: [], userTags: [] }),
                })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {VISIBILITY_SCOPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fields.visibility_scope.value === "partial" && (
                <div className="grid gap-1.5">
                  <Label className="text-xs text-muted-foreground">可见用户或用户标签（至少选 1 项）</Label>
                  <UserPicker
                    value={fields.visibility_scope.userIds}
                    onChange={(userIds) => updateField("visibility_scope", { userIds })}
                    tagValue={fields.visibility_scope.userTags}
                    onTagChange={(userTags) => updateField("visibility_scope", { userTags })}
                    allowTagSelection
                  />
                </div>
              )}
            </EditSection>

            <EditSection
              id="batch-management"
              title="管理范围"
              description={distributionText(managementDistribution, SCOPE_LABELS) || "设置谁可以维护这些素材"}
              checked={fields.management_scope.enabled}
              onCheckedChange={(enabled) => updateField("management_scope", { enabled })}
            >
              <Select
                value={fields.management_scope.value}
                onValueChange={(value) => updateField("management_scope", {
                  value: value as VisibilityScope,
                  ...(value === "partial" ? {} : { userIds: [], userTags: [] }),
                })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MANAGEMENT_SCOPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fields.management_scope.value === "partial" && (
                <div className="grid gap-1.5">
                  <Label className="text-xs text-muted-foreground">可管理用户或用户标签（至少选 1 项）</Label>
                  <UserPicker
                    value={fields.management_scope.userIds}
                    onChange={(userIds) => updateField("management_scope", { userIds })}
                    tagValue={fields.management_scope.userTags}
                    onTagChange={(userTags) => updateField("management_scope", { userTags })}
                    allowTagSelection
                  />
                </div>
              )}
            </EditSection>
          </div>

          <DialogFooter className="mt-4 border-t pt-3 sm:items-center sm:justify-between">
            <p className="mr-auto text-xs text-muted-foreground">
              {enabledFieldLabels.length > 0
                ? "将修改：" + enabledFieldLabels.join("、")
                : "尚未启用任何修改项"}
            </p>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              取消
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              应用到 {resourceIds.length} 项
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ModeSelector<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={"rounded px-3 py-1.5 text-xs font-medium transition-colors " + (
            value === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function EditSection({
  id,
  title,
  description,
  checked,
  onCheckedChange,
  children,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <section className={"grid gap-3 rounded-lg border p-4 transition-colors " + (checked ? "bg-muted/20" : "bg-background")}>
      <header className="flex items-start gap-3">
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(value) => onCheckedChange(value === true)}
          className="mt-0.5"
        />
        <Label htmlFor={id} className="grid flex-1 cursor-pointer gap-0.5">
          <span className="text-sm font-medium text-foreground">{title}</span>
          <span className="text-xs font-normal text-muted-foreground">{description}</span>
        </Label>
      </header>
      {checked && <div className="grid gap-3 pl-7">{children}</div>}
    </section>
  );
}
