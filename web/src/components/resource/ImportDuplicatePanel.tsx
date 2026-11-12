import * as React from "react";
import { CheckCircle2, Loader2, Maximize2, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type DuplicateAction = "reuse" | "iterate" | "overwrite" | "new";

export interface DuplicateChoice {
  action: DuplicateAction;
  resourceId: number | null;
}

export interface DuplicateMatch {
  resource_id: number;
  name: string;
  version_no: number;
  distance: number;
  preview_url: string;
  compare_preview_url?: string;
  owner_name: string;
  tags?: string;
  used_by_shows: number;
  text_checked?: boolean;
  content_changed?: boolean;
  text_state?: "same" | "changed" | "uncompared" | "image_only";
  text_diff?: string;
}

export interface DuplicateItem {
  index: number;
  matches: DuplicateMatch[];
}

export interface DuplicatesResponse {
  status: "warming" | "ready";
  total: number;
  checked: number;
  remaining: number;
  text_remaining?: number;
  items: DuplicateItem[];
}

const ACTION_HINTS: Record<DuplicateAction, string> = {
  reuse: "沿用已有素材，不导入这页的新内容",
  iterate: "给已有素材新增一个版本，已有放映仍使用旧版本",
  overwrite: "直接替换已有素材当前版本，引用它的放映会立即看到新内容，不能撤销",
  new: "另建一个素材，已有素材完全不动",
};

const ACTION_LABELS: Record<DuplicateAction, string> = {
  reuse: "复用已有素材",
  iterate: "迭代为新版本",
  overwrite: "覆盖当前版本",
  new: "作为新素材",
};

interface ImportDuplicatePanelProps {
  status: "idle" | "checking" | "warming" | "ready" | "error";
  data: DuplicatesResponse | null;
  error: string | null;
  skipped: boolean;
  choices: Record<number, DuplicateChoice>;
  pagePreviewUrl: (index: number) => string;
  onChoiceChange: (index: number, choice: DuplicateChoice) => void;
  onApplyAll: (action: DuplicateAction) => void;
  onSkip: () => void;
  disabled?: boolean;
}

export function ImportDuplicatePanel({
  status, data, error, skipped, choices, pagePreviewUrl, onChoiceChange, onApplyAll, onSkip, disabled,
}: ImportDuplicatePanelProps) {
  const [confirmOverwrite, setConfirmOverwrite] = React.useState(false);
  const [compareIndex, setCompareIndex] = React.useState<number | null>(null);
  const [filter, setFilter] = React.useState<"all" | "changed" | "same" | "image" | "uncompared">("all");
  const [listPage, setListPage] = React.useState(0);
  const [compareView, setCompareView] = React.useState<"side" | "import" | "existing">("side");
  const [compareCandidateId, setCompareCandidateId] = React.useState<number | null>(null);
  const [blink, setBlink] = React.useState(false);
  const items = data?.items ?? [];
  const matches = items.filter((item) => item.matches.length > 0);
  const counts = matches.reduce<Record<DuplicateAction, number>>(
    (result, item) => {
      const action = choices[item.index]?.action ?? "reuse";
      result[action] += 1;
      return result;
    },
    { reuse: 0, iterate: 0, overwrite: 0, new: 0 },
  );
  const progress = data && data.total > 0 ? Math.min(100, Math.round((data.checked / data.total) * 100)) : 0;
  const PAGE_SIZE = 20;
  const matchOf = (item: DuplicateItem) => {
    const selected = choices[item.index]?.resourceId;
    return item.matches.find((match) => match.resource_id === selected) ?? item.matches[0];
  };
  const stateOf = (item: DuplicateItem) => {
    const match = matchOf(item);
    return match?.text_state
      ?? (match?.content_changed ? "changed" : match?.text_checked ? "same" : "image_only");
  };
  const stateLabel = (state: string) => state === "same" ? "文字一致" : state === "changed" ? "文字有变化" : state === "uncompared" ? "文字未比对" : "仅图像比对";
  const imageDiffPercent = (distance: number) => Math.round((distance / 64) * 100);
  const changedCount = matches.filter((item) => stateOf(item) === "changed").length;
  const sameCount = matches.filter((item) => stateOf(item) === "same").length;
  const imageCount = matches.filter((item) => stateOf(item) === "image_only").length;
  const uncomparedCount = matches.filter((item) => stateOf(item) === "uncompared").length;
  const filtered = matches.filter((item) => {
    if (filter === "changed") return stateOf(item) === "changed";
    if (filter === "same") return stateOf(item) === "same";
    if (filter === "image") return stateOf(item) === "image_only";
    if (filter === "uncompared") return stateOf(item) === "uncompared";
    return true;
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(listPage, pageCount - 1);
  const visibleItems = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  React.useEffect(() => { setListPage(0); }, [filter]);

  const compareItem = items.find((item) => item.index === compareIndex);
  const compareMatch = compareItem?.matches.find((match) => match.resource_id === compareCandidateId) ?? compareItem?.matches[0];
  const comparePosition = compareMatch ? (compareItem?.matches.findIndex((match) => match.resource_id === compareMatch.resource_id) ?? -1) : -1;

  React.useEffect(() => {
    if (compareIndex === null || !blink) return;
    const timer = window.setInterval(() => {
      setCompareView((current) => (current === "import" ? "existing" : "import"));
    }, 700);
    return () => window.clearInterval(timer);
  }, [compareIndex, blink]);

  const openCompare = (index: number, resourceId?: number) => {
    const item = items.find((entry) => entry.index === index);
    const selected = resourceId ?? choices[index]?.resourceId ?? item?.matches[0]?.resource_id ?? null;
    setCompareCandidateId(selected);
    setCompareIndex(index);
    setCompareView("side");
    setBlink(false);
  };

  const moveCompareCandidate = (delta: number) => {
    const candidates = compareItem?.matches ?? [];
    const target = candidates[comparePosition + delta];
    if (!target) return;
    setCompareCandidateId(target.resource_id);
    setBlink(false);
  };

  const applyCompareCandidate = () => {
    if (compareIndex === null || !compareMatch) return;
    const currentAction = choices[compareIndex]?.action ?? "reuse";
    onChoiceChange(compareIndex, {
      action: currentAction === "new" ? "reuse" : currentAction,
      resourceId: compareMatch.resource_id,
    });
    setCompareIndex(null);
    setBlink(false);
  };

  return (
    <div className="grid gap-3" aria-label="重复页面检查">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {counts.reuse > 0 && <Badge variant="outline">复用 {counts.reuse}</Badge>}
          {counts.iterate > 0 && <Badge variant="outline">迭代 {counts.iterate}</Badge>}
          {counts.overwrite > 0 && <Badge variant="outline" className="border-amber-300 text-amber-700">覆盖 {counts.overwrite}</Badge>}
          {counts.new > 0 && <Badge variant="outline">新建 {counts.new}</Badge>}
        </div>
        {!skipped && (
          <div className="flex flex-wrap items-center gap-1.5">
            {matches.length > 0 && (
              <>
                <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onApplyAll("iterate")}>全部迭代</Button>
                <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setConfirmOverwrite(true)}>全部覆盖</Button>
                <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onApplyAll("new")}>全部新建</Button>
                <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onApplyAll("reuse")}>全部复用</Button>
              </>
            )}
            {(status === "checking" || status === "warming") && (
              <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onSkip}>跳过查重</Button>
            )}
          </div>
        )}
      </div>

      {matches.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="筛选重复页面">
            {([
              ["all", "全部", matches.length],
              ["changed", "内容有变化", changedCount],
              ["same", "文字一致", sameCount],
              ["image", "仅图像比对", imageCount],
              ...(uncomparedCount > 0 ? [["uncompared", "文字未比对", uncomparedCount] as const] : []),
            ] as const).map(([key, label, count]) => (
              <Button
                key={key}
                type="button"
                size="sm"
                variant={filter === key ? "secondary" : "ghost"}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label} <span className="ml-1 tabular-nums text-muted-foreground">{count}</span>
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            显示 {filtered.length === 0 ? 0 : safePage * PAGE_SIZE + 1}–{Math.min(filtered.length, (safePage + 1) * PAGE_SIZE)} / {filtered.length} 页
            <span className="ml-2">全部操作应用于所有 {matches.length} 页</span>
          </p>
        </div>
      )}

      {confirmOverwrite && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          <span>全部覆盖会直接替换这些已有素材的当前版本内容，不能撤销。确定吗？</span>
          <Button type="button" size="sm" variant="destructive" onClick={() => { onApplyAll("overwrite"); setConfirmOverwrite(false); }}>确认全部覆盖</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmOverwrite(false)}>取消</Button>
        </div>
      )}

      {(status === "checking" || status === "warming") && !skipped && (
        <div className="mt-2" role="status" aria-live="polite">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {status === "checking" ? "正在比对素材库…" : `首次使用需为素材库建立指纹，已完成 ${data?.checked ?? 0}/${data?.total ?? 0}`}
          </p>
          {status === "warming" && data && data.total > 0 && (
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={data.total} aria-valuenow={data.checked}>
              <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>
      )}

      {skipped && <p className="mt-2 text-xs text-muted-foreground">已跳过查重，本次导入会为每一页新建素材。</p>}
      {status === "error" && (
        <p role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-destructive">
          查重失败：{error || "未知错误"}
          <Button type="button" size="sm" variant="ghost" onClick={onSkip} disabled={disabled}><RefreshCw className="mr-1 h-3.5 w-3.5" />跳过查重</Button>
        </p>
      )}
      {status === "ready" && !skipped && matches.length === 0 && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />没有发现与素材库重复的页面
        </p>
      )}

      {counts.overwrite > 0 && (
        <p className="mt-2 text-xs text-amber-700">覆盖会直接替换已有素材当前版本的内容，不能撤销；有生效分享链接的素材会被拒绝。</p>
      )}
      {!skipped && matches.length > 0 && (
        <>
        <ul className="space-y-2">
          {visibleItems.map((item) => {
            const match = matchOf(item);
            const choice = choices[item.index] ?? { action: "reuse", resourceId: match.resource_id };
            const state = stateOf(item);
            const changed = state === "changed";
            const uncompared = state === "uncompared";
            const imageOnly = state === "image_only";
            return (
              <li key={item.index} className="flex flex-wrap items-center gap-3 rounded-md border bg-background p-3">
                <figure className="shrink-0">
                  <button type="button" aria-label={`放大对比第 ${item.index + 1} 页（本次导入）`} title="点击放大对比" onClick={() => openCompare(item.index, match.resource_id)} className="group relative block cursor-zoom-in">
                    <img src={pagePreviewUrl(item.index)} alt={`第 ${item.index + 1} 页`} className="h-20 w-32 rounded-sm border bg-muted object-contain sm:h-24 sm:w-40" />
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-sm bg-black/35 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                      <Maximize2 className="h-5 w-5 text-white" />
                    </span>
                  </button>
                  <figcaption className="mt-1 text-center text-[10px] text-muted-foreground">本次导入</figcaption>
                </figure>
                <span className="text-sm text-muted-foreground">↔</span>
                <figure className="shrink-0">
                  <button type="button" aria-label={`放大对比第 ${item.index + 1} 页（素材库已有）`} title="点击放大对比" onClick={() => openCompare(item.index, match.resource_id)} className="group relative block cursor-zoom-in">
                    <img src={match.preview_url} alt={match.name} className="h-20 w-32 rounded-sm border bg-muted object-contain sm:h-24 sm:w-40" loading="lazy" />
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-sm bg-black/35 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                      <Maximize2 className="h-5 w-5 text-white" />
                    </span>
                  </button>
                  <figcaption className="mt-1 text-center text-[10px] text-muted-foreground">素材库已有</figcaption>
                </figure>
                <div className="min-w-0 flex-1 space-y-1.5 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="h-6 gap-1 px-2 text-[11px] font-normal" title={`dHash 差异 ${match.distance}/64，越小越相似`}>
                      图片差异 {Math.round((match.distance / 64) * 100)}%
                    </Badge>
                    <Badge
                      variant={changed || uncompared ? "outline" : "secondary"}
                      className={cn("h-6 gap-1 px-2 text-[11px] font-normal", (changed || uncompared) && "border-amber-300 text-amber-700")}
                    >
                      {changed ? "文字有变化" : uncompared ? "文字未比对" : imageOnly ? "仅图像比对" : "文字一致"}
                    </Badge>
                  </div>
                  <p className="truncate font-medium" title={`第 ${item.index + 1} 页 ${match.distance <= 2 ? "高度相似" : match.distance <= 4 ? "较相似" : "有些相似"}于《${match.name}》`}>
                    第 {item.index + 1} 页 {match.distance <= 2 ? "高度相似" : match.distance <= 4 ? "较相似" : "有些相似"}于《{match.name}》
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    v{match.version_no} · {match.owner_name || "未知创建者"} · 被 {match.used_by_shows} 个放映引用
                    {match.tags ? ` · 标签：${match.tags}` : ""}
                  </p>
                  <p
                    className={cn("truncate text-xs", changed ? "text-amber-700" : "text-muted-foreground")}
                    title={changed && match.text_diff ? `差异：${match.text_diff}` : undefined}
                  >
                    差异：{changed ? (match.text_diff || "文字内容不同") : uncompared ? "文字尚未比对，默认按新素材处理" : imageOnly ? "无文字可比对，仅按图像判断" : "文字一致"}
                  </p>
                  {item.matches.length > 1 && (
                    <button
                      type="button"
                      className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                      onClick={() => openCompare(item.index, match.resource_id)}
                    >
                      还有 {item.matches.length - 1} 个相同素材，点开切换
                    </button>
                  )}
                </div>
                <div className="flex w-48 shrink-0 flex-col gap-1">
                  <Select
                    value={choice.action}
                    disabled={disabled}
                    onValueChange={(action) => onChoiceChange(item.index, {
                      action: action as DuplicateAction,
                      resourceId: action === "new" ? null : match.resource_id,
                    })}
                  >
                    <SelectTrigger className="h-9 w-full" aria-label={`第 ${item.index + 1} 页处理方式`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="reuse">{ACTION_LABELS.reuse}</SelectItem>
                      <SelectItem value="iterate">{ACTION_LABELS.iterate}</SelectItem>
                      <SelectItem value="overwrite">{ACTION_LABELS.overwrite}</SelectItem>
                      <SelectItem value="new">{ACTION_LABELS.new}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] leading-4 text-muted-foreground">{ACTION_HINTS[choice.action]}</p>
                </div>
              </li>
            );
          })}
        </ul>
        {filtered.length === 0 && (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">当前筛选没有页面</p>
        )}
        {pageCount > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>第 {safePage + 1} / {pageCount} 页</span>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={safePage === 0} onClick={() => setListPage((page) => Math.max(0, page - 1))}>上一页</Button>
              <Button type="button" size="sm" variant="outline" disabled={safePage + 1 >= pageCount} onClick={() => setListPage((page) => Math.min(pageCount - 1, page + 1))}>下一页</Button>
            </div>
          </div>
        )}
        </>
      )}

      <Dialog open={compareIndex !== null} onOpenChange={(open) => { if (!open) { setCompareIndex(null); setBlink(false); } }}>
        <DialogContent className="max-w-6xl">
          <DialogHeader>
            <DialogTitle>第 {(compareIndex ?? 0) + 1} 页对比 · {compareMatch?.name ?? ""}</DialogTitle>
            <DialogDescription>
              {compareMatch?.text_state === "uncompared" ? "文字尚未比对，建议先确认这个候选" : compareMatch?.content_changed ? "图片相近，文字内容有变化" : compareMatch?.text_checked ? "图片和文字都比较接近" : "没有可提取的文字，仅按图片比对"}
            </DialogDescription>
            {compareMatch?.content_changed && <p className="text-xs text-amber-700">文字差异：{compareMatch.text_diff || "文字内容不同"}</p>}
            {compareMatch?.text_state === "uncompared" && <p className="text-xs text-amber-700">文字未比对：无法从 PPT 提取文字，或候选文字仍在读取。</p>}
          </DialogHeader>
          {compareItem && compareItem.matches.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/20 p-2">
              <span className="mr-1 text-xs text-muted-foreground">素材库候选（{comparePosition + 1}/{compareItem.matches.length}）</span>
              <Button type="button" size="sm" variant="outline" disabled={comparePosition <= 0} onClick={() => moveCompareCandidate(-1)}>上一个</Button>
              <Button type="button" size="sm" variant="outline" disabled={comparePosition >= compareItem.matches.length - 1} onClick={() => moveCompareCandidate(1)}>下一个</Button>
              {compareItem.matches.map((candidate, index) => {
                const candidateState = candidate.text_state
                  ?? (candidate.content_changed ? "changed" : candidate.text_checked ? "same" : "image_only");
                return (
                  <Button
                    key={candidate.resource_id}
                    type="button"
                    size="sm"
                    variant={candidate.resource_id === compareMatch?.resource_id ? "default" : "outline"}
                    className="max-w-[260px]"
                    onClick={() => { setCompareCandidateId(candidate.resource_id); setBlink(false); }}
                  >
                    <span className="truncate">{index + 1}. {candidate.name} · {imageDiffPercent(candidate.distance)}% · {stateLabel(candidateState)}</span>
                  </Button>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-md border p-1" role="group" aria-label="对比视图">
              <Button type="button" size="sm" variant={compareView === "side" ? "default" : "ghost"} onClick={() => { setBlink(false); setCompareView("side"); }}>并排</Button>
              <Button type="button" size="sm" variant={compareView === "import" ? "default" : "ghost"} onClick={() => { setBlink(false); setCompareView("import"); }}>本次导入</Button>
              <Button type="button" size="sm" variant={compareView === "existing" ? "default" : "ghost"} onClick={() => { setBlink(false); setCompareView("existing"); }}>素材库已有</Button>
            </div>
            <Button type="button" size="sm" variant={blink ? "default" : "outline"} onClick={() => { setBlink((value) => !value); setCompareView("import"); }}>
              {blink ? "停止闪烁" : "闪烁对比"}
            </Button>
          </div>
          {compareMatch && compareIndex !== null ? (
            compareView === "side" ? (
              <div className="grid gap-3 lg:grid-cols-2">
                <figure>
                  <img src={pagePreviewUrl(compareIndex)} alt={`第 ${compareIndex + 1} 页（本次导入）`} className="max-h-[60vh] w-full rounded border bg-muted object-contain" />
                  <figcaption className="mt-1 text-center text-xs text-muted-foreground">本次导入</figcaption>
                </figure>
                <figure>
                  <img src={compareMatch.compare_preview_url || compareMatch.preview_url} alt={compareMatch.name} className="max-h-[60vh] w-full rounded border bg-muted object-contain" />
                  <figcaption className="mt-1 text-center text-xs text-muted-foreground">素材库已有 · {compareMatch.name}</figcaption>
                </figure>
              </div>
            ) : (
              <figure>
                <img
                  src={compareView === "import" ? pagePreviewUrl(compareIndex) : (compareMatch.compare_preview_url || compareMatch.preview_url)}
                  alt={compareView === "import" ? `第 ${compareIndex + 1} 页（本次导入）` : compareMatch.name}
                  className="max-h-[65vh] w-full rounded border bg-muted object-contain"
                />
                <figcaption className="mt-1 text-center text-xs text-muted-foreground">{compareView === "import" ? "本次导入" : `素材库已有 · ${compareMatch.name}`}</figcaption>
              </figure>
            )
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => { setCompareIndex(null); setBlink(false); }}>关闭</Button>
            <Button type="button" disabled={!compareMatch || disabled} onClick={applyCompareCandidate}>
              选为处理目标
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
