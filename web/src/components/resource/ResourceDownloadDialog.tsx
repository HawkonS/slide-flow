import * as React from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DownloadProgress, DownloadProgressState } from "@/components/common/DownloadProgress";
import { FontCheckPanel } from "@/components/common/FontCheckPanel";
import {
  detectLocalFonts,
  downloadWithProgress,
  LocalFontInfo,
  resourceDownloadUrl,
} from "@/lib/fonts";
import { parseTags, Resource, ResourceVersion } from "@/lib/types";

export interface ResourceDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: Resource | null;
  /** 打开时的初始版本，用户可在对话框内切换 */
  version: ResourceVersion | null;
}

export function ResourceDownloadDialog({
  open,
  onOpenChange,
  resource,
  version,
}: ResourceDownloadDialogProps) {
  const [selectedVersionId, setSelectedVersionId] = React.useState<number | null>(null);
  const [local, setLocal] = React.useState<LocalFontInfo | null>(null);
  const [progress, setProgress] = React.useState<DownloadProgressState | null>(null);

  // 打开时重置为外部传入的版本
  React.useEffect(() => {
    if (open) {
      setSelectedVersionId(version?.id ?? null);
    } else {
      setSelectedVersionId(null);
      setLocal(null);
      setProgress(null);
    }
  }, [open, version]);

  const versions = resource?.versions ?? [];
  const currentVersion: ResourceVersion | null =
    versions.find((v) => v.id === selectedVersionId) ?? version ?? null;

  // 版本变更时重新检测本机字体
  React.useEffect(() => {
    if (open && currentVersion) {
      setLocal(detectLocalFonts(currentVersion));
    }
  }, [open, currentVersion]);

  if (!resource || !currentVersion) return null;

  const tags = parseTags(resource.tags);
  const recommendPpt = local?.recommend === "ppt";

  const runDownload = async (withFonts: boolean) => {
    const url = resourceDownloadUrl(resource.id, currentVersion.id, withFonts);
    const ext = withFonts ? "zip" : "pptx";
    const fallbackName = `${resource.name}_v${currentVersion.version_no ?? ""}.${ext}`;
    setProgress({ label: "准备下载…", percent: null });
    try {
      await downloadWithProgress(url, fallbackName, (percent, bytes) => {
        if (percent == null) {
          setProgress({ label: `${Math.round(bytes / 1024)} KB`, percent: null });
        } else {
          setProgress({ label: `${Math.round(percent)}%`, percent });
        }
      });
      toast.success("下载完成");
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || "下载失败");
    } finally {
      setProgress(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>下载</DialogTitle>
          <DialogDescription>
            根据本机字体决定是否一起打包字体
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto px-6 py-4 space-y-4">
          {/* 资源标题 */}
          <section className="space-y-1 text-sm">
            <div className="text-xs font-medium text-muted-foreground">资源标题</div>
            <div className="font-medium">{resource.name}</div>
          </section>

          {/* 资源标签 */}
          {tags.length > 0 && (
            <section className="space-y-1 text-sm">
              <div className="text-xs font-medium text-muted-foreground">资源标签</div>
              <div className="flex flex-wrap gap-1">
                {tags.map((t) => (
                  <Badge key={t} variant="outline" className="font-normal">
                    {t}
                  </Badge>
                ))}
              </div>
            </section>
          )}

          {/* 版本选择 */}
          {versions.length > 0 && (
            <section className="space-y-1 text-sm">
              <div className="text-xs font-medium text-muted-foreground">下载版本</div>
              <Select
                value={String(currentVersion.id)}
                onValueChange={(v) => setSelectedVersionId(Number(v))}
                disabled={progress != null}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((v) => (
                    <SelectItem key={v.id} value={String(v.id)}>
                      v{v.version_no}
                      {resource.current && v.id === resource.current.id ? "（当前）" : ""}
                      {v.change_note ? ` · ${v.change_note}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>
          )}

          <Separator />

          {/* 本机字体检测 */}
          <section>
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              字体状态
            </div>
            <FontCheckPanel local={local} />
          </section>

          <DownloadProgress progress={progress} />
        </div>

        <DialogFooter className="gap-2 border-t bg-muted/30 px-6 py-3">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={progress != null}
          >
            取消
          </Button>
          <Button
            variant={recommendPpt ? "outline" : "default"}
            onClick={() => runDownload(true)}
            disabled={progress != null}
          >
            <Download className="mr-1.5 h-4 w-4" />
            PPT + 字体包
            {!recommendPpt && local ? "（推荐）" : ""}
          </Button>
          <Button
            variant={recommendPpt ? "default" : "outline"}
            onClick={() => runDownload(false)}
            disabled={progress != null}
          >
            <Download className="mr-1.5 h-4 w-4" />
            仅 PPT{recommendPpt ? "（推荐）" : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
