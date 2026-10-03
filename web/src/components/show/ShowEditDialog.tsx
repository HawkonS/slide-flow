import * as React from "react";
import { usePublicConfig } from "@/lib/tag-defaults";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TagInput } from "@/components/resource/TagInput";
import { UserPicker } from "@/components/resource/UserPicker";
import { MetadataTagSelect, useMetadataTagOptions } from "@/components/resource/MetadataTagSelect";
import { ResourcePicker } from "@/components/show/ResourcePicker";
import {
  DeleteScopeDialog,
  type DeleteScope,
} from "@/components/common/DeleteScopeDialog";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import {
  MANAGEMENT_SCOPE_OPTIONS,
  VISIBILITY_SCOPE_OPTIONS,
} from "@/lib/constants";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Show, parseTags, serializeTags, ShowResourceAccessible } from "@/lib/types";

export interface ShowEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 为 null 表示创建模式 */
  show: Show | null;
  tagSuggestions: string[];
  subjectSuggestions: string[];
}

type ScopeValue = "public" | "partial" | "private";

interface FormState {
  name: string;
  subject: string;
  tagList: string[];
  status: string;
  visibility_scope: ScopeValue;
  management_scope: ScopeValue;
  visible_user_ids: number[];
  visible_user_tags: string[];
  manage_user_ids: number[];
  manage_user_tags: string[];
  resource_ids: number[];
}

function defaultForm(show: Show | null): FormState {
  if (!show) {
    return {
      name: "",
      subject: "",
      tagList: [],
      status: "",
      visibility_scope: "public",
      management_scope: "private",
      visible_user_ids: [],
      visible_user_tags: [],
      manage_user_ids: [],
      manage_user_tags: [],
      resource_ids: [],
    };
  }
  return {
    name: show.name,
    subject: show.subject || "",
    tagList: parseTags(show.tags),
    status: show.status as FormState["status"],
    visibility_scope: show.visibility_scope,
    management_scope: show.management_scope,
    visible_user_ids: show.visible_user_ids ?? [],
    visible_user_tags: show.visible_user_tags ?? [],
    manage_user_ids: show.manage_user_ids ?? [],
    manage_user_tags: show.manage_user_tags ?? [],
    resource_ids: show.resources
      .filter((r): r is ShowResourceAccessible => r.accessible === true)
      .map((r) => r.id),
  };
}

export function ShowEditDialog({
  open,
  onOpenChange,
  show,
  tagSuggestions,
  subjectSuggestions,
}: ShowEditDialogProps) {
  const isCreate = show == null;
  const [form, setForm] = React.useState<FormState>(() => defaultForm(show));
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false);
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { options: statusOptions } = useMetadataTagOptions("status");
  const config = usePublicConfig();
  const defaultsInitialized = React.useRef(false);
  const formTouched = React.useRef(false);

  React.useEffect(() => {
    if (open) {
      setForm(defaultForm(show));
      defaultsInitialized.current = false;
      formTouched.current = false;
    }
  }, [open, show]);

  React.useEffect(() => {
    if (!open || !isCreate || config.isPending || config.isFetching || defaultsInitialized.current) return;
    defaultsInitialized.current = true;
    if (formTouched.current) return;
    const defaults = config.data?.tag_defaults?.show_create;
    setForm((current) => ({ ...current, subject: defaults?.subject || "", status: defaults?.status || "", tagList: defaults?.resource_tags ?? [] }));
  }, [open, show, isCreate, config.isPending, config.isFetching, config.data]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (isCreate) {
        return api("/api/shows", {
          method: "POST",
          json: {
            name: form.name.trim(),
            subject: form.subject.trim(),
            tags: serializeTags(form.tagList),
            status: form.status,
            visibility_scope: form.visibility_scope,
            management_scope: form.management_scope,
            visible_user_ids:
              form.visibility_scope === "partial" ? form.visible_user_ids : [],
            visible_user_tags:
              form.visibility_scope === "partial" ? form.visible_user_tags : [],
            manage_user_ids:
              form.management_scope === "partial" ? form.manage_user_ids : [],
            manage_user_tags:
              form.management_scope === "partial" ? form.manage_user_tags : [],
            resource_ids: form.resource_ids,
          },
        });
      }

      // 编辑：仅更新元数据
      await api(`/api/shows/${show!.id}`, {
        method: "PUT",
        json: {
          name: form.name.trim(),
          subject: form.subject.trim(),
          tags: serializeTags(form.tagList),
          status: form.status,
          visibility_scope: form.visibility_scope,
          management_scope: form.management_scope,
          visible_user_ids:
            form.visibility_scope === "partial" ? form.visible_user_ids : [],
          visible_user_tags:
            form.visibility_scope === "partial" ? form.visible_user_tags : [],
          manage_user_ids:
            form.management_scope === "partial" ? form.manage_user_ids : [],
          manage_user_tags:
            form.management_scope === "partial" ? form.manage_user_tags : [],
        },
      });

      return { ok: true };
    },
    onSuccess: () => {
      toast.success(isCreate ? "放映已创建" : "放映已更新");
      queryClient.invalidateQueries({ queryKey: ["shows"] });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error(err.message || "提交失败");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (scope: DeleteScope) => {
      if (!show) throw new Error("放映不存在");
      return api(`/api/shows/${show.id}?scope=${scope}`, { method: "DELETE" });
    },
    onSuccess: (_data, scope) => {
      toast.success(scope === "all" ? "放映及全部版本已删除" : "放映已删除");
      queryClient.invalidateQueries({ queryKey: ["shows"] });
      // 首页置顶卡片与统计也依赖放映数据，删除后需同步失效
      queryClient.invalidateQueries({ queryKey: ["home", "pins"] });
      queryClient.invalidateQueries({ queryKey: ["home", "stats"] });
      setDeleteScopeOpen(false);
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error(err.message || "删除失败");
    },
  });

  const handleDelete = () => {
    if (!show) return;
    // 多版本放映：弹窗让用户选择删除范围
    if (show.has_other_versions) {
      setDeleteScopeOpen(true);
      return;
    }
    setDeleteConfirmOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("请填写放映名称");
      return;
    }
    if (
      form.visibility_scope === "partial" &&
      form.visible_user_ids.length === 0 &&
      form.visible_user_tags.length === 0
    ) {
      toast.error("可见范围为部分时请至少选择一位用户或一个用户标签");
      return;
    }
    if (
      form.management_scope === "partial" &&
      form.manage_user_ids.length === 0 &&
      form.manage_user_tags.length === 0
    ) {
      toast.error("管理范围为部分时请至少选择一位用户或一个用户标签");
      return;
    }
    mutation.mutate();
  };

  const ownerId = show?.owner_id ?? user?.id;
  const [deleteScopeOpen, setDeleteScopeOpen] = React.useState(false);

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-6xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {isCreate ? "创建放映" : "编辑信息"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {isCreate
              ? "创建新的放映，选择要包含的资源并配置元数据与访问范围"
              : "修改放映的元数据与访问范围"}
          </DialogDescription>
        </DialogHeader>

        <form
          id="show-edit-form"
          onChangeCapture={() => { formTouched.current = true; }}
          onPointerDownCapture={() => { formTouched.current = true; }}
          onKeyDownCapture={() => { formTouched.current = true; }}
          onSubmit={handleSubmit}
          className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-0.5 pb-1"
        >
          {/* 名称 */}
          <div className="grid gap-1.5">
            <Label htmlFor="show-name">放映名称</Label>
            <Input
              id="show-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>

          {/* 主体 + 状态 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="show-subject">主体</Label>
              <MetadataTagSelect
                domain="subject"
                id="show-subject"
                value={form.subject}
                onChange={(value) => setForm({ ...form, subject: value })}
              />
            </div>

            <div className="grid gap-1.5">
              <Label>状态</Label>
              <Select
                value={form.status}
                onValueChange={(v) =>
                  setForm({ ...form, status: v as FormState["status"] })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* 标签 */}
          <div className="grid gap-1.5">
            <Label>标签</Label>
            <TagInput
              value={form.tagList}
              onChange={(list) => setForm({ ...form, tagList: list })}
              suggestions={tagSuggestions}
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
              <Label className="text-xs text-muted-foreground">
                可见用户或用户标签（必选至少 1 项）
              </Label>
              <UserPicker
                value={form.visible_user_ids}
                onChange={(ids) => setForm({ ...form, visible_user_ids: ids })}
                tagValue={form.visible_user_tags}
                onTagChange={(tags) => setForm({ ...form, visible_user_tags: tags })}
                allowTagSelection
                lockedIds={ownerId ? [ownerId] : undefined}
              />
            </div>
          )}
          {form.management_scope === "partial" && (
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">
                可管理用户或用户标签（必选至少 1 项）
              </Label>
              <UserPicker
                value={form.manage_user_ids}
                onChange={(ids) => setForm({ ...form, manage_user_ids: ids })}
                tagValue={form.manage_user_tags}
                onTagChange={(tags) => setForm({ ...form, manage_user_tags: tags })}
                allowTagSelection
                lockedIds={ownerId ? [ownerId] : undefined}
              />
            </div>
          )}

          {/* 选择资源（仅创建模式） */}
          {isCreate && (
            <div className="grid gap-1.5">
              <Label>选择资源</Label>
              {/* 固定高度容器：让 ResourcePicker 内部独立滚动，chips/分页栏始终可见 */}
              <div className="h-[52vh] min-h-[420px] overflow-hidden">
                <ResourcePicker
                  value={form.resource_ids}
                  onChange={(ids) => setForm({ ...form, resource_ids: ids })}
                  className="h-full"
                />
              </div>
            </div>
          )}
        </form>

        {/* Footer 作为 Dialog 直接子项，贴底不滚动；dialog 在此下边紧贴结束 */}
        <DialogFooter className="flex shrink-0 flex-col-reverse gap-3 border-t bg-background px-0.5 pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          {!isCreate && show?.can_manage ? (
            <div className="flex flex-wrap items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={deleteMutation.isPending}
                onClick={handleDelete}
              >
                删除放映
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
              form="show-edit-form"
              disabled={mutation.isPending || deleteMutation.isPending}
            >
              {mutation.isPending ? "提交中…" : isCreate ? "创建" : "保存"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {show && (
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="删除放映"
        description={`确定要删除放映「${show.name}」吗？此操作不可恢复。`}
        confirmLabel="删除放映"
        destructive
        loading={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate("latest", { onSuccess: () => setDeleteConfirmOpen(false) });
        }}
      />
    )}

    {show && (
      <DeleteScopeDialog
        open={deleteScopeOpen}
        onOpenChange={setDeleteScopeOpen}
        entityLabel="放映"
        name={show.name}
        versionCount={show.version_count ?? show.version_no}
        latestVersionNo={show.latest_version_no ?? show.version_no}
        loading={deleteMutation.isPending}
        onDelete={(scope) => deleteMutation.mutate(scope)}
      />
    )}
    </>
  );
}
