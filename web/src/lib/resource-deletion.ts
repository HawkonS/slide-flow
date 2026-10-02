import type { QueryClient } from '@tanstack/react-query';
import { assertOfflineIdentity, offlineOwnerKey, type OfflineIdentity } from './offline-session';
import { invalidateCachedShow } from './pwa-cache';

export type ReferenceAction = 'preserve' | 'remove';
export type DeletionScope = 'all' | 'latest';
export interface DeletionPreview {
  scope: DeletionScope;
  targets: Array<{ id: number; name: string; version_count: number; version_nos: number[]; selected_version_count: number; delete_resource: boolean }>;
  shows: Array<{ id: number; name: string; version_no: number; owner: { id: number; name: string | null; username: string } | null; can_manage: boolean; page_count: number; removed_pages: number; remaining_pages: number; will_delete: boolean; share_count: number; references: Array<{ resource_id: number; version_no: number; hidden: boolean }> }>;
  show_count: number; restricted_show_count: number; has_references: boolean;
  removed_pages: number; removed_share_pages: number; empty_show_count: number; share_count: number;
  available_actions: ReferenceAction[]; confirmation_token: string;
}
export interface DeletionResult {
  reference_action: ReferenceAction; resource_ids: number[]; affected_show_ids: number[];
  deleted_show_ids: number[]; removed_pages: number; removed_share_pages?: number; deleted: number; deleted_versions: number;
}
export const RESOURCE_DELETION_EVENT = 'slideflow-resources-deleted';
const roots = new Set(['resources', 'resource', 'resource-detail', 'manage-resources', 'shows', 'show-detail', 'home', 'me', 'offline-cache']);
export async function refreshDeletionQueries(client: QueryClient): Promise<void> {
  const predicate = (query: { queryKey: readonly unknown[] }) => roots.has(String(query.queryKey[0])) || String(query.queryKey[0]).includes('share');
  await client.cancelQueries({ predicate });
  await client.invalidateQueries({ predicate });
}
export async function applyResourceDeletion(client: QueryClient, result: DeletionResult, identity: OfflineIdentity | null): Promise<number> {
  if (identity) assertOfflineIdentity(identity);
  window.dispatchEvent(new CustomEvent(RESOURCE_DELETION_EVENT, { detail: result }));
  if (identity && typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(RESOURCE_DELETION_EVENT);
    channel.postMessage({ owner: offlineOwnerKey(identity), result }); channel.close();
  }
  const refresh = refreshDeletionQueries(client);
  const outcomes = result.reference_action === 'remove' && identity
    ? await Promise.allSettled(result.affected_show_ids.map(id => invalidateCachedShow(id, identity, result.deleted_show_ids.includes(id) ? 'deleted' : 'changed')))
    : [];
  await refresh;
  return outcomes.filter(item => item.status === 'rejected').length;
}
export function subscribeResourceDeletions(client: QueryClient, identity: OfflineIdentity | null): () => void {
  if (!identity || typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(RESOURCE_DELETION_EVENT);
  channel.onmessage = event => {
    if (event.data?.owner !== offlineOwnerKey(identity)) return;
    try { assertOfflineIdentity(identity); } catch { return; }
    const result = event.data.result as DeletionResult | undefined;
    if (!result || !Array.isArray(result.deleted_show_ids) || !Array.isArray(result.affected_show_ids)
      || [...result.deleted_show_ids, ...result.affected_show_ids].some(id => !Number.isSafeInteger(id) || id <= 0)) return;
    window.dispatchEvent(new CustomEvent(RESOURCE_DELETION_EVENT, { detail: result }));
    const cacheUpdates = result.reference_action === 'remove'
      ? result.affected_show_ids.map(id => invalidateCachedShow(id, identity, result.deleted_show_ids.includes(id) ? 'deleted' : 'changed'))
      : [];
    void Promise.allSettled(cacheUpdates).then(() => refreshDeletionQueries(client));
  };
  return () => channel.close();
}
