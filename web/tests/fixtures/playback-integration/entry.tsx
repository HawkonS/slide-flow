import React, { Suspense, lazy, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, RequireAuth, useAuth } from '@/lib/auth';
import * as cache from '@/lib/pwa-cache';
import { readOfflineIdentity, offlineOwnerKey } from '@/lib/offline-session';
import { registerPwa, ensureOfflineShellReady } from '@/lib/pwa';
import '@/styles/globals.css';

// Only the application entry is specialized for test control. Authentication,
// identity, package storage, service worker and all three players remain real.
const Fullscreen = lazy(() => import('@/pages/present/FullscreenPage').then(module => ({ default: module.FullscreenPage })));
const Presenter = lazy(() => import('@/pages/present/PresenterPage').then(module => ({ default: module.PresenterPage })));
const Display = lazy(() => import('@/pages/present/DisplayPage').then(module => ({ default: module.DisplayPage })));
Object.assign(window, { __pwaTest: { ...cache, readOfflineIdentity, offlineOwnerKey, ensureOfflineShellReady } });
function AuthBridge() {
  const auth = useAuth();
  useEffect(() => { Object.assign(window, { __testAuth: auth }); }, [auth]);
  return null;
}
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
Object.assign(window, { __testQueries: client });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}><AuthProvider><AuthBridge /><BrowserRouter><Suspense fallback={<p>加载中…</p>}><Routes>
    <Route path="/manage/offline-cache" element={<RequireAuth><h1>真实缓存整合测试</h1></RequireAuth>} />
    <Route path="/shows/:id/fullscreen" element={<RequireAuth><Fullscreen /></RequireAuth>} />
    <Route path="/shows/:id/present" element={<RequireAuth><Presenter /></RequireAuth>} />
    <Route path="/shows/:id/display" element={<RequireAuth><Display /></RequireAuth>} />
    <Route path="/login" element={<h1>需要登录</h1>} />
  </Routes></Suspense></BrowserRouter></AuthProvider></QueryClientProvider>,
);
registerPwa();
