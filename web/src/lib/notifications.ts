import { api } from "@/lib/api";

export type NotificationBox = "all" | "unread" | "read";
export type TaskNotificationStatus = "completed" | "failed" | "cancelled";

export interface TaskNotificationItem {
  id: string;
  kind: "task";
  task_type: "batch_split_import" | "download" | "ai_tagging" | string;
  status: TaskNotificationStatus;
  title: string;
  body: string;
  link: string;
  created_at: string;
  read_at: string | null;
}

export interface LocalPwaNotificationItem {
  id: string;
  kind: "pwa_update";
  user_id: number;
  title: string;
  body: string;
  link: string;
  version: string;
  created_at: string;
  read_at: string | null;
}

export type NotificationItem = TaskNotificationItem | LocalPwaNotificationItem;

export interface NotificationPage {
  items: TaskNotificationItem[];
  unread_count: number;
  has_more: boolean;
  next_cursor: string | null;
}

export interface NotificationReadResult {
  ok: boolean;
  id: string;
  read_at: string | null;
  unread_count: number;
}

export interface NotificationReadAllResult {
  ok: boolean;
  marked: number;
  unread_count: number;
}

const NOTIFICATION_ENDPOINT = "/api/me/notifications";

export function fetchNotifications(
  box: NotificationBox,
  limit = 20,
  cursor?: string | null,
): Promise<NotificationPage> {
  return api<NotificationPage>(NOTIFICATION_ENDPOINT, {
    params: { filter: box, limit, cursor },
  });
}

export function fetchUnreadNotificationCount(): Promise<{ count: number }> {
  return api<{ count: number }>(`${NOTIFICATION_ENDPOINT}/unread-count`);
}

export function markNotificationRead(id: string): Promise<NotificationReadResult> {
  return api<NotificationReadResult>(`${NOTIFICATION_ENDPOINT}/${encodeURIComponent(id)}/read`, {
    method: "POST",
  });
}

export function markNotificationUnread(id: string): Promise<{ ok: boolean; id: string; unread_count: number }> {
  return api<{ ok: boolean; id: string; unread_count: number }>(`${NOTIFICATION_ENDPOINT}/${encodeURIComponent(id)}/read`, {
    method: "DELETE",
  });
}

export function markAllNotificationsRead(): Promise<NotificationReadAllResult> {
  return api<NotificationReadAllResult>(`${NOTIFICATION_ENDPOINT}/read-all`, {
    method: "POST",
  });
}

/** Newest first; malformed timestamps fall back to a stable id comparison. */
export function sortNotifications<T extends { id: string; created_at: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const leftTime = Date.parse(left.created_at);
    const rightTime = Date.parse(right.created_at);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return right.id.localeCompare(left.id);
  });
}

export function formatNotificationTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return sameYear ? `${month}-${day} ${hour}:${minute}` : `${date.getFullYear()}-${month}-${day}`;
}

export function formatNotificationTitle(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
