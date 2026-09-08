import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { api, setUnauthorizedHandler } from "@/lib/api";
import type { CurrentUser } from "@/lib/types";

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
  setUser: (u: CurrentUser | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ user: CurrentUser }>("/api/me");
      setUser(res.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    setUser(null);
    window.location.href = "/login";
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
    });
    reload();
    return () => setUnauthorizedHandler(null);
  }, [reload]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, reload, logout, setUser }),
    [user, loading, reload, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullscreenLoader />;
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullscreenLoader />;
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  // 运营管理员和系统管理员均可访问运营管理页面。
  if (user.role !== "admin" && user.role !== "system_admin") {
    return <Navigate to="/home" replace />;
  }
  return <>{children}</>;
}

export function RequireSystemAdmin({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullscreenLoader />;
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  // 系统管理页面仅允许系统管理员访问。
  if (user.role !== "system_admin") {
    return <Navigate to="/home" replace />;
  }
  return <>{children}</>;
}

function FullscreenLoader() {
  return (
    <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
      加载中…
    </div>
  );
}
