import * as React from "react";
import { AlertTriangle, CheckCircle2, HelpCircle } from "lucide-react";

import { LocalFontInfo } from "@/lib/fonts";
import { cn } from "@/lib/utils";

/**
 * 下载对话框内统一使用的「本机字体检测」面板：
 * - 顶部一个总结性 callout（ok/warn 两态）
 * - 下方一个紧凑的字体明细列表
 */
export function FontCheckPanel({
  local,
  emptyText = "未检测到显式字体要求",
}: {
  local: LocalFontInfo | null;
  emptyText?: string;
}) {
  const recommendPpt = local?.recommend === "ppt";
  const hasRows = (local?.rows.length ?? 0) > 0;

  return (
    <section className="space-y-2">
      <SummaryCallout
        tone={recommendPpt ? "ok" : "warn"}
        text={local ? (hasRows ? local.summary : emptyText) : "检测中…"}
      />
      {hasRows && local && (
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
            <span>字体检测明细</span>
            <span>共 {local.rows.length} 项</span>
          </div>
          <FontList
            rows={local.rows.map((row) => ({
              name: row.font,
              tone: row.available === true ? "ok" : row.available === null ? "muted" : "warn",
              meta:
                row.available === null
                  ? `无法确认 · ${row.weightLabel}`
                  : row.available
                    ? `本机有${row.matched ? ` · 匹配：${row.matched}` : ""} · ${row.weightLabel}`
                    : `本机缺失 · ${row.weightLabel}`,
            }))}
          />
        </div>
      )}
    </section>
  );
}

/** 总结性 callout：大图标高对比，标题+副标题，与下方紧凑的字体行列表明显区分 */
function SummaryCallout({ tone, text }: { tone: "ok" | "warn"; text: string }) {
  const Icon = tone === "ok" ? CheckCircle2 : AlertTriangle;
  const title = tone === "ok" ? "本机字体齐全" : "检测到缺失字体";
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border px-4 py-3",
        tone === "ok" &&
          "border-[hsl(var(--success))]/30 bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]",
        tone === "warn" &&
          "border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]",
      )}
    >
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          tone === "ok" && "bg-[hsl(var(--success))]/20",
          tone === "warn" && "bg-[hsl(var(--warning))]/20",
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold leading-tight">{title}</div>
        <div className="mt-0.5 text-xs opacity-90">{text}</div>
      </div>
    </div>
  );
}

function FontList({
  rows,
}: {
  rows: { name: string; tone: "ok" | "warn" | "muted"; meta: string }[];
}) {
  return (
    <div className="divide-y rounded-md border">
      {rows.map((row, i) => {
        const Icon = row.tone === "ok" ? CheckCircle2 : row.tone === "warn" ? AlertTriangle : HelpCircle;
        const toneClass =
          row.tone === "ok"
            ? "text-[hsl(var(--success))]"
            : row.tone === "warn"
              ? "text-[hsl(var(--warning))]"
              : "text-muted-foreground";
        return (
          <div
            key={`${row.name}-${i}`}
            className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Icon className={cn("h-4 w-4 shrink-0", toneClass)} />
              <span className="truncate">{row.name}</span>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">{row.meta}</span>
          </div>
        );
      })}
    </div>
  );
}
