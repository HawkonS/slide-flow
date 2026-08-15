import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, ImageIcon } from "lucide-react";
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
import { FilePickerCard } from "@/components/resource/FilePickerCard";
import { RichTextEditor } from "@/components/resource/RichTextEditor";
import {
  DeleteScopeDialog,
  type DeleteScope,
} from "@/components/common/DeleteScopeDialog";
import {
  DEFAULT_RESOURCE_SUBJECT,
  MANAGEMENT_SCOPE_OPTIONS,
  RESOURCE_STATUS_FORM_OPTIONS,
  SECRECY_LEVEL_FORM_OPTIONS,
  VISIBILITY_SCOPE_OPTIONS,
} from "@/lib/constants";
import { api, apiUpload } from "@/lib/api";
import { parseTags, Resource, serializeTags } from "@/lib/types";

export interface ResourceEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 为 null 表示创建模式 */
  resource: Resource | null;
  tagSuggestions: string[];
  subjectSuggestions: string[];
}

type ScopeValue = "public" | "partial" | "private";
type CommonRemarkApplyScope = "latest" | "all";

interface FormState {
  name: string;
  subject: string;
  tagList: string[];
  secrecy_level: "public" | "confidential" | "secret";
  status: "active" | "disabled";
  visibility_scope: ScopeValue;
  management_scope: ScopeValue;
  visible_user_ids: number[];
  manage_user_ids: number[];
  pptFile: File | null;
  pngFile: File | null;
  common_remark_html: string;
  common_remark_apply_scope: CommonRemarkApplyScope;
}

function defaultForm(resource: Resource | null): FormState {
  if (!resource) {
    return {
      name: "",
      subject: DEFAULT_RESOURCE_SUBJECT,
      tagList: [],
      secrecy_level: "public",
      status: "active",
      visibility_scope: "public",
      management_scope: "private",
      visible_user_ids: [],
      manage_user_ids: [],
      pptFile: null,
      pngFile: null,
      common_remark_html: "",
      common_remark_apply_scope: "latest",
    };
  }
  return {
    name: resource.name,
    subject: resource.subject || DEFAULT_RESOURCE_SUBJECT,
    tagList: parseTags(resource.tags),
    secrecy_level: resource.secrecy_level,
    status: resource.status,
    visibility_scope: resource.visibility_scope,
    management_scope: resource.management_scope,
    visible_user_ids: resource.visible_user_ids ?? [],
    manage_user_ids: resource.manage_user_ids ?? [],
    pptFile: null,
    pngFile: null,
    common_remark_html: resource.current?.common_remark_html ?? "",
    common_remark_apply_scope: "latest",
  };
}

export function ResourceEditDialog({
  open,
  onOpenChange,
  resource,
  tagSuggestions,
  subjectSuggestions,
}: ResourceEditDialogProps) {
  const isCreate = resource == null;
  const [form, setForm] = React.useState<FormState>(() => defaultForm(resource));
  const queryClient = useQueryClient();

  React.useEffect(() => {
    if (open) setForm(defaultForm(resource));
  }, [open, resource]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (isCreate) {
        if (!form.pptFile) throw new Error("请上传 PPT 文件");
        if (!form.pngFile) throw new Error("请上传预览图");
        const fd = new FormData();
        fd.append("name", form.name.trim());
        fd.append("subject", form.subject.trim() || DEFAULT_RESOURCE_SUBJECT);
        fd.append("tags", serializeTags(form.tagList));
        fd.append("secrecy_level", form.secrecy_level);
        fd.append("status", form.status);
        fd.append("visibility_scope", form.visibility_scope);
        fd.append("management_scope", form.management_scope);
        if (form.visibility_scope === "partial") {
          fd.append("visible_user_ids", JSON.stringify(form.visible_user_ids));
        }
        if (form.management_scope === "partial") {
          fd.append("manage_user_ids", JSON.stringify(form.manage_user_ids));
        }
        fd.append("resource_type", "asset");
        fd.append("remark_html", form.common_remark_html);
        fd.append("ppt_file", form.pptFile);
        if (form.pngFile) fd.append("png_file", form.pngFile);
        return apiUpload("/api/resources", fd);
      }

      // 编辑：先更新元数据
      await api(`/api/resources/${resource!.id}/metadata`, {
        method: "PUT",
        json: {
          name: form.name.trim(),
          subject: form.subject.trim() || DEFAULT_RESOURCE_SUBJECT,
          tags: serializeTags(form.tagList),
          secrecy_level: form.secrecy_level,
          status: form.status,
          visibility_scope: form.visibility_scope,
          management_scope: form.management_scope,
          visible_user_ids:
            form.visibility_scope === "partial" ? form.visible_user_ids : [],
          manage_user_ids:
            form.management_scope === "partial" ? form.manage_user_ids : [],
        },
      });

      // 通用备注有变动或选中「更新所有版本」时，同步写入
      const originalRemark = resource!.current?.common_remark_html ?? "";
      const remarkChanged = form.common_remark_html !== originalRemark;
      if (remarkChanged || form.common_remark_apply_scope === "all") {
        await api(`/api/resources/${resource!.id}/common-remark`, {
          method: "POST",
          json: {
            content_html: form.common_remark_html,
            apply_scope: form.common_remark_apply_scope,
          },
        });
      }

      return { ok: true };
    },
    onSuccess: () => {
      toast.success(isCreate ? "资源已创建" : "资源信息已更新");
      queryClient.invalidateQueries({ queryKey: ["resources"] });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error(err.message || "提交失败");
    },
  });

  // 删除 / 回退：仅编辑模式下可用，且当前用户具备管理权限
  const deleteMutation = useMutation({
    mutationFn: async (kind: "rollback" | DeleteScope) => {
      if (!resource) throw new Error("资源不存在");
      if (kind === "rollback") {
        return api(`/api/resources/${resource.id}/versions/rollback`, {
          method: "POST",
        });
      }
      if (kind === "latest") {
        return api(`/api/resources/${resource.id}?scope=latest`, {
          method: "DELETE",
        });
      }
      return api(`/api/resources/${resource.id}`, { method: "DELETE" });
    },
    onSuccess: (_data, kind) => {
      toast.success(
        kind === "rollback"
          ? "已回退到上一版本"
          : kind === "latest"
            ? "最新版本已删除"
            : "资源已删除",
      );
      queryClient.invalidateQueries({ queryKey: ["resources"] });
      queryClient.invalidateQueries({ queryKey: ["me", "personal-remarks", "summary"] });
      // 首页置顶卡片与统计也依赖资源数据，删除后需同步失效
      queryClient.invalidateQueries({ queryKey: ["home", "pins"] });
      queryClient.invalidateQueries({ queryKey: ["home", "stats"] });
      setDeleteScopeOpen(false);
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error(err.message || "操作失败");
    },
  });

  const handleRollback = () => {
    if (!resource) return;
    const ok = window.confirm(
      `确定要将「${resource.name}」回退到上一版本吗？当前最新版本 v${resource.current_version} 及其 PPT / 预览图将被永久删除，此操作不可恢复。`,
    );
    if (!ok) return;
    deleteMutation.mutate("rollback");
  };

  const handleDelete = () => {
    if (!resource) return;
    // 多版本资源：弹窗让用户选择删除范围
    if (resource.current_version > 1) {
      setDeleteScopeOpen(true);
      return;
    }
    const ok = window.confirm(
      `确定要彻底删除「${resource.name}」吗？所有文件、备注、访问配置都将被清除，此操作不可恢复。`,
    );
    if (!ok) return;
    deleteMutation.mutate("all");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("请填写资源名称");
      return;
    }
    if (isCreate && !form.pptFile) {
      toast.error("请上传 PPT 文件");
      return;
    }
    if (isCreate && !form.pngFile) {
      toast.error("请上传预览图");
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

  const ownerId = resource?.owner_id;
  const [deleteScopeOpen, setDeleteScopeOpen] = React.useState(false);

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{isCreate ? "资源导入" : "编辑信息"}</DialogTitle>
          <DialogDescription>
            {isCreate
              ? "上传 PPT 与预览图，并补充资源的元数据、访问范围与通用备注"
              : "修改资源的元数据与访问范围"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-0.5 pb-1">
          {/* 创建模式：文件上传放在最上方 */}
          {isCreate && (
            <section className="grid gap-3 rounded-lg border bg-muted/30 p-4">
              <header className="flex items-center justify-between">
                <span className="text-sm font-medium">上传文件</span>
                <span className="text-xs text-muted-foreground">PPT 与预览图均为必填</span>
              </header>
              <div className="grid gap-3 sm:grid-cols-2">
                <FilePickerCard
                  id="res-ppt"
                  label="PPT 文件"
                  accept=".ppt,.pptx"
                  file={form.pptFile}
                  icon={<FileText className="h-4 w-4" />}
                  onChange={(f) => setForm({ ...form, pptFile: f })}
                />
                <FilePickerCard
                  id="res-png"
                  label="PNG 文件"
                  accept="image/png,image/jpeg"
                  file={form.pngFile}
                  icon={<ImageIcon className="h-4 w-4" />}
                  onChange={(f) => setForm({ ...form, pngFile: f })}
                />
              </div>
            </section>
          )}

          {/* 名称 */}
          <div className="grid gap-1.5">
            <Label htmlFor="res-name">资源名称</Label>
            <Input
              id="res-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>

          {/* 主体 + 密级 + 状态 */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="res-subject">主体</Label>
              <Input
                id="res-subject"
                list="res-subject-list"
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
              />
              <datalist id="res-subject-list">
                {subjectSuggestions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>

            <div className="grid gap-1.5">
              <Label>密级</Label>
              <Select
                value={form.secrecy_level}
                onValueChange={(v) =>
                  setForm({ ...form, secrecy_level: v as FormState["secrecy_level"] })
                }
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

            <div className="grid gap-1.5">
              <Label>状态</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm({ ...form, status: v as FormState["status"] })}
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

          {/* 标签 */}
          <div className="grid gap-1.5">
            <Label>标签</Label>
            <TagInput
              value={form.tagList}
              onChange={(list) => setForm({ ...form, tagList: list })}
              suggestions={tagSuggestions}
            />
          </div>

          {/* 可见 / 管理 范围：两列 Select 并排；任一选 partial 时，用户选择器独占一行 */}
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

          {/* 通用备注（富文本）：创建/编辑均可填写；编辑模式可选择应用范围 */}
          <div className="grid gap-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-sm font-medium">通用备注</Label>
              <span className="text-xs text-muted-foreground">所有可见用户可见</span>
            </div>
            <RichTextEditor
              value={form.common_remark_html}
              onChange={(html) => setForm({ ...form, common_remark_html: html })}
              placeholder="对所有可见用户展示的备注，支持加粗 / 列表等格式"
              minHeight={140}
            />
            {!isCreate && (
              <div className="grid gap-1.5 pt-1">
                <Label className="text-xs text-muted-foreground">应用范围</Label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Button
                    type="button"
                    variant={form.common_remark_apply_scope === "latest" ? "default" : "outline"}
                    size="sm"
                    className="justify-start"
                    onClick={() =>
                      setForm({ ...form, common_remark_apply_scope: "latest" })
                    }
                  >
                    仅更新最新版备注
                  </Button>
                  <Button
                    type="button"
                    variant={form.common_remark_apply_scope === "all" ? "default" : "outline"}
                    size="sm"
                    className="justify-start"
                    onClick={() =>
                      setForm({ ...form, common_remark_apply_scope: "all" })
                    }
                  >
                    更新所有历史版本备注
                  </Button>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="sticky bottom-0 -mx-0.5 flex flex-col-reverse gap-3 border-t bg-background pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            {!isCreate && resource?.can_manage ? (
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                  disabled={
                    resource.current_version <= 1 || deleteMutation.isPending
                  }
                  title={
                    resource.current_version <= 1
                      ? "仅剩 1 个版本，无法回退；如需清空请使用删除资源"
                      : undefined
                  }
                  onClick={handleRollback}
                >
                  回退上一版
                </Button>
                <span className="text-muted-foreground/40">·</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={deleteMutation.isPending}
                  onClick={handleDelete}
                >
                  删除资源
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

    {resource && (
      <DeleteScopeDialog
        open={deleteScopeOpen}
        onOpenChange={setDeleteScopeOpen}
        entityLabel="资源"
        name={resource.name}
        versionCount={resource.current_version}
        latestVersionNo={resource.current_version}
        loading={deleteMutation.isPending}
        onDelete={(scope) => deleteMutation.mutate(scope)}
      />
    )}
    </>
  );
}
