import * as React from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CheckCircle2, Copy, EyeOff, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface DuplicateResource {
  id: number;
  name: string;
  version_no: number;
  preview_url: string;
  owner_name: string;
  used_by_shows: number;
  created_at: string;
}

interface DuplicateShow {
  id: number;
  name: string;
  pages: number[];
  manageable: boolean;
}

interface DuplicateGroup {
  resources: DuplicateResource[];
  show_count: number;
  shows: DuplicateShow[];
  mergeable: boolean;
  reason: string | null;
  text_checked?: boolean;
  foreign_resource_count?: number;
  foreign_show_count?: number;
}

interface DuplicateScan {
  status: "warming" | "ready";
  total: number;
  checked: number;
  remaining: number;
  text_remaining?: number;
  ignored_count?: number;
  groups: DuplicateGroup[];
}

interface IgnoredGroup {
  id: number;
  group_key: string;
  resource_ids: number[];
  resources: { id: number; name: string; preview_url: string }[];
  created_at: string;
}

interface MergeResult {
  merged: number;
  deleted: number[];
  moved_pages: number;
  collapsed_pages: number;
}

export function ResourceDuplicatesPage() {
  const queryClient = useQueryClient();
  const [scan, setScan] = React.useState<DuplicateScan | null>(null);
  const [status, setStatus] = React.useState<"checking" | "warming" | "ready" | "error">("checking");
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Record<number, number>>({});
  const [confirming, setConfirming] = React.useState<number | null>(null);
  const [acknowledged, setAcknowledged] = React.useState<Record<number, boolean>>({});
  const [merging, setMerging] = React.useState<number | null>(null);
  const [ignoring, setIgnoring] = React.useState<number | null>(null);
  const [ignoredCount, setIgnoredCount] = React.useState(0);
  const [ignoredOpen, setIgnoredOpen] = React.useState(false);
  const [ignoredGroups, setIgnoredGroups] = React.useState<IgnoredGroup[]>([]);
  const [ignoredLoading, setIgnoredLoading] = React.useState(false);
  const [ignoredError, setIgnoredError] = React.useState<string | null>(null);
  const [restoring, setRestoring] = React.useState<number | null>(null);
  const [mergeError, setMergeError] = React.useState<Record<number, string>>({});
  const runRef = React.useRef(0);

  const startScan = React.useCallback(() => {
    runRef.current += 1;
    const runId = runRef.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setStatus("checking");
    setError(null);
    setConfirming(null);
    setAcknowledged({});
    const run = async () => {
      try {
        const result = await api<DuplicateScan>("/api/resources/duplicates/scan", { method: "POST" });
        if (cancelled || runRef.current !== runId) return;
        setScan(result);
        setIgnoredCount(result.ignored_count ?? 0);
        setStatus(result.status === "ready" ? "ready" : "warming");
        setSelected((previous) => {
          const next = { ...previous };
          result.groups.forEach((group, index) => {
            if (group.resources.some((resource) => resource.id === next[index])) return;
            next[index] = group.resources[0]?.id ?? 0;
          });
          return next;
        });
        if (result.status !== "ready") timer = setTimeout(run, 800);
      } catch (scanError) {
        if (cancelled || runRef.current !== runId) return;
        setError((scanError as Error).message || "扫描失败");
        setStatus("error");
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  React.useEffect(() => {
    const cleanup = startScan();
    return () => {
      runRef.current += 1;
      cleanup();
    };
  }, [startScan]);

  const mergeGroup = async (groupIndex: number) => {
    const group = scan?.groups[groupIndex];
    if (!group || !group.mergeable) return;
    const canonicalId = selected[groupIndex] ?? group.resources[0]?.id;
    if (!canonicalId) return;
    const duplicateIds = group.resources.filter((resource) => resource.id !== canonicalId).map((resource) => resource.id);
    setMerging(groupIndex);
    setConfirming(null);
    setMergeError((previous) => ({ ...previous, [groupIndex]: "" }));
    try {
      const result = await api<MergeResult>("/api/resources/duplicates/merge", {
        method: "POST",
        json: { canonical_id: canonicalId, duplicate_ids: duplicateIds, ...(acknowledged[groupIndex] ? { acknowledge_foreign: true } : {}) },
      });
      toast.success(`已合并 ${result.merged} 个重复素材：更新 ${result.moved_pages} 页、折叠 ${result.collapsed_pages} 页`);
      setScan((previous) => previous ? { ...previous, groups: previous.groups.filter((_, index) => index !== groupIndex) } : previous);
      setSelected({});
      void queryClient.invalidateQueries({ queryKey: ["resources"] });
      void queryClient.invalidateQueries({ queryKey: ["shows"] });
    } catch (mergeFailure) {
      setMergeError((previous) => ({ ...previous, [groupIndex]: (mergeFailure as Error).message || "合并失败" }));
    } finally {
      setMerging(null);
    }
  };

  const ignoreGroup = async (group: DuplicateGroup, groupIndex: number) => {
    if (merging !== null || ignoring !== null) return;
    setIgnoring(groupIndex);
    try {
      const result = await api<{ ok: boolean; id: number; ignored_count: number }>("/api/resources/duplicates/ignores", {
        method: "POST",
        json: { resource_ids: group.resources.map((resource) => resource.id) },
      });
      setScan((previous) => previous ? {
        ...previous,
        groups: previous.groups.filter((_, index) => index !== groupIndex),
        ignored_count: result.ignored_count,
      } : previous);
      setIgnoredCount(result.ignored_count);
      setSelected({});
      toast.success("已忽略此组，可在「已忽略」中恢复");
    } catch (ignoreFailure) {
      toast.error((ignoreFailure as Error).message || "忽略失败");
    } finally {
      setIgnoring(null);
    }
  };

  const openIgnored = async () => {
    setIgnoredOpen(true);
    setIgnoredLoading(true);
    setIgnoredError(null);
    try {
      const result = await api<{ items: IgnoredGroup[]; total: number }>("/api/resources/duplicates/ignores");
      setIgnoredGroups(result.items);
      setIgnoredCount(result.total);
    } catch (ignoredFailure) {
      setIgnoredError((ignoredFailure as Error).message || "读取已忽略记录失败");
    } finally {
      setIgnoredLoading(false);
    }
  };

  const restoreIgnored = async (ignoreId: number) => {
    setRestoring(ignoreId);
    try {
      const result = await api<{ ok: boolean; ignored_count: number }>(`/api/resources/duplicates/ignores/${ignoreId}`, { method: "DELETE" });
      setIgnoredGroups((previous) => previous.filter((item) => item.id !== ignoreId));
      setIgnoredCount(result.ignored_count);
      setIgnoredOpen(false);
      toast.success("已恢复该组，重新扫描后可再次处理");
      void startScan();
    } catch (restoreFailure) {
      toast.error((restoreFailure as Error).message || "恢复失败");
    } finally {
      setRestoring(null);
    }
  };

  const groups = scan?.groups ?? [];
  const progress = scan && scan.total > 0 ? Math.min(100, Math.round((scan.checked / scan.total) * 100)) : 0;

  return (
    <div className="page-shell">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" aria-label="返回单页素材" asChild>
            <Link to="/resources"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <h1 className="page-title">查重</h1>
          {status === "ready" && <Badge variant="outline">{groups.length} 组疑似重复</Badge>}
        </div>
        <div className="flex items-center gap-2">
          {ignoredCount > 0 && (
            <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => void openIgnored()}>
              <EyeOff className="h-3.5 w-3.5" />
              已忽略 {ignoredCount}
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => void startScan()} disabled={status === "checking" || status === "warming"}>
            <RefreshCw className={cn("h-3.5 w-3.5", (status === "checking" || status === "warming") && "animate-spin")} />
            重新扫描
          </Button>
        </div>
      </header>

      <p className="text-sm text-muted-foreground">
        按内容指纹比对单页素材。选定保留素材后，放映里的重复页会改为引用它；同一放映里两页都引用时会折叠为一页。
      </p>

      {(status === "checking" || status === "warming") && (
        <section className="rounded-lg border bg-card p-4" role="status" aria-live="polite">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="h-4 w-4 animate-spin" />
            {status === "checking"
              ? "正在扫描素材库…"
              : scan?.text_remaining
                ? `正在补齐文字比对，图片指纹已完成 ${scan?.checked ?? 0}/${scan?.total ?? 0}`
                : `首次扫描需要建立指纹，已完成 ${scan?.checked ?? 0}/${scan?.total ?? 0}`}
          </p>
          {scan && scan.total > 0 && (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={scan.total} aria-valuenow={scan.checked}>
              <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}
        </section>
      )}

      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">扫描失败：{error}</p>}

      {status === "ready" && groups.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <CheckCircle2 className="h-8 w-8 text-emerald-600" />
          <p className="text-sm font-medium">没有发现重复素材</p>
          <p className="text-xs text-muted-foreground">素材库里的单页内容都不相同。</p>
        </div>
      )}

      <div className="space-y-4">
        {groups.map((group, groupIndex) => {
          const canonicalId = selected[groupIndex] ?? group.resources[0]?.id;
          const canonical = group.resources.find((resource) => resource.id === canonicalId) ?? group.resources[0];
          const shows = group.shows ?? [];
          const foreignCount = (group.foreign_resource_count ?? 0) + (group.foreign_show_count ?? 0);
          const foreign = foreignCount > 0;
          const affectedPages = shows.reduce((total, show) => total + show.pages.length, 0);
          return (
            <section key={group.resources.map((resource) => resource.id).join("-")} className="rounded-xl border bg-card p-4">
              <header className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <Copy className="h-4 w-4 text-muted-foreground" />
                    {group.resources.length} 个素材疑似相同
                    <span className="text-xs font-normal text-muted-foreground">被 {group.show_count} 个放映、{affectedPages} 页引用</span>
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">选择要保留的素材；合并会删除其余素材并更新放映引用。</p>
                </div>
                {group.mergeable ? (
                  <div className="flex items-center gap-1.5">
                    {group.text_checked === false && <Badge variant="outline" className="border-amber-300 text-amber-700">仅图像比对，请核对</Badge>}
                    {foreign && <Badge variant="outline" className="border-amber-300 text-amber-700">含他人素材/放映</Badge>}
                    <Badge variant="secondary">可合并</Badge>
                  </div>
                ) : (
                  <Badge variant="outline" className="border-amber-300 text-amber-700">
                    <AlertTriangle className="mr-1 h-3 w-3" />{group.reason || "暂不可合并"}
                  </Badge>
                )}
              </header>

              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {group.resources.map((resource) => {
                  const active = resource.id === canonicalId;
                  return (
                    <button
                      key={resource.id}
                      type="button"
                      aria-pressed={active}
                      disabled={!group.mergeable || merging !== null}
                      onClick={() => { setSelected((previous) => ({ ...previous, [groupIndex]: resource.id })); setConfirming(null); }}
                      className={cn(
                        "group overflow-hidden rounded-lg border text-left transition",
                        active ? "border-primary ring-2 ring-primary/30" : "hover:border-foreground/20 hover:bg-muted/20",
                      )}
                    >
                      <div className="relative aspect-video w-full overflow-hidden bg-muted">
                        <img src={resource.preview_url} alt={resource.name} className="h-full w-full object-contain" loading="lazy" />
                        {active && <span className="absolute left-2 top-2 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">保留这个</span>}
                      </div>
                      <div className="px-3 py-2">
                        <p className="truncate text-sm font-medium">{resource.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {resource.owner_name || "未知创建者"} · v{resource.version_no} · 被 {resource.used_by_shows} 个放映引用
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>

              {shows.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>受影响的放映：</span>
                  {shows.slice(0, 6).map((show) => (
                    <Badge key={show.id} variant="outline" className="font-normal">
                      {show.name} · 第 {show.pages.join("、")} 页
                    </Badge>
                  ))}
                  {shows.length > 6 && <span>等 {shows.length} 个</span>}
                </div>
              )}

              {mergeError[groupIndex] && <p role="alert" className="mt-2 text-xs text-destructive">{mergeError[groupIndex]}</p>}
              {confirming === groupIndex && (
                <div className="mt-3 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                  <p role="alert">
                    {group.text_checked === false ? "这些页面没有可提取的文字，只能按图片比对，请仔细核对两侧图片。" : ""}
                    将保留《{canonical?.name}》，删除其余 {group.resources.length - 1} 个素材，并更新 {group.show_count} 个放映的引用（同一放映重复页会折叠）。确定继续吗？
                  </p>
                  {foreign && (
                    <label className="flex items-start gap-2 text-amber-900 dark:text-amber-200">
                      <Checkbox
                        checked={Boolean(acknowledged[groupIndex])}
                        onCheckedChange={(checked) => setAcknowledged((previous) => ({ ...previous, [groupIndex]: checked === true }))}
                        aria-label="确认包含他人素材仍要合并"
                      />
                      <span>这组里有 {group.foreign_resource_count ?? 0} 个他人素材、{group.foreign_show_count ?? 0} 个他人放映，我确认仍要合并。</span>
                    </label>
                  )}
                </div>
              )}
              <footer className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">合并不可撤销；被删素材的标签、备注、个人备注和分享会一并移除；有生效分享链接的素材需先撤销分享。</p>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={merging !== null || ignoring !== null}
                    onClick={() => void ignoreGroup(group, groupIndex)}
                  >
                    {ignoring === groupIndex ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <EyeOff className="mr-1.5 h-4 w-4" />}
                    忽略此组
                  </Button>
                  {confirming === groupIndex && <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(null)} disabled={merging !== null}>取消</Button>}
                  <Button
                    type="button"
                    size="sm"
                    variant={confirming === groupIndex ? "destructive" : "default"}
                    disabled={!group.mergeable || merging !== null || (confirming === groupIndex && foreign && !acknowledged[groupIndex])}
                    onClick={() => { if (confirming === groupIndex) void mergeGroup(groupIndex); else { setConfirming(groupIndex); setAcknowledged((previous) => ({ ...previous, [groupIndex]: false })); } }}
                  >
                    {merging === groupIndex && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                    {confirming === groupIndex ? "确认合并" : `保留《${canonical?.name}》并合并其余`}
                  </Button>
                </div>
              </footer>
            </section>
          );
        })}
      </div>

      <Dialog open={ignoredOpen} onOpenChange={setIgnoredOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>已忽略的查重组</DialogTitle>
            <DialogDescription>忽略只影响你自己的查重列表，不会删除或修改任何素材。</DialogDescription>
          </DialogHeader>
          {ignoredLoading ? (
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取…</p>
          ) : ignoredError ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{ignoredError}</p>
          ) : ignoredGroups.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">还没有忽略任何查重组。</p>
          ) : (
            <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
              {ignoredGroups.map((item) => (
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    {item.resources.slice(0, 4).map((resource) => (
                      <div key={resource.id} className="flex min-w-0 items-center gap-1.5">
                        {resource.preview_url ? (
                          <img src={resource.preview_url} alt={resource.name} className="h-10 w-16 rounded-sm border bg-muted object-contain" loading="lazy" />
                        ) : (
                          <span className="flex h-10 w-16 items-center justify-center rounded-sm border bg-muted text-[10px] text-muted-foreground">无预览</span>
                        )}
                        <span className="max-w-[120px] truncate text-xs">{resource.name}</span>
                      </div>
                    ))}
                    {item.resources.length > 4 && <span className="text-xs text-muted-foreground">等 {item.resources.length} 个</span>}
                  </div>
                  <Button type="button" size="sm" variant="outline" disabled={restoring !== null} onClick={() => void restoreIgnored(item.id)}>
                    {restoring === item.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" />}
                    恢复
                  </Button>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIgnoredOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
