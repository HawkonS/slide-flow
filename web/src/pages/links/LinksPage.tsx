import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LinkCard } from "@/components/link/LinkCard";
import { LinkEditDialog } from "@/components/link/LinkEditDialog";

import { fetchLinks, deleteLink } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Link } from "@/lib/types";

export function LinksPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState("");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["links"],
    queryFn: fetchLinks,
  });

  const links = data?.links ?? [];

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return links;
    return links.filter((l) => {
      const hay = [l.name, l.url, l.memo, l.owner?.name || "", l.owner?.username || ""]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [links, search]);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editLink, setEditLink] = React.useState<Link | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);

  const handleEdit = (link: Link) => {
    setEditLink(link);
    setEditOpen(true);
  };

  const handleDelete = (link: Link) => {
    const ok = window.confirm(
      `确定要删除链接「${link.name}」吗？此操作不可恢复。`,
    );
    if (!ok) return;
    deleteLink(link.id)
      .then(() => {
        toast.success("链接已删除");
        queryClient.invalidateQueries({ queryKey: ["links"] });
      })
      .catch((err: Error) => {
        toast.error(err.message || "删除失败");
      });
  };

  return (
    <div className="flex h-full flex-col gap-4">
      {/* 页头 */}
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">链接仓库</h1>
          <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground">
            {filtered.length === links.length
              ? `共 ${links.length} 条`
              : `筛选后 ${filtered.length} / ${links.length} 条`}
          </span>
        </div>
      </header>

      {/* 搜索 + 操作按钮 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜索链接…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 text-sm"
          />
        </div>
        {user && (
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => setCreateOpen(true)}
              className="h-8 gap-1.5 rounded-full px-3 text-sm"
            >
              <Plus className="h-3.5 w-3.5" />
              新建链接
            </Button>
          </div>
        )}
      </div>

      {/* 内容区 */}
      <div className="min-h-0 flex-1 overflow-auto">
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
            {search ? "没有匹配的链接" : "暂无链接"}
          </div>
        ) : (
          <div className="grid grid-cols-2 content-start gap-x-4 gap-y-5 min-[600px]:grid-cols-3 md:grid-cols-4 md:gap-x-5 md:gap-y-6 min-[1000px]:grid-cols-5 min-[1200px]:grid-cols-6 xl:gap-x-6 xl:gap-y-7">
            {filtered.map((l) => (
              <LinkCard
                key={l.id}
                link={l}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* 对话框 */}
      <LinkEditDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        link={null}
      />

      <LinkEditDialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) setEditLink(null);
        }}
        link={editLink}
      />
    </div>
  );
}
