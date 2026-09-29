/** Object URLs are owned by one playback and never stored in a package. */
export class PlaybackAssets {
  private urls = new Map<string, { url: string; size: number }>();
  private pending = new Map<string, Promise<string>>();
  private queue: Array<{ key: string; run: () => Promise<void>; reject: (error: Error) => void }> = [];
  private active = 0;
  private disposed = false;
  private retained = new Set<number>();
  private listeners = new Set<() => void>();

  constructor(
    private readonly read: (index: number, kind: 'image' | 'thumb') => Promise<Blob>,
    private readonly options: {
      concurrency?: number; maxImages?: number; maxImageBytes?: number;
      createUrl?: (blob: Blob) => string; revokeUrl?: (url: string) => void;
    } = {},
  ) {}

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { this.listeners.forEach(listener => listener()); }
  peek(index: number, kind: 'image' | 'thumb') { return this.urls.get(kind + ':' + index)?.url ?? ''; }
  retain(indices: number[]) {
    this.retained = new Set(indices);
    this.queue = this.queue.filter(job => {
      if (!job.key.startsWith('image:') || this.retained.has(Number(job.key.slice(6)))) return true;
      this.pending.delete(job.key);
      job.reject(new DOMException('已离开此页', 'AbortError'));
      return false;
    });
    this.evict();
  }

  load(index: number, kind: 'image' | 'thumb' = 'image', priority = false): Promise<string> {
    if (this.disposed) return Promise.reject(new DOMException('播放已结束', 'AbortError'));
    const key = kind + ':' + index;
    const existing = this.urls.get(key);
    if (existing) {
      this.urls.delete(key); this.urls.set(key, existing);
      return Promise.resolve(existing.url);
    }
    const pending = this.pending.get(key);
    if (pending) {
      if (priority) {
        const at = this.queue.findIndex(item => item.key === key);
        if (at > 0) this.queue.unshift(...this.queue.splice(at, 1));
      }
      return pending;
    }
    const promise = new Promise<string>((resolve, reject) => {
      const job = { key, reject, run: async () => {
        try {
          const blob = await this.read(index, kind);
          if (this.disposed) throw new DOMException('播放已结束', 'AbortError');
          if (kind === 'image' && !this.retained.has(index)) throw new DOMException('已离开此页', 'AbortError');
          if (kind === 'image' && blob.size > (this.options.maxImageBytes ?? 128 * 1024 * 1024)) throw new Error('幻灯片图片超过播放内存上限');
          const url = (this.options.createUrl ?? URL.createObjectURL)(blob);
          this.urls.set(key, { url, size: blob.size });
          this.evict(); this.changed(); resolve(url);
        } catch (error) { reject(error); }
      } };
      if (priority) this.queue.unshift(job); else this.queue.push(job);
    });
    this.pending.set(key, promise);
    const settled = () => { if (this.pending.get(key) === promise) this.pending.delete(key); };
    void promise.then(settled, settled);
    this.pump();
    return promise;
  }

  private pump() {
    while (!this.disposed && this.active < (this.options.concurrency ?? 3) && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void job.run().finally(() => { this.active--; this.pump(); });
    }
  }

  private evict() {
    const images = () => [...this.urls].filter(([key]) => key.startsWith('image:'));
    for (const [key] of images()) if (!this.retained.has(Number(key.slice(6)))) this.drop(key);
    let entries = images();
    while (entries.length > (this.options.maxImages ?? 5) || entries.reduce((n, [, value]) => n + value.size, 0) > (this.options.maxImageBytes ?? 128 * 1024 * 1024)) {
      const current = this.retained.values().next().value;
      const candidate = entries.find(([key]) => Number(key.slice(6)) !== current);
      if (!candidate) break;
      this.drop(candidate[0]); entries = images();
    }
  }

  private drop(key: string) {
    const entry = this.urls.get(key);
    if (entry) (this.options.revokeUrl ?? URL.revokeObjectURL)(entry.url);
    this.urls.delete(key);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.splice(0).forEach(job => job.reject(new DOMException('播放已结束', 'AbortError')));
    for (const key of this.urls.keys()) this.drop(key);
    this.pending.clear();
    this.listeners.clear();
  }
}

/** HTTP failures and malformed JSON are never interpreted as being offline. */
export function isPlaybackTransportError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError');
}

export function isPlaybackAccessError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'status' in error && [401, 403, 404].includes(Number(error.status));
}

export function playbackSnapshot(show: { id: number; version_no: number; resources: Array<{ id: number; hidden: boolean; accessible?: boolean; version_no?: number }> }): string {
  return JSON.stringify([show.id, show.version_no, show.resources.map(resource => [resource.id, resource.version_no ?? null, resource.hidden, resource.accessible !== false])]);
}
