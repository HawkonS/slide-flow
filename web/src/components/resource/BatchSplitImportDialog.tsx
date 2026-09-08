import * as React from "react";
import { FileText, FileUp, ImageIcon, Loader2 } from "lucide-react";
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
import { RichTextEditor } from "@/components/resource/RichTextEditor";
import {
  DEFAULT_RESOURCE_SUBJECT,
  MANAGEMENT_SCOPE_OPTIONS,
  RESOURCE_STATUS_FORM_OPTIONS,
  SECRECY_LEVEL_FORM_OPTIONS,
  VISIBILITY_SCOPE_OPTIONS,
} from "@/lib/constants";

import { serializeTags } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface BatchSplitImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type ScopeValue = "public" | "partial" | "private";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function isImageFile(file: File): boolean {
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/** 文件夹/多图片选择卡片 */
function ImageFolderPicker({
  files,
  onChange,
  className,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer flex-col gap-1 rounded-md border border-dashed bg-background px-3 py-2.5 text-sm transition hover:border-primary hover:bg-primary/5",
        className,
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ImageIcon className="h-4 w-4" />
        图片文件夹
      </span>
      <span
        className={
          files.length > 0
            ? "truncate font-medium text-foreground"
            : "text-xs text-muted-foreground"
        }
      >
        {files.length > 0 ? `已选择 ${files.length} 张图片` : "点击选择文件夹或图片"}
      </span>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        // @ts-expect-error webkitdirectory / directory 为非标准属性，但浏览器支持良好
        webkitdirectory="true"
        directory="true"
        multiple
        className="hidden"
        onChange={(e) => {
          const selected = Array.from(e.target.files ?? []);
          const images = selected.filter(isImageFile);
          const sorted = images.sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true }),
          );
          onChange(sorted);
          // 重置 input 值，允许重复选择同一文件夹
          e.target.value = "";
        }}
      />
    </label>
  );
}

export function BatchSplitImportDialog({
  open,
  onOpenChange,
  onSuccess,
}: BatchSplitImportDialogProps) {
  const [pptFile, setPptFile] = React.useState<File | null>(null);
  const [images, setImages] = React.useState<File[]>([]);
  const [namePrefix, setNamePrefix] = React.useState("");
  const [subject, setSubject] = React.useState(DEFAULT_RESOURCE_SUBJECT);
  const [secrecyLevel, setSecrecyLevel] = React.useState<"public" | "confidential" | "secret">("public");
  const [status, setStatus] = React.useState<"active" | "disabled">("active");
  const [tagList, setTagList] = React.useState<string[]>([]);
  const [visibilityScope, setVisibilityScope] = React.useState<ScopeValue>("public");
  const [managementScope, setManagementScope] = React.useState<ScopeValue>("private");
  const [visibleUserIds, setVisibleUserIds] = React.useState<number[]>([]);
  const [manageUserIds, setManageUserIds] = React.useState<number[]>([]);
  const [remarkHtml, setRemarkHtml] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState<number>(0);
  const [uploading, setUploading] = React.useState(false);
  const xhrRef = React.useRef<XMLHttpRequest | null>(null);

  // 对话框关闭/打开时重置状态
  React.useEffect(() => {
    if (open) {
      setPptFile(null);
      setImages([]);
      setNamePrefix("");
      setSubject(DEFAULT_RESOURCE_SUBJECT);
      setSecrecyLevel("public");
      setStatus("active");
      setTagList([]);
      setVisibilityScope("public");
      setManagementScope("private");
      setVisibleUserIds([]);
      setManageUserIds([]);
      setRemarkHtml("");
      setSubmitting(false);
      setUploadProgress(0);
      setUploading(false);
    } else {
      // 对话框关闭时，如果正在上传则取消
      if (xhrRef.current) {
        xhrRef.current.abort();
        xhrRef.current = null;
      }
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!pptFile) {
      toast.error("请上传 PPT 文件");
      return;
    }
    if (images.length === 0) {
      toast.error("请至少选择 1 张图片");
      return;
    }
    if (!namePrefix.trim()) {
      toast.error("请填写名称前缀");
      return;
    }
    if (visibilityScope === "partial" && visibleUserIds.length === 0) {
      toast.error("可见范围为部分时请至少选择一位用户");
      return;
    }
    if (managementScope === "partial" && manageUserIds.length === 0) {
      toast.error("管理范围为部分时请至少选择一位用户");
      return;
    }

    setSubmitting(true);
    setUploading(true);
    setUploadProgress(0);

    const fd = new FormData();
    fd.append("ppt_file", pptFile);
    fd.append("name_prefix", namePrefix.trim());
    fd.append("subject", subject.trim() || DEFAULT_RESOURCE_SUBJECT);
    fd.append("secrecy_level", secrecyLevel);
    fd.append("tags", serializeTags(tagList));
    fd.append("visibility_scope", visibilityScope);
    fd.append("management_scope", managementScope);
    if (visibilityScope === "partial") {
      fd.append("visible_user_ids", JSON.stringify(visibleUserIds));
    }
    if (managementScope === "partial") {
      fd.append("manage_user_ids", JSON.stringify(manageUserIds));
    }
    fd.append("remark_html", remarkHtml);
    for (const img of images) {
      fd.append("images", img);
    }

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", "/api/tasks/split-import");
    xhr.withCredentials = true;
    xhr.responseType = "text";
    xhr.timeout = 20 * 60 * 1000; // 20分钟超时

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setUploadProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      setUploading(false);
      xhrRef.current = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          toast.success(`任务已创建（ID: ${data.task_id}），正在后台处理`);
          onSuccess?.();
          onOpenChange(false);
        } catch {
          toast.error("响应解析失败");
        }
      } else {
        let detail = `上传失败 (${xhr.status})`;
        try {
          const errData = JSON.parse(xhr.responseText);
          if (errData.detail) detail = errData.detail;
        } catch {}
        toast.error(detail);
      }
      setSubmitting(false);
    };

    xhr.onerror = () => {
      setUploading(false);
      setSubmitting(false);
      xhrRef.current = null;
      toast.error("网络错误，上传失败");
    };

    xhr.ontimeout = () => {
      setUploading(false);
      setSubmitting(false);
      xhrRef.current = null;
      toast.error("上传超时（超过20分钟），请检查网络后重试");
    };

    xhr.send(fd);
  };

  const canSubmit = pptFile !== null && images.length > 0 && namePrefix.trim().length > 0 && !submitting && !uploading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>拆分导入</DialogTitle>
          <DialogDescription>
            上传 PPT 文件并选择图片文件夹，所有图片将按文件名自然排序后批量导入
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
          className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-0.5 pb-1"
        >
          {uploading ? (
            <div className="flex flex-col items-center gap-4 py-8">
              {/* 文件图标 */}
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <FileUp className="h-6 w-6 text-primary" />
              </div>
              {/* 文件名 */}
              <p className="text-sm font-medium">{pptFile?.name || '上传中'}</p>
              {/* 进度条 */}
              <div className="w-full max-w-xs">
                <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>上传中...</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
              {/* 取消按钮 */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (xhrRef.current) {
                    xhrRef.current.abort();
                    xhrRef.current = null;
                  }
                  setUploading(false);
                  setSubmitting(false);
                  setUploadProgress(0);
                  toast.info('已取消上传');
                }}
              >
                取消
              </Button>
            </div>
          ) : (
            <>
          {/* 文件选择区 */}
          <section className="grid gap-3 rounded-lg border bg-muted/30 p-4">
            <header className="flex items-center justify-between">
              <span className="text-sm font-medium">上传文件</span>
              <span className="text-xs text-muted-foreground">PPT 与图片均必填</span>
            </header>
            <div className="grid gap-3 sm:grid-cols-2">
              {/* PPT 文件 */}
              <label
                className={cn(
                  "flex cursor-pointer flex-col gap-1 rounded-md border border-dashed bg-background px-3 py-2.5 text-sm transition hover:border-primary hover:bg-primary/5",
                )}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <FileText className="h-4 w-4" />
                  PPT 文件
                </span>
                <span
                  className={
                    pptFile ? "truncate font-medium text-foreground" : "text-xs text-muted-foreground"
                  }
                >
                  {pptFile ? pptFile.name : "点击选择 .pptx 文件"}
                </span>
                <input
                  type="file"
                  accept=".ppt,.pptx"
                  className="hidden"
                  onChange={(e) => setPptFile(e.target.files?.[0] ?? null)}
                />
              </label>

              {/* 图片文件夹 */}
              <ImageFolderPicker files={images} onChange={setImages} />
            </div>

            {images.length > 0 && (
              <p className="text-xs text-muted-foreground">
                已按文件名自然排序，共 {images.length} 张图片
                {images.length > 0 && (
                  <span className="ml-1 text-foreground">
                    （首张：{images[0].name}）
                  </span>
                )}
              </p>
            )}
          </section>

          {/* 名称前缀 */}
          <div className="grid gap-1.5">
            <Label htmlFor="batch-prefix">
              名称前缀 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="batch-prefix"
              value={namePrefix}
              onChange={(e) => setNamePrefix(e.target.value)}
              placeholder="输入通用前缀，如：产品介绍"
              required
            />
          </div>

          {/* 主体 + 密级 + 状态 */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="batch-subject">主体</Label>
              <Input
                id="batch-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={DEFAULT_RESOURCE_SUBJECT}
              />
            </div>

            <div className="grid gap-1.5">
              <Label>密级</Label>
              <Select
                value={secrecyLevel}
                onValueChange={(v) => setSecrecyLevel(v as "public" | "confidential" | "secret")}
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
                value={status}
                onValueChange={(v) => setStatus(v as "active" | "disabled")}
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
              value={tagList}
              onChange={(list) => setTagList(list)}
              suggestions={[]}
            />
          </div>

          {/* 可见 / 管理 范围 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>可见范围</Label>
              <Select
                value={visibilityScope}
                onValueChange={(v) => setVisibilityScope(v as ScopeValue)}
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
                value={managementScope}
                onValueChange={(v) => setManagementScope(v as ScopeValue)}
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

          {visibilityScope === "partial" && (
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">可见用户（必选至少 1 人）</Label>
              <UserPicker
                value={visibleUserIds}
                onChange={(ids) => setVisibleUserIds(ids)}
              />
            </div>
          )}
          {managementScope === "partial" && (
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">可管理用户（必选至少 1 人）</Label>
              <UserPicker
                value={manageUserIds}
                onChange={(ids) => setManageUserIds(ids)}
              />
            </div>
          )}

          {/* 通用备注 */}
          <div className="grid gap-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-sm font-medium">通用备注</Label>
              <span className="text-xs text-muted-foreground">所有可见用户可见</span>
            </div>
            <RichTextEditor
              value={remarkHtml}
              onChange={(html) => setRemarkHtml(html)}
              placeholder="对所有可见用户展示的备注，支持加粗 / 列表等格式"
              minHeight={140}
            />
          </div>

          <DialogFooter className="sticky bottom-0 -mx-0.5 flex flex-col-reverse gap-3 border-t bg-background pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <span className="hidden sm:block" />
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    提交中…
                  </>
                ) : (
                  "开始导入"
                )}
              </Button>
            </div>
          </DialogFooter>
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
