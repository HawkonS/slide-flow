import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, RequireAuth, useAuth } from '@/lib/auth';
import * as session from '@/lib/offline-session';
import { useDownloadManager } from '@/stores/download-manager';

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const lifecycle = { mounted: 0, unmounted: 0 };
Object.assign(window, { __offlineAuthTest: { client, lifecycle, session, downloads: useDownloadManager } });
function AuthBridge() {
  const auth = useAuth();
  useEffect(() => { Object.assign(window, { __offlineAuth: auth }); }, [auth]);
  return null;
}
function ProtectedPlayer() {
  useEffect(() => { lifecycle.mounted++; return () => { lifecycle.unmounted++; }; }, []);
  return <article data-testid="protected-player">受保护播放页面</article>;
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}><AuthProvider><AuthBridge /><BrowserRouter><Routes>
    <Route path="/auth-probe" element={<RequireAuth><ProtectedPlayer /></RequireAuth>} />
    <Route path="/login" element={<h1>需要登录</h1>} />
  </Routes></BrowserRouter></AuthProvider></QueryClientProvider>,
);
