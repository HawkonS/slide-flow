const CHUNK_RELOAD_KEY = "slideflow:chunk-reload";

export function getChunkErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

export function isChunkLoadError(error: unknown): boolean {
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading (?:CSS )?chunk .+ failed|ChunkLoadError/i.test(
    getChunkErrorMessage(error),
  );
}

/**
 * Refresh once for a specific stale chunk. The token includes the missing
 * asset message, so a later deployment with another hash can recover too.
 */
export function reloadAfterChunkError(error: unknown): boolean {
  if (!isChunkLoadError(error)) return false;
  // Reloading cannot repair an offline connection and must never interrupt
  // a running fullscreen, presenter or audience display during an upgrade.
  if (!navigator.onLine || isPlaybackWindow()) return false;

  const token = [
    window.location.pathname,
    window.location.search,
    getChunkErrorMessage(error).slice(0, 512),
  ].join("|");

  try {
    if (window.sessionStorage.getItem(CHUNK_RELOAD_KEY) === token) return false;
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, token);
  } catch {
    // Without a persisted retry marker an automatic reload could loop.
    return false;
  }

  window.location.reload();
  return true;
}

export function installChunkLoadRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (reloadAfterChunkError(payload)) event.preventDefault();
  });
}
import { isPlaybackWindow } from "./pwa";
