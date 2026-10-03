import { TableText } from "@/components/common/TableContent";
import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  HelpCircle,
} from "lucide-react";

import { LocalFontInfo } from "@/lib/fonts";
import { cn } from "@/lib/utils";

/**
 * 下载对话框内统一使用的「本机字体检测」面板：
 * - 顶部一个总结性 callout（ok/warn 两态）
 * - 下方一个可折叠的紧凑字体明细列表（默认收起，避免字体多时撑爆模态框）
 */
export function FontCheckPanel({
  local,
  emptyText = "未检测到显式字体要求",
  maxHeight = "max-h-48",
}: {
  local: LocalFontInfo | null;
  emptyText?: string;
  /** 展开后字体列表区域的最大高度，默认 max-h-48 */
  maxHeight?: string;
}) {
  const [expanded, setExpanded] = React.useState(false);

  const recommendPpt = local?.recommend === "ppt";
  const hasRows = (local?.rows.length ?? 0) > 0;

  if (!local) {
    return (
      <section>
        <SummaryCallout tone="ok" text="检测中…" />
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <SummaryCallout
        tone={recommendPpt ? "ok" : "warn"}
        text={hasRows ? local.summary : emptyText}
      />
      {hasRows && (
        <div>
          {/* 可折叠标题 */}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-center justify-between rounded-md px-1 py-1 text-xs text-muted-foreground hover:bg-accent/40 transition-colors"
          >
            <span>字体检测明细</span>
            <span className="flex items-center gap-1">
              <span>共 {local.rows.length} 项</span>
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  expanded && "rotate-180",
                )}
              />
            </span>
          </button>

          {/* 展开后的紧凑列表 */}
          {expanded && (
            <div className={cn("mt-1.5 overflow-y-auto", maxHeight)}>
              <table className="w-full table-fixed text-xs">
                <colgroup><col className="w-5" /><col /><col className="w-[45%]" /></colgroup>
                <tbody>
                  {local.rows.map((row, i) => {
                    const isOk = row.available === true;
                    const isWarn = row.available === false;
                    const Icon = isOk
                      ? CheckCircle2
                      : isWarn
                        ? AlertTriangle
                        : HelpCircle;
                    const toneClass = isOk
                      ? "text-[hsl(var(--success))]"
                      : isWarn
                        ? "text-[hsl(var(--warning))]"
                        : "text-muted-foreground";
                    const status = isOk
                      ? `本机有${row.matched ? ` · ${row.matched}` : ""}`
                      : isWarn
                        ? "本机缺失"
                        : "无法确认";
                    return (
                      <tr
                        key={`${row.font}-${i}`}
                        className={cn(
                          "border-b border-border/50 last:border-0",
                        )}
                      >
                        <td className="py-1 pr-1.5 align-middle">
                          <Icon className={cn("h-3.5 w-3.5", toneClass)} />
                        </td>
                        <td className="py-1 pr-2 align-middle font-medium">
                          <TableText text={row.font} />
                        </td>
                        <td
                          className={cn(
                            "py-1 text-right align-middle whitespace-nowrap",
                            toneClass,
                          )}
                        >
                          <TableText text={status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** 总结性 callout：紧凑的单行样式 */
function SummaryCallout({ tone, text }: { tone: "ok" | "warn"; text: string }) {
  const Icon = tone === "ok" ? CheckCircle2 : AlertTriangle;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
        tone === "ok" &&
          "border-[hsl(var(--success))]/30 bg-[hsl(var(--success))]/8 text-[hsl(var(--success))]",
        tone === "warn" &&
          "border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning))]/8 text-[hsl(var(--warning))]",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="break-words">{text}</span>
    </div>
  );
}

