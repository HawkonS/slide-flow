import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Download,
  FileText,
  FileType,
  Image as ImageIcon,
  Loader2,
  PackageOpen,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
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
  DownloadPhase,
} from "@/lib/fonts";
import { useAuth } from "@/lib/auth";
import { useSiteConfig } from "@/stores/site-config";
import { Show } from "@/lib/types";

interface ShowDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  show: Show | null;
}

export function ShowDownloadDialog({ open, onOpenChange, show }: ShowDownloadDialogProps) {
  const [progress, setProgress] = React.useState<DownloadProgressState | null>(null);
  const [phase, setPhase] = React.useState<DownloadPhase | null>(null);
  const [local, setLocal] = React.useState<LocalFontInfo | null>(null);
  // 水印选项
  const [wmEnabled, setWmEnabled] = React.useState(true);
  const [wmUserName, setWmUserName] = React.useState(false);
  const [wmPlatform, setWmPlatform] = React.useState(false);

  const { user } = useAuth();
  const siteName = useSiteConfig((s) => s.siteName);

  const watermarkText = React.useMemo(() => {
    if (!wmEnabled) return "";
    const parts: string[] = [];
    if (wmUserName && user) {
      parts.push(user.display_name || user.name || user.username);
    }
    if (wmPlatform) {
      parts.push(siteName);
    }
    return parts.length > 0 ? parts.join(" | ") : " ";
  }, [wmEnabled, wmUserName, wmPlatform, user, siteName]);

  const { data: fontSource } = useQuery({
    queryKey: ["show-fonts", show?.id],
    queryFn: () => fetchShowFonts(show!.id),
    enabled: open && !!show,
    staleTime: 30_000,
  });

  React.useEffect(() => {
    if (!open) {
      setLocal(null);
      return;
    }
    if (fontSource) {
      setLocal(detectLocalFonts(fontSource));
    }
  }, [open, fontSource]);

  React.useEffect(() => {
    if (open) {
      setProgress(null);
      setPhase(null);
      setWmEnabled(true);
      setWmUserName(false);
      setWmPlatform(false);
    }
  }, [open]);

  if (!show) return null;

  const accessibleCount = show.resources.filter((r) => r.accessible).length;
  const isBusy = progress != null;

  const runDownload = async (url: string, fallbackName: string) => {
    setProgress({ label: "正在生成文件…", percent: null });
    setPhase("generating");
    try {
      await downloadWithProgress(
        url,
        fallbackName,
        (percent, bytes) => {
          if (percent == null) {
            setProgress({ label: `${Math.round(bytes / 1024)} KB`, percent: null });
          } else {
            setProgress({ label: `${Math.round(percent)}%`, percent });
          }
        },
        (p) => {
          setPhase(p);
          if (p === "downloading") {
            setProgress({ label: "0%", percent: 0 });
          }
        },
      );
      toast.success("下载完成");
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || "下载失败");
    } finally {
      setProgress(null);
      setPhase(null);
    }
  };

  const runPdf = () =>
    runDownload(
      showPdfDownloadUrl(show.id, watermarkText || undefined),
      `${show.name}.pdf`,
    );

  const runImagesPpt = () =>
    runDownload(
      showImagesPptxDownloadUrl(show.id, watermarkText || undefined),
      `${show.name}_纯图.pptx`,
    );

  const runPpt = (withFonts: boolean) => {
    const url = showPptxDownloadUrl(show.id, withFonts, watermarkText || undefined);
    const name = withFonts ? `${show.name}_with_fonts.zip` : `${show.name}.pptx`;
    return runDownload(url, name);
  };

  // 进度条显示文案：根据阶段区分
  const progressLabel =
    progress && phase === "generating"
      ? { ...progress, label: "服务端生成中…" }
      : progress
        ? { ...progress, label: `下载中 · ${progress.label}` }
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="text-base font-semibold">下载放映</DialogTitle>
          <DialogDescription className="text-sm">
            {show.name} · 共 {accessibleCount} 项可下载资源
          </DialogDescription>
        </DialogHeader>

        {/* 主体内容：左右分栏 */}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[1fr_260px]">
          {/* 左侧：下载选项 */}
          <div className="flex min-h-0 flex-col overflow-y-auto border-r px-6 py-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              选择下载格式
            </div>
            <div className="space-y-2">
              <DownloadRow
                icon={<FileText className="h-4 w-4" />}
                title="PDF 文档"
                desc="将预览图拼合为 PDF，不受字体影响"
                onClick={runPdf}
                disabled={isBusy}
              />
              <DownloadRow
                icon={<ImageIcon className="h-4 w-4" />}
                title="纯图 PPT"
                desc="每张预览图生成一页幻灯片"
                onClick={runImagesPpt}
                disabled={isBusy}
              />
              <DownloadRow
                icon={<FileType className="h-4 w-4" />}
                title="合并 PPT"
                desc="所有资源合并为一个 PPTX 文件"
                onClick={() => runPpt(false)}
                disabled={isBusy}
              />
              <DownloadRow
                icon={<PackageOpen className="h-4 w-4" />}
                title="PPT + 字体包"
                desc="PPTX 与所需字体打包为 ZIP"
                onClick={() => runPpt(true)}
                disabled={isBusy}
              />
            </div>

            {/* 字体检测面板 */}
            <div className="mt-5">
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                字体状态
              </div>
              <FontCheckPanel local={local} />
            </div>
          </div>

          {/* 右侧：水印设置 */}
          <div className="flex min-h-0 flex-col overflow-y-auto bg-muted/20 px-5 py-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              水印设置
            </div>
            <Label
              htmlFor="wm-enabled"
              className="flex cursor-pointer items-center gap-2 text-sm font-medium"
            >
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              <Checkbox
                id="wm-enabled"
                checked={wmEnabled}
                onCheckedChange={(v) => setWmEnabled(!!v)}
                disabled={isBusy}
              />
              添加下载水印
            </Label>
            {wmEnabled && (
              <div className="mt-3 space-y-2.5 pl-1">
                <WmOption
                  id="wm-track"
                  label="追踪编码"
                  desc="自动嵌入唯一追踪码"
                  checked
                  disabled
                  onChange={() => {}}
                />
                <WmOption
                  id="wm-user"
                  label="下载人姓名"
                  desc={user?.display_name || user?.name || user?.username || ""}
                  checked={wmUserName}
                  disabled={isBusy}
                  onChange={(v) => setWmUserName(v)}
                />
                <WmOption
                  id="wm-platform"
                  label="平台名称"
                  desc={siteName}
                  checked={wmPlatform}
                  disabled={isBusy}
                  onChange={(v) => setWmPlatform(v)}
                />
              </div>
            )}
          </div>
        </div>

        {/* 底部：进度条 + 关闭按钮 */}
        <div className="border-t px-6 py-3">
          {progressLabel && (
            <div className="mb-3">
              <DownloadProgress progress={progressLabel} />
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={isBusy}>
              关闭
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 水印选项行 */
function WmOption({
  id,
  label,
  desc,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  desc: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Label htmlFor={id} className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-accent/40">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(!!v)} className="mt-0.5" />
      <div className="min-w-0">
        <div className="text-xs font-medium">{label}</div>
        {desc && <div className="truncate text-[11px] text-muted-foreground">{desc}</div>}
      </div>
    </Label>
  );
}

/** 下载选项行：图标 + 标题/描述 + 下载按钮 */
function DownloadRow({
  icon,
  title,
  desc,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="group flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 transition-colors hover:border-primary/30 hover:bg-accent/20">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/70 text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-[11px] leading-snug text-muted-foreground">{desc}</div>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 px-2.5 text-xs"
        onClick={onClick}
        disabled={disabled}
      >
        <Download className="mr-1 h-3 w-3" />
        下载
      </Button>
    </div>
  );
}
