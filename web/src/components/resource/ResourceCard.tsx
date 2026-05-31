import * as React from "react";
import {
  Check,
  Download,
  Eye,
  GitBranch,
  ImageOff,
  Loader2,
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
import { Resource, Show, ShowResourceAccessible } from "@/lib/types";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export interface ResourceCardProps {
  resource: Resource;
  onOpen?: (resource: Resource) => void;
  onEdit?: (resource: Resource) => void;
  onNewVersion?: (resource: Resource) => void;
  onDownload?: (resource: Resource) => void;
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
}: ResourceCardProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const version = resource.current;
  const preview = version?.preview_url || version?.original_preview_url || null;
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
    (show: Show) => show.resources.some((r) => r.id === resource.id),
    [resource.id],
  );

  const handleAddToShow = React.useCallback(
    async (show: Show) => {
      try {
        const detail = await api<{ show: Show }>(`/api/shows/${show.id}`);
        const currentIds = detail.show.resources
          .filter((r): r is ShowResourceAccessible => r.accessible === true)
          .map((r) => r.id);

        if (currentIds.includes(resource.id)) {
          toast.info("该资源已在放映中");
          return;
        }

        await api(`/api/shows/${show.id}/resources`, {
          method: "PUT",
          json: { resource_ids: [...currentIds, resource.id] },
        });

        toast.success(`已添加到「${show.name}」`);
        queryClient.invalidateQueries({ queryKey: ["shows"] });
        setAddOpen(false);
      } catch (err) {
        toast.error((err as Error)?.message || "添加失败");
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
      className="group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted">
        {preview ? (
          <img
            src={preview}
            alt={resource.name}
            loading="lazy"
            className="h-full w-full object-cover"
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
              {onDownload && (
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

      <div className="px-3 py-2.5">
        <h3 className="line-clamp-1 text-[13px] font-medium">{resource.name}</h3>
      </div>
    </article>
  );
}
