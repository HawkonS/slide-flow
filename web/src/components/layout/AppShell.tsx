import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  FolderOpen,
  Home,
  AlertCircle,
  LayoutTemplate,
  ListTodo,
  LogOut,
  Menu,
  MonitorPlay,
  RefreshCw,
  Settings,
  ScrollText,
  Server,
  Share2,
  Tag,
  Type,
  Users,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { isAdminRole, isSystemAdminRole } from "@/lib/types";
import { useSiteConfig } from "@/stores/site-config";
import { useDownloadManager } from "@/stores/download-manager";
import { useAuth } from "@/lib/auth";
import { ForceChangePassword } from "@/components/common/ForceChangePassword";
import { usePwaStatus } from "@/lib/pwa";
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

/** 固定导航结构：标签和顺序由产品定义，不从配置文件读取。 */
const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "素材",
    items: [
      { key: "single-resources", to: "/resources", label: "单页素材", icon: FolderOpen },
      { key: "show-resources", to: "/manage/shows", label: "放映素材", icon: MonitorPlay },
    ],
  },
  {
    title: "模板",
    items: [
      { key: "standard-templates", to: "/templates", label: "标准模板", icon: LayoutTemplate },
      { key: "standard-fonts", to: "/fonts", label: "标准字体", icon: Type },
    ],
  },
  {
    title: "管理",
    items: [
      { key: "shares", to: "/manage/shares", label: "分享管理", icon: Share2 },
      { key: "tasks", to: "/manage/tasks", label: "任务管理", icon: ListTodo },
      { key: "tags", to: "/manage/tags", label: "标签管理", icon: Tag },
    ],
  },
  {
    title: "系统",
    items: [
      { key: "users", to: "/admin/users", label: "用户管理", icon: Users },
      { key: "runtime", to: "/admin/runtime", label: "运行管理", icon: Server },
      { key: "config", to: "/admin/config", label: "配置管理", icon: Settings },
      { key: "logs", to: "/admin/logs", label: "日志管理", icon: ScrollText },
    ],
  },
];

// 运营管理员和系统管理员都可进行运营管理与用户管理；运行管理、配置管理、
// 日志管理属于系统管理，仅系统管理员可见。
const ADMIN_ONLY_KEYS = new Set(["tags", "users"]);
const SYSTEM_ADMIN_ONLY_KEYS = new Set(["runtime", "config", "logs"]);

function NavItemLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        cn(
          "relative flex items-center gap-3 rounded-md px-3 py-2.5 text-sm text-foreground/75 transition-colors hover:bg-accent hover:text-foreground",
          isActive &&
            "bg-[hsl(var(--sidebar-active))] font-medium text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-foreground/60 hover:bg-[hsl(var(--sidebar-active))]",
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span>{item.label}</span>
    </NavLink>
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
  const { user, offline } = useAuth();
  const versionCommit = useSiteConfig((s) => s.versionCommit);
  const versionUpdatedAt = useSiteConfig((s) => s.versionUpdatedAt);
  const isAdmin = isAdminRole(user?.role);
  const isSystemAdmin = isSystemAdminRole(user?.role);
  if (offline) return (
    <div className="flex h-full flex-col px-3 py-3">
      <div onClick={onNavigate}><NavItemLink item={{ key: "offline-cache", to: "/manage/offline-cache", label: "离线缓存", icon: MonitorPlay }} /></div>
      <p className="px-3 py-3 text-xs text-muted-foreground">当前离线，仅可使用已授权的缓存放映。</p>
    </div>
  );

  return (
    <div className="flex h-full flex-col select-none">
      {/* 常驻一级入口 */}
      <div className="shrink-0 px-3 pt-3 pb-1">
        <div onClick={onNavigate}>
          <NavItemLink
            item={{ key: "home", to: "/home", label: "用户首页", icon: Home }}
          />
        </div>
        <div className="mt-0.5" onClick={onNavigate}>
          <NavItemLink
            item={{ key: "standard-show", to: "/shows", label: "标准放映", icon: MonitorPlay }}
          />
        </div>
      </div>

      {/* 中部可滚动区域 */}
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        {NAV_SECTIONS.map((section) => {
          const visible = section.items.filter((item) => {
            if (SYSTEM_ADMIN_ONLY_KEYS.has(item.key)) return isSystemAdmin;
            if (ADMIN_ONLY_KEYS.has(item.key)) return isAdmin;
            return true;
          });
          if (visible.length === 0) return null;
          return (
            <div className="mt-3" key={section.title}>
              <SectionLabel title={section.title} />
              <div className="mt-0.5 flex flex-col gap-0.5 px-3">
                {visible.map((item) => (
                  <div key={item.to} onClick={onNavigate}>
                    <NavItemLink item={item} />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
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
  const { user, logout, offline } = useAuth();
  const pwaStatus = usePwaStatus();
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    setSheetOpen(false);
  }, [location.pathname]);

  // 用户登录后初始化全局 WebSocket 连接，用于接收异步任务推送
  // 同源 WebSocket 通过 httpOnly Cookie 鉴权；用户 ID 只用于隔离事件游标。
  useEffect(() => {
    if (!user || user.must_change_pwd || offline) return;
    const userKey = String(user.id);
    useDownloadManager.getState().connect(userKey);
    return () => {
      useDownloadManager.getState().disconnect();
    };
  }, [user?.id, user?.must_change_pwd, offline]);

  const userDisplayName = user?.name || user?.username || "";
  const userRoleText =
    user?.role === "system_admin"
      ? "系统管理员"
      : user?.role === "admin"
        ? "运营管理员"
        : "普通用户";

  const siteName = useSiteConfig((s) => s.siteName);
  const logoSvgPath = useSiteConfig((s) => s.logoSvgPath);
  const pwaNeedsAttention = pwaStatus.status === "development" || pwaStatus.status === "update-available" || pwaStatus.status === "error" || pwaStatus.status === "not-deployed";
        
  return (
    <div className="flex h-screen flex-col bg-background">
      {/* 顶部栏 */}
      <header
        className="flex h-14 shrink-0 items-center border-b bg-card px-4 shadow-[0_1px_0_rgba(15,23,42,0.02)] md:px-6"
        style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
      >
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
            <SheetContent side="left" className="w-[260px] p-0" style={{ userSelect: 'none', WebkitUserSelect: 'none' }}>
              <div className="flex h-full flex-col">
                {/* 移动端 Sheet 顶部 logo */}
                <div className="flex items-center gap-2 border-b px-4 py-3">
                  {logoSvgPath && <img src={logoSvgPath} alt="" className="h-6 w-6" onError={(event) => { event.currentTarget.hidden = true; }} />}
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
          {logoSvgPath && <img src={logoSvgPath} alt="" className="hidden h-7 w-7 md:block" onError={(event) => { event.currentTarget.hidden = true; }} />}
          <span className="min-w-0 max-w-[45vw] truncate text-[15px] font-semibold md:ml-0">{siteName}</span>
        </div>

        {/* 右侧用户信息 */}
        <div className="ml-auto flex items-center gap-3 text-sm md:gap-5">
          {!offline && <NavLink
            to="/manage/offline-cache"
            aria-label={pwaStatus.message}
            title={pwaStatus.message}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition hover:bg-accent",
              pwaNeedsAttention ? "border-amber-300/80 bg-amber-50/70 text-amber-700 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-300" : "border-border text-muted-foreground",
            )}
          >
            {pwaStatus.status === "update-available" ? <RefreshCw className="h-3.5 w-3.5" /> : pwaNeedsAttention ? <AlertCircle className="h-3.5 w-3.5" /> : <MonitorPlay className="h-3.5 w-3.5" />}
            <span className="hidden lg:inline">{pwaStatus.status === "development" ? "开发环境" : pwaStatus.status === "update-available" ? "应用有更新" : pwaNeedsAttention ? "应用需维护" : "本地应用"}</span>
            {pwaNeedsAttention && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
          </NavLink>}
          {user && (
            <span className="inline-flex min-w-0 items-center gap-2 text-foreground/80">
              {user.avatar_url ? <img src={user.avatar_url} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" referrerPolicy="no-referrer" /> : <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">{userDisplayName.slice(0, 1).toUpperCase()}</span>}
              <span className="hidden max-w-28 truncate sm:inline">{userDisplayName}</span>
              <span className="mx-1 hidden text-muted-foreground sm:inline">·</span>
              <span className="hidden max-w-20 truncate md:inline">{userRoleText}</span>
            </span>
          )}
          {user && (
            <button
              type="button"
              onClick={() => logout()}
              className="inline-flex items-center gap-1 text-foreground/70 hover:text-foreground"
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
        <aside
          className="hidden w-56 shrink-0 flex-col overflow-y-auto border-r bg-card md:flex scrollbar-hide"
          style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
        >
          <SidebarContent />
        </aside>

        {/* 主内容 */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-3 py-3 sm:px-4 sm:py-4 md:px-6 md:py-5">
          <Outlet />
        </main>
      </div>

      {/* 强制修改密码弹窗 */}
      {!offline && <ForceChangePassword />}
    </div>
  );
}
