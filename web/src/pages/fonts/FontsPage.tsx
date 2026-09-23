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
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { FontUploadDialog } from "@/components/font/FontUploadDialog";
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
          className="group mt-1 flex max-w-[320px] items-center gap-1.5 text-left text-xs leading-5 text-muted-foreground transition-colors hover:text-foreground"
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
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="page-title">标准字体</h1>
            <Badge variant="secondary" className="rounded-md px-2 text-[11px]">{fonts.length} 个字体</Badge>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {isAdmin ? "统一管理字体资源，上传后可按需安装到服务器。" : "浏览字体资源并下载到本机使用。"}
          </p>
        </div>
        {isAdmin && (
          <Button size="sm" className="h-9 shrink-0 gap-1.5" onClick={() => setUploadOpen(true)}>
            <Upload className="h-3.5 w-3.5" />上传字体
          </Button>
        )}
      </header>

      <section className="grid grid-cols-3 divide-x rounded-md border bg-card shadow-sm" aria-label="字体统计">
        <div className="min-w-0 px-3 py-2.5 sm:px-4">
          <div className="truncate text-[11px] font-medium text-muted-foreground">字体总数</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{fonts.length}</div>
        </div>
        <div className="min-w-0 px-3 py-2.5 sm:px-4">
          <div className="truncate text-[11px] font-medium text-muted-foreground">服务器已安装</div>
          <div className="mt-1 flex items-center gap-1.5 text-lg font-semibold tabular-nums">
            <Server className="h-4 w-4 text-primary" />{installedCount}
          </div>
        </div>
        <div className="min-w-0 px-3 py-2.5 sm:px-4">
          <div className="truncate text-[11px] font-medium text-muted-foreground">可检索别名</div>
          <div className="mt-1 flex items-center gap-1.5 text-lg font-semibold tabular-nums">
            <Tags className="h-4 w-4 text-muted-foreground" />{aliasCount}
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-2 shadow-sm">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索字体名称、别名或文件名"
            className={cn(
              "h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm shadow-sm outline-none transition",
              "placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              query.trim() !== "" && "border-primary/40 bg-primary/5",
            )}
          />
        </div>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {filtered.length === fonts.length ? `共 ${fonts.length} 条` : `筛选后 ${filtered.length} / ${fonts.length} 条`}
        </span>
        <div className={cn("ml-auto flex items-center gap-2", selected.size > 0 && "rounded-md bg-primary/5 px-1.5 py-0.5")}>
          {selected.size > 0 && <span className="text-xs font-medium text-primary">已选 {selected.size} 项</span>}
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
              onClick={() => {
                if (window.confirm(`确认删除选中的 ${selected.size} 个字体？`)) {
                  bulkDeleteMut.mutate(Array.from(selected));
                }
              }}
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
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-10">
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
                  <TableHead>文件</TableHead>
                  <TableHead>服务器</TableHead>
                  <TableHead className="hidden lg:table-cell">上传者</TableHead>
                  <TableHead className="hidden md:table-cell">创建时间</TableHead>
                  <TableHead className="w-32 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((font) => {
                  return (
                    <TableRow key={font.id}>
                      <TableCell><Checkbox checked={selected.has(font.id)} onCheckedChange={(checked) => setPageSelection(Boolean(checked), [font.id])} aria-label={`选择字体 ${font.family}`} /></TableCell>
                      <TableCell className="py-3">
                        <div className="max-w-[260px] truncate font-medium" title={font.family}>{font.family}</div>
                        <AliasList aliases={font.aliases || []} family={font.family} />
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate text-sm text-muted-foreground" title={font.file_name}>{font.file_name}</TableCell>
                      <TableCell>
                        {font.installed_on_server ? <Badge variant="success" className="gap-1 text-[11px]"><Server className="h-3 w-3" />已安装</Badge> : <Badge variant="outline" className="gap-1 text-[11px] text-muted-foreground"><HardDriveDownload className="h-3 w-3" />未安装</Badge>}
                      </TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">{font.uploaded_by || "-"}</TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{font.created_at || "-"}</TableCell>
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
                                  onClick={() => {
                                    if (window.confirm(`确认删除字体 ${font.family}？`)) deleteFontMut.mutate(font.id);
                                  }}
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
    </div>
  );
}
