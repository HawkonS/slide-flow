export class ApiError extends Error {
  status: number;
  data: unknown;
  retryAfterMs: number | undefined;
  constructor(status: number, message: string, data?: unknown, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.data = data;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Only fetch transport failures receive this type; JSON/application errors do not. */
export class ApiTransportError extends TypeError {
  constructor(message: string) { super(message); this.name = "ApiTransportError"; }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.min(30_000, delay)) : undefined;
}

export interface FetchOptions extends RequestInit {
  json?: unknown;
  params?: Record<string, string | number | boolean | undefined | null>;
  raw?: boolean;
}

let unauthorizedHandler: (() => void) | null = null;
let sessionGeneration = 0;

export function advanceApiSession(): void { sessionGeneration++; }

export function setUnauthorizedHandler(fn: (() => void) | null) {
  advanceApiSession();
  unauthorizedHandler = fn;
}

function buildUrl(path: string, params?: FetchOptions["params"]) {
  if (!params) return path;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.append(k, String(v));
  }
  const qs = sp.toString();
  if (!qs) return path;
  return path.includes("?") ? `${path}&${qs}` : `${path}?${qs}`;
}

export async function api<T = unknown>(
  path: string,
  options: FetchOptions = {},
): Promise<T> {
  const requestGeneration = sessionGeneration;
  const requestUnauthorizedHandler = unauthorizedHandler;
  const { json, params, raw, headers, ...init } = options;

  const finalHeaders = new Headers(headers);
  if (!finalHeaders.has("Accept")) finalHeaders.set("Accept", "application/json");

  let body: BodyInit | undefined = init.body as BodyInit | undefined;
  if (json !== undefined) {
    body = JSON.stringify(json);
    finalHeaders.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, params), {
      ...init, body, credentials: "include", headers: finalHeaders,
    });
  } catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException &&
        (error.name === "NetworkError" || error.name === "TimeoutError"))) {
      throw new ApiTransportError(error.message);
    }
    throw error;
  }

  if (!res.ok) {
    let data: unknown = null;
    let detail =
      res.status === 401 ? "未登录或会话已过期" : `${res.status} ${res.statusText}`;
    try {
      data = await res.json();
      if (data && typeof data === "object" && "detail" in data) {
        const d = (data as { detail?: unknown }).detail;
        if (d != null) detail = typeof d === "string" ? d : JSON.stringify(d);
      }
    } catch {
      // ignore
    }
    if (res.status === 401 && !path.startsWith("/api/auth/")
        && requestGeneration === sessionGeneration && requestUnauthorizedHandler === unauthorizedHandler) {
      requestUnauthorizedHandler?.();
    }
    throw new ApiError(res.status, detail, data, parseRetryAfter(res.headers.get("Retry-After")));
  }

  if (raw) return res as unknown as T;

  if (res.status === 204) return undefined as unknown as T;

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

/** Consume bounded UTF-8 NDJSON without buffering the complete render result.
 * Older servers may return their regular JSON response instead. A transport
 * EOF is not a completed job: the caller must require a completed event.
 */
export async function apiNdjson<TEvent, TJson = unknown>(
  path: string,
  onEvent: (event: TEvent) => void | Promise<void>,
  options: FetchOptions & { idleTimeoutMs?: number; maxBytes?: number } = {},
): Promise<TJson | undefined> {
  const { idleTimeoutMs = 45_000, maxBytes = 16 * 1024 * 1024, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers);
  headers.set("Accept", "application/x-ndjson, application/json");
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let rejectAbort: (reason: unknown) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  // Observe even an already-aborted request before the first fetch race starts.
  void interrupted.catch(() => undefined);
  const abortError = () => new DOMException(timedOut ? "渲染连接长时间无响应，请检查网络后重试" : "渲染已取消", timedOut ? "TimeoutError" : "AbortError");
  const abort = () => controller.abort();
  const onAbort = () => { void reader?.cancel().catch(() => undefined); rejectAbort(abortError()); };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  fetchOptions.signal?.addEventListener("abort", abort, { once: true });
  const armTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, idleTimeoutMs));
  };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const maxLineLength = 256 * 1024;
  let pending = "";
  let finished = false;
  let byteCount = 0;
  const checkAbort = () => {
    if (controller.signal.aborted) throw abortError();
  };
  const consume = async (line: string) => {
    checkAbort();
    if (line.length > maxLineLength) throw new Error("渲染事件过大，已停止接收");
    if (!line.trim()) return;
    let event: TEvent;
    try { event = JSON.parse(line) as TEvent; }
    catch { throw new Error("渲染事件格式错误，请重试"); }
    await onEvent(event);
  };
  try {
    if (fetchOptions.signal?.aborted) controller.abort();
    checkAbort();
    armTimeout();
    const response = await Promise.race([api<Response>(path, { ...fetchOptions, headers, raw: true, signal: controller.signal }), interrupted]);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json" && contentType !== "application/x-ndjson" && contentType !== "application/ndjson") {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("渲染服务返回了不支持的响应格式，请重试");
    }
    if (!response.body) throw new Error("渲染响应流不可用，请重试");
    reader = response.body.getReader();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      checkAbort();
      byteCount += value?.byteLength || 0;
      if (byteCount > maxBytes) throw new Error("渲染响应超过安全大小限制，已停止接收");
      armTimeout();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (contentType === "application/json") {
        if (pending.length > maxLineLength) throw new Error("渲染响应过大，已停止接收");
        if (done) { finished = true; return JSON.parse(pending) as TJson; }
        continue;
      }
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        await consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (pending.length > maxLineLength) throw new Error("渲染事件过大，已停止接收");
      if (done) {
        await consume(pending);
        finished = true;
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    fetchOptions.signal?.removeEventListener("abort", abort);
    if (!finished) {
      controller.abort();
      // Never block UI cancellation on a broken underlying stream's cancel().
      void reader?.cancel().catch(() => undefined);
    }
    controller.signal.removeEventListener("abort", onAbort);
    reader?.releaseLock();
  }
}

/** ---------- Preferences API ---------- */

export async function fetchUserPreferences(): Promise<{ preferences: Record<string, string> }> {
  return api<{ preferences: Record<string, string> }>("/api/user/preferences");
}

export async function updateUserPreferences(prefs: Record<string, string>): Promise<{ preferences: Record<string, string> }> {
  return api<{ preferences: Record<string, string> }>("/api/user/preferences", {
    method: "PUT",
    json: { preferences: prefs },
  });
}

/**
 * 通用文件下载助手：先以 GET + `Range: bytes=0-0` 预检（正常文件只返回 206 + 1 字节，
 * 错误分支返回 4xx + JSON detail），成功后通过临时 <a download> 触发浏览器原生
 * 流式下载（保留下载进度、零内存缓冲，不新开标签页）。
 * 预检失败时解析响应 JSON 的 detail 字段并抛出 ApiError，解析失败时按状态码兜底文案。
 */
export async function downloadFile(path: string, fileName?: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { Range: "bytes=0-0" },
      credentials: "include",
    });
  } catch {
    throw new ApiError(0, "网络错误，下载失败");
  }

  if (!res.ok) {
    const fallbackDetail =
      res.status === 410
        ? "下载文件已过期或被清理，请重新发起下载"
        : res.status === 403
          ? "无权访问此任务"
          : res.status === 404
            ? "任务不存在"
            : res.status === 400
              ? "任务文件尚未生成"
              : `${res.status} ${res.statusText}`;
    let data: unknown = null;
    let detail = res.status === 401 ? "未登录或会话已过期" : fallbackDetail;
    try {
      data = await res.json();
      if (data && typeof data === "object" && "detail" in data) {
        const d = (data as { detail?: unknown }).detail;
        if (d != null) detail = typeof d === "string" ? d : JSON.stringify(d);
      }
    } catch {
      // 响应体非 JSON，按状态码兜底文案
    }
    if (res.status === 401 && !path.startsWith("/api/auth/")) {
      unauthorizedHandler?.();
    }
    throw new ApiError(res.status, detail, data);
  }

  // 预检通过：丢弃预检响应体（仅 1 字节）避免连接悬挂，
  // 随后交由浏览器原生流式下载（后端已设置 Content-Disposition: attachment）
  try {
    await res.body?.cancel();
  } catch {
    // 忽略取消失败
  }
  const a = document.createElement("a");
  a.href = path;
  if (fileName) a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** multipart/form-data 上传 */
export async function apiUpload<T = unknown>(
  path: string,
  form: FormData,
  init: Omit<FetchOptions, "json" | "body"> = {},
): Promise<T> {
  return api<T>(path, { ...init, method: init.method || "POST", body: form });
}

/**
 * 基于 XHR 的上传，支持上传进度回调。
 * 使用场景：大文件或大批量文件上传时需要展示 0~100% 的实时进度。
 * onProgress(percent, loaded, total) 的 percent 取值 0~100。
 */
export function apiUploadWithProgress<T = unknown>(
  path: string,
  form: FormData,
  onProgress?: (percent: number, loaded: number, total: number) => void,
  method: string = "POST",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.withCredentials = true;
    xhr.responseType = "text";

    xhr.upload.onprogress = (event) => {
      if (!onProgress) return;
      if (event.lengthComputable) {
        const percent = Math.max(0, Math.min(100, (event.loaded / event.total) * 100));
        onProgress(percent, event.loaded, event.total);
      }
    };

    xhr.onload = () => {
      const contentType = xhr.getResponseHeader("content-type") || "";
      let data: unknown = null;
      if (contentType.includes("application/json")) {
        try {
          data = JSON.parse(xhr.responseText || "null");
        } catch {
          data = null;
        }
      } else {
        data = xhr.responseText;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T);
        return;
      }

      let detail =
        xhr.status === 401 ? "未登录或会话已过期" : `${xhr.status} ${xhr.statusText}`;
      if (data && typeof data === "object" && "detail" in (data as Record<string, unknown>)) {
        const d = (data as { detail?: unknown }).detail;
        if (d != null) detail = typeof d === "string" ? d : JSON.stringify(d);
      }
      if (xhr.status === 401 && !path.startsWith("/api/auth/")) {
        unauthorizedHandler?.();
      }
      reject(new ApiError(xhr.status, detail, data));
    };

    xhr.onerror = () => reject(new ApiError(0, "网络错误，上传失败"));
    xhr.onabort = () => reject(new ApiError(0, "上传已取消"));

    xhr.send(form);
  });
}

/** ---------- Show Version API ---------- */

export async function iterateShow(showId: number, payload: { change_note: string; name?: string; resource_ids?: number[] }) {
  return api<import("./types").Show>(`/api/shows/${showId}/iterate`, {
    method: "POST",
    json: payload,
  });
}

export async function getShowVersions(showId: number): Promise<{ versions: import("./types").ShowVersionItem[]; current_version_no: number }> {
  return api<{ versions: import("./types").ShowVersionItem[]; current_version_no: number }>(`/api/shows/${showId}/versions`);
}

// 获取资源变更对比详情
export async function fetchResourceDiff(
  showId: number,
  resourceId: number,
): Promise<import("./types").ResourceDiff> {
  return api<import("./types").ResourceDiff>(`/api/shows/${showId}/resource-diff/${resourceId}`);
}

// 迭代式升级
export async function iterateUpgradeShow(
  showId: number,
  payload: import("./types").IterateUpgradeRequest,
): Promise<import("./types").IterateUpgradeResponse> {
  return api<import("./types").IterateUpgradeResponse>(`/api/shows/${showId}/iterate-upgrade`, {
    method: "POST",
    json: payload,
  });
}
