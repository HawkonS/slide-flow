import * as React from "react";
import { ExternalLink, MoreHorizontal } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/lib/types";
import { NETWORK_ENV_LABEL } from "@/lib/constants";

const NETWORK_ENV_BADGE_VARIANT: Record<
  string,
  "default" | "secondary" | "outline"
> = {
  company_intranet: "default",
  private_cloud: "secondary",
  public_net: "outline",
};

export interface LinkCardProps {
  link: Link;
  onEdit?: (link: Link) => void;
  onDelete?: (link: Link) => void;
}

export function LinkCard({ link, onEdit, onDelete }: LinkCardProps) {
  const canManage = link.can_manage;

  const handleCardClick = () => {
    window.open(link.url, "_blank", "noopener,noreferrer");
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleCardClick();
    }
  };

  const initial = (link.name || "?")[0].toUpperCase();
  const networkLabel = NETWORK_ENV_LABEL[link.network_env] ?? link.network_env;

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleKeyDown}
      className="group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* 预览区域：首字母头像 + 操作菜单 */}
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted">
        <div className="flex h-full w-full items-center justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-xl font-semibold text-primary">
            {initial}
          </div>
        </div>

        {/* 网络环境标签 */}
        <div className="absolute left-2 top-2">
          <Badge
            variant={NETWORK_ENV_BADGE_VARIANT[link.network_env] ?? "outline"}
            className="text-[10px] px-1.5 py-0"
          >
            {networkLabel}
          </Badge>
        </div>

        {/* 操作菜单 */}
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
              <DropdownMenuItem onSelect={handleCardClick}>
                <ExternalLink className="mr-2 h-4 w-4" />
                打开链接
              </DropdownMenuItem>
              {canManage && (
                <>
                  <DropdownMenuSeparator />
                  {onEdit && (
                    <DropdownMenuItem onSelect={() => onEdit(link)}>编辑</DropdownMenuItem>
                  )}
                  {onDelete && (
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => onDelete(link)}
                    >
                      删除
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* 信息区域 */}
      <div className="px-3 py-2.5">
        <h3 className="line-clamp-1 text-[13px] font-medium">{link.name}</h3>
        <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground group-hover:text-primary group-hover:underline">
          {link.url}
        </p>
        {link.memo && (
          <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
            {link.memo}
          </p>
        )}
      </div>

      {/* 底部：所有者 */}
      <div className="mt-auto border-t px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground">
          {link.owner?.name || link.owner?.username || "未知"}
        </span>
      </div>
    </article>
  );
}
