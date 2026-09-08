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
import { FontCheckPanel } from "@/components/common/FontCheckPanel";
import {
  detectLocalFonts,
  fetchShowFonts,
  LocalFontInfo,
} from "@/lib/fonts";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useSiteConfig } from "@/stores/site-config";
import { useDownloadManager } from "@/stores/download-manager";
import { Show } from "@/lib/types";

interface ShowDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  show: Show | null;
}

/** 异步下载创建接口契约 */
type DownloadType = "pdf" | "pptx_images" | "pptx" | "pptx_fonts" | "pptx_pages";

interface CreateDownloadResponse {
  task_id: number;
  track_code: string;
  message: string;
}

const DOWNLOAD_TYPE_LABEL: Record<DownloadType, string> = {
  pdf: "PDF 文档",
  pptx_images: "纯图 PPT",
  pptx: "合并 PPT",
  pptx_fonts: "PPT + 字体包",
  pptx_pages: "逐页 PPT",
};

export function ShowDownloadDialog({ open, onOpenChange, show }: ShowDownloadDialogProps) {
  /** 当前正在提交的下载类型，用于按钮 loading 状态 */
  const [submitting, setSubmitting] = React.useState<DownloadType | null>(null);
  const [local, setLocal] = React.useState<LocalFontInfo | null>(null);
  // 水印选项
  const [wmEnabled, setWmEnabled] = React.useState(true);
  const [wmUserName, setWmUserName] = React.useState(true);
  const [wmPlatform, setWmPlatform] = React.useState(false);

  const { user } = useAuth();
  const siteName = useSiteConfig((s) => s.siteName);
  const addTask = useDownloadManager((s) => s.addTask);

  const watermarkText = React.useMemo(() => {
    if (!wmEnabled) return "";
    const parts: string[] = [];
    if (wmUserName && user) {
      parts.push(user.name || user.username);
    }
    if (wmPlatform) {
      parts.push(siteName);
    }
    // 即使 parts 为空也返回特殊标记表示"启用水印"
    // 后端会自动追加追踪编码
    return parts.length > 0 ? parts.join(" | ") : "__enabled__";
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
      setSubmitting(null);
      setWmEnabled(true);
      setWmUserName(true);
      setWmPlatform(false);
    }
  }, [open]);

  if (!show) return null;

  const accessibleCount = show.resources.filter((r) => r.accessible).length;
  const isBusy = submitting != null;

  const submitDownload = async (downloadType: DownloadType, withFonts: boolean) => {
    if (!show) return;
    // UI loading 状态用 pptx_fonts 区分两个 pptx 按钮，但实际请求 download_type 仍为 pptx
    const submittingKey: DownloadType =
      withFonts && downloadType === "pptx" ? "pptx_fonts" : downloadType;
    const labelKey: DownloadType = submittingKey;
    setSubmitting(submittingKey);
    try {
      const res = await api<CreateDownloadResponse>("/api/downloads/create", {
        method: "POST",
        json: {
          show_id: show.id,
          download_type: downloadType,
          watermark: watermarkText,
          with_fonts: withFonts,
        },
      });
      addTask(res.task_id, show.name, res.track_code);
      toast.success("下载任务已提交", {
        description: `${show.name} · ${DOWNLOAD_TYPE_LABEL[labelKey]}`,
        action: {
          label: "查看任务",
          onClick: () => {
            window.location.href = "/manage/tasks?tab=downloads";
          },
        },
      });
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || "提交失败");
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle className="text-base font-semibold">下载放映</DialogTitle>
          <DialogDescription className="sr-only">
            {show.name} · 共 {accessibleCount} 项可下载资源
          </DialogDescription>
        </DialogHeader>

        {/* 主体内容：左右分栏 */}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[1fr_260px]">
          {/* 左侧：下载选项 */}
          <div className="flex min-h-0 flex-col overflow-y-auto border-b px-6 py-4 md:border-b-0 md:border-r">
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              选择下载格式
            </div>
            <div className="space-y-2">
              <DownloadRow
                icon={<FileText className="h-4 w-4" />}
                title="PDF 文档"
                desc="将预览图拼合为 PDF，不受字体影响"
                onClick={() => submitDownload("pdf", false)}
                disabled={isBusy}
                loading={submitting === "pdf"}
              />
              <DownloadRow
                icon={<ImageIcon className="h-4 w-4" />}
                title="纯图 PPT"
                desc="每张预览图生成一页幻灯片"
                onClick={() => submitDownload("pptx_images", false)}
                disabled={isBusy}
                loading={submitting === "pptx_images"}
              />
              <DownloadRow
                icon={<FileType className="h-4 w-4" />}
                title="合并 PPT"
                desc="所有资源合并为一个 PPTX 文件"
                onClick={() => submitDownload("pptx", false)}
                disabled={isBusy}
                loading={submitting === "pptx"}
              />
              <DownloadRow
                icon={<PackageOpen className="h-4 w-4" />}
                title="PPT + 字体包"
                desc="PPTX 与所需字体打包为 ZIP"
                onClick={() => submitDownload("pptx", true)}
                disabled={isBusy}
                loading={submitting === "pptx_fonts"}
              />
              <DownloadRow
                icon={<PackageOpen className="h-4 w-4" />}
                title="逐页 PPT"
                desc="每页幻灯片单独一个 PPTX，打包为 ZIP"
                onClick={() => submitDownload("pptx_pages", false)}
                disabled={isBusy}
                loading={submitting === "pptx_pages"}
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
                  desc={user?.name || user?.username || ""}
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
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  启用水印后将自动嵌入唯一追踪编码，可额外叠加姓名或平台信息。
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 底部：关闭按钮 */}
        <div className="shrink-0 border-t px-6 py-3">
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

/** 下载选项行：图标 + 标题/描述 + 提交按钮 */
function DownloadRow({
  icon,
  title,
  desc,
  onClick,
  disabled,
  loading,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
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
        {loading ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : (
          <Download className="mr-1 h-3 w-3" />
        )}
        开始下载
      </Button>
    </div>
  );
}
