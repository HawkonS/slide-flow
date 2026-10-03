import { usePublicConfig } from "@/lib/tag-defaults";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { subscribeResourceDeletions } from "@/lib/resource-deletion";
import { AuthProvider, useAuth } from "@/lib/auth";
import { AppRouter } from "@/router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { useSiteConfig } from "@/stores/site-config";

function SiteConfigSync() {
  const { data: config } = usePublicConfig();
  useEffect(() => {
    if (config?.site_name) {
      useSiteConfig.getState().setSiteName(config.site_name);
      document.title = config.site_name;
    }
    if (config?.logo_svg_path) useSiteConfig.getState().setLogoSvgPath(config.logo_svg_path);
  }, [config]);
  return null;
}

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

  // Version lookup is independent of the shared React Query site config.
  useEffect(() => {
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
      versionController.abort();
      window.clearTimeout(versionTimeout);
    };
  }, []);

  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <ResourceDeletionSync />
        <SiteConfigSync />
        <TooltipProvider delayDuration={200}>
          <AppRouter />
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
