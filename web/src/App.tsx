import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { subscribeResourceDeletions } from "@/lib/resource-deletion";
import { AuthProvider, useAuth } from "@/lib/auth";
import { AppRouter } from "@/router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { useResourceFilters } from "@/stores/resource-filters";
import { useManageResourceFilters } from "@/stores/manage-resource-filters";
import { useSiteConfig } from "@/stores/site-config";

function ResourceDeletionSync() {
  const client = useQueryClient();
  const { identity } = useAuth();
  useEffect(() => subscribeResourceDeletions(client, identity), [client, identity]);
  return null;
}

export function App() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: false,
            staleTime: 30_000,
          },
        },
      }),
  );

  // 加载配置并初始化筛选器默认值
  // 使用 AbortController + setTimeout 给 fetch 加上 5s 超时保护，
  // 避免后端不可用时 promise 长期挂起、以及组件卸载后仍被触发。
  useEffect(() => {
    const configController = new AbortController();
    const configTimeout = window.setTimeout(() => configController.abort(), 5000);
    fetch("/api/config", { signal: configController.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((config) => {
        if (config) {
          useResourceFilters.getState().initDefaults(config);
          useManageResourceFilters.getState().initDefaults(config);
          // 站点名称 & Logo
          if (config.site_name) {
            useSiteConfig.getState().setSiteName(config.site_name);
            document.title = config.site_name;
          }
          if (config.logo_svg_path) {
            useSiteConfig.getState().setLogoSvgPath(config.logo_svg_path);
          }
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => window.clearTimeout(configTimeout));

    // 加载版本信息
    const versionController = new AbortController();
    const versionTimeout = window.setTimeout(() => versionController.abort(), 5000);
    fetch("/api/version", { signal: versionController.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((v) => {
        if (v) {
          useSiteConfig.getState().setVersion(v.commit || "", v.updated_at || "");
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => window.clearTimeout(versionTimeout));

    return () => {
      configController.abort();
      versionController.abort();
      window.clearTimeout(configTimeout);
      window.clearTimeout(versionTimeout);
    };
  }, []);

  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <ResourceDeletionSync />
        <TooltipProvider delayDuration={200}>
          <AppRouter />
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
