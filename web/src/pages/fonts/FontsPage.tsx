import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Loader2, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";

interface FontListResponse {
  fonts: FontItem[];
}

export function FontsPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["fonts"],
    queryFn: async () => api<FontListResponse>("/api/fonts"),
  });

  const [query, setQuery] = React.useState("");

  const fonts = data?.fonts ?? [];
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fonts;
    return fonts.filter((f) =>
      `${f.family} ${f.file_name} ${(f.aliases || []).join(" ")}`.toLowerCase().includes(q),
    );
  }, [fonts, query]);

  // 分页：根据内容区高度动态计算每页行数
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = React.useState(10);
  React.useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const compute = () => {
      const H = el.clientHeight;
      if (!H) return;
      const headerH = 45; // 表头行高度（含底部 border）
      const rowH = 57; // 每行约 p-4 + 单行内容
      const rows = Math.max(5, Math.floor((H - headerH) / rowH));
      setPageSize((prev) => (prev === rows ? prev : rows));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [page, setPage] = React.useState(1);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  React.useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);
  React.useEffect(() => {
    setPage(1);
  }, [query]);
  const pageStart = (page - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);

  const handleDownload = async (font: FontItem) => {
    try {
      await downloadWithProgress(font.download_url, font.file_name || "font");
      toast.success("下载完成");
    } catch (err) {
      toast.error((err as Error).message || "下载失败");
    }
  };

  return (
    <div className="flex h-full flex-col gap-8">
      {/* 页头：与资源仓库/模板仓库一致（左标题+描述，右总数徽章） */}
      <header className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">字体仓库</h1>
          <p className="text-xs text-muted-foreground">
            字体由管理员统一上传维护，登录用户均可下载使用。
          </p>
        </div>
        <span className="inline-flex h-6 items-center rounded-full bg-muted px-2.5 text-xs text-muted-foreground">
          {filtered.length === fonts.length
            ? `共 ${fonts.length} 条`
            : `筛选后 ${filtered.length} / ${fonts.length} 条`}
        </span>
      </header>

      {/* 筛选栏：仅保留搜索框，上传能力由管理员端承载 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索字体、别名、文件名"
            className={cn(
              "h-8 w-56 rounded-full border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition",
              "placeholder:text-muted-foreground",
              "focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              query.trim() !== "" && "border-primary/40 bg-primary/5",
            )}
          />
        </div>
      </div>

      {/* 内容区：占剩余空间，根据可视高度动态行数 */}
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
          <div className="rounded-md border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>字体</TableHead>
                  <TableHead>文件</TableHead>
                  <TableHead className="w-32 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((f) => {
                  const otherAliases = (f.aliases || []).filter((a) => a && a !== f.family);
                  return (
                    <TableRow key={String(f.id)}>
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
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" onClick={() => handleDownload(f)}>
                          <Download className="mr-1 h-3.5 w-3.5" />
                          下载
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* 分页条：粘底常驻（有数据时显示） */}
      {!isLoading && !isError && filtered.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t pt-3 text-sm text-muted-foreground">
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
            <span className="min-w-[52px] text-center text-foreground">
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
    </div>
  );
}
