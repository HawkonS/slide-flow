export async function getCachedShow(showId: number, packageId?: string) {
  const packages = JSON.parse(localStorage.getItem('playback-test-packages') || '{}');
  const value = packages[packageId || localStorage.getItem('playback-test-latest') || ''];
  if (!value || value.show_id !== showId) throw new Error('没有可用离线缓存');
  if (localStorage.getItem('playback-test-revoked')) throw new Error('缓存授权已撤销');
  if (value.user_id !== window.__playbackAuth.user.id || value.session_version !== window.__playbackAuth.user.session_version) throw new Error('缓存不属于当前身份');
  if (Date.parse(value.expires_at) <= Date.now()) throw new Error('缓存授权已过期');
  return value;
}
export async function pinCachedShow(packageId: string) { await getCachedShow(1, packageId); return () => {}; }
export async function invalidateCachedShow() { localStorage.setItem('playback-test-revoked', 'true'); window.dispatchEvent(new Event('slideflow-pwa-change')); }
export async function getCachedAsset(packageId: string, index: number, kind: string) {
  const show = await getCachedShow(1, packageId);
  if (!show.resources[index] || localStorage.getItem('playback-test-corrupt')) throw new Error('缓存图片校验失败');
  const data = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=');
  return new Blob([Uint8Array.from(data, character => character.charCodeAt(0))], { type: 'image/png' });
}
