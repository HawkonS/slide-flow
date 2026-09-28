import * as React from "react";
import { Archive, ChevronDown, Download, Image, Loader2, Presentation } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DownloadProgressState } from "@/components/common/DownloadProgress";
import {
  downloadWithProgress,
  PngDownloadResolution,
  ResourceDownloadFormat,
  resourceDownloadUrl,
} from "@/lib/fonts";
import { Resource, ResourceVersion } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ResourceDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: Resource | null;
  /** 调用入口已经选定的下载版本 */
  version: ResourceVersion | null;
}

const resolutions: { value: PngDownloadResolution; label: string; maxEdge: number }[] = [
  { value: "4k", label: "4K", maxEdge: 4096 },
  { value: "2k", label: "2K", maxEdge: 2048 },
  { value: "1080p", label: "1080p", maxEdge: 1920 },
  { value: "720p", label: "720p", maxEdge: 1280 },
];

export function ResourceDownloadDialog({
  open,
  onOpenChange,
  resource,
  version,
}: ResourceDownloadDialogProps) {
  const [resolution, setResolution] = React.useState<PngDownloadResolution>("4k");
  const [progress, setProgress] = React.useState<DownloadProgressState | null>(null);
  const [activeFormat, setActiveFormat] = React.useState<ResourceDownloadFormat | null>(null);

  React.useEffect(() => {
    if (open) {
      setResolution("4k");
    } else {
      setProgress(null);
      setActiveFormat(null);
    }
  }, [open, version]);

  const currentVersion = version;

  if (!resource || !currentVersion) return null;

  const runDownload = async (
    format: ResourceDownloadFormat,
    pngResolution: PngDownloadResolution = resolution,
  ) => {
    const url = resourceDownloadUrl(resource.id, currentVersion.id, format, pngResolution);
    const extension = format === "zip" ? "zip" : format === "png" ? "png" : "pptx";
    const suffix = format === "pptx-embedded" ? "_内嵌字体" : format === "png" ? `_${pngResolution}` : "";
    const fallbackName = `${resource.name}_v${currentVersion.version_no ?? ""}${suffix}.${extension}`;
    setActiveFormat(format);
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
      setActiveFormat(null);
    }
  };

  const downloading = progress != null;
  const resolutionLabel = resolutions.find((item) => item.value === resolution)?.label ?? "4K";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>选择下载格式</DialogTitle>
          <DialogDescription className="truncate">{resource.name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-6 py-5">
          <section className="grid gap-2" aria-label="下载格式">
            <DownloadOption
              icon={Presentation}
              title="PPT（内嵌字体）"
              detail="打开时无需另行安装字体"
              disabled={downloading}
              progress={activeFormat === "pptx-embedded" ? progress : null}
              onClick={() => void runDownload("pptx-embedded")}
            />
            <DownloadOption
              icon={Presentation}
              title="PPT（非内嵌字体）"
              detail="文件更小，使用本机已安装的字体"
              disabled={downloading}
              progress={activeFormat === "pptx" ? progress : null}
              onClick={() => void runDownload("pptx")}
            />
            <DownloadOption
              icon={Archive}
              title="压缩包（PPT + 字体包）"
              detail="包含 PPT、可用字体文件和缺失字体清单"
              disabled={downloading}
              progress={activeFormat === "zip" ? progress : null}
              onClick={() => void runDownload("zip")}
            />

            <div className="flex overflow-hidden rounded-md">
              <Button
                variant="outline"
                className={cn(
                  "relative h-auto min-h-[62px] flex-1 justify-start overflow-hidden rounded-r-none px-3 py-2.5 text-left",
                  activeFormat === "png" && "border-primary/40 bg-primary/5",
                )}
                disabled={downloading}
                onClick={() => void runDownload("png")}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Image className="h-[18px] w-[18px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">PNG（{resolutionLabel}）</span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {activeFormat === "png" && progress
                      ? "下载中 · " + progress.label
                      : "预览图，最长边不超过 " + resolutions.find((item) => item.value === resolution)?.maxEdge + " px"}
                  </span>
                </span>
                {activeFormat === "png" ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                ) : (
                  <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                {activeFormat === "png" && progress && <InlineProgressBar progress={progress} />}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-auto w-11 shrink-0 rounded-l-none border-l-0"
                    disabled={downloading}
                    aria-label="选择 PNG 清晰度"
                    title="选择 PNG 清晰度"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel>PNG 清晰度</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup
                    value={resolution}
                    onValueChange={(value) => setResolution(value as PngDownloadResolution)}
                  >
                    {resolutions.map((item) => (
                      <DropdownMenuRadioItem key={item.value} value={item.value}>
                        <span>{item.label}</span>
                        <span className="ml-auto text-xs text-muted-foreground">最长边 {item.maxEdge} px</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </section>

        </div>

        <DialogFooter className="border-t bg-muted/20 px-6 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={downloading}>
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DownloadOption({
  icon,
  title,
  detail,
  disabled,
  progress,
  onClick,
}: {
  icon: React.ElementType<{ className?: string }>;
  title: string;
  detail: string;
  disabled: boolean;
  progress?: DownloadProgressState | null;
  onClick: () => void;
}) {
  const Icon = icon;
  return (
    <Button
      variant="outline"
      className={cn(
        "relative h-auto min-h-[62px] justify-start overflow-hidden px-3 py-2.5 text-left",
        progress && "border-primary/40 bg-primary/5",
      )}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs font-normal text-muted-foreground">
          {progress ? "下载中 · " + progress.label : detail}
        </span>
      </span>
      {progress ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
      ) : (
        <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      {progress && <InlineProgressBar progress={progress} />}
    </Button>
  );
}

function InlineProgressBar({ progress }: { progress: DownloadProgressState }) {
  return (
    <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-primary/10">
      <span
        className={cn(
          "block h-full bg-primary transition-[width] duration-300",
          progress.percent == null && "animate-pulse",
        )}
        style={{
          width: progress.percent == null ? "36%" : String(Math.min(100, progress.percent)) + "%",
        }}
      />
    </span>
  );
}
