import React, { Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthProvider, RequireAuth, useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import type { Show } from '@/lib/types';
import * as cache from '@/lib/pwa-cache';
import { readOfflineIdentity, offlineOwnerKey, notifyPwaChange } from '@/lib/offline-session';
import { registerPwa, ensureOfflineShellReady } from '@/lib/pwa';
import ShowOfflineCacheDialog from '@/components/show/ShowOfflineCacheDialog';
import '@/styles/globals.css';

// Only routing and test controls are specialized. Product UI, authentication,
// cache storage, offline identity, players and the service worker remain real.
const Management = lazy(() => import('@/pages/manage/OfflineCachePage'));
const Fullscreen = lazy(() => import('@/pages/present/FullscreenPage').then(module => ({ default: module.FullscreenPage })));
const Presenter = lazy(() => import('@/pages/present/PresenterPage').then(module => ({ default: module.PresenterPage })));
const Display = lazy(() => import('@/pages/present/DisplayPage').then(module => ({ default: module.DisplayPage })));
Object.assign(window, { __cacheUiTest: { ...cache, readOfflineIdentity, offlineOwnerKey, notifyPwaChange, ensureOfflineShellReady } });
function AuthBridge() {
  const auth = useAuth();
  useEffect(() => { Object.assign(window, { __testAuth: auth }); }, [auth]);
  return null;
}
function DownloadFixture() {
  const { id } = useParams();
  const [show, setShow] = useState<Show | null>(null);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<{ show: Show }>('/api/shows/' + id, { signal: controller.signal })
      .then(result => setShow(result.show)).catch(failure => { if (!controller.signal.aborted) setError(String(failure)); });
    return () => controller.abort();
  }, [id]);
  return <main><h1>缓存下载测试入口</h1>{error && <p role="alert">{error}</p>}
    <button onClick={() => setOpen(true)}>打开缓存下载</button>
    <ShowOfflineCacheDialog show={show} open={open} onOpenChange={setOpen} />
  </main>;
}
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}><AuthProvider><AuthBridge /><BrowserRouter>
    <main className="flex h-screen min-h-0 flex-col"><Suspense fallback={<p>加载中…</p>}><Routes>
      <Route path="/test/cache/:id" element={<RequireAuth><DownloadFixture /></RequireAuth>} />
      <Route path="/manage/offline-cache" element={<RequireAuth><Management /></RequireAuth>} />
      <Route path="/shows/:id/fullscreen" element={<RequireAuth><Fullscreen /></RequireAuth>} />
      <Route path="/shows/:id/present" element={<RequireAuth><Presenter /></RequireAuth>} />
      <Route path="/shows/:id/display" element={<RequireAuth><Display /></RequireAuth>} />
      <Route path="/login" element={<h1>需要登录</h1>} />
    </Routes></Suspense></main><Toaster />
  </BrowserRouter></AuthProvider></QueryClientProvider>,
);
registerPwa();
