import { getDirectoryHandle, ensurePermission } from './offline-cache'

/**
 * 从 PNG/JPEG Blob 即时生成 640×360 缩略图（JPEG Q74）。
 * 用于兼容旧缓存（info.js 中 thumb_file 缺失或读取失败时回退）。
 * 返回缩略图的 blob URL；失败返回 null。
 */
async function generateThumbFromImageBlob(
  imgBlob: Blob,
  maxW = 640,
  maxH = 360,
  quality = 0.74,
): Promise<string | null> {
  const srcUrl = URL.createObjectURL(imgBlob)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('image load failed'))
      img.src = srcUrl
    })
    const ratio = Math.min(maxW / img.width, maxH / img.height, 1)
    const w = Math.max(1, Math.round(img.width * ratio))
    const h = Math.max(1, Math.round(img.height * ratio))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, w, h)
    const blob: Blob | null = await new Promise(resolve =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    )
    if (!blob) return null
    return URL.createObjectURL(blob)
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(srcUrl)
  }
}

export interface OfflineShowInfo {
  id: number
  name: string
  version_no: number
  slide_count: number
  resources: Array<{
    id: number
    name: string
    version_no: number
    slide_index: number
    file?: string
    thumb_file?: string
    common_remark_html: string
    personal_remark_html: string
    show_remark_html: string
  }>
}

export interface OfflineSlideData {
  showInfo: OfflineShowInfo
  slideUrls: string[]        // 懒填充，'' 表示尚未加载
  thumbUrls: string[]        // 预加载的缩略图（文件小，启动时全部加载）
  /** 按需加载指定索引的幻灯片大图，返回 blob URL 或 null */
  loadSlide(index: number): Promise<string | null>
  /** 后台预加载多个索引的幻灯片（fire-and-forget） */
  preloadSlides(indices: number[]): void
  /** 释放所有 blob URL */
  revokeAll(): void
}

/**
 * 从本地缓存文件夹读取 show 数据。
 * - 缩略图（thumbUrls）全部预加载（文件小，640×360 JPEG）
 * - 幻灯片大图（slideUrls）采用懒加载，仅首页立即加载
 * - 调用 loadSlide / preloadSlides 按需加载其余页面
 */
export async function loadOfflineShowData(showId: string | number): Promise<OfflineSlideData | null> {
  try {
    const handle = await getDirectoryHandle()
    if (!handle) return null

    const granted = await ensurePermission(handle)
    if (!granted) return null

    // 读取 info.js
    const showsDir = await handle.getDirectoryHandle('shows')
    const showDir = await showsDir.getDirectoryHandle(String(showId))
    const infoFile = await showDir.getFileHandle('info.js')
    const infoText = await (await infoFile.getFile()).text()

    // 解析 JSONP: "window.__SHOW_INFO = {...};"
    const jsonStr = infoText.replace(/^window\.__SHOW_INFO\s*=\s*/, '').replace(/;\s*$/, '')
    const showInfo: OfflineShowInfo = JSON.parse(jsonStr)

    // 获取 slides 目录句柄（后续 loadSlide 需要）
    const slidesDir = await showDir.getDirectoryHandle('slides')

    const slideUrls: string[] = new Array<string>(showInfo.resources.length).fill('')
    const thumbUrls: string[] = new Array<string>(showInfo.resources.length).fill('')

    // 预加载所有缩略图：
    // - 优先使用预存的 thumb_file（640×360 JPEG Q74，文件小，启动时全部加载）
    // - 兼容旧缓存：若 thumb_file 缺失或读取失败，则从 PNG 大图即时生成缩略图
    //   这样可避免旧缓存在演讲/讲演模式下出现「预览图只有第一张」「缩略图条只见前后几张」的问题
    const loadOneThumb = async (idx: number): Promise<void> => {
      const resource = showInfo.resources[idx]
      // 1) 优先使用 thumb_file
      if (resource.thumb_file) {
        try {
          const thumbHandle = await slidesDir.getFileHandle(resource.thumb_file)
          const thumbFile = await thumbHandle.getFile()
          const thumbBlob = new Blob([await thumbFile.arrayBuffer()], { type: 'image/jpeg' })
          thumbUrls[idx] = URL.createObjectURL(thumbBlob)
          return
        } catch {
          // 文件不存在或读取失败，回退到从 PNG 生成
        }
      }
      // 2) 兼容旧缓存：从 PNG 大图即时生成缩略图（生成后立即释放 PNG blob，不占用内存）
      try {
        const fileName = resource.file || `${resource.slide_index}.png`
        const fileHandle = await slidesDir.getFileHandle(fileName)
        const file = await fileHandle.getFile()
        const pngBlob = new Blob([await file.arrayBuffer()], { type: 'image/png' })
        const generated = await generateThumbFromImageBlob(pngBlob)
        if (generated) thumbUrls[idx] = generated
      } catch {
        // 完全失败则保留空字符串
      }
    }

    // 限制并发，避免一次性把所有 PNG 解码到内存
    const CONCURRENCY = 4
    let nextIdx = 0
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (true) {
          const i = nextIdx++
          if (i >= showInfo.resources.length) return
          await loadOneThumb(i)
        }
      })
    )

    // 立即加载首页大图
    const firstRes = showInfo.resources[0]
    if (firstRes) {
      try {
        const fileName = firstRes.file || `${firstRes.slide_index}.png`
        const fileHandle = await slidesDir.getFileHandle(fileName)
        const file = await fileHandle.getFile()
        const blob = new Blob([await file.arrayBuffer()], { type: 'image/png' })
        slideUrls[0] = URL.createObjectURL(blob)
      } catch {
        // ignore
      }
    }

    return {
      showInfo,
      slideUrls,
      thumbUrls,
      loadSlide: async (index: number): Promise<string | null> => {
        if (index < 0 || index >= showInfo.resources.length) return null
        if (slideUrls[index]) return slideUrls[index] // 已加载

        try {
          const resource = showInfo.resources[index]
          const fileName = resource.file || `${resource.slide_index}.png`
          const fileHandle = await slidesDir.getFileHandle(fileName)
          const file = await fileHandle.getFile()
          const blob = new Blob([await file.arrayBuffer()], { type: 'image/png' })
          const url = URL.createObjectURL(blob)
          slideUrls[index] = url
          return url
        } catch {
          return null
        }
      },
      preloadSlides: (indices: number[]): void => {
        for (const idx of indices) {
          if (idx >= 0 && idx < showInfo.resources.length && !slideUrls[idx]) {
            const resource = showInfo.resources[idx]
            const fileName = resource.file || `${resource.slide_index}.png`
            slidesDir.getFileHandle(fileName)
              .then(fh => fh.getFile())
              .then(async file => {
                const blob = new Blob([await file.arrayBuffer()], { type: 'image/png' })
                slideUrls[idx] = URL.createObjectURL(blob)
              })
              .catch(() => { /* ignore */ })
          }
        }
      },
      revokeAll: (): void => {
        for (const url of slideUrls) { if (url) URL.revokeObjectURL(url) }
        for (const url of thumbUrls) { if (url) URL.revokeObjectURL(url) }
      },
    }
  } catch {
    return null
  }
}

/**
 * 释放一组 blob URL（保留向后兼容）
 */
export function revokeOfflineUrls(urls: string[]): void {
  urls.forEach(url => { if (url) URL.revokeObjectURL(url) })
}

/**
 * 检查 URL 是否为离线模式
 */
export function isOfflineMode(): boolean {
  const params = new URLSearchParams(window.location.search)
  return params.get('offline') === 'true'
}
