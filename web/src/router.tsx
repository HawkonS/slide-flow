import { Component, Suspense, lazy, type ErrorInfo, type ReactNode } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { AppShell } from "@/components/layout/AppShell";
import { PlaceholderPage } from "@/components/common/PlaceholderPage";
import { RequireAdmin, RequireAuth, RequireSuperAdmin } from "@/lib/auth";

// 路由级代码分割：各页面按需加载，登录页与主应用不再打入同一 bundle
const LoginPage = lazy(() => import("@/pages/auth/LoginPage").then((m) => ({ default: m.LoginPage })));
const HomePage = lazy(() => import("@/pages/home/HomePage").then((m) => ({ default: m.HomePage })));
const ResourcesPage = lazy(() => import("@/pages/resources/ResourcesPage").then((m) => ({ default: m.ResourcesPage })));
const TemplatesPage = lazy(() => import("@/pages/templates/TemplatesPage").then((m) => ({ default: m.TemplatesPage })));
const FontsPage = lazy(() => import("@/pages/fonts/FontsPage").then((m) => ({ default: m.FontsPage })));
const ShowsPage = lazy(() => import("@/pages/shows/ShowsPage").then((m) => ({ default: m.ShowsPage })));
const LinksPage = lazy(() => import("@/pages/links/LinksPage").then((m) => ({ default: m.LinksPage })));
const DisplayPage = lazy(() => import("@/pages/present/DisplayPage").then((m) => ({ default: m.DisplayPage })));
const FullscreenPage = lazy(() => import("@/pages/present/FullscreenPage").then((m) => ({ default: m.FullscreenPage })));
const PresenterPage = lazy(() => import("@/pages/present/PresenterPage").then((m) => ({ default: m.PresenterPage })));
const LinkSharePage = lazy(() => import("@/pages/present/LinkSharePage"));
const ResourceManagePage = lazy(() => import("@/pages/manage/ResourceManagePage"));
const TasksPage = lazy(() => import("@/pages/manage/TasksPage"));
const OfflineCachePage = lazy(() => import("@/pages/manage/OfflineCachePage"));
const TagManagePage = lazy(() => import("@/pages/manage/TagManagePage"));
const AdminUsersPage = lazy(() => import("@/pages/admin/AdminUsersPage").then((m) => ({ default: m.AdminUsersPage })));
const AdminTemplatesPage = lazy(() => import("@/pages/admin/AdminTemplatesPage").then((m) => ({ default: m.AdminTemplatesPage })));
const AdminFontsPage = lazy(() => import("@/pages/admin/AdminFontsPage").then((m) => ({ default: m.AdminFontsPage })));
const AdminLinksPage = lazy(() => import("@/pages/admin/AdminLinksPage").then((m) => ({ default: m.AdminLinksPage })));
const AdminSystemPage = lazy(() => import("@/pages/admin/AdminSystemPage").then((m) => ({ default: m.AdminSystemPage })));

// 全屏加载指示器：路由懒加载挂起时显示
function PageLoader() {
  return (
    <div className="flex h-screen w-full items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    path: "/shows/:id/fullscreen",
    element: (
      <RequireAuth>
        <FullscreenPage />
      </RequireAuth>
    ),
  },
  { path: "/shows/:id/display", element: <DisplayPage /> },
  { path: "/shows/:id/link-share", element: <LinkSharePage /> },
  {
    path: "/shows/:id/present",
    element: (
      <RequireAuth>
        <PresenterPage />
      </RequireAuth>
    ),
  },
  {
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { path: "/", element: <Navigate to="/home" replace /> },
      { path: "/home", element: <HomePage /> },
      { path: "/resources", element: <ResourcesPage /> },
      { path: "/templates", element: <TemplatesPage /> },
      { path: "/fonts", element: <FontsPage /> },
      { path: "/shows", element: <ShowsPage /> },
      { path: "/links", element: <LinksPage /> },
      { path: "/manage/resources", element: <ResourceManagePage /> },
      { path: "/manage/tasks", element: <TasksPage /> },
      { path: "/manage/offline-cache", element: <OfflineCachePage /> },
      {
        path: "/manage/tags",
        element: (
          <RequireAdmin>
            <TagManagePage />
          </RequireAdmin>
        ),
      },
      {
        path: "/admin/users",
        element: (
          <RequireAdmin>
            <AdminUsersPage />
          </RequireAdmin>
        ),
      },
      {
        path: "/admin/templates",
        element: (
          <RequireAdmin>
            <AdminTemplatesPage />
          </RequireAdmin>
        ),
      },
      {
        path: "/admin/fonts",
        element: (
          <RequireAdmin>
            <AdminFontsPage />
          </RequireAdmin>
        ),
      },
      {
        path: "/admin/links",
        element: (
          <RequireAdmin>
            <AdminLinksPage />
          </RequireAdmin>
        ),
      },
      {
        path: "/admin/system",
        element: (
          <RequireSuperAdmin>
            <AdminSystemPage />
          </RequireSuperAdmin>
        ),
      },
      {
        path: "*",
        element: <PlaceholderPage title="404" description="页面不存在" />,
      },
    ],
  },
]);

// 懒加载失败兜底：后端启动时会重建 app/static/dist，会话期间若服务升级，
// 旧 hash chunk 将 404 导致 import() reject，此时刷新页面以获取新的 index.html
class ChunkErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  componentDidCatch(error: Error, info: ErrorInfo) {
    const message = error?.message || "";
    const isChunkLoadFailed =
      error instanceof TypeError ||
      /Failed to fetch dynamically imported module/i.test(message) ||
      /Loading chunk/i.test(message) ||
      /Importing a module/i.test(message);
    console.error("[ChunkErrorBoundary] 懒加载失败，即将刷新页面", error, info);
    if (isChunkLoadFailed) {
      this.setState({ failed: true });
      window.location.reload();
    }
  }

  render() {
    if (this.state.failed) {
      // 刷新前的短暂占位，避免白屏闪烁
      return (
        <div className="flex h-screen w-full items-center justify-center text-sm text-muted-foreground">
          检测到版本更新，正在刷新页面…
        </div>
      );
    }
    return this.props.children;
  }
}

export function AppRouter() {
  return (
    <ChunkErrorBoundary>
      <Suspense fallback={<PageLoader />}>
        <RouterProvider router={router} />
      </Suspense>
    </ChunkErrorBoundary>
  );
}
