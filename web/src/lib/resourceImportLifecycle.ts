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

export interface PendingImportReceipt { sessionId: string; slideCount: number; createdAt?: number }
export const pendingImportReceiptKey = (ownerId: number) => `slide-flow:pending-import:${ownerId}`;

/** The server drops an idle import session after this window. A recovery
 * pointer older than that can only block the next import, so it expires too. */
export const PENDING_IMPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Store no file name, PPT content, metadata or authentication secrets. Scope
// the recovery pointer to this user and browser tab, and write before POST.
export function rememberPendingImport(ownerId: number | undefined, receipt: PendingImportReceipt): boolean {
  if (ownerId === undefined) return false;
  try {
    sessionStorage.setItem(pendingImportReceiptKey(ownerId), JSON.stringify({ ...receipt, createdAt: Date.now() }));
    return true;
  } catch { return false; }
}

export function readPendingImport(ownerId: number | undefined): PendingImportReceipt | null {
  if (ownerId === undefined) return null;
  try {
    const raw = sessionStorage.getItem(pendingImportReceiptKey(ownerId));
    if (!raw) return null;
    const value = JSON.parse(raw) as PendingImportReceipt;
    if (typeof value.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.sessionId) || !Number.isInteger(value.slideCount) || value.slideCount < 1 || value.slideCount > 500) return null;
    // A record without a timestamp predates the expiry check and cannot be
    // verified; drop it rather than keep asking about a batch that is gone.
    if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)
      || Date.now() - value.createdAt > PENDING_IMPORT_MAX_AGE_MS) {
      sessionStorage.removeItem(pendingImportReceiptKey(ownerId));
      return null;
    }
    return value;
  } catch { return null; }
}

export function forgetPendingImport(ownerId: number | undefined, sessionId: string): void {
  if (ownerId === undefined) return;
  try {
    if (readPendingImport(ownerId)?.sessionId === sessionId) sessionStorage.removeItem(pendingImportReceiptKey(ownerId));
  } catch { /* Storage may be disabled; never turn a successful save into failure. */ }
}

/** Metadata worth re-typing after an abandoned import. Scope choices and
 * grants are the expensive part; the name prefix follows the new file. */
export interface ImportDraft {
  subject?: string;
  status?: string;
  tagList?: string[];
  visibilityScope?: string;
  managementScope?: string;
  visibleUserIds?: number[];
  visibleUserTags?: string[];
  manageUserIds?: number[];
  manageUserTags?: string[];
  remarkHtml?: string;
}

export const importDraftKey = (ownerId: number) => `slide-flow:import-draft:${ownerId}`;
const IMPORT_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const IMPORT_DRAFT_MAX_REMARK_CHARS = 100_000;

const stringList = (value: unknown): string[] | undefined => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string").slice(0, 500)
  : undefined;
const idList = (value: unknown): number[] | undefined => Array.isArray(value)
  ? value.filter((item): item is number => Number.isInteger(item) && item > 0).slice(0, 500)
  : undefined;

// Shared across tabs on purpose: a repeated import usually starts in a new tab,
// where a tab-scoped pointer would never be seen.
export function rememberImportDraft(ownerId: number | undefined, draft: ImportDraft): boolean {
  if (ownerId === undefined) return false;
  const remark = typeof draft.remarkHtml === "string" ? draft.remarkHtml.slice(0, IMPORT_DRAFT_MAX_REMARK_CHARS) : "";
  try {
    localStorage.setItem(importDraftKey(ownerId), JSON.stringify({ ...draft, remarkHtml: remark, savedAt: Date.now() }));
    return true;
  } catch { return false; }
}

export function readImportDraft(ownerId: number | undefined): ImportDraft | null {
  if (ownerId === undefined) return null;
  try {
    const raw = localStorage.getItem(importDraftKey(ownerId));
    if (!raw) return null;
    const value = JSON.parse(raw) as ImportDraft & { savedAt?: number };
    if (!value || typeof value !== "object" || typeof value.savedAt !== "number" || Date.now() - value.savedAt > IMPORT_DRAFT_MAX_AGE_MS) return null;
    const draft: ImportDraft = {};
    if (typeof value.subject === "string") draft.subject = value.subject.slice(0, 120);
    if (typeof value.status === "string") draft.status = value.status.slice(0, 40);
    if (typeof value.visibilityScope === "string") draft.visibilityScope = value.visibilityScope;
    if (typeof value.managementScope === "string") draft.managementScope = value.managementScope;
    if (typeof value.remarkHtml === "string") draft.remarkHtml = value.remarkHtml;
    const tags = stringList(value.tagList); if (tags) draft.tagList = tags;
    const visibleIds = idList(value.visibleUserIds); if (visibleIds) draft.visibleUserIds = visibleIds;
    const manageIds = idList(value.manageUserIds); if (manageIds) draft.manageUserIds = manageIds;
    const visibleTags = stringList(value.visibleUserTags); if (visibleTags) draft.visibleUserTags = visibleTags;
    const manageTags = stringList(value.manageUserTags); if (manageTags) draft.manageUserTags = manageTags;
    return draft;
  } catch { return null; }
}
