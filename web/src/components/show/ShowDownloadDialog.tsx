import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";

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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DownloadProgress, DownloadProgressState } from "@/components/common/DownloadProgress";
import { FontCheckPanel } from "@/components/common/FontCheckPanel";
import {
  detectLocalFonts,
  downloadWithProgress,
  fetchShowFonts,
  LocalFontInfo,
  showImagesPptxDownloadUrl,
  showPdfDownloadUrl,
  showPptxDownloadUrl,
  showZipDownloadUrl,
} from "@/lib/fonts";
import { Show } from "@/lib/types";

interface ShowDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  show: Show | null;
}

type PptMode = "merged" | "bundle";

export function ShowDownloadDialog({ open, onOpenChange, show }: ShowDownloadDialogProps) {
  const [mode, setMode] = React.useState<PptMode>("merged");
  const [progress, setProgress] = React.useState<DownloadProgressState | null>(null);
  const [local, setLocal] = React.useState<LocalFontInfo | null>(null);

  // 仅在对话框打开且有 show 时拉取字体聚合
  const { data: fontSource } = useQuery({
    queryKey: ["show-fonts", show?.id],
    queryFn: () => fetchShowFonts(show!.id),
    enabled: open && !!show,
    staleTime: 30_000,
  });

  // 拿到字体源后做本机检测
  React.useEffect(() => {
    if (!open) {
      setLocal(null);
      return;
    }
    if (fontSource) {
      setLocal(detectLocalFonts(fontSource));
    }
  }, [open, fontSource]);

  // 每次打开重置状态
  React.useEffect(() => {
    if (open) {
      setMode("merged");
      setProgress(null);
    }
  }, [open]);

  if (!show) return null;

  const accessibleCount = show.resources.filter((r) => r.accessible).length;
  const recommendPpt = local?.recommend === "ppt";

  const runDownload = async (url: string, fallbackName: string) => {
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

  const runPdf = () => runDownload(showPdfDownloadUrl(show.id), `${show.name}.pdf`);

  const runImagesPpt = () =>
    runDownload(showImagesPptxDownloadUrl(show.id), `${show.name}_纯图.pptx`);

  const runPpt = (withFonts: boolean) => {
    if (mode === "merged") {
      const url = showPptxDownloadUrl(show.id, withFonts);
      const name = withFonts ? `${show.name}_with_fonts.zip` : `${show.name}.pptx`;
      return runDownload(url, name);
    }
    const url = showZipDownloadUrl(show.id, withFonts);
    const name = withFonts ? `${show.name}_with_fonts.zip` : `${show.name}.zip`;
    return runDownload(url, name);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>下载</DialogTitle>
          <DialogDescription>
            PDF 不受本机字体影响，PPT 可选是否同时打包所需字体
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 放映信息 */}
          <section className="space-y-1 text-sm">
            <div className="text-xs font-medium text-muted-foreground">放映名称</div>
            <div className="flex items-center gap-2 font-medium">
              <span className="truncate">{show.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                · 共 {accessibleCount} 项可下载
              </span>
            </div>
          </section>

          {/* PDF 独立卡片 */}
          <section className="flex items-center gap-4 rounded-lg border p-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <FileText className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">PDF 文档</div>
              <div className="text-xs text-muted-foreground">
                将所有有权限的预览图拼接为一个 PDF
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={runPdf}
              disabled={progress != null}
            >
              <Download className="mr-1.5 h-4 w-4" />
              下载 PDF
            </Button>
          </section>

          {/* 纯图 PPT 独立卡片 */}
          <section className="flex items-center gap-4 rounded-lg border p-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <ImageIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">纯图 PPT</div>
              <div className="text-xs text-muted-foreground">
                将每张高清预览图生成一页 PPTX，不受本机字体影响
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={runImagesPpt}
              disabled={progress != null}
            >
              <Download className="mr-1.5 h-4 w-4" />
              下载纯图 PPT
            </Button>
          </section>

          <Separator />

          {/* PPT 下载区 */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">PPT 下载</div>
              <Tabs value={mode} onValueChange={(v) => setMode(v as PptMode)}>
                <TabsList className="h-8">
                  <TabsTrigger value="merged" className="text-xs" disabled={progress != null}>
                    合并为一个 PPTX
                  </TabsTrigger>
                  <TabsTrigger value="bundle" className="text-xs" disabled={progress != null}>
                    逐个 PPT 压缩包
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            <FontCheckPanel local={local} />
          </section>

          <DownloadProgress progress={progress} />
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={progress != null}
          >
            取消
          </Button>
          <Button
            variant={recommendPpt ? "outline" : "default"}
            onClick={() => runPpt(true)}
            disabled={progress != null}
          >
            <Download className="mr-1.5 h-4 w-4" />
            PPT + 字体包{!recommendPpt && local ? "（推荐）" : ""}
          </Button>
          <Button
            variant={recommendPpt ? "default" : "outline"}
            onClick={() => runPpt(false)}
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
