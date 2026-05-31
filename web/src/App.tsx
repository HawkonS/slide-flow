import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { AuthProvider } from "@/lib/auth";
import { AppRouter } from "@/router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { useResourceFilters } from "@/stores/resource-filters";
import { useManageResourceFilters } from "@/stores/manage-resource-filters";
import { useSiteConfig } from "@/stores/site-config";

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
  useEffect(() => {
    fetch("/api/config")
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
      .catch(() => { /* ignore */ });
  }, []);

  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <TooltipProvider delayDuration={200}>
          <AppRouter />
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
