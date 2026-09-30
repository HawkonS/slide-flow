import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Maximize, Pencil, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RichTextEditor } from "@/components/resource/RichTextEditor";
import {
  DEFAULT_RESOURCE_SUBJECT,
  RESOURCE_SCOPE_LABEL,
} from "@/lib/constants";
import { api } from "@/lib/api";
import { parseTags, Resource, ResourceVersion } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ResourceDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: Resource | null;
  onEdit?: (resource: Resource) => void;
  onNewVersion?: (resource: Resource) => void;
  onDownload?: (resource: Resource, version: ResourceVersion) => void;
  onFullscreen?: (resource: Resource) => void;
}

interface PersonalRemarkResponse {
  content_html: string;
  version_id: number;
}

export function resolveVersion(resource: Resource, versionId: number | null): ResourceVersion {
  if (!versionId) return resource.current;
  return resource.versions?.find((v) => v.id === versionId) ?? resource.current;
}

export function ResourceDetailDialog({
  open,
  onOpenChange,
  resource,
  onEdit,
  onNewVersion,
  onDownload,
  onFullscreen,
}: ResourceDetailDialogProps) {
  const [selectedVersionId, setSelectedVersionId] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (open && resource) {
      setSelectedVersionId(resource.current?.id ?? null);
    }
  }, [open, resource]);

  if (!resource) return null;
  const version = resolveVersion(resource, selectedVersionId);
  const preview = version?.preview_url;
  const tags = parseTags(resource.tags);
  const hasMultipleVersions = (resource.versions?.length ?? 0) > 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-5xl flex-col overflow-hidden gap-4">
        <DialogHeader className="pr-10">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-lg">
            <span className="truncate">{resource.name}</span>
            {tags.length > 0 && (
              <span className="flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="font-normal">
                    {tag}
                  </Badge>
                ))}
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">资源详情</DialogDescription>
        </DialogHeader>

        {/* 2 行 2 列：左上信息卡片 / 右上通用备注；左下预览 / 右下个人备注 */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto md:overflow-hidden md:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] md:grid-rows-[auto_minmax(0,1fr)]">
          {/* 左上：信息卡片 */}
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <InfoRow label="主体" value={resource.subject || DEFAULT_RESOURCE_SUBJECT} />
              <InfoRow
                label="所有者"
                value={resource.owner?.name || resource.owner?.username || "-"}
              />
              <InfoRow
                label="最终修改"
                value={resource.updated_by?.name || resource.updated_by?.username || "-"}
              />
              <InfoRow
                label="状态"
                value={resource.status}
              />
              <InfoRow
                label="可见范围"
                value={RESOURCE_SCOPE_LABEL[resource.visibility_scope] || resource.visibility_scope}
              />
              <InfoRow
                label="管理范围"
                value={RESOURCE_SCOPE_LABEL[resource.management_scope] || resource.management_scope}
              />
              {version?.created_at && (
                <InfoRow
                  label="版本创建"
                  value={new Date(version.created_at).toLocaleString("zh-CN")}
                />
              )}
              {version?.change_note && (
                <InfoRow label="版本说明" value={version.change_note} />
              )}
            </div>
          </div>

          {/* 右上：通用备注（与左上信息卡片对齐；只读展示） */}
          <CommonRemarkView html={version?.common_remark_html || ""} />

          {/* 左下：版本切换 + PPT 预览图 */}
          <div className="flex min-h-0 flex-col gap-2 overflow-hidden">
            <Select
              value={String(selectedVersionId ?? "")}
              onValueChange={(v) => setSelectedVersionId(Number(v))}
              disabled={!hasMultipleVersions}
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue placeholder={`v${version?.version_no ?? ""}`} />
              </SelectTrigger>
              <SelectContent>
                {(resource.versions?.length ? resource.versions : [version]).map((v) =>
                  v ? (
                    <SelectItem key={v.id} value={String(v.id)}>
                      v{v.version_no}
                      {resource.current && v.id === resource.current.id ? "（当前）" : ""}
                      {v.change_note ? ` · ${v.change_note}` : ""}
                    </SelectItem>
                  ) : null,
                )}
              </SelectContent>
            </Select>
            <div className="relative aspect-[16/9] w-full overflow-hidden rounded-lg border bg-muted">
              {preview ? (
                <img
                  src={preview}
                  alt={resource.name}
                  className="absolute inset-0 h-full w-full object-contain"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  无预览
                </div>
              )}
            </div>
          </div>

          {/* 右下：个人备注（与左下预览对齐） */}
          <PersonalRemarkEditor
            resourceId={resource.id}
            versionId={version?.id ?? null}
            open={open}
          />
        </div>

        <DialogFooter className="border-t pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          {onFullscreen && (
            <Button variant="outline" onClick={() => onFullscreen(resource)}>
              <Maximize className="mr-1 h-4 w-4" />
              放大查看
            </Button>
          )}
          {resource.can_manage && onEdit && (
            <Button variant="outline" onClick={() => onEdit(resource)}>
              <Pencil className="mr-1 h-4 w-4" />
              编辑信息
            </Button>
          )}
          {resource.can_manage && onNewVersion && (
            <Button variant="outline" onClick={() => onNewVersion(resource)}>
              <RefreshCw className="mr-1 h-4 w-4" />
              版本迭代
            </Button>
          )}
          {onDownload && version && (
            <Button onClick={() => onDownload(resource, version)}>
              <Download className="mr-1 h-4 w-4" />
              下载
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 max-w-[70%] truncate text-right font-medium">{value}</span>
    </div>
  );
}

/** 通用备注：默认只读查看；有管理权限时可切换到编辑模式 */
export function CommonRemarkView({
  html,
  className,
  resourceId,
  versionId,
  canManage = false,
}: {
  html: string;
  className?: string;
  resourceId?: number;
  versionId?: number | null;
  canManage?: boolean;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = React.useState<"view" | "edit">("view");
  const [draft, setDraft] = React.useState(html);
  const [applyScope, setApplyScope] = React.useState<"selected" | "all">("selected");
  const hasRemark = remarkHasContent(html);
  const dirty = draft !== html;

  React.useEffect(() => {
    setDraft(html);
    setMode("view");
  }, [html, resourceId, versionId]);

  const save = useMutation({
    mutationFn: async () => {
      if (!resourceId || versionId == null) throw new Error("请选择要编辑的版本");
      return api(`/api/resources/${resourceId}/common-remark`, {
        method: "POST",
        json: { content_html: draft, apply_scope: applyScope, version_id: versionId },
      });
    },
    onSuccess: () => {
      toast.success("通用备注已保存");
      setMode("view");
      void queryClient.invalidateQueries({ queryKey: ["resource-detail"] });
      void queryClient.invalidateQueries({ queryKey: ["resource", resourceId] });
      void queryClient.invalidateQueries({ queryKey: ["resources"] });
    },
    onError: (error: Error) => toast.error(error.message || "保存失败"),
  });

  return (
    <section className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg border", className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2 pr-14">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span>通用备注</span>
          <RemarkStatus hasRemark={hasRemark} />
          <span className="hidden text-xs font-normal text-muted-foreground sm:inline">所有可见用户可见</span>
          {mode === "edit" && dirty && <span className="text-[10px] font-normal text-amber-600">未保存</span>}
        </div>
        <RemarkModeSwitch
          mode={mode}
          dirty={dirty}
          canEdit={canManage}
          onView={() => setMode("view")}
          onEdit={() => { setDraft(html); setApplyScope("selected"); setMode("edit"); }}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === "edit" ? (
          <div className="flex h-full min-h-[160px] flex-col">
            <div className="min-h-0 flex-1">
              <RichTextEditor
                value={draft}
                onChange={setDraft}
                placeholder="所有可见用户都能查看的备注，支持加粗 / 列表等格式"
                minHeight={120}
                bordered={false}
                className="h-full"
              />
            </div>
            <RemarkEditorFooter
              dirty={dirty}
              pending={save.isPending}
              onCancel={() => { setDraft(html); setMode("view"); }}
              onSave={() => save.mutate()}
              saveDisabled={!resourceId || versionId == null}
              leading={<div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>应用到</span>
                <Select value={applyScope} onValueChange={(value: "selected" | "all") => setApplyScope(value)}>
                  <SelectTrigger className="h-7 w-[132px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="selected">当前版本</SelectItem>
                    <SelectItem value="all">所有版本</SelectItem>
                  </SelectContent>
                </Select>
              </div>}
            />
          </div>
        ) : hasRemark ? (
          <div className="h-full overflow-auto px-3 py-2">
            <div className="prose prose-sm max-w-none text-sm text-foreground" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        ) : (
          <div className="flex h-full min-h-24 items-center justify-center text-sm text-muted-foreground">
            暂无通用备注
          </div>
        )}
      </div>
    </section>
  );
}

/** 个人备注：默认只读查看，按需切换到富文本编辑状态 */
export function PersonalRemarkEditor({
  resourceId,
  versionId,
  open,
  className,
}: {
  resourceId: number;
  versionId: number | null;
  open: boolean;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState("");
  const [mode, setMode] = React.useState<"view" | "edit">("view");

  const { data, isLoading } = useQuery({
    queryKey: ["resource", resourceId, "personal-remark", versionId],
    queryFn: async () =>
      api<PersonalRemarkResponse>(
        `/api/resources/${resourceId}/personal-remark`,
        versionId ? { params: { version_id: versionId } } : undefined,
      ),
    enabled: open && versionId != null,
    staleTime: 30_000,
  });

  const serverHtml = data?.content_html || "";

  // 服务端内容返回 / 资源或版本切换时，重置草稿
  React.useEffect(() => {
    setDraft(serverHtml);
    setMode("view");
  }, [serverHtml, resourceId, versionId]);

  const mutation = useMutation({
    mutationFn: async () =>
      api(`/api/resources/${resourceId}/personal-remark`, {
        method: "PUT",
        json: { content_html: draft, version_id: versionId },
      }),
    onSuccess: () => {
      toast.success("个人备注已保存");
      setMode("view");
      queryClient.invalidateQueries({
        queryKey: ["resource", resourceId, "personal-remark", versionId],
      });
      // 刷新个人备注摘要（筛选用）
      queryClient.invalidateQueries({
        queryKey: ["me", "personal-remarks", "summary"],
      });
      // 刷新资源列表（has_personal_remark 字段）
      queryClient.invalidateQueries({
        queryKey: ["resources", "asset"],
      });
    },
    onError: (err: Error) => toast.error(err.message || "保存失败"),
  });

  const dirty = draft !== serverHtml;
  const hasRemark = remarkHasContent(serverHtml);

  return (
    <section className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg border", className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2 pr-14">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span>个人备注</span>
          <RemarkStatus hasRemark={hasRemark} pending={isLoading} />
          <span className="hidden text-xs font-normal text-muted-foreground sm:inline">仅自己可见</span>
          {mode === "edit" && dirty && <span className="text-[10px] font-normal text-amber-600">未保存</span>}
        </div>
        <RemarkModeSwitch
          mode={mode}
          dirty={dirty}
          canEdit
          editDisabled={isLoading || versionId == null}
          onView={() => setMode("view")}
          onEdit={() => { setDraft(serverHtml); setMode("edit"); }}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {isLoading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
          </div>
        ) : mode === "edit" ? (
          <div className="flex h-full min-h-[160px] flex-col">
            <div className="min-h-0 flex-1">
              <RichTextEditor
                value={draft}
                onChange={setDraft}
                placeholder="仅自己可见的笔记，支持加粗 / 列表等格式"
                minHeight={120}
                bordered={false}
                className="h-full"
              />
            </div>
            <RemarkEditorFooter
              dirty={dirty}
              pending={mutation.isPending}
              onCancel={() => { setDraft(serverHtml); setMode("view"); }}
              onSave={() => mutation.mutate()}
            />
          </div>
        ) : hasRemark ? (
          <div className="h-full overflow-auto px-3 py-2">
            <div className="prose prose-sm max-w-none text-sm text-foreground" dangerouslySetInnerHTML={{ __html: serverHtml }} />
          </div>
        ) : (
          <div className="flex h-full min-h-24 items-center justify-center text-sm text-muted-foreground">暂无个人备注</div>
        )}
      </div>
    </section>
  );
}

function remarkHasContent(html: string) {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;|&#xA0;|\s/gi, "").length > 0;
}

function RemarkModeSwitch({
  mode,
  dirty,
  canEdit,
  editDisabled = false,
  onView,
  onEdit,
}: {
  mode: "view" | "edit";
  dirty: boolean;
  canEdit: boolean;
  editDisabled?: boolean;
  onView: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant={mode === "view" ? "secondary" : "ghost"}
        className="h-7 px-2 text-xs"
        onClick={onView}
        disabled={mode === "edit" && dirty}
      >
        查看
      </Button>
      {canEdit && (
        <Button
          size="sm"
          variant={mode === "edit" ? "secondary" : "ghost"}
          className="h-7 gap-1 px-2 text-xs"
          onClick={onEdit}
          disabled={editDisabled || mode === "edit"}
        >
          <Pencil className="h-3 w-3" />编辑
        </Button>
      )}
    </div>
  );
}

function RemarkEditorFooter({
  dirty,
  pending,
  onCancel,
  onSave,
  saveDisabled = false,
  leading,
}: {
  dirty: boolean;
  pending: boolean;
  onCancel: () => void;
  onSave: () => void;
  saveDisabled?: boolean;
  leading?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-2">
      {leading}
      <div className="ml-auto flex items-center gap-1.5">
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onCancel}>取消</Button>
        <Button
          size="sm"
          variant={dirty ? "default" : "outline"}
          className="h-7 gap-1 px-2.5 text-xs"
          onClick={onSave}
          disabled={pending || !dirty || saveDisabled}
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          保存
        </Button>
      </div>
    </div>
  );
}

function RemarkStatus({ hasRemark, pending = false }: { hasRemark: boolean; pending?: boolean }) {
  if (pending) {
    return <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">加载中</span>;
  }
  return (
    <span className={cn(
      "rounded-full px-2 py-0.5 text-[10px] font-medium",
      hasRemark ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
    )}>
      {hasRemark ? "有备注" : "无备注"}
    </span>
  );
}
