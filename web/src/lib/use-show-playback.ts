import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { useAuth } from './auth';
import { cachedPlaybackShow, loadOfflineShowData, type OfflineSlideData } from './offline-playback';
import { getCachedShow, invalidateCachedShow, type CachedShow, type OfflineManifestV3 } from './pwa-cache';
import { PlaybackAssets, isPlaybackAccessError, isPlaybackTransportError, playbackSnapshot } from './playback-assets';
import type { Show, ShowResource } from './types';
import { RESOURCE_DELETION_EVENT, type DeletionResult } from './resource-deletion';

interface PlaybackOptions {
  enabled?: boolean;
  accessibleOnly?: boolean;
  packageId?: string;
  preferCache?: boolean;
  expectedSnapshot?: string;
}
interface LoadedPlayback {
  show: Show;
  source: 'online' | 'cache';
  sessionToken: string;
  assets: PlaybackAssets;
  cached: OfflineSlideData | null;
  packageId?: string;
  ownerKey: string;
}

async function boundedRequest<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (parent.aborted) controller.abort();
  parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
  try { return await operation(controller.signal); }
  catch (error) { if (timedOut) throw new DOMException('播放请求超时', 'TimeoutError'); throw error; }
  finally { clearTimeout(timer); parent.removeEventListener('abort', abort); }
}

function manifestMatches(cached: CachedShow, fresh: OfflineManifestV3): boolean {
  return !!fresh && Array.isArray(fresh.resources) && fresh.format_version === 3 && fresh.user_id === cached.user_id && fresh.session_version === cached.session_version
    && fresh.show_id === cached.show_id && fresh.version_no === cached.version_no
    && fresh.resources.length === cached.resources.length && fresh.resources.every((item, index) => {
      const prior = cached.resources[index];
      return !!item && item.id === prior.id && item.version_no === prior.version_no && item.hidden === prior.hidden
        && item.image_sha256 === prior.image_sha256 && item.thumb_sha256 === prior.thumb_sha256;
    });
}

/** Shared source selection and ownership for fullscreen, presenter and its display. */
export function useShowPlayback(showId: number, currentIndex: number, options: PlaybackOptions = {}) {
  const auth = useAuth();
  const offlineIdentity = auth.offline === true;
  const identityOfflineRef = useRef(offlineIdentity);
  identityOfflineRef.current = offlineIdentity;
  const version = Number(auth.user?.session_version ?? 0);
  const ownerKey = auth.user ? auth.user.id + ':' + version + ':' + (auth.identity?.epoch ?? auth.epoch ?? 'unavailable') : '';
  const ownerKeyRef = useRef(ownerKey);
  ownerKeyRef.current = ownerKey;
  const [route] = useState(() => new URLSearchParams(window.location.search));
  const requestedPackage = options.packageId ?? route.get('package_id') ?? undefined;
  const preferCache = options.preferCache ?? (route.get('offline') === 'true' || (!!requestedPackage && route.get('source') !== 'online'));
  const enabled = options.enabled !== false;
  const [loaded, setLoaded] = useState<LoadedPlayback | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [assetRevision, setAssetRevision] = useState(0);
  const [thumbsReady, setThumbsReady] = useState(false);
  const switchRef = useRef<() => Promise<void>>(async () => { throw new Error('播放尚未就绪'); });
  const switchToCache = useCallback(() => switchRef.current(), []);
  const failureRef = useRef<(failure: unknown) => void>(() => undefined);
  const reportFailure = useCallback((failure: unknown) => failureRef.current(failure), []);

  useEffect(() => {
    if (!enabled || !ownerKey) return;
    const expectedIdentity = auth.identity ?? null;
    const controller = new AbortController();
    let cancelled = false;
    let terminalError: Error | null = null;
    let current: LoadedPlayback | null = null;
    let candidate: OfflineSlideData | null = null;
    let unsubscribe: (() => void) | undefined;
    let fallback: Promise<void> | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = () => !cancelled && ownerKeyRef.current === ownerKey;
    const revokeCache = async () => {
      if (!isCurrent()) return;
      await invalidateCachedShow(showId, expectedIdentity);
    };
    const request = <T,>(path: string, method = 'GET') => boundedRequest(signal => api<T>(path, { method, signal, cache: 'no-store' }), controller.signal);
    const fail = (failure: unknown) => {
      if (!isCurrent() || terminalError || (failure instanceof DOMException && failure.name === 'AbortError')) return;
      terminalError = failure instanceof Error ? failure : new Error('播放加载失败');
      controller.abort(); unsubscribe?.(); clearTimeout(expiryTimer);
      current?.assets.dispose();
      candidate?.revokeAll();
      setImageUrl(null);
      setError(terminalError.message);
      setLoading(false); setImageLoading(false);
    };
    failureRef.current = fail;
    const assertSnapshot = (show: Show) => {
      if (!show.resources.length) throw new Error('放映没有可播放页面，请返回详情页处理');
      if (show.resources.some(resource => !resource.accessible && (resource.unavailable_reason === 'missing_resource' || resource.unavailable_reason === 'missing_version'))) {
        throw new Error('放映包含已删除的素材或版本，请返回详情页清理失效页');
      }
      if (options.expectedSnapshot && playbackSnapshot(show) !== options.expectedSnapshot) throw new Error('放映版本与主控不一致，请从主控重新打开用户视图');
    };
    const authorizeCache = async (data: OfflineSlideData) => {
      await getCachedShow(showId, data.showInfo.package_id);
      if (identityOfflineRef.current) return;
      try {
        const fresh = await request<OfflineManifestV3>('/api/shows/' + showId + '/offline-manifest');
        if (!manifestMatches(data.showInfo, fresh)) throw new Error('缓存内容与当前放映版本不一致，请更新缓存后重新播放');
      } catch (failure) {
        if (isPlaybackAccessError(failure)) await revokeCache();
        if (!isPlaybackTransportError(failure)) throw failure;
      }
    };
    const publish = (value: LoadedPlayback) => {
      if (!isCurrent() || terminalError) { value.assets.dispose(); value.cached?.revokeAll(); return; }
      unsubscribe?.();
      current = value;
      unsubscribe = value.assets.subscribe(() => { if (!cancelled) setAssetRevision(revision => revision + 1); });
      clearTimeout(expiryTimer);
      if (value.source === 'cache' && value.cached) {
        expiryTimer = setTimeout(() => fail(new Error('此离线缓存授权已过期，请联网重新下载')), Math.max(0, Date.parse(value.cached.showInfo.expires_at) - Date.now()));
      }
      setLoaded(value); setError(null); setLoading(false);
    };
    const cachedValue = (data: OfflineSlideData): LoadedPlayback => {
      const show = cachedPlaybackShow(data.showInfo);
      assertSnapshot(show);
      return { show, assets: data.assets, cached: data, source: 'cache', sessionToken: '', packageId: data.showInfo.package_id, ownerKey };
    };
    switchRef.current = () => {
      if (terminalError) return Promise.reject(terminalError);
      if (current?.source === 'cache') return Promise.resolve();
      if (fallback) return fallback;
      fallback = (async () => {
        if (!candidate) throw new Error('网络连接失败，此版本没有可用的授权离线缓存');
        await authorizeCache(candidate);
        const next = cachedValue(candidate);
        if (current && playbackSnapshot(current.show) !== playbackSnapshot(next.show)) throw new Error('离线缓存不是本次播放的版本，请联网后重新打开');
        if (!isCurrent() || terminalError) return;
        current?.assets.dispose();
        publish(next);
      })().catch(failure => { fail(failure); throw failure; });
      return fallback;
    };
    setLoading(true); setError(null); setLoaded(null); setImageUrl(null);
    void (async () => {
      if (!Number.isInteger(showId) || showId <= 0) throw new Error('无效的放映 ID');
      if (preferCache || identityOfflineRef.current) {
        candidate = await loadOfflineShowData(showId, requestedPackage);
        if (!isCurrent()) { candidate.revokeAll(); return; }
        await authorizeCache(candidate);
        publish(cachedValue(candidate));
        return;
      }
      // Observe every result: a parallel HTTP denial outranks a transport failure.
      const results = await Promise.allSettled([
        request<{ show: Show }>('/api/shows/' + showId),
        request<{ session_token: string }>('/api/shows/' + showId + '/present-session', 'POST'),
      ]);
      if (!isCurrent() || terminalError) return;
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      const denial = failures.find(result => isPlaybackAccessError(result.reason))
        ?? failures.find(result => result.reason instanceof ApiError);
      if (denial) {
        if (isPlaybackAccessError(denial.reason)) await revokeCache();
        throw denial.reason;
      }
      if (failures.length && !failures.every(result => isPlaybackTransportError(result.reason))) throw failures[0].reason;
      candidate = await loadOfflineShowData(showId, requestedPackage).catch(() => null);
      if (!isCurrent()) { candidate?.revokeAll(); return; }
      if (requestedPackage && !candidate) throw new Error('指定播放缓存已失效，请从主控重新打开');
      if (failures.length) {
        if (!candidate) throw new Error('网络连接失败，且没有可用的授权离线缓存');
        if (results[0].status === 'fulfilled') {
          const knownShow = results[0].value.show;
          if (!knownShow || !Array.isArray(knownShow.resources)) throw new Error('播放数据不完整');
          assertSnapshot(knownShow);
          if (knownShow.resources.some(resource => !resource.accessible)) {
            await revokeCache();
            throw new Error('此放映中有素材已无权访问，不能使用旧缓存播放');
          }
          if (playbackSnapshot(knownShow) !== playbackSnapshot(cachedPlaybackShow(candidate.showInfo))) throw new Error('离线缓存不是当前放映版本，请联网后重新打开');
        }
        await authorizeCache(candidate);
        publish(cachedValue(candidate));
        return;
      }
      const show = (results[0] as PromiseFulfilledResult<{ show: Show }>).value.show;
      const token = (results[1] as PromiseFulfilledResult<{ session_token: string }>).value.session_token;
      if (!show || !Array.isArray(show.resources) || typeof token !== 'string' || !token) throw new Error('播放数据不完整');
      assertSnapshot(show);
      if (candidate && playbackSnapshot(show) !== playbackSnapshot(cachedPlaybackShow(candidate.showInfo))) { candidate.revokeAll(); candidate = null; }
      const assets = new PlaybackAssets(async index => {
        if (identityOfflineRef.current) throw new TypeError('当前使用离线身份');
        const resource = show.resources[index];
        if (!resource?.accessible) throw new Error('无权限查看此幻灯片');
        return boundedRequest(async signal => {
          try {
            const response = await api<Response>('/api/shows/' + showId + '/offline-assets/' + resource.id + '/image?version_no=' + resource.version_no, { raw: true, signal, cache: 'no-store' });
            const blob = await response.blob();
            if (!blob.type.startsWith('image/')) throw new Error('幻灯片响应不是图片');
            return blob;
          } catch (failure) {
            if (isPlaybackAccessError(failure)) { await revokeCache(); fail(failure); }
            throw failure;
          }
        }, controller.signal);
      });
      publish({ show, sessionToken: token, source: 'online', assets, cached: null, packageId: candidate?.showInfo.package_id, ownerKey });
    })().catch(fail);

    const checkAuthorization = () => {
      if (!isCurrent() || terminalError || current?.source !== 'cache' || !current.packageId) return;
      void getCachedShow(showId, current.packageId).catch(fail);
    };
    const onPwaChange = (event: Event) => {
      if (!isCurrent() || terminalError) return;
      const detail = (event as CustomEvent<{ showId?: number; ownerKey?: string; reason?: 'revoked' | 'deleted' | 'changed' }>).detail;
      if (detail?.showId === showId && detail.ownerKey === ownerKey) {
        if (detail.reason === 'changed') { fail(new Error('放映页面已变更，请重新打开或更新缓存')); return; }
        if (detail.reason === 'revoked') {
          fail(new Error(current?.source === 'online'
            ? '此放映的访问授权已撤销，请重新打开'
            : '此放映的离线授权已失效，请联网重新获取'));
          return;
        }
        if (detail.reason === 'deleted' && (current?.source === 'cache' || (!current && (preferCache || identityOfflineRef.current)))) {
          fail(new Error('此离线缓存已删除，请重新下载'));
          return;
        }
      }
      checkAuthorization();
    };
    const onResourceDeletion = (event: Event) => {
      const result = (event as CustomEvent<DeletionResult>).detail;
      if (result?.deleted_show_ids.includes(showId)) fail(new Error('此放映已因页面清空而删除，请返回放映列表'));
      else if (result?.reference_action === 'remove' && result.affected_show_ids.includes(showId)) fail(new Error('放映页面已变更，请重新打开'));
    };
    window.addEventListener(RESOURCE_DELETION_EVENT, onResourceDeletion);
    const checkTimer = setInterval(checkAuthorization, 10_000);
    window.addEventListener('storage', checkAuthorization);
    window.addEventListener('slideflow-pwa-change', onPwaChange);
    document.addEventListener('visibilitychange', checkAuthorization);
    return () => {
      cancelled = true; controller.abort(); unsubscribe?.();
      clearInterval(checkTimer); clearTimeout(expiryTimer);
      window.removeEventListener(RESOURCE_DELETION_EVENT, onResourceDeletion);
      window.removeEventListener('storage', checkAuthorization);
      window.removeEventListener('slideflow-pwa-change', onPwaChange);
      document.removeEventListener('visibilitychange', checkAuthorization);
      current?.assets.dispose(); candidate?.revokeAll();
    };
  }, [showId, ownerKey, enabled, preferCache, requestedPackage, options.expectedSnapshot]);

  const active = loaded?.ownerKey === ownerKey ? loaded : null;
  const sourceIndices = useMemo(() => active ? active.show.resources.flatMap((resource, index) => options.accessibleOnly && !resource.accessible ? [] : [index]) : [], [active, options.accessibleOnly]);
  const resources: ShowResource[] = useMemo(() => sourceIndices.map(index => {
    const resource = active!.show.resources[index];
    return resource.accessible && active!.source === 'cache' ? { ...resource, preview_url: active!.assets.peek(index, 'thumb') || null } : resource;
  }), [active, sourceIndices, assetRevision]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const index = sourceIndices[currentIndex];
    const resource = active.show.resources[index];
    setImageUrl(null); setImageLoading(false);
    if (index === undefined || !resource?.accessible) return;
    const adjacent = [currentIndex, currentIndex + 1, currentIndex - 1, currentIndex + 2, currentIndex - 2].map(at => sourceIndices[at]).filter(at => at !== undefined && active.show.resources[at]?.accessible);
    active.assets.retain(adjacent);
    setImageLoading(true);
    const load = active.cached ? active.cached.loadSlide(index) : active.assets.load(index, 'image', true);
    void load.then(url => { if (!cancelled) { setImageUrl(url); setImageLoading(false); } }).catch(async failure => {
      if (cancelled || (failure instanceof DOMException && failure.name === 'AbortError')) return;
      if (active.source === 'online' && isPlaybackTransportError(failure)) {
        await switchToCache().catch(() => undefined);
      } else {
        reportFailure(failure);
      }
    });
    for (const neighbor of adjacent.slice(1)) void active.assets.load(neighbor).catch(() => undefined);
    return () => { cancelled = true; };
  }, [active, currentIndex, sourceIndices, switchToCache, reportFailure]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    if (active.source === 'online') { setThumbsReady(true); return; }
    setThumbsReady(false);
    void Promise.allSettled(sourceIndices.map(index => active.assets.load(index, 'thumb'))).then(results => {
      if (cancelled) return;
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected' && !(failed.reason instanceof DOMException && failed.reason.name === 'AbortError')) reportFailure(failed.reason);
      setThumbsReady(true);
    });
    return () => { cancelled = true; };
  }, [active, sourceIndices, reportFailure]);

  useEffect(() => {
    if (offlineIdentity && active?.source === 'online') void switchToCache().catch(() => undefined);
  }, [offlineIdentity, active, switchToCache]);

  return {
    show: active?.show ?? null, resources, imageUrl: active && !error ? imageUrl : null,
    loading: enabled && (loading || !active) && !error, error, imageLoading, thumbsReady,
    source: active?.source ?? 'online', offlineData: active?.cached ?? null,
    packageId: active?.packageId, sessionToken: active?.sessionToken ?? '', ownerKey,
    snapshot: active ? playbackSnapshot(active.show) : '', switchToCache,
    canWrite: !!active && !error && active.source === 'online' && !offlineIdentity,
    reportImageError: () => reportFailure(new Error('幻灯片图片无法显示，请重新打开播放')),
  };
}
