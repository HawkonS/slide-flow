import * as React from "react";
import { Check, Download, ImageOff, Loader2, X } from "lucide-react";
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
import {
  TEMPLATE_PLATFORM_LABEL,
  TEMPLATE_TYPE_LABEL,
} from "@/lib/constants";
import {
  detectLocalFonts,
  downloadWithProgress,
  LocalFontInfo,
} from "@/lib/fonts";
import { TemplateItem } from "@/lib/types";
import { useResponsiveGrid } from "@/lib/use-grid-layout";
import { usePaginatedQuery } from "@/lib/use-paginated-query";
import { cn } from "@/lib/utils";

export function TemplatesPage() {
  const [detail, setDetail] = React.useState<TemplateItem | null>(null);

  // 列数由共享 hook 按容器宽度连续计算
  // widthOffset:16 用于补偿 grid 上层 `pl-4` 造成的实际可用宽度 -16 偏差，避免临界宽度下列数抖动
  const contentRef = React.useRef<HTMLDivElement>(null);
  const { gridStyle } = useResponsiveGrid(contentRef, { widthOffset: 16 });

  const {
    items: templates,
    total,
    isLoading,
    isError,
    error,
  } = usePaginatedQuery<TemplateItem>({
    url: "/api/templates",
    queryKeyPrefix: "templates",
    params: {},
    page: 1,
    pageSize: 500,
  });

  // 主体 → 系列 → 模板数组
  const grouped = React.useMemo(() => {
    const bySubject = new Map<string, Map<string, TemplateItem[]>>();
    templates.forEach((t) => {
      const subject = (t.subject || "").trim() || "未设置主体";
      const series = (t.series || "").trim() || "未设置系列";
      if (!bySubject.has(subject)) bySubject.set(subject, new Map());
      const seriesMap = bySubject.get(subject)!;
      if (!seriesMap.has(series)) seriesMap.set(series, []);
      seriesMap.get(series)!.push(t);
    });
    return Array.from(bySubject.entries()).map(([subject, seriesMap]) => ({
      subject,
      seriesList: Array.from(seriesMap.entries()).map(([series, items]) => ({ series, items })),
    }));
  }, [templates]);

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">标准模板</h1>
          <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground">
            {total} 个模板
          </span>
        </div>
      </header>

      {/* 内容区：contentRef 始终挂载，确保首次渲染（含刷新场景）时 hook 即可拿到稳定的容器尺寸 */}
      <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
          </div>
        ) : isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            加载失败：{error?.message || "未知错误"}
          </div>
        ) : grouped.length === 0 ? (
          <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">
            暂无模板
          </div>
        ) : (
          <div className="flex flex-col gap-10 pb-4">
            {grouped.map(({ subject, seriesList }) => {
              const subjectCount = seriesList.reduce((acc, s) => acc + s.items.length, 0);
              return (
                <section key={subject} className="space-y-5">
                  <div className="flex items-center gap-3">
                    <span className="inline-block h-6 w-1 rounded-full bg-primary" />
                    <h2 className="text-lg font-semibold tracking-tight">{subject}</h2>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {subjectCount}
                    </span>
                  </div>
                  <div className="space-y-6 pl-4">
                    {seriesList.map(({ series, items }) => (
                      <section key={series} className="space-y-3">
                        <div className="flex items-baseline gap-2">
                          <h3 className="text-sm font-medium text-foreground/80">{series}</h3>
                          <span className="text-xs text-muted-foreground">· {items.length}</span>
                        </div>
                        <div className="grid content-start" style={gridStyle}>
                          {items.map((t) => (
                            <TemplateCard key={t.id} template={t} onClick={() => setDetail(t)} />
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>

      <TemplateDetailDialog
        template={detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      />
    </div>
  );
}

function TemplateCard({ template, onClick }: { template: TemplateItem; onClick: () => void }) {
  const typeLabel = template.template_type
    ? TEMPLATE_TYPE_LABEL[template.template_type] || template.template_type
    : null;
  const platformLabel = template.platform
    ? TEMPLATE_PLATFORM_LABEL[template.platform] || template.platform
    : null;

  return (
    <article
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "group relative flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-card",
        "shadow-sm ring-1 ring-transparent transition-all duration-200",
        "hover:-translate-y-1 hover:shadow-lg hover:ring-primary/20",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
      )}
    >
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted">
        {template.preview_url ? (
          <img
            src={template.preview_url}
            alt={template.name}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <ImageOff className="h-6 w-6" />
          </div>
        )}
        {/* 悬停渐显的底部信息栏 */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/35 to-transparent p-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <div className="flex flex-wrap items-center gap-1 text-[10px] text-white/95">
            {typeLabel && (
              <span className="rounded bg-white/20 px-1.5 py-0.5">{typeLabel}</span>
            )}
            {platformLabel && (
              <span className="rounded bg-white/20 px-1.5 py-0.5">{platformLabel}</span>
            )}
            {template.ratio && (
              <span className="rounded bg-white/20 px-1.5 py-0.5">{template.ratio}</span>
            )}
          </div>
        </div>
      </div>
      <div className="px-3 py-2.5">
        <h3 className="line-clamp-1 text-[13px] font-medium" title={template.name}>
          {template.name}
        </h3>
      </div>
    </article>
  );
}

function TemplateDetailDialog({
  template,
  onOpenChange,
}: {
  template: TemplateItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [local, setLocal] = React.useState<LocalFontInfo | null>(null);
  const [progress, setProgress] = React.useState<{ label: string; percent: number | null } | null>(
    null,
  );

  React.useEffect(() => {
    if (template) {
      setLocal(
        detectLocalFonts({
          id: 0,
          version_no: 0,
          font_names: template.font_names || [],
          font_aliases: template.font_aliases,
          missing_fonts: template.missing_fonts,
          common_remark_html: null,
          change_note: null,
          created_by: null,
          created_at: "",
          preview_url: null,
          original_preview_url: null,
        }),
      );
    } else {
      setLocal(null);
      setProgress(null);
    }
  }, [template]);

  if (!template) return null;

  const recommendPpt = local?.recommend === "ppt";
  const previewUrl = template.original_preview_url || template.preview_url;

  const typeLabel = template.template_type
    ? TEMPLATE_TYPE_LABEL[template.template_type] || template.template_type
    : null;
  const platformLabel = template.platform
    ? TEMPLATE_PLATFORM_LABEL[template.platform] || template.platform
    : null;

  const metaChips = [
    typeLabel,
    platformLabel,
    template.ratio,
    (template.subject || "").trim() || null,
    (template.series || "").trim() || null,
  ].filter(Boolean) as string[];

  const baseUrl = template.download_url || `/api/templates/${template.id}/download`;
  const runDownload = async (withFonts: boolean) => {
    const url = `${baseUrl}${withFonts ? "?with_fonts=true" : ""}`;
    const base = template.office_file_name || `${template.name}.pptx`;
    const fallbackName = withFonts
      ? `${base.replace(/\.[^.]+$/, "")}_with_fonts.zip`
      : base;
    setProgress({ label: "准备下载…", percent: null });
    try {
      await downloadWithProgress(url, fallbackName, (percent, bytes) => {
        if (percent == null) setProgress({ label: `${Math.round(bytes / 1024)} KB`, percent: null });
        else setProgress({ label: `${Math.round(percent)}%`, percent });
      });
      toast.success("下载完成");
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || "下载失败");
    } finally {
      setProgress(null);
    }
  };

  const fontRows = local?.rows ?? [];
  const hasFonts = fontRows.length > 0;
  const missingCount = fontRows.filter((r) => r.available === false).length;

  return (
    <Dialog open={!!template} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="pr-6 text-base font-semibold leading-snug">
            {template.name}
          </DialogTitle>
          <DialogDescription className="sr-only">模板详情</DialogDescription>
          {metaChips.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {metaChips.map((chip) => (
                <Badge key={chip} variant="secondary" className="font-normal">
                  {chip}
                </Badge>
              ))}
            </div>
          )}
        </DialogHeader>

        <div className="grid max-h-[65vh] gap-0 overflow-hidden md:grid-cols-[1.4fr_1fr]">
          {/* 左侧：预览图 */}
          <div className="flex items-center justify-center overflow-hidden bg-muted/40 p-4">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt={template.name}
                className="max-h-full max-w-full rounded-md object-contain shadow-sm"
              />
            ) : (
              <div className="flex h-56 w-full items-center justify-center text-muted-foreground">
                <ImageOff className="h-6 w-6" />
              </div>
            )}
          </div>

          {/* 右侧：字体检测 + 下载进度 */}
          <div className="flex flex-col gap-4 overflow-y-auto border-l bg-background p-5">
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">本机字体检测</h4>
                {hasFonts && (
                  <span className="text-xs text-muted-foreground">
                    {missingCount > 0 ? `缺失 ${missingCount}/${fontRows.length}` : `${fontRows.length} 项齐全`}
                  </span>
                )}
              </div>
              <div
                className={cn(
                  "rounded-md border px-3 py-2 text-xs leading-relaxed",
                  recommendPpt
                    ? "border-[hsl(var(--success))]/30 bg-[hsl(var(--success))]/5 text-[hsl(var(--success))]"
                    : "border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning))]/5 text-[hsl(var(--warning))]",
                )}
              >
                {local?.summary ?? "检测中…"}
              </div>
              {hasFonts && (
                <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-2 text-xs">
                  {fontRows.map((r, i) => (
                    <li
                      key={`${r.font}-${i}`}
                      className="flex items-center justify-between gap-2 px-1 py-0.5"
                    >
                      <span className="truncate" title={r.font}>
                        {r.font}
                      </span>
                      <span className="shrink-0">
                        {r.available === null ? (
                          <span className="text-muted-foreground">未知</span>
                        ) : r.available ? (
                          <span className="inline-flex items-center gap-0.5 text-[hsl(var(--success))]">
                            <Check className="h-3 w-3" />
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-0.5 text-[hsl(var(--warning))]">
                            <X className="h-3 w-3" /> 缺失
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {progress && (
              <div className="rounded-md border bg-muted/40 p-3 text-xs">
                <div className="mb-1.5 flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  下载中 · {progress.label}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{
                      width: progress.percent == null ? "40%" : `${Math.min(100, progress.percent)}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 border-t bg-muted/30 px-6 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={progress != null}>
            关闭
          </Button>
          <Button
            variant={recommendPpt ? "outline" : "default"}
            onClick={() => runDownload(true)}
            disabled={progress != null}
          >
            <Download className="mr-1.5 h-4 w-4" />
            PPT + 字体包{!recommendPpt ? "（推荐）" : ""}
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
