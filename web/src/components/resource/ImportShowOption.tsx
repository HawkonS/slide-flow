import * as React from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MetadataTagSelect } from "@/components/resource/MetadataTagSelect";
import { TagInput } from "@/components/resource/TagInput";
import { UserPicker } from "@/components/resource/UserPicker";
import { MANAGEMENT_SCOPE_OPTIONS, VISIBILITY_SCOPE_OPTIONS } from "@/lib/constants";

export type ShowScope = "public" | "partial" | "private" | "";

export interface ShowDraft {
  name: string;
  subject: string;
  status: string;
  tagList: string[];
  visibilityScope: ShowScope;
  managementScope: ShowScope;
  visibleUserIds: number[];
  visibleUserTags: string[];
  manageUserIds: number[];
  manageUserTags: string[];
}

export const EMPTY_SHOW_DRAFT: ShowDraft = {
  name: "",
  subject: "",
  status: "",
  tagList: [],
  visibilityScope: "",
  managementScope: "",
  visibleUserIds: [],
  visibleUserTags: [],
  manageUserIds: [],
  manageUserTags: [],
};

export interface ImportShowOptionProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  draft: ShowDraft;
  onDraftChange: (draft: ShowDraft) => void;
  disabled?: boolean;
  ownerId?: number;
  error?: string | null;
}

/** 确认导入步骤的可选项：按导入顺序把这批页面组合成一个放映素材。
 *  字段默认带入第一步填写的信息，用户可单独修改；放映权限不会改变素材自身权限。 */
export function ImportShowOption({
  enabled,
  onEnabledChange,
  draft,
  onDraftChange,
  disabled,
  ownerId,
  error,
}: ImportShowOptionProps) {
  const patch = (values: Partial<ShowDraft>) => onDraftChange({ ...draft, ...values });
  return (
    <div className="rounded-md border bg-muted/30 p-4">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
        />
        <span>
          <span className="font-medium">同时创建放映素材</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            把这批页面按顺序加入一个新放映；以下信息已按第一步带入，可单独修改。放映的可见范围不会扩大素材本身的可见范围。
          </span>
        </span>
      </label>
      {enabled && (
        <div className="mt-4 grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="import-show-name">放映名称 <span className="text-destructive">*</span></Label>
              <Input
                id="import-show-name"
                maxLength={200}
                value={draft.name}
                disabled={disabled}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder="如：产品发布会放映"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="import-show-subject">主体</Label>
              <MetadataTagSelect
                id="import-show-subject"
                domain="subject"
                value={draft.subject}
                disabled={disabled}
                onChange={(value) => patch({ subject: value })}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="import-show-status">状态</Label>
              <MetadataTagSelect
                id="import-show-status"
                domain="status"
                value={draft.status}
                disabled={disabled}
                onChange={(value) => patch({ status: value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>分类标签</Label>
              <TagInput
                value={draft.tagList}
                onChange={(value) => patch({ tagList: value })}
                suggestions={[]}
                disabled={disabled}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="import-show-visibility">可见范围 <span className="text-destructive">*</span></Label>
              <Select
                value={draft.visibilityScope}
                disabled={disabled}
                onValueChange={(value) => patch({ visibilityScope: value as ShowScope })}
              >
                <SelectTrigger id="import-show-visibility"><SelectValue placeholder="请选择可见范围" /></SelectTrigger>
                <SelectContent>
                  {VISIBILITY_SCOPE_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="import-show-management">管理范围 <span className="text-destructive">*</span></Label>
              <Select
                value={draft.managementScope}
                disabled={disabled}
                onValueChange={(value) => patch({ managementScope: value as ShowScope })}
              >
                <SelectTrigger id="import-show-management"><SelectValue placeholder="请选择管理范围" /></SelectTrigger>
                <SelectContent>
                  {MANAGEMENT_SCOPE_OPTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {draft.visibilityScope === "partial" && (
            <div className="space-y-2">
              <Label>放映可见用户或用户标签（至少选 1 项）</Label>
              <UserPicker
                value={draft.visibleUserIds}
                onChange={(value) => patch({ visibleUserIds: value })}
                tagValue={draft.visibleUserTags}
                onTagChange={(value) => patch({ visibleUserTags: value })}
                allowTagSelection
                lockedIds={ownerId ? [ownerId] : undefined}
              />
            </div>
          )}
          {draft.managementScope === "partial" && (
            <div className="space-y-2">
              <Label>放映管理用户或用户标签（至少选 1 项）</Label>
              <UserPicker
                value={draft.manageUserIds}
                onChange={(value) => patch({ manageUserIds: value })}
                tagValue={draft.manageUserTags}
                onTagChange={(value) => patch({ manageUserTags: value })}
                allowTagSelection
                lockedIds={ownerId ? [ownerId] : undefined}
              />
            </div>
          )}
          {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
        </div>
      )}
    </div>
  );
}
