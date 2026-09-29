import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { api, advanceApiSession, ApiError, ApiTransportError, setUnauthorizedHandler } from "@/lib/api";
import { isAdminRole, isSystemAdminRole, type CurrentUser } from "@/lib/types";
import {
  beginOfflineLogin, completeOfflineLogin, installOfflineSessionSync, isOfflineLoggedOut,
  isOfflineRouteAllowed, lockOfflineIdentity, offlineAuthEpoch, offlineOwnerKey,
  OFFLINE_SESSION_EVENT, readOfflineIdentity, rememberOnlineIdentity, type OfflineIdentity,
} from "@/lib/offline-session";

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  offline: boolean;
  identity: OfflineIdentity | null;
  epoch: string;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
  setUser: (u: CurrentUser | null) => void;
  beginLogin: () => string;
  completeLogin: (user: CurrentUser, loginEpoch: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function purgePrevious(identity: OfflineIdentity | null): void {
  if (!identity) return;
  void import("./pwa-cache").then(({ purgeOfflineOwner }) => purgeOfflineOwner(offlineOwnerKey(identity))).catch(() => undefined);
}

function validUser(user: CurrentUser | undefined): user is CurrentUser {
  return !!user && Number.isSafeInteger(user.id) && user.id > 0
    && typeof user.username === "string" && ["user", "admin", "system_admin"].includes(user.role);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUserState] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [identity, setIdentity] = useState<OfflineIdentity | null>(null);
  const [epoch, setEpoch] = useState(offlineAuthEpoch);
  const epochRef = useRef(epoch);
  const userRef = useRef<CurrentUser | null>(null);
  const requests = useRef(0);
  const pending = useRef<AbortController | null>(null);

  const clearClient = useCallback(() => {
    advanceApiSession();
    requests.current++;
    pending.current?.abort();
    pending.current = null;
    userRef.current = null;
    setUserState(null); setOffline(false); setIdentity(null); setLoading(false);
    epochRef.current = offlineAuthEpoch();
    setEpoch(epochRef.current);
    queryClient.clear();
  }, [queryClient]);

  const invalidate = useCallback(() => {
    // Synchronous lock and notification precede every asynchronous cleanup.
    advanceApiSession();
    const previous = lockOfflineIdentity();
    clearClient();
    purgePrevious(previous);
  }, [clearClient]);

  const adoptOnline = useCallback((verified: CurrentUser, requestEpoch: string) => {
    if (!validUser(verified)) throw new Error("登录状态响应无效，请重试");
    if (offlineAuthEpoch() !== requestEpoch || isOfflineLoggedOut()) throw new Error("登录身份已变化，请重试");
    const previous = readOfflineIdentity();
    const next = rememberOnlineIdentity(verified, requestEpoch);
    const onlineUserChanged = userRef.current && (userRef.current.id !== verified.id
      || userRef.current.session_version !== verified.session_version);
    if (onlineUserChanged || (previous && (!next || offlineOwnerKey(previous) !== offlineOwnerKey(next)))) {
      advanceApiSession(); queryClient.clear(); purgePrevious(previous);
    }
    epochRef.current = offlineAuthEpoch();
    setEpoch(epochRef.current);
    userRef.current = verified;
    setUserState(verified); setIdentity(next); setOffline(false);
  }, [queryClient]);

  const reload = useCallback(async () => {
    if (isOfflineLoggedOut()) { clearClient(); return; }
    const requestEpoch = offlineAuthEpoch();
    const request = ++requests.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const timer = window.setTimeout(() => controller.abort(new DOMException("身份验证连接超时", "TimeoutError")), 8000);
    const current = () => request === requests.current && offlineAuthEpoch() === requestEpoch && !isOfflineLoggedOut();
    setLoading(true);
    try {
      const result = await api<{ user: CurrentUser }>("/api/me", { signal: controller.signal, cache: "no-store" });
      if (!current()) return;
      adoptOnline(result.user, requestEpoch);
    } catch (error) {
      if (!current()) return;
      const cached = readOfflineIdentity();
      if (error instanceof ApiTransportError && cached && cached.expiresAt > Date.now()) {
        userRef.current = cached.user;
        setUserState(cached.user); setIdentity(cached); setOffline(true);
        epochRef.current = cached.epoch; setEpoch(cached.epoch);
      } else if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        invalidate();
      } else {
        userRef.current = null;
        setUserState(null); setIdentity(null); setOffline(false);
      }
    } finally {
      window.clearTimeout(timer);
      if (request === requests.current) { pending.current = null; setLoading(false); }
    }
  }, [adoptOnline, clearClient, invalidate]);

  const beginLogin = useCallback(() => {
    advanceApiSession();
    const previous = readOfflineIdentity();
    const nextEpoch = beginOfflineLogin();
    clearClient();
    purgePrevious(previous);
    return nextEpoch;
  }, [clearClient]);

  const completeLogin = useCallback(async (loginUser: CurrentUser, loginEpoch: string) => {
    if (!validUser(loginUser)) throw new Error("登录状态响应无效，请重试");
    completeOfflineLogin(loginEpoch);
    const request = ++requests.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const timer = window.setTimeout(() => controller.abort(new DOMException("身份验证连接超时", "TimeoutError")), 8000);
    const current = () => request === requests.current && offlineAuthEpoch() === loginEpoch && !isOfflineLoggedOut();
    setLoading(true);
    try {
      // Login payloads may lack session_version; only a fresh /me enables caching.
      const result = await api<{ user: CurrentUser }>("/api/me", { signal: controller.signal, cache: "no-store" });
      if (!current()) throw new Error("登录请求已失效，请重新登录");
      if (result.user?.id !== loginUser.id) throw new Error("账号已在其他窗口切换，请重新登录");
      adoptOnline(result.user, loginEpoch);
    } catch (error) {
      if (!current()) throw new Error("登录请求已失效，请重新登录");
      if (error instanceof ApiTransportError) {
        // The successful login remains usable online; no offline grant is created.
        userRef.current = loginUser;
        setUserState(loginUser); setIdentity(null); setOffline(false);
        epochRef.current = loginEpoch; setEpoch(loginEpoch);
      } else { invalidate(); throw error; }
    } finally {
      window.clearTimeout(timer);
      if (request === requests.current) { pending.current = null; setLoading(false); }
    }
  }, [adoptOnline, invalidate]);

  const logout = useCallback(async () => {
    invalidate();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 3000);
    try { await api("/api/auth/logout", { method: "POST", signal: controller.signal }); }
    catch { /* The persistent local marker keeps the old cookie locked offline. */ }
    finally { window.clearTimeout(timer); }
  }, [invalidate]);

  // Profile/password updates cannot clear a logout marker or revive an old render.
  const setUser = useCallback((updated: CurrentUser | null) => {
    if (offlineAuthEpoch() !== epoch || isOfflineLoggedOut()) return;
    if (!updated) { invalidate(); return; }
    if (!userRef.current || updated.id !== userRef.current.id) return;
    userRef.current = updated; setUserState(updated);
    void reload();
  }, [epoch, invalidate, reload]);

  useEffect(() => {
    const stopSync = installOfflineSessionSync();
    setUnauthorizedHandler(invalidate);
    const onSession = (event: Event) => {
      // Cache revocation may lock this window outside AuthProvider. Process that
      // lock synchronously, but do not re-enter normal local identity adoption.
      if (!(event as CustomEvent).detail?.remote && !isOfflineLoggedOut()) return;
      const next = readOfflineIdentity();
      if (!isOfflineLoggedOut() && offlineAuthEpoch() === epochRef.current && next
          && userRef.current?.id === next.user.id && userRef.current.session_version === next.sessionVersion) return;
      clearClient();
      if (!isOfflineLoggedOut()) void reload();
    };
    const onConnection = () => { if (!isOfflineLoggedOut()) void reload(); };
    window.addEventListener(OFFLINE_SESSION_EVENT, onSession);
    window.addEventListener("online", onConnection);
    window.addEventListener("offline", onConnection);
    void reload();
    return () => {
      requests.current++; pending.current?.abort();
      stopSync(); setUnauthorizedHandler(null);
      window.removeEventListener(OFFLINE_SESSION_EVENT, onSession);
      window.removeEventListener("online", onConnection);
      window.removeEventListener("offline", onConnection);
    };
  }, [clearClient, invalidate, reload]);

  useEffect(() => {
    if (!offline || !identity) return;
    let timer: number;
    const expire = () => {
      const current = readOfflineIdentity();
      if (!current || offlineOwnerKey(current) !== offlineOwnerKey(identity) || current.expiresAt <= Date.now()) {
        userRef.current = null; setUserState(null); setIdentity(null); setOffline(false);
      } else {
        timer = window.setTimeout(expire, Math.min(2_147_483_647, current.expiresAt - Date.now()));
      }
    };
    timer = window.setTimeout(expire, Math.max(0, Math.min(2_147_483_647, identity.expiresAt - Date.now())));
    return () => window.clearTimeout(timer);
  }, [offline, identity]);

  const value = useMemo<AuthContextValue>(() => ({ user, loading, offline, identity, epoch, reload, logout, setUser, beginLogin, completeLogin }),
    [user, loading, offline, identity, epoch, reload, logout, setUser, beginLogin, completeLogin]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading, offline } = useAuth();
  const location = useLocation();
  if (loading && !user) return <FullscreenLoader />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (offline && !isOfflineRouteAllowed(location.pathname)) return <Navigate to="/manage/offline-cache" replace />;
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, loading, offline } = useAuth();
  const location = useLocation();
  if (loading && !user) return <FullscreenLoader />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (offline) return <Navigate to="/manage/offline-cache" replace />;
  if (!isAdminRole(user.role)) return <Navigate to="/home" replace />;
  return <>{children}</>;
}

export function RequireSystemAdmin({ children }: { children: React.ReactNode }) {
  const { user, loading, offline } = useAuth();
  const location = useLocation();
  if (loading && !user) return <FullscreenLoader />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (offline) return <Navigate to="/manage/offline-cache" replace />;
  if (!isSystemAdminRole(user.role)) return <Navigate to="/home" replace />;
  return <>{children}</>;
}

function FullscreenLoader() {
  return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">加载中…</div>;
}
