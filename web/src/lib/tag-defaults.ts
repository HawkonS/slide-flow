import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { DEFAULT_SORT_KEY, type SortKey } from "@/lib/constants";

export type DefaultScene = "resource_list" | "resource_create" | "show_list" | "show_create"
  | "standard_show_list" | "resource_picker" | "resource_manage" | "user_list";
export type TagDomain = "resource" | "subject" | "status" | "user";
export interface SceneDefaults {
  subject?: string | null;
  status?: string | null;
  resource_tags?: string[];
  user_tags?: string[];
}
export interface PublicConfig {
  site_name?: string;
  logo_svg_path?: string;
  resource_custom_tags?: boolean;
  user_custom_tags?: boolean;
  tag_defaults?: Partial<Record<DefaultScene, SceneDefaults>>;
}
export function usePublicConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: () => api<PublicConfig>("/api/config", { signal: AbortSignal.timeout(5000) }),
    staleTime: 30_000,
  });
}

type FilterUrl = { q: string; sub: string; sta: string; tags: string[]; tm: string; p: number;
  perm?: string; own?: string; rc?: string; rp?: string; sort?: string; view?: string };

function decodeState<T extends object>(raw: string | null, base: T): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(escape(atob(raw.replace(/-/g, "+").replace(/_/g, "/")))));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const next = { ...base };
    for (const key of Object.keys(base) as (keyof T)[]) {
      const value = parsed[key];
      if (Array.isArray(base[key])) {
        if (Array.isArray(value) && value.every((item) => typeof item === "string")) next[key] = value as T[keyof T];
      } else if (typeof value === typeof base[key]) next[key] = value;
    }
    if ("p" in next && (!Number.isInteger(next.p) || Number(next.p) < 1)) next.p = 1;
    return next;
  } catch { return null; }
}
function encodeState(value: object) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A single source of filter state: URL for lists, session storage for pickers.
 * Defaults are captured once per page entry; explicit state always wins. */
export function useSceneFilters<T extends FilterUrl>(scene: DefaultScene, base: T, session = false) {
  const config = usePublicConfig();
  const { user } = useAuth();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const defaults = config.data?.tag_defaults?.[scene];
  const baseline = { ...base, sub: defaults?.subject || "all", sta: defaults?.status || "all",
    tags: defaults?.resource_tags ?? defaults?.user_tags ?? [] };
  const identity = `${user?.id ?? "anonymous"}:${scene}:${location.pathname}`;
  const storageKey = `slide-flow:filters:${identity}`;
  const readSession = () => {
    try { return sessionStorage.getItem(storageKey); } catch { return null; }
  };
  const [entry, setEntry] = React.useState(() => ({ identity, baseline, settled: !config.isPending && !config.isFetching, saved: session ? readSession() : null }));
  if (entry.identity !== identity) {
    setEntry({ identity, baseline, settled: !config.isPending && !config.isFetching, saved: session ? readSession() : null });
  } else if (!entry.settled && !config.isPending && !config.isFetching) {
    setEntry({ ...entry, baseline, settled: true });
  }
  const raw = session ? entry.saved : params.get("s");
  const state = React.useMemo(() => decodeState(raw, base) ?? entry.baseline, [raw, base, entry.baseline]);
  const setState = React.useCallback((action: React.SetStateAction<T>) => {
    if (session) {
      setEntry((prev) => {
        const current = decodeState(prev.saved, base) ?? prev.baseline;
        const next = typeof action === "function" ? action(current) : action;
        return { ...prev, saved: encodeState(next) };
      });
    } else {
      setParams((prev) => {
        const current = decodeState(prev.get("s"), base) ?? entry.baseline;
        const next = typeof action === "function" ? action(current) : action;
        const result = new URLSearchParams(prev);
        // Keep explicit empty values, even when they equal the unfiltered base.
        result.set("s", encodeState(next));
        return result;
      }, { replace: true });
    }
  }, [session, base, entry.baseline, setParams]);
  React.useEffect(() => {
    if (!session || !entry.saved || entry.identity !== identity) return;
    try { sessionStorage.setItem(storageKey, entry.saved); } catch { /* Storage is optional. */ }
  }, [session, entry.saved, entry.identity, identity, storageKey]);
  const update = <K extends keyof T>(key: K, value: T[K]) => setState((prev) => ({ ...prev, [key]: value, p: 1 }));
  const restore = (target: T) => setState((prev) => ({ ...target, ...(prev.view ? { view: prev.view } : {}), p: 1 }));
  const filters = {
    query: state.q, subject: state.sub, status: state.sta, tags: state.tags,
    permission: (state.perm ?? "all") as "all" | "created" | "managed" | "visible",
    ownership: (state.own ?? "all") as "all" | "created" | "managed",
    remarkCommon: (state.rc ?? "all") as "all" | "has" | "none",
    remarkPersonal: (state.rp ?? "all") as "all" | "has" | "none",
    tagsMode: (state.tm === "any" ? "any" : "all") as "any" | "all",
    sort: (state.sort ?? DEFAULT_SORT_KEY) as SortKey,
    setQuery: (v: string) => update("q", v as T["q"]),
    setSubject: (v: string) => update("sub", v as T["sub"]),
    setStatus: (v: string) => update("sta", v as T["sta"]),
    setTags: (v: string[]) => update("tags", v as T["tags"]),
    toggleTag: (tag: string) => setState((prev) => ({ ...prev, p: 1, tags: prev.tags.includes(tag) ? prev.tags.filter((t) => t !== tag) : [...prev.tags, tag] })),
    setTagsMode: (v: "any" | "all") => update("tm", v as T["tm"]),
    setPermission: (v: string) => update("perm", v as T["perm"]),
    setOwnership: (v: string) => update("own", v as T["own"]),
    setRemarkCommon: (v: string) => update("rc", v as T["rc"]),
    setRemarkPersonal: (v: string) => update("rp", v as T["rp"]),
    setSort: (v: SortKey) => update("sort", v as T["sort"]),
    reset: () => restore(baseline),
    clear: () => restore(base),
  };
  return { state, setState, filters };
}
export type SceneFilters = ReturnType<typeof useSceneFilters>["filters"];

/** Only initialize new, untouched forms. A saved draft/task owns its values. */
export function useNewFormDefaults(scene: "resource_create" | "show_create", apply: (defaults: SceneDefaults) => void, protectedForm: boolean) {
  const config = usePublicConfig();
  const initialized = React.useRef(false);
  const touched = React.useRef(false);
  React.useEffect(() => {
    if (initialized.current || config.isPending || config.isFetching) return;
    initialized.current = true;
    if (!protectedForm && !touched.current) apply(config.data?.tag_defaults?.[scene] ?? {});
  }, [scene, config.isPending, config.isFetching, config.data, protectedForm, apply]);
  return () => { touched.current = true; };
}
