import { Suspense, lazy, useEffect } from "react";
import { createBrowserRouter, Navigate, RouterProvider, useRouteError } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { AppShell } from "@/components/layout/AppShell";
import { PlaceholderPage } from "@/components/common/PlaceholderPage";
import { RequireAdmin, RequireAuth, RequireSystemAdmin } from "@/lib/auth";
import { getChunkErrorMessage, isChunkLoadError, reloadAfterChunkError } from "@/lib/chunk-recovery";

// 路由级代码分割：各页面按需加载，登录页与主应用不再打入同一 bundle
const LoginPage = lazy(() => import("@/pages/auth/LoginPage").then((m) => ({ default: m.LoginPage })));
const SetupPage = lazy(() => import("@/pages/auth/SetupPage").then((m) => ({ default: m.SetupPage })));
const HomePage = lazy(() => import("@/pages/home/HomePage").then((m) => ({ default: m.HomePage })));
const ResourcesPage = lazy(() => import("@/pages/resources/ResourcesPage").then((m) => ({ default: m.ResourcesPage })));
const ResourceImportPage = lazy(() => import("@/pages/resources/ResourceImportPage").then((m) => ({ default: m.ResourceImportPage })));
const ResourceDetailPage = lazy(() => import("@/pages/resources/ResourceDetailPage").then((m) => ({ default: m.ResourceDetailPage })));
const ResourceSharePage = lazy(() => import("@/pages/resources/ResourceDetailPage").then((m) => ({ default: m.ResourceSharePage })));
const TemplatesPage = lazy(() => import("@/pages/templates/TemplatesPage").then((m) => ({ default: m.TemplatesPage })));
const TemplateImportPage = lazy(() => import("@/pages/templates/TemplateImportPage").then((m) => ({ default: m.TemplateImportPage })));
const FontsPage = lazy(() => import("@/pages/fonts/FontsPage").then((m) => ({ default: m.FontsPage })));
const ShowsPage = lazy(() => import("@/pages/shows/ShowsPage").then((m) => ({ default: m.ShowsPage })));
const ShowDetailPage = lazy(() => import("@/pages/shows/ShowDetailPage").then((m) => ({ default: m.ShowDetailPage })));
const ShowIterationPage = lazy(() => import("@/pages/shows/ShowIterationPage").then((m) => ({ default: m.ShowIterationPage })));
const ShowCreatePage = lazy(() => import("@/pages/shows/ShowCreatePage").then((m) => ({ default: m.ShowCreatePage })));
const StandardShowsPage = lazy(() => import("@/pages/shows/StandardShowsPage").then((m) => ({ default: m.StandardShowsPage })));
const DisplayPage = lazy(() => import("@/pages/present/DisplayPage").then((m) => ({ default: m.DisplayPage })));
const FullscreenPage = lazy(() => import("@/pages/present/FullscreenPage").then((m) => ({ default: m.FullscreenPage })));
const PresenterPage = lazy(() => import("@/pages/present/PresenterPage").then((m) => ({ default: m.PresenterPage })));
const ResourceManagePage = lazy(() => import("@/pages/manage/ResourceManagePage"));
const ShareManagePage = lazy(() => import("@/pages/manage/ShareManagePage"));
const TasksPage = lazy(() => import("@/pages/manage/TasksPage"));
const OfflineCachePage = lazy(() => import("@/pages/manage/OfflineCachePage"));
const TagManagePage = lazy(() => import("@/pages/manage/TagManagePage"));
const AdminUsersPage = lazy(() => import("@/pages/admin/AdminUsersPage").then((m) => ({ default: m.AdminUsersPage })));
const AdminSystemPage = lazy(() => import("@/pages/admin/AdminSystemPage").then((m) => ({ default: m.AdminSystemPage })));

// 全屏加载指示器：路由懒加载挂起时显示
function PageLoader() {
  return (
    <div className="flex h-screen w-full items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

function RouteErrorPage() {
  const error = useRouteError();
  const chunkLoadFailed = isChunkLoadError(error);
  const message = getChunkErrorMessage(error);

  useEffect(() => {
    if (chunkLoadFailed) reloadAfterChunkError(error);
  }, [chunkLoadFailed, error]);

  return (
    <div className="flex h-screen w-full items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-4 text-center">
        {chunkLoadFailed && <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />}
        <h1 className="text-xl font-semibold">
          {chunkLoadFailed ? "正在加载新版本" : "页面加载失败"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {chunkLoadFailed
            ? "检测到页面资源已更新；若未自动恢复，请手动刷新。"
            : "页面运行时发生错误，请刷新后重试。"}
        </p>
        {!chunkLoadFailed && message && (
          <p className="break-words rounded-md bg-muted p-3 text-left text-xs text-muted-foreground">
            {message}
          </p>
        )}
        <div className="flex justify-center gap-2">
          <button
            type="button"
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
            onClick={() => window.location.reload()}
          >
            刷新页面
          </button>
          {!chunkLoadFailed && (
            <button
              type="button"
              className="rounded-md border px-4 py-2 text-sm"
              onClick={() => window.location.assign("/")}
            >
              返回首页
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export const router = createBrowserRouter([
  { path: "/setup", element: <SetupPage />, errorElement: <RouteErrorPage /> },
  { path: "/login", element: <LoginPage />, errorElement: <RouteErrorPage /> },
  { path: "/share/resources/:token", element: <ResourceSharePage />, errorElement: <RouteErrorPage /> },
  {
    path: "/shows/:id/fullscreen",
    errorElement: <RouteErrorPage />,
    element: (
      <RequireAuth>
        <FullscreenPage />
      </RequireAuth>
    ),
  },
  { path: "/shows/:id/display", element: <RequireAuth><DisplayPage /></RequireAuth>, errorElement: <RouteErrorPage /> },
  {
    path: "/shows/:id/present",
    errorElement: <RouteErrorPage />,
    element: (
      <RequireAuth>
        <PresenterPage />
      </RequireAuth>
    ),
  },
  {
    errorElement: <RouteErrorPage />,
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { path: "/", element: <Navigate to="/home" replace /> },
      { path: "/home", element: <HomePage /> },
      { path: "/resources", element: <ResourcesPage /> },
      { path: "/resources/import", element: <ResourceImportPage /> },
      { path: "/resources/:resourceKey", element: <ResourceDetailPage /> },
      { path: "/templates", element: <TemplatesPage /> },
      {
        path: "/templates/import",
        element: (
          <RequireAdmin>
            <TemplateImportPage />
          </RequireAdmin>
        ),
      },
      { path: "/fonts", element: <FontsPage /> },
      { path: "/shows", element: <StandardShowsPage /> },
      { path: "/shows/:id/iterate", element: <ShowIterationPage /> },
      { path: "/shows/:id", element: <ShowDetailPage /> },
      { path: "/manage/shows", element: <ShowsPage /> },
      { path: "/manage/shows/new", element: <ShowCreatePage /> },
      { path: "/manage/resources", element: <ResourceManagePage /> },
      { path: "/manage/shares", element: <ShareManagePage /> },
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
            <Navigate to="/templates" replace />
          </RequireAdmin>
        ),
      },
      {
        path: "/admin/runtime",
        element: (
          <RequireSystemAdmin>
            <AdminSystemPage section="runtime" />
          </RequireSystemAdmin>
        ),
      },
      {
        path: "/admin/config",
        element: (
          <RequireSystemAdmin>
            <AdminSystemPage section="config" />
          </RequireSystemAdmin>
        ),
      },
      {
        path: "/admin/logs",
        element: (
          <RequireSystemAdmin>
            <AdminSystemPage section="logs" />
          </RequireSystemAdmin>
        ),
      },
      {
        path: "*",
        element: <PlaceholderPage title="404" description="页面不存在" />,
      },
    ],
  },
]);

export function AppRouter() {
  return (
    <Suspense fallback={<PageLoader />}>
      <RouterProvider router={router} />
    </Suspense>
  );
}
