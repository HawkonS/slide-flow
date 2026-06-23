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
  RESOURCE_SECRECY_LABEL,
  RESOURCE_STATUS_LABEL,
} from "@/lib/constants";
import { api } from "@/lib/api";
import { parseTags, Resource, ResourceVersion } from "@/lib/types";

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

function resolveVersion(resource: Resource, versionId: number | null): ResourceVersion {
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
  const preview = version?.original_preview_url || version?.preview_url;
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
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden md:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] md:grid-rows-[auto_minmax(0,1fr)]">
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
                value={RESOURCE_STATUS_LABEL[resource.status] || resource.status}
              />
              <InfoRow
                label="密级"
                value={RESOURCE_SECRECY_LABEL[resource.secrecy_level] || resource.secrecy_level}
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

/** 通用备注：详情页只读展示；编辑入口在「编辑信息」对话框内 */
function CommonRemarkView({ html }: { html: string }) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-md border">
      <header className="flex items-center justify-between border-b bg-muted/40 px-3 py-2 text-sm font-medium">
        <span>通用备注</span>
        <span className="text-xs font-normal text-muted-foreground">所有可见用户可见</span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {html ? (
          <div
            className="prose prose-sm max-w-none text-sm text-foreground"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            暂无通用备注
          </div>
        )}
      </div>
    </section>
  );
}

/** 个人备注：常驻编辑态，富文本编辑器 + 保存按钮；内部高度固定、内容超出滚动 */
function PersonalRemarkEditor({
  resourceId,
  versionId,
  open,
}: {
  resourceId: number;
  versionId: number | null;
  open: boolean;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState("");

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
  }, [serverHtml, resourceId, versionId]);

  const mutation = useMutation({
    mutationFn: async () =>
      api(`/api/resources/${resourceId}/personal-remark`, {
        method: "PUT",
        json: { content_html: draft, version_id: versionId },
      }),
    onSuccess: () => {
      toast.success("个人备注已保存");
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

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-md border">
      <header className="flex items-center justify-between border-b bg-muted/40 px-3 py-2 text-sm font-medium">
        <span className="flex items-center gap-2">
          个人备注
          {dirty && (
            <span className="text-[10px] font-normal text-amber-600">未保存</span>
          )}
        </span>
        <Button
          size="sm"
          variant={dirty ? "default" : "outline"}
          className="h-7 px-2"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || isLoading || !dirty}
        >
          {mutation.isPending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="mr-1 h-3.5 w-3.5" />
          )}
          保存
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {isLoading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
          </div>
        ) : (
          <RichTextEditor
            value={draft}
            onChange={setDraft}
            placeholder="仅自己可见的笔记，支持加粗 / 列表等格式"
            minHeight={120}
            bordered={false}
            className="h-full"
          />
        )}
      </div>
    </section>
  );
}
