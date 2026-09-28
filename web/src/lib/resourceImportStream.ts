export type PreviewRenderEvent =
  | { type: "started" | "progress" | "heartbeat"; message?: string }
  | { type: "page"; index: number; preview_url: string }
  | { type: "completed"; preview_status: "ready"; preview_count: number }
  | { type: "error"; message: string; recoverable: boolean };

/** Reject partial/foreign results instead of accidentally confirming another
 * session's images or opening a renderer-controlled external URL. */
export function parsePreviewRenderEvent(
  value: unknown,
  sessionId: string,
  total: number,
  origin: string,
): PreviewRenderEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("渲染事件格式错误");
  const event = value as Record<string, unknown>;
  if (event.total !== undefined && event.total !== total) throw new Error("渲染页数与源文件不一致");
  switch (event.type) {
    case "started":
    case "progress":
    case "heartbeat":
      return { type: event.type, message: typeof event.message === "string" ? event.message.slice(0, 2000) : undefined };
    case "page": {
      if (!Number.isInteger(event.index) || (event.index as number) < 0 || (event.index as number) >= total) throw new Error("渲染返回了无效的页码");
      if (typeof event.preview_url !== "string" || event.preview_url.length > 4096) throw new Error("预览地址无效");
      const url = new URL(event.preview_url, origin);
      if (url.origin !== origin || url.username || url.password || url.hash || url.pathname !== `/api/resource-import/${sessionId}/preview/${event.index}`) {
        throw new Error("渲染返回的预览地址与当前任务不匹配");
      }
      return { type: "page", index: event.index as number, preview_url: `${url.pathname}${url.search}` };
    }
    case "completed":
      if (event.preview_status !== "ready" || event.preview_count !== total) throw new Error("渲染结果不完整，请重试图片渲染");
      return { type: "completed", preview_status: "ready", preview_count: total };
    case "error":
      return {
        type: "error",
        message: typeof event.message === "string" ? event.message.slice(0, 2000) : "图片渲染失败，请重试",
        recoverable: event.recoverable === true,
      };
    default:
      throw new Error("渲染服务返回了未知事件，请刷新后重试");
  }
}
