import { create } from "zustand";

import type { LocalPwaNotificationItem } from "@/lib/notifications";

const STORAGE_KEY = "slide-flow:local-notifications:v1";
const MAX_PER_USER = 20;

interface PersistedLocalNotifications {
  version: 1;
  items: LocalPwaNotificationItem[];
}

interface LocalNotificationsState {
  items: LocalPwaNotificationItem[];
  /** Record a local-app update once per user and service-worker build. */
  recordPwaUpdate: (userId: number, version: string) => void;
  markRead: (userId: number, id: string) => void;
  markUnread: (userId: number, id: string) => void;
  markAllRead: (userId: number) => void;
  /** Once no update is waiting, existing "new version" notices are historical. */
  settlePwaUpdates: (userId: number) => void;
}

function isLocalNotification(value: unknown): value is LocalPwaNotificationItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string"
    && item.kind === "pwa_update"
    && typeof item.user_id === "number"
    && Number.isSafeInteger(item.user_id)
    && item.user_id > 0
    && typeof item.title === "string"
    && typeof item.body === "string"
    && typeof item.link === "string"
    && typeof item.version === "string"
    && typeof item.created_at === "string"
    && (item.read_at === null || typeof item.read_at === "string")
  );
}

function trimPerUser(items: LocalPwaNotificationItem[]): LocalPwaNotificationItem[] {
  const counts = new Map<number, number>();
  return items.filter((item) => {
    const count = (counts.get(item.user_id) ?? 0) + 1;
    counts.set(item.user_id, count);
    return count <= MAX_PER_USER;
  });
}

function readStored(): LocalPwaNotificationItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<PersistedLocalNotifications> | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items)) return [];
    const seen = new Set<string>();
    const items: LocalPwaNotificationItem[] = [];
    for (const value of parsed.items) {
      if (!isLocalNotification(value) || seen.has(value.id)) continue;
      seen.add(value.id);
      items.push(value);
    }
    return trimPerUser(items);
  } catch {
    return [];
  }
}

function persist(items: LocalPwaNotificationItem[]): void {
  if (typeof window === "undefined") return;
  try {
    const payload: PersistedLocalNotifications = { version: 1, items };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Restricted storage or quota exhaustion: keep the in-memory history.
  }
}

export const useLocalNotifications = create<LocalNotificationsState>((set, get) => ({
  items: readStored(),
  recordPwaUpdate: (userId, version) => {
    const trimmedVersion = String(version || "").trim();
    if (!Number.isSafeInteger(userId) || userId <= 0 || !trimmedVersion) return;
    const current = get().items;
    if (current.some((item) => item.user_id === userId && item.version === trimmedVersion)) return;
    const item: LocalPwaNotificationItem = {
      id: `pwa-update:${userId}:${trimmedVersion}`,
      kind: "pwa_update",
      user_id: userId,
      title: "本地应用有新版本",
      body: "完成当前工作后关闭所有窗口并重新打开即可更新。",
      link: "/manage/offline-cache",
      version: trimmedVersion,
      created_at: new Date().toISOString(),
      read_at: null,
    };
    const items = trimPerUser([item, ...current]);
    persist(items);
    set({ items });
  },
  markRead: (userId, id) => {
    if (!Number.isSafeInteger(userId) || userId <= 0) return;
    const stamp = new Date().toISOString();
    let changed = false;
    const items = get().items.map((item) => {
      if (item.user_id !== userId || item.id !== id || item.read_at) return item;
      changed = true;
      return { ...item, read_at: stamp };
    });
    if (!changed) return;
    persist(items);
    set({ items });
  },
  markUnread: (userId, id) => {
    if (!Number.isSafeInteger(userId) || userId <= 0) return;
    let changed = false;
    const items = get().items.map((item) => {
      if (item.user_id !== userId || item.id !== id || !item.read_at) return item;
      changed = true;
      return { ...item, read_at: null };
    });
    if (!changed) return;
    persist(items);
    set({ items });
  },
  markAllRead: (userId) => {
    if (!Number.isSafeInteger(userId) || userId <= 0) return;
    const stamp = new Date().toISOString();
    let changed = false;
    const items = get().items.map((item) => {
      if (item.user_id !== userId || item.read_at) return item;
      changed = true;
      return { ...item, read_at: stamp };
    });
    if (!changed) return;
    persist(items);
    set({ items });
  },
  settlePwaUpdates: (userId) => {
    if (!Number.isSafeInteger(userId) || userId <= 0) return;
    let changed = false;
    const items = get().items.map((item) => {
      if (item.user_id !== userId || item.kind !== "pwa_update" || item.title === "本地应用已更新") return item;
      changed = true;
      return { ...item, title: "本地应用已更新", body: "新版本已生效，无需其他操作。" };
    });
    if (!changed) return;
    persist(items);
    set({ items });
  },
}));
