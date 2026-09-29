/* Build-time configuration contains only public application files. */
const SHELL_CONFIG = __SLIDEFLOW_PWA_CONFIG__;
const CACHE_PREFIX = 'slideflow-shell-';
const CACHE_NAME = CACHE_PREFIX + SHELL_CONFIG.version;
const READY_KEY = '/__slideflow_shell_ready__';
const ASSETS = new Map(SHELL_CONFIG.files.map(file => [file.url, file]));
const APP_ROUTE = /^[/](?:$|(?:home|login|setup|resources|templates|fonts|shows|manage|admin|share)(?:[/]|$))/;

async function verifiedResponse(file) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 45000);
  try {
    const response = await fetch(file.url, {
      credentials: 'omit', cache: 'reload', redirect: 'error', signal: abort.signal,
    });
    if (!response.ok || response.status !== 200 || response.type === 'opaque' || response.redirected) {
      throw new Error('Application file download failed');
    }
    const type = (response.headers.get('content-type') || '').split(';', 1)[0].trim();
    if ((file.url.endsWith('.js') && !/^(?:text|application)[/](?:javascript|ecmascript)$/.test(type)) ||
        (file.url.endsWith('.css') && type !== 'text/css') ||
        (file.url === '/index.html' && type !== 'text/html')) {
      throw new Error('Application file has an invalid content type');
    }
    const bytes = await response.clone().arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== file.sha256) throw new Error('Application build changed during installation');
    // Preserve native response metadata (including HTTP decompression state).
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function shellReady() {
  if (!(await caches.has(CACHE_NAME))) return false;
  const cache = await caches.open(CACHE_NAME);
  if (!(await cache.match(READY_KEY))) return false;
  // Storage can be evicted after a successful installation. Recheck every file
  // before allowing a user to rely on the application being available offline.
  const keys = new Set((await cache.keys()).map(request => new URL(request.url).pathname));
  return SHELL_CONFIG.files.every(file => keys.has(file.url));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Reinstalling identical bytes may reuse a complete verified build.
    if (await shellReady()) return;
    const cache = await caches.open(CACHE_NAME);
    let index = 0;
    let failure = null;
    const workers = Array.from({ length: Math.min(4, SHELL_CONFIG.files.length) }, async () => {
      while (!failure && index < SHELL_CONFIG.files.length) {
        const file = SHELL_CONFIG.files[index++];
        try {
          await cache.put(file.url, await verifiedResponse(file));
        } catch (error) {
          failure = error;
        }
      }
    });
    await Promise.all(workers);
    if (failure) {
      await caches.delete(CACHE_NAME);
      throw failure;
    }
    try {
      await cache.put(READY_KEY, new Response(JSON.stringify({ installedAt: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      }));
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
    // Never skipWaiting: an upgrade must not replace a worker beneath any
    // existing presentation, presenter screen, upload, or edit form.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    if (!(await shellReady())) throw new Error('Application installation is incomplete');
    await self.clients.claim();
    // Normal activation waits for old clients to close. Keep two previous
    // builds too, so retained pages and deployment rollbacks remain usable.
    const previous = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith(CACHE_PREFIX) || name === CACHE_NAME) continue;
      const cache = await caches.open(name);
      const marker = await cache.match(READY_KEY);
      let installedAt = 0;
      try { installedAt = marker ? (await marker.json()).installedAt || 0 : 0; } catch { /* incomplete cache */ }
      previous.push({ name, installedAt });
    }
    previous.sort((a, b) => b.installedAt - a.installedAt);
    await Promise.all(previous.slice(2).map(item => caches.delete(item.name)));
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // There is deliberately no runtime API/image cache. Authenticated media,
  // signed URLs, API responses (including 401/403) and external hosts bypass us.
  if (!url.search && ASSETS.has(url.pathname)) {
    event.respondWith((async () => {
      const cached = await (await caches.open(CACHE_NAME)).match(url.pathname);
      return cached || fetch(request);
    })());
    return;
  }
  if (request.mode !== 'navigate' || !APP_ROUTE.test(url.pathname) || /[.][^/]+$/.test(url.pathname)) return;
  // Serve the shell belonging to this worker, including while an update waits.
  // An online network-first index would mix a new entry with the old precache.
  event.respondWith((async () => {
    const cached = await (await caches.open(CACHE_NAME)).match('/index.html');
    return cached || fetch(request);
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'SLIDEFLOW_SHELL_STATUS' || !event.ports?.[0]) return;
  event.waitUntil((async () => {
    let ready = false;
    try { ready = await shellReady(); } catch { /* storage unavailable */ }
    event.ports[0].postMessage({ type: 'SLIDEFLOW_SHELL_STATUS', protocol: 1, version: SHELL_CONFIG.version, ready });
  })());
});
