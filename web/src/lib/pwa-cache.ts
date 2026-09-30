import { api, ApiError, type FetchOptions } from "./api";
import { ensureOfflineShellReady } from "./pwa";
import {
  assertOfflineIdentity,
  createClientId,
  grantOfflineLease,
  lockOfflineIdentity,
  notifyPwaChange,
  offlineOwnerKey,
  readOfflineIdentity,
  type OfflineIdentity,
} from "./offline-session";

export interface OfflineManifestV3 {
  format_version: 3;
  package_id: string;
  user_id: number;
  session_version: number;
  issued_at: string;
  expires_at: string;
  show_id: number;
  name: string;
  version_no: number;
  series_id: string;
  updated_at: string;
  subject: string | null;
  tags: string[];
  status: string;
  owner_name: string | null;
  resources: Array<{
    id: number;
    name: string;
    version_no: number;
    slide_index: number;
    hidden: boolean;
    image_url: string;
    thumb_url: string;
    image_sha256: string;
    thumb_sha256: string;
    size_bytes: number;
    thumb_size_bytes: number;
    common_remark_html: string;
    personal_remark_html: string;
    show_remark_html: string;
  }>;
}

export interface CachedShow extends OfflineManifestV3 {
  cached_at: string;
  total_bytes: number;
  owner_key: string;
  state: "staging" | "ready";
  revoked?: boolean;
}

export interface CacheProgress {
  phase: "preparing" | "downloading" | "verifying" | "ready";
  completed: number;
  total: number;
  bytes: number;
}

interface ActivePackage { packageId: string; revoked: boolean; revision?: number }
interface PlaybackLease { id: string; packageId: string; until: number }
const DB_NAME = "slideflow-pwa-v3";
const STORES = ["packages", "assets", "active", "leases"];
const LEASE_MS = 10 * 60_000;
const downloads = new Map<string, Promise<CachedShow>>();

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("无法读取离线缓存"));
  });
}

async function transaction<T>(
  stores: string[], mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const opening = indexedDB.open(DB_NAME, 1);
  opening.onupgradeneeded = () => {
    for (const name of STORES) {
      if (!opening.result.objectStoreNames.contains(name)) opening.result.createObjectStore(name);
    }
  };
  const db = await request(opening);
  db.onversionchange = () => db.close();
  const tx = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException("缓存操作已取消", "AbortError"));
    tx.onerror = () => reject(tx.error ?? new Error("缓存存储失败"));
  });
  // A request may fail before work() has returned. Observe that rejection now.
  void done.catch(() => undefined);
  try {
    const result = await work(tx);
    await done;
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* The transaction may already have completed. */ }
    await done.catch(() => undefined);
    throw error;
  } finally { db.close(); }
}

function currentIdentity(): OfflineIdentity {
  const identity = readOfflineIdentity();
  if (!identity) throw new Error("请先联网登录，再下载或播放离线放映");
  assertOfflineIdentity(identity);
  return identity;
}

function activeKey(owner: string, showId: number): string { return owner + ":" + showId; }
function assetKey(packageId: string, index: number, kind: "image" | "thumb"): string {
  return packageId + ":" + index + ":" + kind;
}
function assetRange(packageId: string): IDBKeyRange {
  return IDBKeyRange.bound(packageId + ":", packageId + ":\uffff");
}

function checkPackage(entry: CachedShow | undefined, identity: OfflineIdentity, active?: ActivePackage): asserts entry is CachedShow {
  assertOfflineIdentity(identity);
  if (!entry || entry.state !== "ready") throw new Error("尚未完整缓存此放映，请联网下载后再播放");
  if (entry.owner_key !== offlineOwnerKey(identity) || entry.user_id !== identity.user.id || entry.session_version !== identity.sessionVersion) {
    throw new Error("此缓存不属于当前登录会话，请重新下载");
  }
  if (active?.revoked || entry.revoked) throw new Error("此放映的离线授权已失效，请联网重新获取");
  if (!Number.isFinite(Date.parse(entry.expires_at)) || Date.parse(entry.expires_at) <= Date.now()) {
    throw new Error("离线授权已到期，请联网更新缓存");
  }
}

export async function listCachedShows(): Promise<CachedShow[]> {
  const identity = currentIdentity();
  const owner = offlineOwnerKey(identity);
  const entries = await transaction(["packages", "active"], "readonly", async (tx) => {
    const [packages, pointers, keys] = await Promise.all([
      request<CachedShow[]>(tx.objectStore("packages").getAll()),
      request<ActivePackage[]>(tx.objectStore("active").getAll()),
      request(tx.objectStore("active").getAllKeys()),
    ]);
    const active = new Map(keys.map((key, index) => [String(key), pointers[index]]));
    return packages.filter((entry) => entry.owner_key === owner && entry.state === "ready" &&
      active.get(activeKey(owner, entry.show_id))?.packageId === entry.package_id)
      .map((entry) => ({ ...entry, revoked: active.get(activeKey(owner, entry.show_id))?.revoked ?? false }));
  });
  assertOfflineIdentity(identity);
  return entries.sort((a, b) => b.cached_at.localeCompare(a.cached_at));
}

export async function getCachedShow(showId: number, packageId?: string): Promise<CachedShow> {
  const identity = currentIdentity();
  return transaction(["packages", "active"], "readonly", async (tx) => {
    const active = await request<ActivePackage | undefined>(tx.objectStore("active").get(activeKey(offlineOwnerKey(identity), showId)));
    const selected = packageId || active?.packageId;
    const entry = selected ? await request<CachedShow | undefined>(tx.objectStore("packages").get(selected)) : undefined;
    checkPackage(entry, identity, active);
    if (entry.show_id !== showId) throw new Error("缓存包与当前放映不匹配");
    return entry;
  });
}

export async function getCachedAsset(packageId: string, index: number, kind: "image" | "thumb"): Promise<Blob> {
  const identity = currentIdentity();
  return transaction(["packages", "active", "assets"], "readonly", async (tx) => {
    const entry = await request<CachedShow | undefined>(tx.objectStore("packages").get(packageId));
    const active = entry ? await request<ActivePackage | undefined>(tx.objectStore("active").get(activeKey(offlineOwnerKey(identity), entry.show_id))) : undefined;
    checkPackage(entry, identity, active);
    if (!Number.isInteger(index) || index < 0 || index >= entry.resources.length) throw new Error("放映页码无效");
    const blob = await request<Blob | undefined>(tx.objectStore("assets").get(assetKey(packageId, index, kind)));
    assertOfflineIdentity(identity);
    if (!(blob instanceof Blob) || !blob.size) throw new Error("缓存图片缺失，请联网重新下载此放映");
    return blob;
  });
}

export async function pinCachedShow(packageId: string): Promise<() => void> {
  const identity = currentIdentity();
  const id = createClientId();
  let released = false;
  const touch = async () => transaction(["packages", "active", "leases"], "readwrite", async (tx) => {
    const entry = await request<CachedShow | undefined>(tx.objectStore("packages").get(packageId));
    const active = entry ? await request<ActivePackage | undefined>(tx.objectStore("active").get(activeKey(offlineOwnerKey(identity), entry.show_id))) : undefined;
    checkPackage(entry, identity, active);
    if (!released) tx.objectStore("leases").put({ id, packageId, until: Date.now() + LEASE_MS } satisfies PlaybackLease, id);
  });
  await touch();
  const timer = setInterval(() => { if (!released) void touch().catch(() => undefined); }, 30_000);
  return () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    void transaction(["leases"], "readwrite", (tx) => { tx.objectStore("leases").delete(id); }).catch(() => undefined);
  };
}

export async function invalidateCachedShow(
  showId: number,
  identity: OfflineIdentity | null,
  reason: "revoked" | "deleted" = "revoked",
): Promise<void> {
  if (!identity) return;
  assertOfflineIdentity(identity);
  const owner = offlineOwnerKey(identity);
  // Stop already-loaded views immediately, even if persistence subsequently fails.
  notifyPwaChange(showId, { ownerKey: owner, reason });
  try {
    await transaction(["active", "packages"], "readwrite", async (tx) => {
      const key = activeKey(owner, showId);
      const [active, packages] = await Promise.all([
        request<ActivePackage | undefined>(tx.objectStore("active").get(key)),
        request<CachedShow[]>(tx.objectStore("packages").getAll()),
      ]);
      assertOfflineIdentity(identity);
      tx.objectStore("active").put({ packageId: active?.packageId ?? "", revoked: true, revision: (active?.revision ?? 0) + 1 }, key);
      // A later authorized package must never revive an older revoked snapshot.
      for (const entry of packages) {
        if (entry.owner_key === owner && entry.show_id === showId) {
          tx.objectStore("packages").put({ ...entry, revoked: true }, entry.package_id);
        }
      }
    });
  } catch (error) {
    // A late response for a previous identity cannot lock the current account.
    assertOfflineIdentity(identity);
    // Readable-but-unwritable IndexedDB must not turn a definitive denial into
    // an offline fallback. Lock locally before best-effort physical cleanup.
    lockOfflineIdentity();
    void purgeOfflineOwner(owner).catch(() => undefined);
    throw new Error("无法保存缓存失效状态，已暂停此登录会话的本地访问，请重新登录");
  }
  notifyPwaChange(showId, { ownerKey: owner, reason });
}

function removePackage(tx: IDBTransaction, packageId: string) {
  tx.objectStore("packages").delete(packageId);
  tx.objectStore("assets").delete(assetRange(packageId));
}

export async function deleteCachedShow(showId: number): Promise<void> {
  const identity = currentIdentity();
  const owner = offlineOwnerKey(identity);
  await invalidateCachedShow(showId, identity, "deleted");
  await transaction(STORES, "readwrite", async (tx) => {
    const entries = await request<CachedShow[]>(tx.objectStore("packages").getAll());
    assertOfflineIdentity(identity);
    const ids = new Set(entries.filter((entry) => entry.owner_key === owner && entry.show_id === showId).map((entry) => entry.package_id));
    for (const id of ids) removePackage(tx, id);
    const leases = await request<PlaybackLease[]>(tx.objectStore("leases").getAll());
    for (const lease of leases) if (ids.has(lease.packageId)) tx.objectStore("leases").delete(lease.id);
  });
  notifyPwaChange(showId);
}

// Accept an explicit previous owner: logout invalidates identity synchronously first.
export async function purgeOfflineOwner(ownerKey: string): Promise<void> {
  await transaction(STORES, "readwrite", async (tx) => {
    const [entries, keys, leases] = await Promise.all([
      request<CachedShow[]>(tx.objectStore("packages").getAll()),
      request(tx.objectStore("active").getAllKeys()),
      request<PlaybackLease[]>(tx.objectStore("leases").getAll()),
    ]);
    const ids = new Set(entries.filter((entry) => entry.owner_key === ownerKey).map((entry) => entry.package_id));
    for (const id of ids) removePackage(tx, id);
    for (const key of keys) if (String(key).startsWith(ownerKey + ":")) tx.objectStore("active").delete(key);
    for (const lease of leases) if (ids.has(lease.packageId)) tx.objectStore("leases").delete(lease.id);
  });
}

async function collectUnusedPackages(): Promise<void> {
  await transaction(STORES, "readwrite", async (tx) => {
    const [entries, active, leases] = await Promise.all([
      request<CachedShow[]>(tx.objectStore("packages").getAll()),
      request<ActivePackage[]>(tx.objectStore("active").getAll()),
      request<PlaybackLease[]>(tx.objectStore("leases").getAll()),
    ]);
    const retained = new Set(active.map((entry) => entry.packageId));
    for (const lease of leases) {
      if (lease.until > Date.now()) retained.add(lease.packageId);
      else tx.objectStore("leases").delete(lease.id);
    }
    for (const entry of entries) {
      const age = Date.now() - Date.parse(entry.cached_at);
      const grace = entry.state === "staging" ? 24 * 60 * 60_000 : 60_000;
      if (!retained.has(entry.package_id) && age > grace) removePackage(tx, entry.package_id);
    }
  });
}

function validateManifest(manifest: OfflineManifestV3, showId: number, identity: OfflineIdentity): void {
  const issued = Date.parse(manifest.issued_at);
  const expires = Date.parse(manifest.expires_at);
  if (manifest.format_version !== 3 || manifest.show_id !== showId || !/^[a-zA-Z0-9_-]{8,128}$/.test(manifest.package_id) ||
      manifest.user_id !== identity.user.id || manifest.session_version !== identity.sessionVersion ||
      !Number.isFinite(issued) || !Number.isFinite(expires) || expires <= Date.now() || expires <= issued ||
      expires - issued > 24 * 60 * 60_000 + 1000 || !Array.isArray(manifest.resources) ||
      manifest.resources.length === 0 || manifest.resources.length > 10_000) {
    throw new Error("离线清单或登录授权无效，请重新登录后下载");
  }
  for (const resource of manifest.resources) {
    if (!Number.isInteger(resource.id) || !Number.isInteger(resource.version_no) ||
        !/^[a-f0-9]{64}$/i.test(resource.image_sha256) || !/^[a-f0-9]{64}$/i.test(resource.thumb_sha256)) {
      throw new Error("离线清单缺少有效的资源版本或校验值");
    }
    for (const [path, size] of [[resource.image_url, resource.size_bytes], [resource.thumb_url, resource.thumb_size_bytes]] as const) {
      const url = new URL(path, window.location.origin);
      if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/shows/" + showId + "/offline-assets/") ||
          !Number.isSafeInteger(size) || size <= 0 || size > 128 * 1024 * 1024) {
        throw new Error("离线图片地址或大小无效");
      }
    }
  }
}

function manifestContent(manifest: OfflineManifestV3): string {
  const { package_id: _package, issued_at: _issued, expires_at: _expires, ...content } = manifest;
  return JSON.stringify(content);
}

async function timedApi<T>(path: string, options: FetchOptions, signal: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);
  try { return await api<T>(path, { ...options, signal: controller.signal, cache: "no-store" }); }
  catch (error) {
    if (timedOut && !signal.aborted) throw new DOMException("下载长时间无响应，请检查网络后重试", "TimeoutError");
    throw error;
  } finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
}

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("下载已取消", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    task.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

async function readImageBody(response: Response, expectedSize: number, signal: AbortSignal): Promise<Blob> {
  const type = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!type.startsWith("image/") || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("下载响应不是图片，缓存未发布");
  }
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DOMException("下载已取消", "AbortError");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > expectedSize) throw new Error("图片大小超出清单限制，已停止下载");
      chunks.push(value as BlobPart);
    }
    if (bytes !== expectedSize) throw new Error("图片下载不完整，请重试");
    return new Blob(chunks, { type });
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function fetchAsset(path: string, size: number, sha256: string, signal: AbortSignal): Promise<Blob> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    // Cover the complete response body, not only the arrival of HTTP headers.
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);
    try {
      const response = await api<Response>(path, { raw: true, redirect: "error", cache: "no-store", signal: controller.signal });
      const blob = await readImageBody(response, size, controller.signal);
      if (signal.aborted) throw new DOMException("下载已取消", "AbortError");
      const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      if (signal.aborted) throw new DOMException("下载已取消", "AbortError");
      const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (actual !== sha256.toLowerCase()) throw new Error("图片校验失败，缓存未发布，请重试");
      return blob;
    } catch (error) {
      const transient = timedOut || error instanceof TypeError ||
        (error instanceof ApiError && [502, 503, 504].includes(error.status));
      if (signal.aborted || !transient || attempt >= 2) {
        if (timedOut && !signal.aborted) throw new DOMException("图片下载长时间无响应，请检查网络后重试", "TimeoutError");
        throw error;
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.abort();
    }
  }
}

async function performDownload(showId: number, options: { signal?: AbortSignal; onProgress?: (progress: CacheProgress) => void }): Promise<CachedShow> {
  const identity = currentIdentity();
  const owner = offlineOwnerKey(identity);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const identityChanged = () => { try { assertOfflineIdentity(identity); } catch { cancel(); } };
  const check = () => {
    assertOfflineIdentity(identity);
    if (controller.signal.aborted) throw new DOMException("下载已取消", "AbortError");
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  window.addEventListener("storage", identityChanged);
  window.addEventListener("slideflow-pwa-change", identityChanged);
  if (options.signal?.aborted) cancel();
  let stagedId: string | undefined;
  let published = false;
  try {
    options.onProgress?.({ phase: "preparing", completed: 0, total: 0, bytes: 0 });
    check();
    const originalActive = await transaction(["active"], "readonly", (tx) =>
      request<ActivePackage | undefined>(tx.objectStore("active").get(activeKey(owner, showId))));
    const originalRevision = originalActive?.revision ?? 0;
    await abortable(ensureOfflineShellReady(), controller.signal);
    check();
    const manifest = await timedApi<OfflineManifestV3>("/api/shows/" + showId + "/offline-manifest", {}, controller.signal);
    check();
    validateManifest(manifest, showId, identity);
    const totalBytes = manifest.resources.reduce((sum, resource) => sum + resource.size_bytes + resource.thumb_size_bytes, 0);
    await collectUnusedPackages();
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota && totalBytes + 1024 * 1024 > estimate.quota - (estimate.usage ?? 0)) {
      throw new Error("浏览器存储空间不足，请删除不需要的离线放映后重试");
    }
    await navigator.storage?.persist?.().catch(() => false);
    check();
    const entry: CachedShow = { ...manifest, cached_at: new Date().toISOString(), total_bytes: totalBytes, owner_key: owner, state: "staging" };
    await transaction(["packages"], "readwrite", (tx) => { check(); tx.objectStore("packages").add(entry, entry.package_id); });
    stagedId = entry.package_id;
    const jobs = manifest.resources.flatMap((resource, index) => [
      { index, kind: "image" as const, path: resource.image_url, size: resource.size_bytes, sha: resource.image_sha256 },
      { index, kind: "thumb" as const, path: resource.thumb_url, size: resource.thumb_size_bytes, sha: resource.thumb_sha256 },
    ]);
    let next = 0;
    let completed = 0;
    let bytes = 0;
    let failure: unknown;
    options.onProgress?.({ phase: "downloading", completed, total: jobs.length, bytes });
    const concurrency = jobs.some((job) => job.size > 16 * 1024 * 1024) ? 1 : 3;
    await Promise.allSettled(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      try {
        while (next < jobs.length) {
          check();
          const job = jobs[next++];
          const blob = await fetchAsset(job.path, job.size, job.sha, controller.signal);
          check();
          await transaction(["assets"], "readwrite", (tx) => { check(); tx.objectStore("assets").put(blob, assetKey(entry.package_id, job.index, job.kind)); });
          completed++;
          bytes += blob.size;
          options.onProgress?.({ phase: "downloading", completed, total: jobs.length, bytes });
        }
      } catch (error) {
        // Preserve a definitive authorization rejection over another worker's abort.
        if (!failure || (error instanceof ApiError && [401, 403, 404].includes(error.status))) failure = error;
        controller.abort();
      }
    }));
    if (failure) throw failure;
    check();
    options.onProgress?.({ phase: "verifying", completed, total: jobs.length, bytes });
    const verified = await timedApi<OfflineManifestV3>("/api/shows/" + showId + "/offline-manifest", {}, controller.signal);
    check();
    validateManifest(verified, showId, identity);
    if (manifestContent(manifest) !== manifestContent(verified)) throw new Error("下载期间放映内容发生变化，请重试；原缓存仍保留");
    const ready: CachedShow = { ...entry, issued_at: verified.issued_at, expires_at: verified.expires_at, state: "ready" };
    let publication: IDBTransaction | undefined;
    const abortPublication = () => { try { publication?.abort(); } catch { /* Already committed. */ } };
    controller.signal.addEventListener("abort", abortPublication, { once: true });
    try {
      await transaction(["packages", "assets", "active"], "readwrite", async (tx) => {
        publication = tx;
        const [count, active] = await Promise.all([
          request(tx.objectStore("assets").count(assetRange(entry.package_id))),
          request<ActivePackage | undefined>(tx.objectStore("active").get(activeKey(owner, showId))),
        ]);
        check();
        if (count !== jobs.length) throw new Error("缓存图片不完整，未发布新版本");
        if ((active?.revision ?? 0) !== originalRevision) throw new Error("缓存已在其他操作中更新、删除或撤销，本次下载未发布，请重试");
        // A lease alone never makes a package playable: readers also require a
        // committed ready package. Fail local identity persistence before changing
        // the active pointer so a storage failure preserves the previous version.
        grantOfflineLease(identity, ready.expires_at);
        check();
        tx.objectStore("packages").put(ready, entry.package_id);
        tx.objectStore("active").put({ packageId: entry.package_id, revoked: false, revision: originalRevision + 1 } satisfies ActivePackage, activeKey(owner, showId));
      });
    } finally { controller.signal.removeEventListener("abort", abortPublication); }
    published = true;
    // Committing is the cancellation boundary. Never delete a complete package
    // merely because its UI cancellation arrived after that commit.
    try { assertOfflineIdentity(identity); }
    catch (error) { await purgeOfflineOwner(owner); throw error; }
    notifyPwaChange(showId);
    options.onProgress?.({ phase: "ready", completed, total: jobs.length, bytes });
    return ready;
  } catch (error) {
    if (error instanceof ApiError && [403, 404, 409].includes(error.status)) {
      let sameIdentity = false;
      try { assertOfflineIdentity(identity); sameIdentity = true; }
      catch { /* A stale response must not revoke a different account's cache. */ }
      if (sameIdentity) await invalidateCachedShow(showId, identity);
    }
    if (error instanceof DOMException && error.name === "QuotaExceededError") throw new Error("浏览器存储空间不足，原缓存仍保留；请清理后重试");
    throw error;
  } finally {
    controller.abort();
    options.signal?.removeEventListener("abort", cancel);
    window.removeEventListener("storage", identityChanged);
    window.removeEventListener("slideflow-pwa-change", identityChanged);
    if (stagedId && !published) {
      const id = stagedId;
      await transaction(["packages", "assets"], "readwrite", (tx) => { removePackage(tx, id); }).catch(() => undefined);
    }
  }
}

export async function downloadShow(showId: number, options: { signal?: AbortSignal; onProgress?: (progress: CacheProgress) => void } = {}): Promise<CachedShow> {
  if (!Number.isSafeInteger(showId) || showId <= 0) throw new Error("无效的放映 ID");
  const key = activeKey(offlineOwnerKey(currentIdentity()), showId);
  if (downloads.has(key)) throw new Error("此放映正在下载，请等待当前下载完成");
  const task = (async (): Promise<CachedShow> => {
    if (!navigator.locks) return performDownload(showId, options);
    return await navigator.locks.request("slideflow-download:" + key, { ifAvailable: true }, (lock) => {
      if (!lock) throw new Error("此放映正在另一个窗口下载");
      return performDownload(showId, options);
    });
  })();
  downloads.set(key, task);
  try { return await task; }
  finally { downloads.delete(key); }
}
