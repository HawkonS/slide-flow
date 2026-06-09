import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search, X } from "lucide-react";

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
import { useUrlPage } from "@/lib/use-url-page";
import { cn } from "@/lib/utils";

// ==================== 类型定义 ====================

interface DownloadRecord {
  id: number;
  track_code: string;
  user_name: string;
  user_username: string;
  show_name: string;
  show_id: number;
  download_type: string;
  client_ip: string;
  downloaded_at: string;
}

interface DownloadRecordsResponse {
  total: number;
  page: number;
  page_size: number;
  items: DownloadRecord[];
}

// ==================== 下载类型映射 ====================

const DOWNLOAD_TYPE_LABEL: Record<string, string> = {
  pdf: "PDF",
  pptx_images: "纯图PPT",
  pptx: "合并PPT",
  pptx_fonts: "合并PPT+字体",
  zip: "逐个PPT",
  zip_fonts: "逐个PPT+字体",
};

// ==================== 组件 ====================

export function AdminDownloadsPage() {
  const [trackCodeInput, setTrackCodeInput] = React.useState("");
  const [trackCode, setTrackCode] = React.useState("");
  const [page, setPage] = useUrlPage();
  const pageSize = 20;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["admin", "download-records", trackCode, page, pageSize],
    queryFn: async () =>
      api<DownloadRecordsResponse>("/api/admin/download-records", {
        params: {
          track_code: trackCode || undefined,
          page,
          page_size: pageSize,
        },
      }),
  });

  const handleSearch = () => {
    setTrackCode(trackCodeInput.trim());
    setPage(1);
  };

  const handleClear = () => {
    setTrackCodeInput("");
    setTrackCode("");
    setPage(1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const items = data?.items ?? [];
  const pageStart = (page - 1) * pageSize;

  return (
    <div className="flex h-full flex-col gap-4">
      {/* 页头 */}
      <header className="flex items-center gap-4">
        <h1 className="text-xl font-semibold tracking-tight">下载记录</h1>
      </header>

      {/* 搜索栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={trackCodeInput}
            onChange={(e) => setTrackCodeInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入6位追踪码"
            maxLength={6}
            className={cn(
              "h-8 w-48 rounded-full border bg-background pl-7 pr-3 text-sm shadow-sm outline-none transition",
              "placeholder:text-muted-foreground",
              "focus:border-primary/60 focus:ring-2 focus:ring-primary/20",
              trackCodeInput.trim() !== "" && "border-primary/40 bg-primary/5",
            )}
          />
        </div>
        <Button size="sm" className="h-8 gap-1.5 px-3 text-sm" onClick={handleSearch}>
          <Search className="h-3.5 w-3.5" />
          查询
        </Button>
        {trackCodeInput.trim() !== "" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-muted-foreground"
            onClick={handleClear}
          >
            <X className="h-3.5 w-3.5" />
            清除
          </Button>
        )}
      </div>

      {/* 数据表格 */}
      {isLoading ? (
        <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
        </div>
      ) : isError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          加载失败：{(error as Error)?.message || "未知错误"}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-md border border-dashed py-16 text-center text-sm text-muted-foreground">
          暂无下载记录
        </div>
      ) : (
        <div className="rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>追踪码</TableHead>
                <TableHead>用户</TableHead>
                <TableHead>放映组</TableHead>
                <TableHead>下载类型</TableHead>
                <TableHead>客户端 IP</TableHead>
                <TableHead>下载时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((record) => (
                <TableRow key={record.id}>
                  <TableCell>
                    <span className="font-mono text-sm">{record.track_code}</span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {record.user_name} ({record.user_username})
                  </TableCell>
                  <TableCell className="text-sm">{record.show_name}</TableCell>
                  <TableCell className="text-sm">
                    {DOWNLOAD_TYPE_LABEL[record.download_type] || record.download_type}
                  </TableCell>
                  <TableCell className="font-mono text-sm text-muted-foreground">
                    {record.client_ip}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {record.downloaded_at}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 分页 */}
      {!isLoading && !isError && items.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t pt-3 text-sm text-muted-foreground">
          <span>
            显示 {pageStart + 1}-{Math.min(pageStart + pageSize, total)}，共 {total} 条
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
    </div>
  );
}

export default AdminDownloadsPage;
