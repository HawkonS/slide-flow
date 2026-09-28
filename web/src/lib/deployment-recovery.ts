const RELOAD_TARGET_KEY = "slideflow:deployment-reload-target";
const DEFAULT_POLL_INTERVAL_MS = 30_000;

const reloadBlockers = new Set<string>();
let pendingEntry: string | null = null;
let installed = false;

function normalizeUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return "";
  }
}

export function moduleEntryFromDocument(documentValue: Document, baseUrl = window.location.href): string {
  const script = documentValue.querySelector<HTMLScriptElement>('script[type="module"][src]');
  return script ? normalizeUrl(script.getAttribute("src") || "", baseUrl) : "";
}

function rememberedReloadTarget(): string {
  try {
    return window.sessionStorage.getItem(RELOAD_TARGET_KEY) || "";
  } catch {
    return "";
  }
}

function rememberReloadTarget(value: string): boolean {
  try {
    window.sessionStorage.setItem(RELOAD_TARGET_KEY, value);
    return true;
  } catch {
    return false;
  }
}

function forgetReloadTarget(): void {
  try {
    window.sessionStorage.removeItem(RELOAD_TARGET_KEY);
  } catch {
    // Storage can be disabled. Version checks remain best effort.
  }
}

function reloadForEntry(entry: string): void {
  const current = moduleEntryFromDocument(document);
  if (!entry || entry === current) {
    pendingEntry = null;
    forgetReloadTarget();
    return;
  }
  if (reloadBlockers.size > 0) {
    pendingEntry = entry;
    return;
  }
  pendingEntry = null;
  // A marker prevents a broken intermediary cache from causing a reload loop.
  if (rememberedReloadTarget() === entry || !rememberReloadTarget(entry)) return;
  window.location.reload();
}

export function setAutomaticReloadBlocked(blocker: string, blocked: boolean): void {
  if (blocked) reloadBlockers.add(blocker);
  else reloadBlockers.delete(blocker);
  if (!blocked && reloadBlockers.size === 0 && pendingEntry) reloadForEntry(pendingEntry);
}

export async function checkForFrontendUpdate(): Promise<void> {
  const current = moduleEntryFromDocument(document);
  if (!current) return;
  try {
    const response = await fetch(`/?__slideflow_entry=${Date.now()}`, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "text/html" },
    });
    if (!response.ok) return;
    const html = await response.text();
    const latestDocument = new DOMParser().parseFromString(html, "text/html");
    const latest = moduleEntryFromDocument(latestDocument, response.url || window.location.origin);
    if (!latest) return;
    if (latest === current) {
      pendingEntry = null;
      forgetReloadTarget();
      return;
    }
    reloadForEntry(latest);
  } catch {
    // Offline and transient server failures are retried on the next interval.
  }
}

export function installDeploymentRecovery(pollIntervalMs = DEFAULT_POLL_INTERVAL_MS): void {
  if (installed) return;
  installed = true;
  const check = () => { if (!document.hidden) void checkForFrontendUpdate(); };
  window.setTimeout(check, 1_000);
  window.setInterval(check, pollIntervalMs);
  window.addEventListener("focus", check);
  window.addEventListener("online", check);
  document.addEventListener("visibilitychange", check);
}
