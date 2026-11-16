import * as React from "react";
import { ChevronDown, KeyRound, LogOut } from "lucide-react";

import { ChangePasswordDialog } from "@/components/common/ChangePasswordDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth";

function roleLabel(role: string | undefined): string {
  if (role === "system_admin") return "系统管理员";
  if (role === "admin") return "运营管理员";
  return "普通用户";
}

/** Avatar + name trigger with the account actions below it. */
export function UserMenu() {
  const { user, offline, logout } = useAuth();
  const [passwordOpen, setPasswordOpen] = React.useState(false);

  if (!user) return null;
  const displayName = user.name || user.username || "用户";
  const initial = displayName.slice(0, 1).toUpperCase() || "?";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`用户菜单：${displayName}`}
            className="group inline-flex h-9 max-w-[190px] items-center gap-2 rounded-md px-1.5 text-foreground/80 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {user.avatar_url ? (
              <img
                src={user.avatar_url}
                alt=""
                className="h-7 w-7 shrink-0 rounded-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
                {initial}
              </span>
            )}
            <span className="hidden max-w-28 truncate text-sm sm:inline">{displayName}</span>
            <ChevronDown className="hidden h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180 sm:block" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="w-60">
          <div className="px-2 py-2">
            <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              @{user.username} · {roleLabel(user.role)}
            </p>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={offline}
            onSelect={() => {
              // Open after the menu closes so the dialog receives focus.
              window.setTimeout(() => setPasswordOpen(true), 0);
            }}
          >
            <KeyRound className="mr-2 h-4 w-4" />
            修改密码
          </DropdownMenuItem>
          {offline && (
            <p className="px-2 pb-1 text-[11px] leading-4 text-muted-foreground">离线状态下不可修改密码</p>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => { void logout(); }}>
            <LogOut className="mr-2 h-4 w-4" />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </>
  );
}
