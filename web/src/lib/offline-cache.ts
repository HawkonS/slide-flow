// offline-cache.ts - File System Access API 封装工具库
// 用于离线缓存管理页面和ShowOfflineCacheDialog

// ============================================================
// File System Access API Type Declarations
// ============================================================

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

// ============================================================
// Types
// ============================================================

export interface OfflineShowEntry {
  id: number
  name: string
  version_no: number
  series_id: string
  cached_at: string
  slide_count: number
  auth_mode: 'required' | 'none'
  updated_at: string
  subject?: string
  tags?: string[]
  status?: string
  secrecy_level?: string
  owner_name?: string
}

export interface OfflineManifest {
  version: number
  server_url: string
  generated_at: string
  shows: Record<string, OfflineShowEntry>
}

export interface OfflinePackageData {
  show_id: number
  name: string
  version_no: number
  series_id: string
  updated_at: string
  auth_mode: 'required' | 'none'
  auth_hash?: string
  auth_username?: string
  subject?: string
  tags?: string[]
  status?: string
  secrecy_level?: string
  owner_name?: string
  cover_thumb_base64?: string | null
  cover_hd_base64?: string | null
  resources: Array<{
    id: number
    name: string
    version_no: number
    slide_index: number
    image_base64: string
    thumb_base64?: string
    common_remark_html: string
    personal_remark_html: string
    show_remark_html: string
  }>
}

// ============================================================
// Constants
// ============================================================

const DB_NAME = 'slideflow-offline-cache'
const STORE_NAME = 'settings'
const DIR_HANDLE_KEY = 'dir-handle'

// ============================================================
// 1. IndexedDB 存储管理
// ============================================================

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** 存储DirectoryHandle到IndexedDB */
export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.put(handle, DIR_HANDLE_KEY)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => db.close()
  })
}

/** 从IndexedDB读取DirectoryHandle */
export async function getDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const req = store.get(DIR_HANDLE_KEY)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => db.close()
  })
}

/** 清除已存储的DirectoryHandle */
export async function clearDirectoryHandle(): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.delete(DIR_HANDLE_KEY)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => db.close()
  })
}

// ============================================================
// 2. 文件夹选择和权限
// ============================================================

/** 弹出文件夹选择器 */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
    return handle
  } catch (e: unknown) {
    // 用户取消选择
    if (e instanceof DOMException && e.name === 'AbortError') {
      return null
    }
    throw e
  }
}

/** 检查并请求文件夹权限 */
export async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const opts: FileSystemPermissionDescriptor = { mode: 'readwrite' }
  if ((await handle.queryPermission(opts)) === 'granted') {
    return true
  }
  if ((await handle.requestPermission(opts)) === 'granted') {
    return true
  }
  return false
}

/** 检查浏览器是否支持File System Access API */
export function isFileSystemAccessSupported(): boolean {
  if (typeof window === 'undefined') return false
  // File System Access API requires secure context (HTTPS or localhost)
  if (!window.isSecureContext) return false
  return 'showDirectoryPicker' in window && typeof window.showDirectoryPicker === 'function'
}

/**
 * 检查当前是否在安全上下文中（HTTPS 或 localhost）
 */
export function isSecureContext(): boolean {
  if (typeof window === 'undefined') return false
  return window.isSecureContext
}

// ============================================================
// 3. Manifest 管理
// ============================================================

/** 从文件夹读取manifest */
export async function readManifest(dirHandle: FileSystemDirectoryHandle): Promise<OfflineManifest | null> {
  try {
    const fileHandle = await dirHandle.getFileHandle('manifest.js')
    const file = await fileHandle.getFile()
    const text = await file.text()
    // JSONP格式: window.__OFFLINE_MANIFEST = { ... };
    const match = text.match(/window\.__OFFLINE_MANIFEST\s*=\s*([\s\S]*?)\s*;?\s*$/)
    if (!match || !match[1]) {
      return null
    }
    return JSON.parse(match[1]) as OfflineManifest
  } catch {
    // 文件不存在或解析失败
    return null
  }
}

/** 写入/更新manifest */
export async function writeManifest(dirHandle: FileSystemDirectoryHandle, manifest: OfflineManifest): Promise<void> {
  const json = JSON.stringify(manifest, null, 2)
  const content = `window.__OFFLINE_MANIFEST = ${json};`
  await writeTextFile(dirHandle, 'manifest.js', content)
}

// ============================================================
// 4. 文件写入操作
// ============================================================

/** 生成随机文件名（10位hex） */
function generateRandomFilename(): string {
  const bytes = new Uint8Array(5)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** 将base64图片数据写入PNG文件，返回生成的文件名（含.png扩展名） */
export async function writeImageFile(
  dirHandle: FileSystemDirectoryHandle,
  showId: number,
  base64Data: string
): Promise<string> {
  const filename = generateRandomFilename() + '.png'
  const rawData = base64ToUint8Array(base64Data)

  const showsDir = await getOrCreateDir(dirHandle, 'shows')
  const showDir = await getOrCreateDir(showsDir, String(showId))
  const slidesDir = await getOrCreateDir(showDir, 'slides')

  const fileHandle = await slidesDir.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(new Blob([rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength) as ArrayBuffer]))
  await writable.close()

  return filename
}

/** 写入show的info.js文件 */
export async function writeShowInfo(
  dirHandle: FileSystemDirectoryHandle,
  showId: number,
  info: object
): Promise<void> {
  const showDir = await getOrCreateDir(dirHandle, 'shows')
  const showIdDir = await getOrCreateDir(showDir, String(showId))
  const json = JSON.stringify(info, null, 2)
  const content = `window.__SHOW_INFO = ${json};`
  await writeTextFile(showIdDir, 'info.js', content)
}

/** 写入show的auth.js文件 */
export async function writeShowAuth(
  dirHandle: FileSystemDirectoryHandle,
  showId: number,
  auth: object
): Promise<void> {
  const showDir = await getOrCreateDir(dirHandle, 'shows')
  const showIdDir = await getOrCreateDir(showDir, String(showId))
  const json = JSON.stringify(auth, null, 2)
  const content = `window.__SHOW_AUTH = ${json};`
  await writeTextFile(showIdDir, 'auth.js', content)
}

/** 写入离线播放文件（index.html + style.css + app.js） */
export async function writeOfflineFiles(dirHandle: FileSystemDirectoryHandle): Promise<void> {
  const { generateOfflineHtml, generateOfflineCss, generateOfflineJs } = await import('./offline-html-template')
  await writeTextFile(dirHandle, 'index.html', generateOfflineHtml())
  await writeTextFile(dirHandle, 'style.css', generateOfflineCss())
  await writeTextFile(dirHandle, 'app.js', generateOfflineJs())
}

/** @deprecated 使用 writeOfflineFiles 替代 */
export async function writeOfflineHtml(
  dirHandle: FileSystemDirectoryHandle,
  htmlContent: string
): Promise<void> {
  await writeTextFile(dirHandle, 'index.html', htmlContent)
}

/** 删除show目录 */
export async function deleteShowCache(
  dirHandle: FileSystemDirectoryHandle,
  showId: number
): Promise<void> {
  const showsDir = await getOrCreateDir(dirHandle, 'shows')
  try {
    await showsDir.removeEntry(String(showId), { recursive: true })
  } catch {
    // 目录不存在，忽略
  }
}

// ============================================================
// 5. 辅助函数
// ============================================================

/** 获取或创建子目录 */
async function getOrCreateDir(
  parent: FileSystemDirectoryHandle,
  name: string
): Promise<FileSystemDirectoryHandle> {
  return await parent.getDirectoryHandle(name, { create: true })
}

/** base64字符串转Uint8Array */
function base64ToUint8Array(base64: string): Uint8Array {
  // 去掉 data:image/png;base64, 前缀
  const base64Clean = base64.includes(',') ? base64.split(',')[1] : base64
  const binaryStr = atob(base64Clean)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i)
  }
  return bytes
}

/** 写入文本文件 */
async function writeTextFile(
  dirHandle: FileSystemDirectoryHandle,
  filename: string,
  content: string
): Promise<void> {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(content)
  await writable.close()
}

// ============================================================
// 6. 缓存执行函数（核心）
// ============================================================

/** 执行完整的缓存写入流程 */
export async function cacheShowToDirectory(
  dirHandle: FileSystemDirectoryHandle,
  packageData: OfflinePackageData,
  serverUrl: string,
  onProgress?: (current: number, total: number) => void
): Promise<void> {
  // 1. 遍历resources，写入PNG图片并收集文件名映射
  const resourcesWithFiles = []
  for (let i = 0; i < packageData.resources.length; i++) {
    const r = packageData.resources[i]
    // 写入PNG图片，获取文件名（含.png扩展名）
    const filename = await writeImageFile(dirHandle, packageData.show_id, r.image_base64)

    // 保存缩略图（如果后端提供了 thumb_base64）
    let thumbFilename = ''
    if (r.thumb_base64) {
      const randomHex = filename.replace('.png', '')
      thumbFilename = randomHex + '_thumb.jpg'
      const thumbBinary = base64ToUint8Array(r.thumb_base64)
      const showsDir = await getOrCreateDir(dirHandle, 'shows')
      const showDir = await getOrCreateDir(showsDir, String(packageData.show_id))
      const slidesDir = await getOrCreateDir(showDir, 'slides')
      const thumbHandle = await slidesDir.getFileHandle(thumbFilename, { create: true })
      const thumbWritable = await thumbHandle.createWritable()
      await thumbWritable.write(new Blob([thumbBinary.buffer.slice(thumbBinary.byteOffset, thumbBinary.byteOffset + thumbBinary.byteLength) as ArrayBuffer]))
      await thumbWritable.close()
    }

    resourcesWithFiles.push({
      id: r.id,
      name: r.name,
      version_no: r.version_no,
      slide_index: r.slide_index,
      file: filename,
      thumb_file: thumbFilename,
      common_remark_html: r.common_remark_html || '',
      personal_remark_html: r.personal_remark_html || '',
      show_remark_html: r.show_remark_html || '',
    })

    onProgress?.(i + 1, packageData.resources.length)
  }

  // 2. 写入封面图片（不做XOR加密，明文存储）
  const showsDir = await getOrCreateDir(dirHandle, 'shows')
  const showDir = await getOrCreateDir(showsDir, String(packageData.show_id))

  let coverThumbFile: string | null = null
  let coverHdFile: string | null = null

  if (packageData.cover_thumb_base64) {
    const thumbData = base64ToUint8Array(packageData.cover_thumb_base64)
    const thumbHandle = await showDir.getFileHandle('cover_thumb.jpg', { create: true })
    const thumbWritable = await thumbHandle.createWritable()
    await thumbWritable.write(new Blob([thumbData.buffer.slice(thumbData.byteOffset, thumbData.byteOffset + thumbData.byteLength) as ArrayBuffer]))
    await thumbWritable.close()
    coverThumbFile = 'cover_thumb.jpg'
  }

  if (packageData.cover_hd_base64) {
    const hdData = base64ToUint8Array(packageData.cover_hd_base64)
    const hdHandle = await showDir.getFileHandle('cover_hd.png', { create: true })
    const hdWritable = await hdHandle.createWritable()
    await hdWritable.write(new Blob([hdData.buffer.slice(hdData.byteOffset, hdData.byteOffset + hdData.byteLength) as ArrayBuffer]))
    await hdWritable.close()
    coverHdFile = 'cover_hd.png'
  }

  // 3. 写入 info.js（xor_key=0 表示明文存储，file 字段含 .png 扩展名）
  const showInfo = {
    id: packageData.show_id,
    name: packageData.name,
    version_no: packageData.version_no,
    slide_count: packageData.resources.length,
    xor_key: 0,
    subject: packageData.subject,
    tags: packageData.tags,
    status: packageData.status,
    secrecy_level: packageData.secrecy_level,
    owner_name: packageData.owner_name,
    cover_thumb: coverThumbFile,
    cover_hd: coverHdFile,
    resources: resourcesWithFiles,
  }
  await writeShowInfo(dirHandle, packageData.show_id, showInfo)

  // 4. 如果auth_mode=required，写入 auth.js
  if (packageData.auth_mode === 'required') {
    await writeShowAuth(dirHandle, packageData.show_id, {
      mode: 'required',
      password_hash: packageData.auth_hash || '',
      allowed_users: packageData.auth_username ? [packageData.auth_username] : [],
      verify_url: serverUrl + '/api/auth/verify-offline',
    })
  }

  // 5. 读取现有manifest或创建新的
  let manifest = await readManifest(dirHandle)
  if (!manifest) {
    manifest = {
      version: 1,
      server_url: serverUrl,
      generated_at: new Date().toISOString(),
      shows: {},
    }
  }

  // 6. 更新manifest中该show的条目
  manifest.shows[String(packageData.show_id)] = {
    id: packageData.show_id,
    name: packageData.name,
    version_no: packageData.version_no,
    series_id: packageData.series_id,
    cached_at: new Date().toISOString(),
    slide_count: packageData.resources.length,
    auth_mode: packageData.auth_mode,
    updated_at: packageData.updated_at,
    subject: packageData.subject,
    tags: packageData.tags,
    status: packageData.status,
    secrecy_level: packageData.secrecy_level,
    owner_name: packageData.owner_name,
  }
  manifest.generated_at = new Date().toISOString()

  // 7. 写入manifest.js
  await writeManifest(dirHandle, manifest)

  // 8. 写入离线HTML文件（拆分为三个文件）
  await writeOfflineFiles(dirHandle)
}
