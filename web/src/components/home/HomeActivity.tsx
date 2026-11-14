import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type ActivityKind = "login" | "upload" | "download";
type ActivityEntry = { date: string; count: number };

interface ActivityResponse {
  start: string;
  end: string;
  login: ActivityEntry[];
  upload: ActivityEntry[];
  download: ActivityEntry[];
}

const TAB_CONFIG: Record<ActivityKind, {
  label: string;
  cells: [string, string, string, string, string];
  description: string;
}> = {
  login: {
    label: "登录",
    cells: ["#edf2f6", "#cce8e2", "#8ed2c5", "#43ad9c", "#0f766e"],
    description: "最近 12 个月 · 每格代表一天，颜色越深代表当天登录次数越多",
  },
  upload: {
    label: "上传",
    cells: ["#edf2f6", "#d7e8f7", "#a7caea", "#679dcf", "#2e6fa8"],
    description: "最近 12 个月 · 每格代表一天，颜色越深代表当天完成上传任务越多",
  },
  download: {
    label: "下载",
    cells: ["#edf2f6", "#f7ead3", "#ebd09f", "#d7ad60", "#b47b1f"],
    description: "最近 12 个月 · 每格代表一天，颜色越深代表当天完成下载任务越多",
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDay(offset: number): string {
  return new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
}

function parseDay(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

function formatDate(value: string): string {
  const parsed = parseDay(value);
  return `${parsed.getUTCMonth() + 1} 月 ${parsed.getUTCDate()} 日`;
}

export function HomeActivity() {
  const [kind, setKind] = React.useState<ActivityKind>("login");
  const heatmapRef = React.useRef<HTMLDivElement>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["home", "activity"],
    queryFn: () => api<ActivityResponse>("/api/me/activity", { params: { days: 365 } }),
    staleTime: 60_000,
  });

  const entries = data?.[kind] ?? [];
  const config = TAB_CONFIG[kind];
  const counts = React.useMemo(() => new Map(entries.map((entry) => [entry.date, entry.count])), [entries]);
  const max = Math.max(1, ...entries.map((entry) => entry.count));
  const latest = entries.length ? entries[entries.length - 1].date : "";
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  const activeDays = entries.filter((entry) => entry.count > 0).length;

  const start = data ? parseDay(data.start) : parseDay(isoDay(-364));
  const end = data ? parseDay(data.end) : parseDay(isoDay(0));
  const leading = start.getUTCDay();
  const dayCount = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1);
  const columns = Math.ceil((dayCount + leading) / 7);
  const monthLabels = React.useMemo(() => {
    const labels: { label: string; column: number }[] = [];
    let previousMonth = -1;
    for (let index = 0; index < columns; index += 1) {
      const date = addDays(start, index * 7 - leading);
      if (date > end) break;
      const month = date.getUTCMonth();
      if (month !== previousMonth) {
        labels.push({ label: `${month + 1}月`, column: index });
        previousMonth = month;
      }
    }
    return labels;
  }, [columns, end, leading, start]);

  React.useEffect(() => {
    const element = heatmapRef.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [data, kind, columns]);

  return (
    <section className="flex min-w-0 flex-col rounded-xl border bg-card shadow-sm">
      <div className="flex h-[50px] shrink-0 items-center justify-between gap-3 border-b px-5">
        <h2 className="text-sm font-semibold tracking-tight">活跃度</h2>
        <div className="flex items-center gap-0.5 rounded-lg border bg-muted/30 p-0.5">
          {(Object.keys(TAB_CONFIG) as ActivityKind[]).map((item) => (
            <button
              key={item}
              type="button"
              className={cn(
                "rounded-md px-2.5 py-1 text-[10px] font-semibold transition-colors",
                kind === item ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setKind(item)}
            >
              {TAB_CONFIG[item].label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex min-h-[250px] flex-1 items-center justify-center text-sm text-muted-foreground">正在加载活跃度…</div>
      ) : isError ? (
        <div className="flex min-h-[250px] flex-1 items-center justify-center text-sm text-muted-foreground">暂时无法读取活跃度</div>
      ) : (
        <div className="flex flex-1 flex-col justify-center px-5 py-3">
          <div className="mb-1 flex items-center justify-between text-[9px] text-muted-foreground">
            <span>{formatDate(data?.start ?? isoDay(-364))}</span>
            <span>{formatDate(data?.end ?? isoDay(0))}</span>
          </div>
          <div ref={heatmapRef} className="relative min-w-0 overflow-x-auto pb-0.5 pt-3">
            <div className="relative flex min-w-[500px] gap-[2px]">
              {Array.from({ length: columns }).map((_, column) => (
                <div key={column} className="grid grid-rows-7 gap-[2px]">
                  {Array.from({ length: 7 }).map((__, row) => {
                    const index = column * 7 + row - leading;
                    if (index < 0 || index >= dayCount) return <span key={row} className="h-[9px] w-[9px]" />;
                    const day = addDays(start, index);
                    const key = day.toISOString().slice(0, 10);
                    const count = counts.get(key) ?? 0;
                    const level = count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
                    return (
                      <span
                        key={row}
                        title={`${key} · ${count} 次`}
                        className="h-[9px] w-[9px] rounded-[2px]"
                        style={{ backgroundColor: config.cells[level] }}
                      />
                    );
                  })}
                </div>
              ))}
              <div className="pointer-events-none absolute inset-x-0 top-0 h-3">
                {monthLabels.map((item) => (
                  <span key={`${item.label}-${item.column}`} className="absolute text-[8px] text-muted-foreground" style={{ left: `${item.column * 11}px` }}>{item.label}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid shrink-0 grid-cols-3">
        <div className="px-5 py-2.5"><span className="block text-[10px] text-muted-foreground">活跃天数</span><b className="mt-0.5 block text-xl font-semibold tabular-nums">{activeDays}</b></div>
        <div className="border-l px-5 py-2.5"><span className="block text-[10px] text-muted-foreground">总次数</span><b className="mt-0.5 block text-xl font-semibold tabular-nums">{total}</b></div>
        <div className="border-l px-5 py-2.5"><span className="block text-[10px] text-muted-foreground">最近活跃</span><b className="mt-0.5 block truncate text-xs font-medium">{latest ? formatDate(latest) : "暂无"}</b></div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-5 py-2 text-[10px] text-muted-foreground">
        <span>{config.description}</span>
        <span className="flex items-center gap-1">少
          {config.cells.map((color) => <i key={color} className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: color }} />)}
          多
        </span>
      </div>
    </section>
  );
}
