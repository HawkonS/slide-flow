export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export interface FetchOptions extends RequestInit {
  json?: unknown;
  params?: Record<string, string | number | boolean | undefined | null>;
  raw?: boolean;
}

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null) {
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
  const { json, params, raw, headers, ...init } = options;

  const finalHeaders: Record<string, string> = {
    Accept: "application/json",
    ...(headers as Record<string, string> | undefined),
  };

  let body: BodyInit | undefined = init.body as BodyInit | undefined;
  if (json !== undefined) {
    body = JSON.stringify(json);
    finalHeaders["Content-Type"] = "application/json";
  }

  const res = await fetch(buildUrl(path, params), {
    ...init,
    body,
    credentials: "include",
    headers: finalHeaders,
  });

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
    if (res.status === 401 && !path.startsWith("/api/auth/")) {
      unauthorizedHandler?.();
    }
    throw new ApiError(res.status, detail, data);
  }

  if (raw) return res as unknown as T;

  if (res.status === 204) return undefined as unknown as T;

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
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
