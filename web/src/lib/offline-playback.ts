import { getCachedAsset, getCachedShow, pinCachedShow, type CachedShow } from './pwa-cache';
import { PlaybackAssets } from './playback-assets';
import type { Show } from './types';

export interface OfflineSlideData {
  showInfo: CachedShow;
  assets: PlaybackAssets;
  loadSlide(index: number): Promise<string>;
  revokeAll(): void;
}

/** Reads authenticated PWA packages from the current application store. */
export async function loadOfflineShowData(showId: string | number, packageId?: string): Promise<OfflineSlideData> {
  const showInfo = await getCachedShow(Number(showId), packageId);
  const release = await pinCachedShow(showInfo.package_id);
  const assets = new PlaybackAssets((index, kind) => getCachedAsset(showInfo.package_id, index, kind));
  let released = false;
  return {
    showInfo, assets,
    async loadSlide(index) {
      await getCachedShow(Number(showId), showInfo.package_id);
      return assets.load(index, 'image', true);
    },
    revokeAll() {
      assets.dispose();
      if (!released) { released = true; release(); }
    },
  };
}

export function cachedPlaybackShow(manifest: CachedShow): Show {
  return {
    id: manifest.show_id, name: manifest.name, version_no: manifest.version_no,
    series_id: manifest.series_id, updated_at: manifest.updated_at,
    subject: manifest.subject, tags: manifest.tags.join(','), status: manifest.status,
    owner_id: manifest.user_id, owner: null, visibility_scope: 'private',
    management_scope: 'private', is_standard: false, can_manage: false,
    has_other_versions: false, created_at: manifest.issued_at,
    resources: manifest.resources.map(resource => ({
      id: resource.id, name: resource.name, accessible: true,
      hidden: resource.hidden, version_no: resource.version_no,
      latest_version_no: resource.version_no, preview_url: null, original_preview_url: null,
    })),
  };
}

export function isOfflineMode(): boolean {
  return new URLSearchParams(window.location.search).get('offline') === 'true';
}
