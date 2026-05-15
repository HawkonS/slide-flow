import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, ImageIcon, Loader2 } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FilePickerCard } from "@/components/resource/FilePickerCard";
import { RichTextEditor } from "@/components/resource/RichTextEditor";
import { apiUpload } from "@/lib/api";
import { Resource } from "@/lib/types";

export interface ResourceNewVersionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: Resource | null;
}

/**
 * 迭代新版本：上传新 PPTX（必填）+ 预览图（必填）+ 版本说明 +
 * 可选通用备注（留空=新版为空）+ 是否继承个人备注。
 * 对接 POST /api/resources/{id}/versions，mode=iterate。
 */
export function ResourceNewVersionDialog({
  open,
  onOpenChange,
  resource,
}: ResourceNewVersionDialogProps) {
  const [pptFile, setPptFile] = React.useState<File | null>(null);
  const [pngFile, setPngFile] = React.useState<File | null>(null);
  const [changeNote, setChangeNote] = React.useState("");
  const [commonRemark, setCommonRemark] = React.useState("");
  const [inheritPersonal, setInheritPersonal] = React.useState(true);
  const queryClient = useQueryClient();

  React.useEffect(() => {
    if (open) {
      setPptFile(null);
      setPngFile(null);
      setChangeNote("");
      // 通用备注默认带入上一版内容，便于微调
      setCommonRemark(resource?.current?.common_remark_html ?? "");
      setInheritPersonal(true);
    }
  }, [open, resource?.id, resource?.current?.common_remark_html]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!resource) throw new Error("资源不存在");
      if (!pptFile) throw new Error("请选择新版 PPTX");
      if (!pngFile) throw new Error("请上传预览图");
      const fd = new FormData();
      fd.append("mode", "iterate");
      fd.append("change_note", changeNote.trim());
      fd.append("common_remark_html", commonRemark);
      fd.append("inherit_personal_remarks", inheritPersonal ? "true" : "false");
      fd.append("ppt_file", pptFile);
      fd.append("png_file", pngFile);
      return apiUpload(`/api/resources/${resource.id}/versions`, fd);
    },
    onSuccess: () => {
      toast.success("新版本已创建");
      queryClient.invalidateQueries({ queryKey: ["resources"] });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error(err.message || "提交失败");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pptFile) {
      toast.error("请选择新版 PPTX");
      return;
    }
    if (!pngFile) {
      toast.error("请上传预览图");
      return;
    }
    mutation.mutate();
  };

  const currentVersionNo = resource?.current?.version_no ?? 0;
  const nextVersionNo = currentVersionNo + 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>版本迭代</DialogTitle>
          <DialogDescription>
            {resource ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="truncate font-medium text-foreground">{resource.name}</span>
                <span className="text-muted-foreground">·</span>
                <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
                  v{currentVersionNo}
                </span>
                <span className="text-muted-foreground">→</span>
                <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                  v{nextVersionNo}
                </span>
              </span>
            ) : (
              "选择新版 PPTX 文件"
            )}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          className="grid min-h-0 flex-1 gap-5 overflow-y-auto px-0.5 pb-1"
        >
          {/* 文件区 */}
          <section className="grid gap-3 rounded-lg border bg-muted/30 p-4">
            <header className="flex items-center justify-between">
              <span className="text-sm font-medium">新版文件</span>
              <span className="text-xs text-muted-foreground">PPT 与预览图均为必填</span>
            </header>
            <div className="grid gap-3 sm:grid-cols-2">
              <FilePickerCard
                id="new-ver-ppt"
                label="PPT 文件"
                accept=".ppt,.pptx"
                file={pptFile}
                icon={<FileText className="h-4 w-4" />}
                onChange={setPptFile}
              />
              <FilePickerCard
                id="new-ver-png"
                label="PNG 文件"
                accept="image/png,image/jpeg"
                file={pngFile}
                icon={<ImageIcon className="h-4 w-4" />}
                onChange={setPngFile}
              />
            </div>
          </section>

          {/* 版本说明 */}
          <section className="grid gap-1.5">
            <Label htmlFor="new-ver-note">版本说明（可选）</Label>
            <Input
              id="new-ver-note"
              value={changeNote}
              onChange={(e) => setChangeNote(e.target.value)}
              placeholder="例：调整配色 / 更新数据"
            />
          </section>

          {/* 通用备注：UI 与「版本说明」保持一致，默认带入上一版内容 */}
          <section className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label>新版通用备注（可选）</Label>
              <span className="text-xs text-muted-foreground">留空则新版通用备注为空</span>
            </div>
            <RichTextEditor
              value={commonRemark}
              onChange={setCommonRemark}
              placeholder="对所有可见用户展示的备注，支持加粗 / 列表等格式"
              minHeight={120}
            />
          </section>

          {/* 个人备注继承 */}
          <section className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4">
            <Checkbox
              id="inherit-personal"
              checked={inheritPersonal}
              onCheckedChange={(v) => setInheritPersonal(v === true)}
              className="mt-0.5"
            />
            <div className="grid gap-0.5">
              <Label htmlFor="inherit-personal" className="text-sm font-medium">
                继承上一版本的个人备注
              </Label>
              <span className="text-xs text-muted-foreground">
                勾选后，所有用户在 v{currentVersionNo} 的个人备注会被复制到 v{nextVersionNo}；不勾选则新版本所有个人备注为空。
              </span>
            </div>
          </section>

          <DialogFooter className="sticky bottom-0 -mx-0.5 border-t bg-background pt-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              取消
            </Button>
            <Button type="submit" disabled={mutation.isPending || !resource}>
              {mutation.isPending ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  提交中…
                </>
              ) : (
                `创建 v${nextVersionNo}`
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
