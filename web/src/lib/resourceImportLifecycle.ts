import { ApiError, api } from "./api";

export function waitForImportRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("已取消", "AbortError")); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException("已取消", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delay);
    signal.addEventListener("abort", abort, { once: true });
  });
}

const cleanupRequests = new Map<string, Promise<void>>();

/** A cancelled render keeps its server-side lease until its worker stops.
 * Retry cleanup for a bounded period instead of silently losing the initial
 * DELETE to 409/429. Server expiry remains the safety net after navigation. */
export function releaseImportSession(sessionId: string): Promise<void> {
  const existing = cleanupRequests.get(sessionId);
  if (existing) return existing;
  const cleanup = (async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        await api(`/api/resource-import/${encodeURIComponent(sessionId)}`, { method: "DELETE", signal: controller.signal, keepalive: true });
        return;
      } catch (error) {
        if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) return;
        if (error instanceof ApiError && ![409, 429, 502, 503, 504].includes(error.status)) return;
        if (attempt === 4) return;
        const delay = error instanceof ApiError ? error.retryAfterMs : undefined;
        await new Promise((resolve) => setTimeout(resolve, delay ?? 1000 * 2 ** attempt));
      } finally { clearTimeout(timer); }
    }
  })().finally(() => cleanupRequests.delete(sessionId));
  cleanupRequests.set(sessionId, cleanup);
  return cleanup;
}

export interface PendingImportReceipt { sessionId: string; slideCount: number }
export const pendingImportReceiptKey = (ownerId: number) => `slide-flow:pending-import:${ownerId}`;

// Store no file name, PPT content, metadata or authentication secrets. Scope
// the recovery pointer to this user and browser tab, and write before POST.
export function rememberPendingImport(ownerId: number | undefined, receipt: PendingImportReceipt): boolean {
  if (ownerId === undefined) return false;
  try { sessionStorage.setItem(pendingImportReceiptKey(ownerId), JSON.stringify(receipt)); return true; }
  catch { return false; }
}

export function readPendingImport(ownerId: number | undefined): PendingImportReceipt | null {
  if (ownerId === undefined) return null;
  try {
    const raw = sessionStorage.getItem(pendingImportReceiptKey(ownerId));
    if (!raw) return null;
    const value = JSON.parse(raw) as PendingImportReceipt;
    if (typeof value.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.sessionId) || !Number.isInteger(value.slideCount) || value.slideCount < 1 || value.slideCount > 500) return null;
    return value;
  } catch { return null; }
}

export function forgetPendingImport(ownerId: number | undefined, sessionId: string): void {
  if (ownerId === undefined) return;
  try {
    if (readPendingImport(ownerId)?.sessionId === sessionId) sessionStorage.removeItem(pendingImportReceiptKey(ownerId));
  } catch { /* Storage may be disabled; never turn a successful save into failure. */ }
}
