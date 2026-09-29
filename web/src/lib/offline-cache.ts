// Read-only migration for retired directory caches. New downloads use pwa-cache.ts.
interface FileSystemPermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

declare global {
  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>
    requestPermission(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>
  }
  interface Window {
    showDirectoryPicker(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>
  }
}

export interface LegacyShow { show_id: number; name: string; version_no: number }

/** Read a previously saved handle without creating or modifying a legacy database. */
export function getDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  return new Promise((resolve, reject) => {
    let absent = false;
    let blocked = false;
    const request = indexedDB.open('slideflow-offline-cache');
    request.onupgradeneeded = () => {
      absent = true;
      request.transaction?.abort();
    };
    request.onblocked = () => { blocked = true; reject(new Error('旧目录记录暂时不可读取')); };
    request.onerror = () => absent ? resolve(null) : reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (blocked || !db.objectStoreNames.contains('settings')) { db.close(); resolve(null); return; }
      const tx = db.transaction('settings', 'readonly');
      const read = tx.objectStore('settings').get('dir-handle');
      let handle: FileSystemDirectoryHandle | null = null;
      read.onsuccess = () => {
        const value = read.result;
        if (value?.kind === 'directory' && typeof value.getFileHandle === 'function') handle = value;
      };
      tx.oncomplete = () => { db.close(); resolve(handle); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || read.error); };
    };
  });
}

/** Legacy files supply metadata only. Never load scripts or read old images. */
export async function readLegacyManifest(
  handle: FileSystemDirectoryHandle, expectedOrigin = window.location.origin,
): Promise<LegacyShow[]> {
  let file: File;
  try { file = await (await handle.getFileHandle('manifest.json')).getFile(); }
  catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
    file = await (await handle.getFileHandle('manifest.js')).getFile();
  }
  if (file.size > 2 * 1024 * 1024) throw new Error('旧目录清单过大，无法迁移');
  const text = (await file.text()).trim();
  const wrapper = text.match(/^window\.__OFFLINE_MANIFEST\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  const data: unknown = JSON.parse(wrapper ? wrapper[1] : text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('旧目录清单格式无效');
  const manifest = data as Record<string, unknown>;
  if (manifest.version !== 2 || !manifest.shows || typeof manifest.shows !== 'object' || Array.isArray(manifest.shows)) {
    throw new Error('旧目录清单格式无效');
  }
  if (typeof manifest.server_url !== 'string' || new URL(manifest.server_url).origin !== expectedOrigin) {
    throw new Error('旧目录来自其他站点，请在原站点重新下载对应放映');
  }
  const entries = Object.entries(manifest.shows);
  if (entries.length > 10000) throw new Error('旧目录清单条目过多');
  return entries.flatMap(([key, value]) => {
    if (!/^[1-9]\d*$/.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const id = Number(key);
    if (!Number.isSafeInteger(id) || row.id !== id || typeof row.name !== 'string'
        || typeof row.version_no !== 'number' || !Number.isSafeInteger(row.version_no) || row.version_no < 1) return [];
    return [{ show_id: id, name: row.name.slice(0, 500), version_no: row.version_no }];
  });
}
