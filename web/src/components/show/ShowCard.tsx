import * as React from "react";
import {
  Copy,
  Eye,
  GitBranch,
  Layers,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isAdminRole, Show, ShowResourceAccessible } from "@/lib/types";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export interface ShowCardProps {
  show: Show;
  onOpen?: (show: Show) => void;
  onEdit?: (show: Show) => void;
  onDuplicate?: (show: Show) => void;
  onIterate?: () => void;
  onDelete?: (show: Show) => void;
  onToggleStandard?: (show: Show) => void;
}

export function ShowCard({ show, onOpen, onEdit, onDuplicate, onIterate, onDelete, onToggleStandard }: ShowCardProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const accessibleResources = show.resources.filter(
    (r): r is ShowResourceAccessible => r.accessible === true
  );

  const firstPreview =
    accessibleResources[0]?.preview_url || accessibleResources[0]?.original_preview_url || null;
  const secondPreview =
    accessibleResources[1]?.preview_url || accessibleResources[1]?.original_preview_url || null;

  const hasResources = show.resources.length > 0;
  const hasAccessible = accessibleResources.length > 0;
  const canManage = show.can_manage;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen?.(show);
    }
  };

  const handleTogglePin = React.useCallback(async () => {
    try {
      if (show.is_pinned) {
        await api(`/api/me/pins/shows/${show.id}`, { method: "DELETE" });
        toast.success("已取消置顶");
      } else {
        await api(`/api/me/pins/shows/${show.id}`, { method: "POST" });
        toast.success("已置顶到首页");
      }
      queryClient.invalidateQueries({ queryKey: ["shows"] });
      queryClient.invalidateQueries({ queryKey: ["home", "pins"] });
      queryClient.invalidateQueries({ queryKey: ["home", "stats"] });
    } catch (err) {
      toast.error((err as Error)?.message || "操作失败");
    }
  }, [show.id, show.is_pinned, queryClient]);

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(show)}
      onKeyDown={handleKeyDown}
      className="group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted">
        {/* 没有资源时显示空状态 */}
        {!hasResources ? (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Layers className="h-8 w-8" />
          </div>
        ) : /* 有资源但全部不可访问时显示灰色背景 */
        !hasAccessible ? (
          <div className="flex h-full w-full items-center justify-center bg-muted-foreground/10 text-muted-foreground">
            <Layers className="h-8 w-8 opacity-40" />
          </div>
        ) : (
          <>
            {/* 第二张（底层，稍微偏移） */}
            {secondPreview && (
              <div className="absolute inset-0 translate-x-1 translate-y-1 rounded bg-muted-foreground/10">
                <img
                  src={secondPreview}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover opacity-60"
                />
              </div>
            )}
            {/* 第一张（顶层） */}
            {firstPreview ? (
              <img
                src={firstPreview}
                alt={show.name}
                loading="lazy"
                className="relative h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                <Layers className="h-8 w-8" />
              </div>
            )}
          </>
        )}

        {/* 版本徽章 */}
        {show.has_other_versions && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-black/50 px-1.5 py-0.5 text-[11px] font-medium text-white">
            <GitBranch className="h-3 w-3" />
            v{show.version_no}
          </span>
        )}

        {show.is_standard && (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded bg-primary/90 px-1.5 py-0.5 text-[11px] font-medium text-primary-foreground">
            <Star className="h-3 w-3 fill-current" /> 标准放映
          </span>
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
              <DropdownMenuItem onSelect={() => onOpen?.(show)}>
                <Eye className="mr-2 h-4 w-4" /> 查看详情
              </DropdownMenuItem>
              {user && (
                <DropdownMenuItem onSelect={() => handleTogglePin()}>
                  {show.is_pinned ? (
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
              {onToggleStandard && isAdminRole(user?.role) && (
                <DropdownMenuItem onSelect={() => onToggleStandard(show)}>
                  {show.is_standard ? (
                    <><StarOff className="mr-2 h-4 w-4" /> 取消标准放映</>
                  ) : (
                    <><Star className="mr-2 h-4 w-4" /> 设为标准放映</>
                  )}
                </DropdownMenuItem>
              )}
              {canManage && (
                <>
                  <DropdownMenuSeparator />
                  {onEdit && (
                    <DropdownMenuItem onSelect={() => onEdit(show)}>
                      <Pencil className="mr-2 h-4 w-4" /> 编辑信息
                    </DropdownMenuItem>
                  )}
                  {onDuplicate && (
                    <DropdownMenuItem onSelect={() => onDuplicate(show)}>
                      <Copy className="mr-2 h-4 w-4" /> 创建副本
                    </DropdownMenuItem>
                  )}
                  {onIterate && (
                    <DropdownMenuItem onSelect={() => onIterate()}>
                      <GitBranch className="mr-2 h-4 w-4" /> 版本迭代
                    </DropdownMenuItem>
                  )}
                  {onDelete && (
                    <DropdownMenuItem
                      onSelect={() => onDelete(show)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="mr-2 h-4 w-4" /> 删除
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="px-3 py-2.5">
        <h3 className="line-clamp-1 text-[13px] font-medium">{show.name}</h3>
      </div>
    </article>
  );
}
