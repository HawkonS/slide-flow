import { TableText } from "@/components/common/TableContent";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  HardDriveDownload,
  Loader2,
  MoreHorizontal,
  Search,
  Server,
  Tags,
  Type,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { FontUploadDialog } from "@/components/font/FontUploadDialog";
import { PageMetrics } from "@/components/common/PageMetrics";
import { PageHeader } from "@/components/common/PageHeader";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { downloadWithProgress } from "@/lib/fonts";
import { isAdminRole, type FontItem } from "@/lib/types";
import { useUrlPage } from "@/lib/use-url-page";
import { cn } from "@/lib/utils";

interface FontListResponse {
  fonts: FontItem[];
}

function getFontAliases(aliases: string[], family: string) {
  const familyKey = family.trim().toLocaleLowerCase();
  const seen = new Set<string>();

  return aliases.reduce<string[]>((result, alias) => {
    const normalized = alias.trim();
    const key = normalized.toLocaleLowerCase();
    if (!normalized || key === familyKey || seen.has(key)) return result;
    seen.add(key);
    result.push(normalized);
    return result;
  }, []);
}

function AliasList({ aliases, family }: { aliases: string[]; family: string }) {
  const visibleAliases = getFontAliases(aliases, family);

  if (visibleAliases.length === 0) return null;

  const copyAliases = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(message);
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  const preview = visibleAliases.slice(0, 2).join(" · ");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="group mt-1 flex w-full min-w-0 items-center gap-1.5 text-left text-xs leading-5 text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`查看 ${visibleAliases.length} 个字体别名`}
        >
          <span className="shrink-0 text-[11px] text-muted-foreground/70">别名</span>
          <span className="min-w-0 truncate" title={visibleAliases.join("、")}>{preview}</span>
          <span className="flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[11px] text-muted-foreground/70 group-hover:text-primary">
            {visibleAliases.length > 2 ? `共 ${visibleAliases.length} 个` : "查看"}
            <ChevronDown className="h-3 w-3" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <div className="text-sm font-semibold">字体别名</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{family} · {visibleAliases.length} 个</div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2 text-xs text-muted-foreground"
            onClick={() => copyAliases(visibleAliases.join("、"), "全部别名已复制")}
          >
            <Copy className="h-3.5 w-3.5" />复制全部
          </Button>
        </div>
        <div className="max-h-56 divide-y overflow-y-auto">
          {visibleAliases.map((alias) => (
            <div key={alias.toLocaleLowerCase()} className="group/alias flex min-h-10 items-center gap-3 px-4 py-2">
              <span className="min-w-0 flex-1 break-words text-sm text-foreground">{alias}</span>
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-60 transition hover:bg-accent hover:text-foreground group-hover/alias:opacity-100"
                onClick={() => copyAliases(alias, "别名已复制")}
                aria-label={`复制别名 ${alias}`}
                title="复制别名"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function FontsPage() {
  const { user } = useAuth();
  const isAdmin = isAdminRole(user?.role);
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["fonts"],
    queryFn: async () => api<FontListResponse>("/api/fonts"),
  });

  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [fontDeleteTarget, setFontDeleteTarget] = React.useState<FontItem | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  const fonts = data?.fonts ?? [];

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fonts;
    return fonts.filter((font) =>
      `${font.family} ${font.file_name} ${(font.aliases || []).join(" ")}`.toLowerCase().includes(q),
    );
  }, [fonts, query]);

  const installedCount = fonts.filter((font) => font.installed_on_server).length;
  const aliasCount = fonts.reduce(
    (count, font) => count + getFontAliases(font.aliases || [], font.family).length,
    0,
  );

  const deleteFontMut = useMutation({
    mutationFn: async (fontId: number) => api(`/api/admin/fonts/${fontId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("字体已删除");
      queryClient.invalidateQueries({ queryKey: ["fonts"] });
    },
    onError: (err: Error) => toast.error(err.message || "删除失败"),
  });

  const bulkDeleteMut = useMutation({
    mutationFn: async (fontIds: number[]) =>
      api<{ deleted: number }>("/api/admin/fonts/bulk-delete", {
        method: "POST",
        json: { font_ids: fontIds },
      }),
    onSuccess: (result) => {
      toast.success(`已删除 ${result.deleted} 个字体`);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["fonts"] });
    },
    onError: (err: Error) => toast.error(err.message || "批量删除失败"),
  });

  const bulkDownloadMut = useMutation({
    mutationFn: async (fontIds: number[]) =>
      downloadWithProgress(
        "/api/fonts/bulk-download",
        `标准字体_${fontIds.length}个.zip`,
        undefined,
        undefined,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ font_ids: fontIds }),
        },
      ),
    onSuccess: () => toast.success("字体包下载完成"),
    onError: (err: Error) => toast.error(err.message || "批量下载失败"),
  });

  const handleDownload = async (font: FontItem) => {
    try {
      await downloadWithProgress(font.download_url, font.file_name || "font");
      toast.success("下载完成");
    } catch (err) {
      toast.error((err as Error).message || "下载失败");
    }
  };

  const contentRef = React.useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = React.useState(10);
  React.useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const compute = () => {
      if (!element.clientHeight) return;
      const rows = Math.max(5, Math.floor((element.clientHeight - 45) / 64));
      setPageSize((current) => (current === rows ? current : rows));
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const [page, setPage] = useUrlPage();
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  React.useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, setPage, totalPages]);
  React.useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [query, setPage]);

  const pageStart = (page - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);
  const pageItemIds = pageItems.map((font) => font.id);
  const filteredIds = filtered.map((font) => font.id);
  const allSelected = pageItemIds.length > 0 && pageItemIds.every((id) => selected.has(id));
  const someSelected = pageItemIds.some((id) => selected.has(id)) && !allSelected;

  const setPageSelection = (checked: boolean, ids: number[]) => {
    setSelected((current) => {
      const next = new Set(current);
      ids.forEach((id) => (checked ? next.add(id) : next.delete(id)));
      return next;
    });
  };

  return (
    <div className="page-shell">
      <PageHeader
        title="标准字体"
        titleExtra={isAdmin ? <Badge variant="secondary" className="rounded-md px-2 text-[11px]">可维护</Badge> : null}
        description="统一管理用于 PPT 导入、渲染与导出的字体资源。"
        actions={isAdmin ? (
          <Button size="sm" className="h-9 shrink-0 gap-1.5" onClick={() => setUploadOpen(true)}>
            <Upload className="h-3.5 w-3.5" />上传字体
          </Button>
        ) : null}
      />

      <PageMetrics
        ariaLabel="字体统计"
        items={[
          { label: "字体", value: fonts.length, icon: Type },
          { label: "服务器已安装", value: installedCount, icon: Server, tone: "success" },
          { label: "可检索别名", value: aliasCount, icon: Tags },
        ]}
      />

      <div className="page-toolbar">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索字体名称、别名或文件名"
            className={cn(
              "h-8 w-full rounded-md border bg-background pl-8 pr-3 text-sm shadow-sm outline-none transition sm:w-72",
              "placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              query.trim() !== "" && "border-primary/40 bg-primary/5",
            )}
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && <span className="text-xs text-muted-foreground">已选 <span className="font-medium text-primary">{selected.size}</span> 项</span>}
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            disabled={selected.size === 0 || bulkDownloadMut.isPending}
            onClick={() => bulkDownloadMut.mutate(Array.from(selected))}
          >
            {bulkDownloadMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            批量下载
          </Button>
          {isAdmin && selected.size > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={bulkDeleteMut.isPending}
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />批量删除
            </Button>
          )}
        </div>
      </div>

      <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" />加载中…</div>
        ) : isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">加载失败：{(error as Error)?.message || "未知错误"}</div>
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">{query.trim() ? "没有匹配的字体" : "暂无字体资源"}</div>
        ) : (
          <div className="overflow-hidden rounded-md border bg-card">
            <Table className="min-w-[760px] md:min-w-[960px] lg:min-w-[1080px]">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-12">
                    <div className="flex items-center gap-0.5">
                      <Checkbox checked={allSelected ? true : someSelected ? "indeterminate" : false} onCheckedChange={(checked) => setPageSelection(Boolean(checked), pageItemIds)} aria-label="选择当前页字体" />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button type="button" className="rounded p-0.5 hover:bg-accent" aria-label="选择更多字体"><ChevronDown className="h-3 w-3 text-muted-foreground" /></button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-44">
                          <DropdownMenuItem onClick={() => setSelected(new Set(pageItemIds))}><Check className="mr-2 h-3.5 w-3.5" />全选本页</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setSelected(new Set(filteredIds))}><Check className="mr-2 h-3.5 w-3.5" />选择筛选结果 ({filteredIds.length})</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setSelected(new Set())}><X className="mr-2 h-3.5 w-3.5" />取消选择</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableHead>
                  <TableHead>字体</TableHead>
                  <TableHead className="w-56">文件</TableHead>
                  <TableHead className="w-28">服务器</TableHead>
                  <TableHead className="hidden w-32 lg:table-cell">上传者</TableHead>
                  <TableHead className="hidden w-44 md:table-cell">创建时间</TableHead>
                  <TableHead className="w-36 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((font) => {
                  return (
                    <TableRow key={font.id}>
                      <TableCell><Checkbox checked={selected.has(font.id)} onCheckedChange={(checked) => setPageSelection(Boolean(checked), [font.id])} aria-label={`选择字体 ${font.family}`} /></TableCell>
                      <TableCell className="py-3">
                        <TableText className="font-medium" text={font.family} />
                        <AliasList aliases={font.aliases || []} family={font.family} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground"><TableText text={font.file_name} /></TableCell>
                      <TableCell>
                        {font.installed_on_server ? <Badge variant="success" className="gap-1 text-[11px]"><Server className="h-3 w-3" />已安装</Badge> : <Badge variant="outline" className="gap-1 text-[11px] text-muted-foreground"><HardDriveDownload className="h-3 w-3" />未安装</Badge>}
                      </TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground lg:table-cell"><TableText text={font.uploaded_by || "-"} /></TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground md:table-cell"><TableText text={font.created_at || "-"} /></TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="outline" size="sm" onClick={() => handleDownload(font)}><Download className="mr-1 h-3.5 w-3.5" />下载</Button>
                          {isAdmin && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`管理字体 ${font.family}`}>
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-36">
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  disabled={deleteFontMut.isPending}
                                  onClick={() => setFontDeleteTarget(font)}
                                >
                                  <Trash2 className="mr-2 h-3.5 w-3.5" />删除字体
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {!isLoading && !isError && filtered.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t pt-3 text-sm text-muted-foreground select-none">
          <span>显示 {pageStart + 1}-{Math.min(pageStart + pageSize, filtered.length)}，共 {filtered.length} 条</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</Button>
            <span className="min-w-[52px] text-center text-foreground">{page} / {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>下一页</Button>
          </div>
        </div>
      )}

      {isAdmin && <FontUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} onSuccess={() => queryClient.invalidateQueries({ queryKey: ["fonts"] })} />}
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title="批量删除字体"
        description={`确定删除选中的 ${selected.size} 个字体吗？删除后，依赖这些字体的后续渲染可能需要重新上传字体。`}
        confirmLabel="删除字体"
        destructive
        loading={bulkDeleteMut.isPending}
        onConfirm={() => {
          bulkDeleteMut.mutate(Array.from(selected), { onSuccess: () => setBulkDeleteOpen(false) });
        }}
      />
      <ConfirmDialog
        open={fontDeleteTarget !== null}
        onOpenChange={(open) => { if (!open) setFontDeleteTarget(null); }}
        title="删除字体"
        description={fontDeleteTarget ? `确定删除字体「${fontDeleteTarget.family}」吗？已上传的素材文件不会被删除。` : ""}
        confirmLabel="删除字体"
        destructive
        loading={deleteFontMut.isPending}
        onConfirm={() => {
          const target = fontDeleteTarget;
          if (target) deleteFontMut.mutate(target.id, { onSuccess: () => setFontDeleteTarget(null) });
        }}
      />
    </div>
  );
}
