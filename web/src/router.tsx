import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";

import { AppShell } from "@/components/layout/AppShell";
import { PlaceholderPage } from "@/components/common/PlaceholderPage";
import { RequireAdmin, RequireAuth, RequireSuperAdmin } from "@/lib/auth";
import { LoginPage } from "@/pages/auth/LoginPage";
import { HomePage } from "@/pages/home/HomePage";
import { ResourcesPage } from "@/pages/resources/ResourcesPage";
import { TemplatesPage } from "@/pages/templates/TemplatesPage";
import { FontsPage } from "@/pages/fonts/FontsPage";
import { ShowsPage } from "@/pages/shows/ShowsPage";
import { LinksPage } from "@/pages/links/LinksPage";
import { DisplayPage } from "@/pages/present/DisplayPage";
import { FullscreenPage } from "@/pages/present/FullscreenPage";
import { AdminUsersPage } from "@/pages/admin/AdminUsersPage";
import { AdminTemplatesPage } from "@/pages/admin/AdminTemplatesPage";
import { AdminFontsPage } from "@/pages/admin/AdminFontsPage";
import { AdminLinksPage } from "@/pages/admin/AdminLinksPage";
import { AdminSystemPage } from "@/pages/admin/AdminSystemPage";
import { PresenterPage } from "@/pages/present/PresenterPage";
import LinkSharePage from "@/pages/present/LinkSharePage";
import ResourceManagePage from "@/pages/manage/ResourceManagePage";
import TasksPage from '@/pages/manage/TasksPage';
import OfflineCachePage from '@/pages/manage/OfflineCachePage';

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

export function AppRouter() {
  return <RouterProvider router={router} />;
}
