import { useSyncExternalStore } from 'react';
declare global { interface Window { __playbackAuth: { user: { id: number; session_version: number; username: string; name: string; role: string }; offline: boolean; loading: boolean } } }
export function useAuth() {
  return useSyncExternalStore(listener => { window.addEventListener('playback-test-auth', listener); return () => window.removeEventListener('playback-test-auth', listener); }, () => window.__playbackAuth);
}
