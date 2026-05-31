import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Download,
  FolderOpen,
  HardDrive,
  Home,
  LayoutTemplate,
  Link2,
  ListTodo,
  LogOut,
  Menu,
  Monitor,
  Settings,
  SlidersHorizontal,
  Type,
  Users,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useSiteConfig } from "@/stores/site-config";
import { useAuth } from "@/lib/auth";
import { ForceChangePassword } from "@/components/common/ForceChangePassword";
import {
  SheetRoot,
  SheetTrigger,
  SheetContent,
} from "@/components/ui/sheet";

type NavItem = {
  to: string;
  label: string;
  icon: React.ElementType;
};

const homeNav: NavItem[] = [
  { to: "/home", label: "用户首页", icon: Home },
];

const materialNav: NavItem[] = [
  { to: "/resources", label: "资源仓库", icon: FolderOpen },
  { to: "/templates", label: "模板仓库", icon: LayoutTemplate },
  { to: "/shows", label: "放映仓库", icon: Monitor },
  { to: "/fonts", label: "字体仓库", icon: Type },
  { to: "/links", label: "链接仓库", icon: Link2 },
];

const systemNav: NavItem[] = [
  { to: "/admin/users", label: "用户管理", icon: Users },
  { to: "/admin/templates", label: "模板管理", icon: LayoutTemplate },
  { to: "/admin/fonts", label: "字体管理", icon: Type },
  { to: "/admin/links", label: "链接管理", icon: Link2 },
];

const superAdminNav: NavItem[] = [
  { to: "/admin/system", label: "系统管理", icon: SlidersHorizontal },
];

const manageNav: NavItem[] = [
  { to: "/manage/resources", label: "资源管理", icon: Settings },
  { to: "/manage/tasks", label: "任务管理", icon: ListTodo },
  { to: "/manage/offline-cache", label: "离线缓存", icon: HardDrive },
];

const manageAdminNav: NavItem[] = [
  { to: "/manage/downloads", label: "下载记录", icon: Download },
];

function NavItemLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm text-foreground/80 transition-colors hover:bg-accent",
          isActive &&
            "bg-[hsl(var(--primary-weak))] font-medium text-primary hover:bg-[hsl(var(--primary-weak))]",
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span>{item.label}</span>
    </NavLink>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth();
  const versionCommit = useSiteConfig((s) => s.versionCommit);
  const versionUpdatedAt = useSiteConfig((s) => s.versionUpdatedAt);

  return (
    <div className="flex h-full flex-col">
      {/* 首页 */}
      <div className="px-3 py-3">
        {homeNav.map((item) => (
          <div key={item.to} onClick={onNavigate}>
            <NavItemLink item={item} />
          </div>
        ))}
      </div>

      {/* 素材 */}
      <div className="mt-2 px-3">
        <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          素材
        </div>
        <div className="flex flex-col gap-1.5">
          {materialNav.map((item) => (
            <div key={item.to} onClick={onNavigate}>
              <NavItemLink item={item} />
            </div>
          ))}
        </div>
      </div>

      {/* 维护 */}
      <div className="mt-4 px-3">
        <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          维护
        </div>
        <div className="flex flex-col gap-1.5">
          {manageNav.map((item) => (
            <div key={item.to} onClick={onNavigate}>
              <NavItemLink item={item} />
            </div>
          ))}
          {(user?.role === "admin" || user?.role === "super_admin") &&
            manageAdminNav.map((item) => (
              <div key={item.to} onClick={onNavigate}>
                <NavItemLink item={item} />
              </div>
            ))}
        </div>
      </div>

      {/* 系统 */}
      {(user?.role === "admin" || user?.role === "super_admin") && (
        <div className="mt-4 px-3">
          <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            系统
          </div>
          <div className="flex flex-col gap-1.5">
            {systemNav.map((item) => (
              <div key={item.to} onClick={onNavigate}>
                <NavItemLink item={item} />
              </div>
            ))}
            {user?.role === "super_admin" &&
              superAdminNav.map((item) => (
                <div key={item.to} onClick={onNavigate}>
                  <NavItemLink item={item} />
                </div>
              ))}
          </div>
        </div>
      )}

      {/* 底部版本号 */}
      <div className="mt-auto px-3 py-4 text-center text-xs text-muted-foreground">
        {versionCommit && <div>{versionCommit}</div>}
        {versionUpdatedAt && <div>最后更新: {versionUpdatedAt}</div>}
      </div>
    </div>
  );
}

export function AppShell() {
  const location = useLocation();
  const { user, logout } = useAuth();
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    setSheetOpen(false);
  }, [location.pathname]);

  const userDisplayName = user?.display_name || user?.name || user?.username || "";
  const userRoleText =
    user?.role === "super_admin"
      ? "超级管理员"
      : user?.role === "admin"
        ? "系统管理员"
        : "系统用户";

  const siteName = useSiteConfig((s) => s.siteName);
  const logoSvgPath = useSiteConfig((s) => s.logoSvgPath);
        
  return (
    <div className="flex h-screen flex-col bg-background">
      {/* 顶部栏 */}
      <header className="flex h-14 shrink-0 items-center border-b bg-card px-4 md:px-6">
        {/* 移动端：汉堡按钮 */}
        <div className="md:hidden">
          <SheetRoot open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground/80 hover:bg-accent"
                aria-label="打开菜单"
              >
                <Menu className="h-5 w-5" />
              </button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[260px] p-0">
              <div className="flex h-full flex-col">
                {/* 移动端 Sheet 顶部 logo */}
                <div className="flex items-center gap-2 border-b px-4 py-3">
                  <img
                    src={logoSvgPath}
                    alt="logo"
                    className="h-6 w-6"
                  />
                  <span className="text-sm font-semibold">{siteName}</span>
                </div>
                <div className="flex-1 overflow-y-auto py-2">
                  <SidebarContent onNavigate={() => setSheetOpen(false)} />
                </div>
              </div>
            </SheetContent>
          </SheetRoot>
        </div>

        {/* Logo + 应用名（桌面端左侧，移动端居中） */}
        <div className="flex items-center gap-2 md:mr-auto">
          <img
            src={logoSvgPath}
            alt="logo"
            className="hidden h-7 w-7 md:block"
          />
          <span className="text-[15px] font-semibold md:ml-0">{siteName}</span>
        </div>

        {/* 右侧用户信息 */}
        <div className="ml-auto flex items-center gap-3 text-sm md:gap-5">
          {user && (
            <span className="text-foreground/80">
              {userDisplayName}
              <span className="mx-1 text-muted-foreground">·</span>
              {userRoleText}
            </span>
          )}
          {user && (
            <button
              type="button"
              onClick={() => logout()}
              className="inline-flex items-center gap-1 text-foreground/70 hover:text-primary"
            >
              <LogOut className="h-4 w-4 md:hidden" />
              <span className="hidden md:inline">退出</span>
            </button>
          )}
        </div>
      </header>

      {/* 下方内容区 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 桌面端固定 Sidebar */}
        <aside className="hidden w-56 shrink-0 flex-col overflow-y-auto border-r bg-card md:flex">
          <SidebarContent />
        </aside>

        {/* 主内容 */}
        <main className="flex flex-1 flex-col min-h-0 overflow-x-hidden overflow-y-auto px-4 py-4 md:px-6 md:py-5">
          <Outlet />
        </main>
      </div>

      {/* 强制修改密码弹窗 */}
      <ForceChangePassword />
    </div>
  );
}
