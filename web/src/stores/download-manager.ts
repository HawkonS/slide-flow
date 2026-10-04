import { create } from "zustand";
import { toast } from "sonner";
import { downloadFile } from "@/lib/api";

/* ---------- Types ---------- */

export type DownloadTaskStatus = "pending" | "processing" | "completed" | "failed";

export interface DownloadTask {
  taskId: number;
  showName: string;
  trackCode: string;
  status: DownloadTaskStatus;
  progress: number;
  message: string;
  fileName?: string;
  fileSize?: number;
  error?: string;
}

interface ProgressMessage {
  type: "download_progress";
  task_id: number;
  status: DownloadTaskStatus;
  progress: number;
  message?: string;
}

interface CompletedMessage {
  type: "download_completed";
  task_id: number;
  file_name: string;
  file_size: number;
  watermark_applied?: boolean;
  watermark_requested?: boolean;
}

interface FailedMessage {
  type: "download_failed";
  task_id: number;
  error: string;
}

interface PingMessage {
  type: "ping";
}

interface EventCursorMessage {
  type: "event_cursor";
  event_id: number;
}

type ServerMessage = ProgressMessage | CompletedMessage | FailedMessage | PingMessage | EventCursorMessage | { type: string; [key: string]: unknown };

interface DownloadManagerState {
  tasks: Map<number, DownloadTask>;
  wsConnected: boolean;
  /** WebSocket lifecycle */
  connect: (userKey: string) => void;
  disconnect: (clearTasks?: boolean) => void;
  /** Task management */
  addTask: (taskId: number, showName: string, trackCode: string) => void;
  removeTask: (taskId: number) => void;
}

/* ---------- WebSocket connection state (kept outside Zustand to avoid re-renders) ---------- */

// 重连策略：最多 5 次，间隔指数退避；用尽后不再尝试，避免控制台刷屏
const RECONNECT_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 48_000];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;

interface WsRuntime {
  socket: WebSocket | null;
  reconnectAttempts: number;
  reconnectTimer: number | null;
  manuallyClosed: boolean;
  userKey: string;
  lastEventId: number | null;
  givenUp: boolean;
}

const wsRuntime: WsRuntime = {
  socket: null,
  reconnectAttempts: 0,
  reconnectTimer: null,
  manuallyClosed: false,
  userKey: "",
  lastEventId: null,
  givenUp: false,
};

function eventCursorStorageKey(userKey: string): string {
  return `slide-flow:task-event-cursor:${userKey}`;
}

function loadEventCursor(userKey: string): number | null {
  try {
    const raw = window.sessionStorage.getItem(eventCursorStorageKey(userKey));
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function saveEventCursor(userKey: string, eventId: number): void {
  if (!userKey) return;
  try {
    window.sessionStorage.setItem(eventCursorStorageKey(userKey), String(eventId));
  } catch {
    // Session storage may be unavailable in restricted browser contexts.
  }
}

function buildWsUrl(): string {
  // 开发环境下，如果 Vite 的 /ws 代理因任何原因未生效，可通过环境变量
  // VITE_WS_BACKEND 直接指向后端地址（例如："ws://127.0.0.1:8088"）。
  // 生产环境始终使用同源 host，由 Nginx/FastAPI 处理 Upgrade。
  const override = (import.meta.env?.VITE_WS_BACKEND as string | undefined) || "";
  let origin: string;
  if (override && import.meta.env?.DEV) {
    // 允许传入完整 origin（含协议）或仅 host
    if (/^wss?:\/\//i.test(override)) {
      origin = override.replace(/\/$/, "");
    } else {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      origin = `${protocol}//${override.replace(/\/$/, "")}`;
    }
  } else {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    origin = `${protocol}//${window.location.host}`;
  }
  const base = `${origin}/ws/tasks`;
  const params = new URLSearchParams();
  if (wsRuntime.lastEventId != null) {
    params.set("after", String(wsRuntime.lastEventId));
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/* ---------- Auto-trigger browser download ---------- */

// 已经自动触发过浏览器下载的任务集合，防止同一任务被重复自动下载。
// 重复触发的根因可能是：
//   1) React StrictMode 在开发环境下对 AppShell 的 useEffect 进行 mount→cleanup→mount
//      双调用，导致短暂存在两个 WebSocket，服务端对同一 user_id 同时持有两条连接，
//      `download_completed` 被推送两次。
//   2) 网络抖动触发自动重连后，旧/新两条连接同时存活的极短窗口期。
// 该集合作为客户端侧的兜底去重，确保每个 task_id 只在第一次收到 completed 时
// 自动触发一次浏览器下载，后续重复消息只刷新状态、不再下载。
const autoTriggeredTasks = new Set<number>();
const AUTO_TRIGGERED_MAX = 500;

// 防止 autoTriggeredTasks 在长期运行下无限增长：超过阈值时清理
// 不在当前任务列表中的 ID（这些任务已不需要去重）。
function maybeShrinkAutoTriggered(currentTaskIds: Iterable<number>) {
  if (autoTriggeredTasks.size <= AUTO_TRIGGERED_MAX) return;
  const alive = new Set(currentTaskIds);
  for (const id of autoTriggeredTasks) {
    if (!alive.has(id)) autoTriggeredTasks.delete(id);
  }
}

function triggerBrowserDownload(taskId: number, fileName: string, userKey = wsRuntime.userKey) {
  if (wsRuntime.manuallyClosed || wsRuntime.userKey !== userKey) return;
  // 复用 downloadFile：Range 预检 + 浏览器原生流式下载，失败时 toast 提示
  void downloadFile(`/api/downloads/${taskId}/file`, fileName).catch((err) =>
    wsRuntime.userKey === userKey && !wsRuntime.manuallyClosed && toast.error(err instanceof Error ? err.message : "下载失败"),
  );
}

/* ---------- Store ---------- */

export const useDownloadManager = create<DownloadManagerState>((set, get) => {
  function updateTask(taskId: number, patch: Partial<DownloadTask>) {
    set((state) => {
      const existing = state.tasks.get(taskId);
      if (!existing) return {};
      const next = new Map(state.tasks);
      next.set(taskId, { ...existing, ...patch });
      return { tasks: next };
    });
  }

  function handleMessage(raw: string) {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

    const eventId = (msg as { event_id?: unknown }).event_id;
    if (typeof eventId === "number" && Number.isInteger(eventId) && eventId >= 0) {
      if (msg.type !== "event_cursor" && wsRuntime.lastEventId != null && eventId <= wsRuntime.lastEventId) {
        return;
      }
      wsRuntime.lastEventId = Math.max(wsRuntime.lastEventId ?? 0, eventId);
      saveEventCursor(wsRuntime.userKey, wsRuntime.lastEventId);
    }

    switch (msg.type) {
      case "event_cursor":
        break;
      case "ping": {
        // Server-side liveness probe – respond with pong if socket is open
        const sock = wsRuntime.socket;
        if (sock && sock.readyState === WebSocket.OPEN) {
          try {
            sock.send(JSON.stringify({ type: "pong" }));
          } catch {
            // ignore
          }
        }
        break;
      }
      case "pong":
        break;
      case "download_progress": {
        const m = msg as ProgressMessage;
        updateTask(m.task_id, {
          status: m.status,
          progress: m.progress ?? 0,
          message: m.message ?? "",
        });
        break;
      }
      case "download_completed": {
        const m = msg as CompletedMessage;
        const userKey = wsRuntime.userKey;
        const task = get().tasks.get(m.task_id);
        updateTask(m.task_id, {
          status: "completed",
          progress: 100,
          fileName: m.file_name,
          fileSize: m.file_size,
        });
        // 自动下载去重：同一 task_id 仅在首次完成时自动触发一次浏览器下载。
        // 即便由于双 WS 连接、StrictMode 双挂载等原因导致 completed 消息被重复
        // 收到，也只会刷新任务状态、不会再次自动下载。
        const alreadyTriggered = autoTriggeredTasks.has(m.task_id);
        if (!alreadyTriggered) {
          autoTriggeredTasks.add(m.task_id);
          triggerBrowserDownload(m.task_id, m.file_name);
          // 任务完成后顺便检查集合大小，超过阈值时清理已不在任务列表中的 ID
          maybeShrinkAutoTriggered(get().tasks.keys());
        }
        // Toast 仅作为可视化提示与“浏览器拦截时的手动兜底”。
        // action.onClick 只会在用户主动点击「点击下载」按钮时执行，不会随 toast
        // 弹出而自动触发；重复消息也不会重复弹 toast。
        if (!alreadyTriggered) {
          toast.success("下载任务已完成", {
            description: task?.showName
              ? `${task.showName} · ${m.file_name}`
              : m.file_name,
            duration: 8000,
            action: {
              label: "点击下载",
              onClick: () => {
                triggerBrowserDownload(m.task_id, m.file_name, userKey);
              },
            },
          });
          // 水印添加失败提醒：后端明确返回 watermark_applied === false
          // 表示文件未成功嵌入水印，需要提示用户。
          if (m.watermark_requested === true && m.watermark_applied === false) {
            toast.warning("下载已完成，但水印添加失败，文件不包含水印");
          }
        }
        break;
      }
      case "download_failed": {
        const m = msg as FailedMessage;
        const task = get().tasks.get(m.task_id);
        updateTask(m.task_id, {
          status: "failed",
          error: m.error,
        });
        toast.error(`下载失败${task?.showName ? `：${task.showName}` : ""}`, {
          description: m.error || "服务端处理出错，请稍后重试",
        });
        break;
      }
      default:
        // Unknown message types are ignored
        break;
    }
  }

  function scheduleReconnect() {
    if (wsRuntime.manuallyClosed) return;
    if (wsRuntime.givenUp) return;
    if (wsRuntime.reconnectTimer != null) return;
    if (wsRuntime.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      // 用尽重连次数后，标记放弃并停止刷屏。用户下次主动调用 connect() 才会重置。
      wsRuntime.givenUp = true;
      console.debug(
        "[download-manager] WebSocket 重连达到上限，已停止尝试"
      );
      return;
    }

    const delay =
      RECONNECT_DELAYS_MS[wsRuntime.reconnectAttempts] ??
      RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1];
    wsRuntime.reconnectAttempts += 1;
    wsRuntime.reconnectTimer = window.setTimeout(() => {
      wsRuntime.reconnectTimer = null;
      openSocket();
    }, delay);
  }

  function openSocket() {
    if (wsRuntime.givenUp) return;
    if (wsRuntime.socket) {
      // Already connected or connecting
      const rs = wsRuntime.socket.readyState;
      if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(buildWsUrl());
    } catch (err) {
      console.debug("[download-manager] WebSocket 构造失败", err);
      scheduleReconnect();
      return;
    }
    wsRuntime.socket = socket;
    const userKey = wsRuntime.userKey;
    const isCurrent = () => wsRuntime.socket === socket && !wsRuntime.manuallyClosed && wsRuntime.userKey === userKey;

    socket.onopen = () => {
      if (!isCurrent()) return;
      wsRuntime.reconnectAttempts = 0;
      wsRuntime.givenUp = false;
      set({ wsConnected: true });
    };

    socket.onmessage = (event) => {
      if (!isCurrent()) return;
      if (typeof event.data === "string") {
        handleMessage(event.data);
      }
    };

    socket.onclose = () => {
      if (!isCurrent()) return;
      wsRuntime.socket = null;
      set({ wsConnected: false });
      scheduleReconnect();
    };

    socket.onerror = () => {
      if (!isCurrent()) return;
      // 浏览器原生会输出一条 WebSocket error，无法静默；
      // 这里仅做调试日志（debug 级别），并由 onclose 触发重连
      console.debug("[download-manager] WebSocket 出错，等待 onclose 触发重连");
      try {
        socket.close();
      } catch {
        // ignore
      }
    };
  }

  return {
    tasks: new Map<number, DownloadTask>(),
    wsConnected: false,

    connect: (userKey: string) => {
      if (wsRuntime.userKey !== userKey) {
        get().disconnect();
        autoTriggeredTasks.clear();
        set({ tasks: new Map() });
        wsRuntime.lastEventId = loadEventCursor(userKey);
      }
      wsRuntime.manuallyClosed = false;
      wsRuntime.userKey = userKey;
      // 用户主动调用 connect 视为重置“放弃”状态，允许重新尝试一轮
      wsRuntime.givenUp = false;
      if (wsRuntime.reconnectTimer != null) {
        window.clearTimeout(wsRuntime.reconnectTimer);
        wsRuntime.reconnectTimer = null;
      }
      // If we already have an open/connecting socket, do nothing
      const existing = wsRuntime.socket;
      if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
        return;
      }
      wsRuntime.reconnectAttempts = 0;
      openSocket();
    },

    disconnect: (clearTasks = true) => {
      wsRuntime.manuallyClosed = true;
      wsRuntime.givenUp = false;
      wsRuntime.reconnectAttempts = 0;
      if (wsRuntime.reconnectTimer != null) {
        window.clearTimeout(wsRuntime.reconnectTimer);
        wsRuntime.reconnectTimer = null;
      }
      const sock = wsRuntime.socket;
      wsRuntime.socket = null;
      if (sock) {
        try {
          sock.close();
        } catch {
          // ignore
        }
      }
      set(clearTasks ? { wsConnected: false, tasks: new Map() } : { wsConnected: false });
    },

    addTask: (taskId, showName, trackCode) => {
      set((state) => {
        const next = new Map(state.tasks);
        next.set(taskId, {
          taskId,
          showName,
          trackCode,
          status: "pending",
          progress: 0,
          message: "已提交，等待处理…",
        });
        return { tasks: next };
      });
    },

    removeTask: (taskId) => {
      // 任务从前端列表移除时，同时清理自动下载去重记录，避免长时间运行后
      // Set 持续膨胀；任务已被移除，重复消息也不再有意义。
      autoTriggeredTasks.delete(taskId);
      set((state) => {
        if (!state.tasks.has(taskId)) return {};
        const next = new Map(state.tasks);
        next.delete(taskId);
        return { tasks: next };
      });
    },
  };
});
