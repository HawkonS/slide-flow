import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  ChevronRight,
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
  Tag,
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
  key: string;
  to: string;
  label: string;
  icon: React.ElementType;
};

/** 导航项注册表（图标与路径固定，标签与排序从 store 动态读取） */
const NAV_ICONS: Record<string, React.ElementType> = {
  resources: FolderOpen,
  templates: LayoutTemplate,
  shows: Monitor,
  fonts: Type,
  links: Link2,
  manage_resources: Settings,
  manage_tasks: ListTodo,
  manage_offline: HardDrive,
  manage_downloads: Download,
  manage_tags: Tag,
  admin_users: Users,
  admin_templates: LayoutTemplate,
  admin_fonts: Type,
  admin_links: Link2,
  admin_system: SlidersHorizontal,
};

/** 默认标签（回退值） */
const DEFAULT_LABELS: Record<string, string> = {
  home: "首页",
  resources: "资源仓库",
  templates: "模板仓库",
  shows: "放映仓库",
  fonts: "字体仓库",
  links: "链接仓库",
  manage_resources: "资源管理",
  manage_tasks: "任务管理",
  manage_offline: "离线缓存",
  manage_downloads: "下载记录",
  manage_tags: "标签管理",
  admin_users: "用户管理",
  admin_templates: "模板管理",
  admin_fonts: "字体管理",
  admin_links: "链接管理",
  admin_system: "系统管理",
  section_material: "素材",
  section_manage: "维护",
  section_system: "系统",
};

/** 分组成员定义（key + 路径） */
const SECTION_MEMBERS: Record<string, { key: string; to: string }[]> = {
  material: [
    { key: "resources", to: "/resources" },
    { key: "templates", to: "/templates" },
    { key: "shows", to: "/shows" },
    { key: "fonts", to: "/fonts" },
    { key: "links", to: "/links" },
  ],
  manage: [
    { key: "manage_resources", to: "/manage/resources" },
    { key: "manage_tasks", to: "/manage/tasks" },
    { key: "manage_offline", to: "/manage/offline-cache" },
    { key: "manage_downloads", to: "/manage/downloads" },
    { key: "manage_tags", to: "/manage/tags" },
  ],
  system: [
    { key: "admin_users", to: "/admin/users" },
    { key: "admin_templates", to: "/admin/templates" },
    { key: "admin_fonts", to: "/admin/fonts" },
    { key: "admin_links", to: "/admin/links" },
    { key: "admin_system", to: "/admin/system" },
  ],
};

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

function CollapsibleSection({
  title,
  children,
  defaultOpen = true,
  forceOpen,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  return (
    <div className="px-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
        {title}
      </button>
      {open && <div className="mt-0.5 flex flex-col gap-0.5">{children}</div>}
    </div>
  );
}

function SectionLabel({ title }: { title: string }) {
  return (
    <div className="px-3">
      <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth();
  const location = useLocation();
  const versionCommit = useSiteConfig((s) => s.versionCommit);
  const versionUpdatedAt = useSiteConfig((s) => s.versionUpdatedAt);
  const navLabels = useSiteConfig((s) => s.navLabels);
  const navOrder = useSiteConfig((s) => s.navOrder);

  const isAdmin = user?.role === "admin" || user?.role === "super_admin";
  const isSuperAdmin = user?.role === "super_admin";
  const isHomeActive = location.pathname.startsWith("/home");
  const isOnSystemRoute = location.pathname.startsWith("/admin");

  const getLabel = (key: string): string => navLabels[key] || DEFAULT_LABELS[key] || key;

  // 动态构建分组导航数组，并按 navOrder 排序
  const materialNav = useMemo<NavItem[]>(
    () =>
      SECTION_MEMBERS.material
        .map((m) => ({ key: m.key, to: m.to, label: getLabel(m.key), icon: NAV_ICONS[m.key] || FolderOpen }))
        .sort((a, b) => (navOrder[a.key] ?? 99) - (navOrder[b.key] ?? 99)),
    [navLabels, navOrder],
  );

  const manageNav = useMemo<NavItem[]>(
    () => {
      // 下载记录仅 admin 可见
      const members = isAdmin
        ? SECTION_MEMBERS.manage
        : SECTION_MEMBERS.manage.filter((m) => m.key !== "manage_downloads");
      return members
        .map((m) => ({ key: m.key, to: m.to, label: getLabel(m.key), icon: NAV_ICONS[m.key] || Settings }))
        .sort((a, b) => (navOrder[a.key] ?? 99) - (navOrder[b.key] ?? 99));
    },
    [navLabels, navOrder, isAdmin],
  );

  const systemNav = useMemo<NavItem[]>(
    () => {
      const members = isSuperAdmin
        ? SECTION_MEMBERS.system
        : SECTION_MEMBERS.system.filter((m) => m.key !== "admin_system");
      return members
        .map((m) => ({ key: m.key, to: m.to, label: getLabel(m.key), icon: NAV_ICONS[m.key] || Users }))
        .sort((a, b) => (navOrder[a.key] ?? 99) - (navOrder[b.key] ?? 99));
    },
    [navLabels, navOrder, isSuperAdmin],
  );

  return (
    <div className="flex h-full flex-col">
      {/* 常驻首页 */}
      <div className="shrink-0 px-3 pt-3 pb-1">
        <div onClick={onNavigate}>
          <NavLink
            to="/home"
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
              isHomeActive
                ? "bg-[hsl(var(--primary-weak))] font-medium text-primary"
                : "text-foreground/70 hover:bg-accent hover:text-foreground",
            )}
          >
            <Home className="h-4 w-4 shrink-0" />
            <span>{getLabel("home")}</span>
          </NavLink>
        </div>
      </div>

      {/* 中部可滚动区域 */}
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        {/* 素材 - 始终展开 */}
        <div className="mt-1">
          <SectionLabel title={getLabel("section_material")} />
          <div className="mt-0.5 flex flex-col gap-0.5 px-3">
            {materialNav.map((item) => (
              <div key={item.to} onClick={onNavigate}>
                <NavItemLink item={item} />
              </div>
            ))}
          </div>
        </div>

        {/* 维护 - 始终展开 */}
        <div className="mt-3">
          <SectionLabel title={getLabel("section_manage")} />
          <div className="mt-0.5 flex flex-col gap-0.5 px-3">
            {manageNav.map((item) => (
              <div key={item.to} onClick={onNavigate}>
                <NavItemLink item={item} />
              </div>
            ))}
          </div>
        </div>

        {/* 系统 - 默认折叠 */}
        {isAdmin && (
          <div className="mt-3">
            <CollapsibleSection title={getLabel("section_system")} defaultOpen={false} forceOpen={isOnSystemRoute}>
              {systemNav.map((item) => (
                <div key={item.to} onClick={onNavigate}>
                  <NavItemLink item={item} />
                </div>
              ))}
            </CollapsibleSection>
          </div>
        )}
      </div>

      {/* 底部版本号 - 固定不动 */}
      <div className="shrink-0 px-3 py-3 text-center text-[11px] leading-relaxed text-muted-foreground/70">
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
        <aside className="hidden w-56 shrink-0 flex-col overflow-y-auto border-r bg-card md:flex scrollbar-hide">
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
