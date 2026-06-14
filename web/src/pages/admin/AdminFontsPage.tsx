import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Download, FolderUp, Loader2, Search, Trash2, Upload, X } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { downloadWithProgress } from "@/lib/fonts";
import { FontItem } from "@/lib/types";
import { useUrlPage } from "@/lib/use-url-page";
import { cn } from "@/lib/utils";
import { useNavLabel } from "@/lib/nav-config";

interface FontListResponse {
  fonts: FontItem[];
}

export function AdminFontsPage() {
  const qc = useQueryClient();
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
    return fonts.filter((f) =>
      `${f.family} ${f.file_name} ${(f.aliases || []).join(" ")}`.toLowerCase().includes(q),
    );
  }, [fonts, query]);

  const filteredIds = React.useMemo(() => filtered.map((f) => f.id), [filtered]);

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };


  const delOneMut = useMutation({
    mutationFn: async (id: number) => api(`/api/admin/fonts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("字体已删除");
      qc.invalidateQueries({ queryKey: ["fonts"] });
    },
    onError: (err: Error) => toast.error(err.message || "删除失败"),
  });

  const bulkDelMut = useMutation({
    mutationFn: async (ids: number[]) =>
      api<{ deleted: number }>("/api/admin/fonts/bulk-delete", {
        method: "POST",
        json: { font_ids: ids },
      }),
    onSuccess: (data) => {
      toast.success(`已删除 ${data.deleted} 个字体`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["fonts"] });
    },
    onError: (err: Error) => toast.error(err.message || "批量删除失败"),
  });

  const handleDownload = async (font: FontItem) => {
    try {
      await downloadWithProgress(font.download_url, font.file_name || "font");
      toast.success("下载完成");
    } catch (err) {
      toast.error((err as Error).message || "下载失败");
    }
  };


  // 分页：根据内容区高度动态计算每页行数
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = React.useState(10);
  React.useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const compute = () => {
      const H = el.clientHeight;
      if (!H) return;
      const headerH = 45;
      const rowH = 57;
      const rows = Math.max(5, Math.floor((H - headerH) / rowH));
      setPageSize((prev) => (prev === rows ? prev : rows));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [page, setPage] = useUrlPage();
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  React.useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);
  React.useEffect(() => {
    setPage(1);
  }, [query]);
  const pageStart = (page - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);
  const pageItemIds = React.useMemo(() => pageItems.map((f) => f.id), [pageItems]);
  const allSelected = pageItemIds.length > 0 && pageItemIds.every((id) => selected.has(id));
  const someSelected = pageItemIds.some((id) => selected.has(id)) && !allSelected;

  return (
    <div className="flex h-full flex-col gap-4">
      {/* 页头 */}
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">{useNavLabel("admin_fonts", "字体管理")}</h1>
          <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground">
            {filtered.length === fonts.length
              ? `共 ${fonts.length} 条`
              : `筛选后 ${filtered.length} / ${fonts.length} 条`}
          </span>
        </div>
      </header>

      {/* 筛选行 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索字体、别名、文件名"
            className={cn(
              "h-8 w-full sm:w-56 rounded-full border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition",
              "placeholder:text-muted-foreground",
              "focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              query.trim() !== "" && "border-primary/40 bg-primary/5",
            )}
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <span className="text-xs text-muted-foreground">
              已选 <span className="font-medium text-primary">{selected.size}</span> 项
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            disabled={selected.size === 0 || bulkDelMut.isPending}
            onClick={() => {
              if (!window.confirm(`确认删除选中的 ${selected.size} 个字体？`)) return;
              bulkDelMut.mutate(Array.from(selected));
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            批量删除
          </Button>
        </div>
        <Button
          size="sm"
          className="h-8 gap-1.5 rounded-full px-3 text-sm"
          onClick={() => setUploadOpen(true)}
        >
          <Upload className="h-3.5 w-3.5" />
          上传字体
        </Button>
      </div>

      {/* 内容区 */}
      <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
          </div>
        ) : isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            加载失败：{(error as Error)?.message || "未知错误"}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">
            暂无字体
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <div className="flex items-center gap-0.5">
                      <Checkbox
                        checked={allSelected ? true : someSelected ? "indeterminate" : false}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelected(new Set(pageItemIds));
                          } else {
                            setSelected(new Set());
                          }
                        }}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button type="button" className="ml-0.5 rounded p-0.5 hover:bg-accent">
                            <ChevronDown className="h-3 w-3 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-40">
                          <DropdownMenuItem onClick={() => setSelected(new Set(pageItemIds))}>
                            <Check className="mr-2 h-3.5 w-3.5" />
                            全选本页
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setSelected(new Set(filteredIds))}>
                            <Check className="mr-2 h-3.5 w-3.5" />
                            选择全部 ({filteredIds.length})
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setSelected(new Set())}>
                            <X className="mr-2 h-3.5 w-3.5" />
                            取消选择
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableHead>
                  <TableHead>字体</TableHead>
                  <TableHead>文件</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="w-32 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((f) => {
                  const otherAliases = (f.aliases || []).filter((a) => a && a !== f.family);
                  return (
                    <TableRow key={f.id}>
                      <TableCell>
                        <Checkbox
                          checked={selected.has(f.id)}
                          onCheckedChange={() => toggleOne(f.id)}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{f.family}</div>
                        {otherAliases.length > 0 && (
                          <div className="text-xs text-muted-foreground">
                            别名：{otherAliases.slice(0, 3).join("、")}
                            {otherAliases.length > 3 ? ` 等 ${otherAliases.length} 个` : ""}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{f.file_name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {f.created_at || "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="outline" size="sm" onClick={() => handleDownload(f)}>
                            <Download className="mr-1 h-3.5 w-3.5" />
                            下载
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => {
                              if (window.confirm(`确认删除字体 ${f.family}？`)) {
                                delOneMut.mutate(f.id);
                              }
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
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

      {/* 分页条 */}
      {!isLoading && !isError && filtered.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t pt-3 text-sm text-muted-foreground select-none">
          <span>
            显示 {pageStart + 1}-{Math.min(pageStart + pageSize, filtered.length)}，共{" "}
            {filtered.length} 条
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <span className="min-w-[52px] text-center text-foreground select-none">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一页
            </Button>
          </div>
        </div>
      )}

      <AdminFontUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onSuccess={() => qc.invalidateQueries({ queryKey: ["fonts"] })}
      />
    </div>
  );
}

function AdminFontUploadDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSuccess: () => void;
}) {
  type Mode = "file" | "folder";
  const FONT_EXT = /\.(ttf|otf|ttc|otc)$/i;

  const [mode, setMode] = React.useState<Mode>("file");
  const [files, setFiles] = React.useState<File[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [progress, setProgress] = React.useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });

  React.useEffect(() => {
    if (!open) {
      setMode("file");
      setFiles([]);
      setLoading(false);
      setProgress({ done: 0, total: 0 });
    }
  }, [open]);

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setFiles([]);
    setProgress({ done: 0, total: 0 });
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || []);
    const filtered = list.filter((f) => FONT_EXT.test(f.name));
    setFiles(mode === "file" ? filtered.slice(0, 1) : filtered);
    e.target.value = "";
  };

  const submit = async () => {
    if (files.length === 0) {
      toast.error(mode === "folder" ? "所选文件夹未发现字体文件" : "请选择字体文件");
      return;
    }
    setLoading(true);
    let done = 0;
    const failed: string[] = [];
    setProgress({ done: 0, total: files.length });
    for (const f of files) {
      const body = new FormData();
      body.append("font_file", f);
      try {
        const res = await fetch("/api/fonts/upload", {
          method: "POST",
          credentials: "include",
          body,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.detail || "上传失败");
        }
      } catch (err) {
        failed.push(`${f.name}（${(err as Error).message || "失败"}）`);
      }
      done++;
      setProgress({ done, total: files.length });
    }
    setLoading(false);
    const ok = files.length - failed.length;
    if (ok > 0) {
      toast.success(`已上传 ${ok} 个字体${failed.length ? `，${failed.length} 个失败` : ""}`);
    }
    if (failed.length > 0) {
      toast.error(`失败：${failed.slice(0, 3).join("；")}${failed.length > 3 ? " …" : ""}`);
    }
    onSuccess();
    if (failed.length === 0) {
      onOpenChange(false);
    } else {
      setFiles([]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>上传字体</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4">
          {/* 模式二选一 */}
          <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1 text-xs">
            {(
              [
                { v: "file", label: "单个文件", icon: <Upload className="h-3.5 w-3.5" /> },
                { v: "folder", label: "整个文件夹", icon: <FolderUp className="h-3.5 w-3.5" /> },
              ] as const
            ).map((it) => {
              const active = it.v === mode;
              return (
                <button
                  key={it.v}
                  type="button"
                  disabled={loading}
                  onClick={() => switchMode(it.v)}
                  className={cn(
                    "flex h-8 items-center justify-center gap-1.5 rounded-[0.35rem] text-sm transition",
                    active
                      ? "bg-background font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                    loading && "cursor-not-allowed opacity-60",
                  )}
                >
                  {it.icon}
                  {it.label}
                </button>
              );
            })}
          </div>

          {/* 虚线拾取区 */}
          <label
            htmlFor={mode === "folder" ? "admin-font-folder-input" : "admin-font-file-input"}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed bg-muted/30 px-4 py-6 text-center transition",
              "hover:border-primary hover:bg-primary/5",
              loading && "pointer-events-none opacity-60",
            )}
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              {mode === "folder" ? (
                <FolderUp className="h-5 w-5" />
              ) : (
                <Upload className="h-5 w-5" />
              )}
            </span>
            <span className="text-sm font-medium">
              {mode === "folder" ? "点击选择文件夹" : "点击选择字体文件"}
            </span>
            <span className="text-xs text-muted-foreground">
              支持 TTF / OTF / TTC / OTC
              {mode === "folder" ? "，将自动过滤并批量上传" : ""}
            </span>
            <input
              id="admin-font-file-input"
              type="file"
              accept=".ttf,.otf,.ttc,.otc"
              className="hidden"
              onChange={onPick}
            />
            <input
              id="admin-font-folder-input"
              type="file"
              multiple
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              className="hidden"
              onChange={onPick}
            />
          </label>

          {/* 已选列表 */}
          {files.length > 0 && (
            <div className="rounded-md border bg-background">
              <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
                <span>
                  已选 <span className="font-medium text-foreground">{files.length}</span> 个字体
                </span>
                {!loading && (
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => setFiles([])}
                  >
                    清空
                  </button>
                )}
              </div>
              <ul className="max-h-40 overflow-auto px-3 py-1.5 text-xs">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="truncate py-0.5" title={f.name}>
                    {f.name}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 进度条 */}
          {loading && progress.total > 0 && (
            <div className="space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{
                    width: `${Math.round((progress.done / progress.total) * 100)}%`,
                  }}
                />
              </div>
              <div className="text-right text-xs text-muted-foreground">
                {progress.done} / {progress.total}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            取消
          </Button>
          <Button onClick={submit} disabled={loading || files.length === 0}>
            {loading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {loading ? "上传中…" : `上传${files.length > 1 ? ` ${files.length} 个` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
