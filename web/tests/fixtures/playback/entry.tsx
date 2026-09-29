import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FullscreenPage } from '@/pages/present/FullscreenPage';
import { PresenterPage } from '@/pages/present/PresenterPage';
import { DisplayPage } from '@/pages/present/DisplayPage';
import '@/styles/globals.css';
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><BrowserRouter><Routes>
  <Route path="/shows/:id/fullscreen" element={<FullscreenPage />} />
  <Route path="/shows/:id/presenter" element={<PresenterPage />} />
  <Route path="/shows/:id/display" element={<DisplayPage />} />
</Routes></BrowserRouter></QueryClientProvider>);
