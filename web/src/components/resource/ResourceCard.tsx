import * as React from "react";
import {
  Check,
  Download,
  Eye,
  GitBranch,
  ImageOff,
  Loader2,
  Maximize,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Resource, Show } from "@/lib/types";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export interface ResourceCardProps {
  resource: Resource;
  onOpen?: (resource: Resource) => void;
  onEdit?: (resource: Resource) => void;
  onNewVersion?: (resource: Resource) => void;
  onDownload?: (resource: Resource) => void;
  onFullscreen?: (resource: Resource) => void;
}

interface ShowListResponse {
  items: Show[];
}

export function ResourceCard({
  resource,
  onOpen,
  onEdit,
  onNewVersion,
  onDownload,
  onFullscreen,
}: ResourceCardProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const version = resource.current;
  const preview = version?.preview_url || null;
  const canManage = resource.can_manage;

  const [addOpen, setAddOpen] = React.useState(false);

  const { data: showsData, isLoading: showsLoading } = useQuery({
    queryKey: ["shows"],
    queryFn: async () => api<ShowListResponse>("/api/shows"),
    enabled: addOpen && !!user,
    staleTime: 60_000,
  });

  const manageableShows = React.useMemo(() => {
    return showsData?.items?.filter((s) => s.can_manage) ?? [];
  }, [showsData]);

  const isInShow = React.useCallback(
    (show: Show) => {
      // 优先使用后端返回的完整资源 ID 列表，回退到 lite 接口仅返回的前 2 个预览
      if (Array.isArray(show.all_resource_ids)) {
        return show.all_resource_ids.includes(resource.id);
      }
      return show.resources.some((r) => r.id === resource.id);
    },
    [resource.id],
  );

  const handleAddToShow = React.useCallback(
    async (show: Show) => {
      try {
        // 使用后端原子追加接口，一次调用完成，避免 GET→PUT 竞态
        const result = await api<{ show: Show; added: boolean }>(
          `/api/shows/${show.id}/resources/append`,
          {
            method: "POST",
            json: { resource_id: resource.id },
          },
        );

        if (result.added) {
          toast.success(`已添加到「${show.name}」`);
        } else {
          toast.info(`该资源已在「${show.name}」中`);
        }

        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["shows"] }),
          queryClient.invalidateQueries({ queryKey: ["shows", show.id] }),
          queryClient.invalidateQueries({ queryKey: ["show", show.id] }),
          queryClient.invalidateQueries({ queryKey: ["home", "pins"] }),
          queryClient.invalidateQueries({ queryKey: ["home", "stats"] }),
        ]);
        // 刷新完成后再关闭菜单，确保下次打开时能立即看到灰色状态
        setAddOpen(false);
      } catch (err) {
        const message = (err as Error)?.message || "添加失败";
        toast.error(message);
      }
    },
    [resource.id, queryClient],
  );

  const handleTogglePin = React.useCallback(async () => {
    try {
      if (resource.is_pinned) {
        await api(`/api/me/pins/resources/${resource.id}`, { method: "DELETE" });
        toast.success("已取消置顶");
      } else {
        await api(`/api/me/pins/resources/${resource.id}`, { method: "POST" });
        toast.success("已置顶到首页");
      }
      queryClient.invalidateQueries({ queryKey: ["resources"] });
      queryClient.invalidateQueries({ queryKey: ["home", "pins"] });
      queryClient.invalidateQueries({ queryKey: ["home", "stats"] });
    } catch (err) {
      toast.error((err as Error)?.message || "操作失败");
    }
  }, [resource.id, resource.is_pinned, queryClient]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen?.(resource);
    }
  };

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(resource)}
      onKeyDown={handleKeyDown}
      className="group relative flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm transition hover:border-foreground/20 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted">
        {preview ? (
          <img
            src={preview}
            alt={resource.name}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="block h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <ImageOff className="h-8 w-8" />
          </div>
        )}

        <div className="absolute right-2 top-2 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="更多操作"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background/90 text-foreground shadow-sm hover:bg-background"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onSelect={() => onOpen?.(resource)}>
                <Eye className="mr-2 h-4 w-4" /> 查看详情
              </DropdownMenuItem>
              {onFullscreen && (
                <DropdownMenuItem onSelect={() => onFullscreen(resource)}>
                  <Maximize className="mr-2 h-4 w-4" /> 放大查看
                </DropdownMenuItem>
              )}
              {resource.can_manage && onDownload && (
                <DropdownMenuItem onSelect={() => onDownload(resource)}>
                  <Download className="mr-2 h-4 w-4" /> 下载
                </DropdownMenuItem>
              )}
              {user && (
                <DropdownMenuItem onSelect={() => handleTogglePin()}>
                  {resource.is_pinned ? (
                    <>
                      <PinOff className="mr-2 h-4 w-4" /> 取消置顶
                    </>
                  ) : (
                    <>
                      <Pin className="mr-2 h-4 w-4" /> 置顶首页
                    </>
                  )}
                </DropdownMenuItem>
              )}
              {canManage && (
                <>
                  <DropdownMenuSeparator />
                  {onEdit && (
                    <DropdownMenuItem onSelect={() => onEdit(resource)}>
                      <Pencil className="mr-2 h-4 w-4" /> 编辑信息
                    </DropdownMenuItem>
                  )}
                  {onNewVersion && (
                    <DropdownMenuItem onSelect={() => onNewVersion(resource)}>
                      <GitBranch className="mr-2 h-4 w-4" /> 版本迭代
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {user && (
          <div className="absolute right-2 bottom-2 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
            <DropdownMenu open={addOpen} onOpenChange={setAddOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="添加到放映"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background/90 text-foreground shadow-sm hover:bg-background"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                {showsLoading ? (
                  <DropdownMenuItem disabled>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    加载中…
                  </DropdownMenuItem>
                ) : manageableShows.length === 0 ? (
                  <DropdownMenuItem disabled>没有可管理的放映</DropdownMenuItem>
                ) : (
                  manageableShows.map((show) => {
                    const alreadyIn = isInShow(show);
                    return (
                      <DropdownMenuItem
                        key={show.id}
                        onSelect={() => handleAddToShow(show)}
                        disabled={alreadyIn}
                      >
                        <span className="flex-1 truncate">{show.name}</span>
                        {alreadyIn && <Check className="ml-2 h-3.5 w-3.5 shrink-0" />}
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <div className="h-[52px] shrink-0 overflow-hidden border-t bg-[hsl(var(--surface-subtle))] px-3 py-2.5">
        <h3 className="line-clamp-1 text-[13px] font-medium text-foreground">{resource.name}</h3>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>v{resource.current_version}</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate">{resource.subject || "未设置主体"}</span>
        </div>
      </div>
    </article>
  );
}
