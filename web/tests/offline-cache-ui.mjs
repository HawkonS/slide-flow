// Product management/download UI with real AuthProvider, IndexedDB and SW.
// Only backend HTTP responses and browser failure boundaries are controlled.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { launchBrowser } from './helpers/browser.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=', 'base64');
const hash = createHash('sha256').update(png).digest('hex');
let dist, server, browser, origin, state;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function showState(id) {
  if (!state.shows.has(id)) state.shows.set(id, { id, name: 'UI缓存' + String(id).padStart(2, '0'), version: 1,
    subject: id % 2 ? '产品' : '培训', tags: [id % 2 ? '产品说明' : '培训材料'], status: 'active',
    manifestStatus: 200, manifestMode: 'ok', updateStatus: 200, resourceUpdates: {}, assetMode: 'ok' });
  return state.shows.get(id);
}
function manifest(id) {
  const show = showState(id);
  return { format_version: 3, package_id: randomUUID().replaceAll('-', ''), user_id: 1, session_version: 3,
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(),
    show_id: id, name: show.name, version_no: show.version, series_id: 'ui-show-' + id,
    updated_at: '2026-09-28T00:00:00Z', subject: show.subject, tags: show.tags, status: show.status, owner_name: 'UI Test',
    resources: Array.from({ length: 3 }, (_, index) => {
      const resourceId = id * 100 + index; const asset = '/api/shows/' + id + '/offline-assets/' + resourceId;
      return { id: resourceId, name: show.name + ' 第' + (index + 1) + '页', version_no: show.version, slide_index: index, hidden: false,
        image_url: asset + '/image?version_no=' + show.version + '&sha256=' + hash,
        thumb_url: asset + '/thumb?version_no=' + show.version + '&sha256=' + hash,
        image_sha256: hash, thumb_sha256: hash, size_bytes: png.length, thumb_size_bytes: png.length,
        common_remark_html: '<p>通用备注</p>', personal_remark_html: '<p>个人备注</p>', show_remark_html: '<p>放映备注</p>' };
    }) };
}
async function handle(request, response) {
  const url = new URL(request.url, origin || 'http://127.0.0.1');
  response.setHeader('Cache-Control', 'no-store');
  const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/api/')) {
    for await (const part of request) void part;
    state.requests.push({ path: url.pathname, query: url.search, method: request.method });
    if (url.pathname === '/api/me') return json({ user: { id: 1, session_version: 3, username: 'ui-test', name: 'UI Test', role: 'admin' } });
    const showMatch = url.pathname.match(/^\/api\/shows\/(\d+)(?:\/(.*))?$/);
    if (showMatch) {
      const id = Number(showMatch[1]); const row = showState(id); const operation = showMatch[2];
      if (operation === 'offline-manifest') {
        if (row.manifestStatus !== 200) return json({ detail: '放映授权已撤销' }, row.manifestStatus);
        if (row.manifestMode === 'hold') { state.heldManifests.push({ id, response }); return; }
        return json(manifest(id));
      }
      if (operation === 'offline-version') {
        if (row.updateStatus !== 200) return json({ detail: '更新检查暂时失败' }, row.updateStatus);
        const data = manifest(id);
        return json({ show_id: id, queried_show_id: id, series_id: data.series_id, name: row.name,
          version_no: row.version, updated_at: data.updated_at, resource_versions: Object.fromEntries(data.resources.map(item => [item.id, item.version_no])), resource_updates: row.resourceUpdates });
      }
      if (operation?.startsWith('offline-assets/')) {
        const mode = row.assetMode;
        if (mode === 'hold') { row.assetMode = 'ok'; state.held.push({ id, response }); return; }
        if (mode === 'deny') return json({ detail: '素材访问已撤销' }, 403);
        response.writeHead(200, { 'Content-Type': 'image/png' });
        if (mode === 'sha') { const corrupt = Buffer.from(png); corrupt[corrupt.length - 1] ^= 1; response.end(corrupt); return; }
        response.end(png); return;
      }
      if (operation === 'present-session') return json({ session_token: 'ui-present-token' });
      if (!operation) {
        const data = manifest(id);
        return json({ show: { ...data, id, can_manage: true, resources: data.resources.map(item => ({
          ...item, accessible: true, latest_version_no: item.version_no, preview_url: item.thumb_url, original_preview_url: null })) } });
      }
    }
    const resource = url.pathname.match(/^\/api\/resources\/(\d+)$/);
    if (resource) {
      const id = Number(resource[1]); const row = showState(Math.floor(id / 100));
      return json({ resource: { id, can_manage: true, versions: [{ id: id * 1000 + row.version, version_no: row.version, common_remark_html: '<p>通用备注</p>' }] } });
    }
    return json({ preferences: {}, content_html: '<p>备注</p>', ok: true });
  }
  const extension = path.extname(url.pathname);
  const file = url.pathname === '/' || !extension ? 'index.html' : url.pathname.slice(1);
  if (file === 'sw.js') response.setHeader('Service-Worker-Allowed', '/');
  if (file.includes('..')) { response.writeHead(404); response.end(); return; }
  try {
    const data = await readFile(path.join(dist, file));
    response.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }[path.extname(file)] || 'text/html');
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
}
before(async () => {
  dist = await mkdtemp(path.join(os.tmpdir(), 'slideflow-cache-ui-'));
  await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
    plugins: [{ name: 'offline-cache-ui-entry', enforce: 'pre', transformIndexHtml: { order: 'pre',
      handler: html => html.replace('/src/main.tsx', '/tests/fixtures/offline-cache-ui/entry.tsx') } }],
    build: { outDir: dist, emptyOutDir: true } });
  server = http.createServer((request, response) => { void handle(request, response).catch(error => { if (!response.destroyed) { response.writeHead(500); response.end(String(error)); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (dist) await rm(dist, { recursive: true, force: true });
});
async function setup(t) {
  state = { shows: new Map(), requests: [], held: [], heldManifests: [] };
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(10_000);
  t.after(() => context.close());
  const popups = [], errors = [];
  await context.exposeBinding('__recordCachePopup', (_source, item) => { popups.push(item); });
  await context.addInitScript(() => {
    let click = null;
    document.addEventListener('click', event => { click = event; }, true);
    const original = window.open;
    window.open = function (url, name, features) {
      void window.__recordCachePopup({ url: String(url ?? ''), name: String(name ?? ''),
        sourceUrl: location.href, duringClick: !!click?.currentTarget, userActivation: navigator.userActivation.isActive });
      return original.call(this, url, name, features);
    };
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  await page.goto(origin + '/test/cache/1');
  await page.waitForFunction(() => window.__testAuth?.user?.id === 1 && !window.__testAuth.loading);
  await page.evaluate(() => window.__cacheUiTest.ensureOfflineShellReady());
  return { page, context, state, popups, errors };
}
async function seed(page, ids = [1]) {
  for (let index = 0; index < ids.length; index += 4) {
    await page.evaluate(ids => Promise.all(ids.map(id => window.__cacheUiTest.downloadShow(id))), ids.slice(index, index + 4));
  }
  return page.evaluate(() => window.__cacheUiTest.listCachedShows());
}
async function management(page) {
  await page.goto(origin + '/manage/offline-cache');
  await page.getByRole('heading', { name: '离线缓存', exact: true }).waitFor();
}
function card(page, name) { return page.locator('[data-slot="card"]').filter({ has: page.getByText(name, { exact: true }) }); }
async function cached(page, id = 1) { return page.evaluate(id => window.__cacheUiTest.getCachedShow(id), id); }
async function waitHeld(id = 1) {
  const end = Date.now() + 10_000;
  while (!state.held.some(item => item.id === id) && Date.now() < end) await delay(20);
  assert.ok(state.held.some(item => item.id === id), 'download reached its controlled image response');
}
function releaseHeld() {
  for (const { response } of state.held.splice(0)) if (!response.destroyed) { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(png); }
}
async function playerPage(context, suffix) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const page = context.pages().find(page => new URL(page.url()).pathname.endsWith(suffix));
    if (page) return page;
    await delay(20);
  }
  throw new Error('Expected a real player page ending in ' + suffix);
}
async function visibleImage(page, selector) {
  await page.locator(selector).waitFor({ state: 'visible' });
  await page.waitForFunction(selector => {
    const image = document.querySelector(selector); const rect = image?.getBoundingClientRect();
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
      && rect.width > 100 && rect.height > 100 && getComputedStyle(image).opacity !== '0';
  }, selector);
}

test('a completed real download appears in the offline cache card list', { timeout: 60_000 }, async t => {
  const { page, errors } = await setup(t);
  await page.getByRole('button', { name: '开始缓存', exact: true }).click();
  await page.getByText('缓存完成，可离线播放', { exact: true }).waitFor();
  const saved = await cached(page);
  assert.equal(saved.state, 'ready');
  await page.getByRole('link', { name: '管理离线缓存', exact: true }).click();
  await page.getByRole('heading', { name: '离线缓存', exact: true }).waitFor();
  const entry = card(page, saved.name);
  await entry.waitFor();
  assert.match(await entry.innerText(), /3\s*页/);
  assert.equal(await page.getByRole('button', { name: '选择文件夹', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});

test('cancelling a UI update preserves the previous complete package and card', { timeout: 60_000 }, async t => {
  const { page } = await setup(t);
  const [original] = await seed(page);
  showState(1).version = 2; showState(1).assetMode = 'hold';
  await page.getByRole('button', { name: '开始缓存', exact: true }).click();
  await waitHeld();
  await page.getByRole('progressbar', { name: '离线缓存下载进度' }).waitFor();
  await page.getByRole('button', { name: '取消下载', exact: true }).click();
  await page.getByText('本次下载已取消。', { exact: true }).waitFor();
  releaseHeld();
  assert.equal((await cached(page)).package_id, original.package_id);
  await management(page);
  await card(page, original.name).waitFor();
  assert.equal((await cached(page)).version_no, 1);
});

test('a failed UI update explains the failure while preserving the previous package', { timeout: 60_000 }, async t => {
  const { page } = await setup(t);
  const [original] = await seed(page);
  showState(1).version = 2; showState(1).assetMode = 'sha';
  await page.getByRole('button', { name: '开始缓存', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /校验/ }).waitFor();
  assert.equal((await cached(page)).package_id, original.package_id);
  assert.equal(await page.getByRole('button', { name: '重试下载', exact: true }).isEnabled(), true);
  await management(page);
  await card(page, original.name).waitFor();
  assert.equal((await cached(page)).version_no, 1);
});

test('cached cards support real search, subject filtering and URL-backed pagination', { timeout: 60_000 }, async t => {
  const { page } = await setup(t);
  await seed(page, Array.from({ length: 25 }, (_, index) => index + 1));
  await management(page);
  await page.getByRole('button', { name: '下一页', exact: true }).waitFor();
  const cards = page.locator('[data-slot="card"]');
  const firstNames = (await cards.allTextContents()).flatMap(text => text.match(/UI缓存\d{2}/g) ?? []);
  assert.ok(firstNames.length > 0 && firstNames.length < 25);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.waitForURL(url => url.searchParams.get('page') === '2');
  await card(page, firstNames[0]).waitFor({ state: 'detached' });
  const secondNames = (await cards.allTextContents()).flatMap(text => text.match(/UI缓存\d{2}/g) ?? []);
  assert.ok(secondNames.length > 0);
  assert.ok(secondNames.every(name => !firstNames.includes(name)));
  await page.getByPlaceholder('搜索名称、关键词').fill('UI缓存25');
  await card(page, 'UI缓存25').waitFor();
  assert.equal(await cards.count(), 1);
  assert.equal(new URL(page.url()).searchParams.get('page'), null);
  await page.getByRole('button', { name: '重置筛选', exact: true }).click();
  await page.getByRole('button', { name: /^主体/ }).click();
  await page.getByRole('button', { name: '培训', exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('.page-count')?.textContent ?? '').replace(/\s/g, '').includes('筛选后12/25'));
  const filteredNames = (await cards.allTextContents()).flatMap(text => text.match(/UI缓存\d{2}/g) ?? []);
  assert.ok(filteredNames.length > 0);
  assert.ok(filteredNames.every(name => Number(name.slice(-2)) % 2 === 0));
});

test('expired and revoked cards explain their state and disable both playback entries', { timeout: 60_000 }, async t => {
  const { page } = await setup(t);
  const packages = await seed(page, [1, 2]);
  const expires = packages.find(entry => entry.show_id === 1);
  await page.evaluate(packageId => new Promise((resolve, reject) => {
    const opening = indexedDB.open('slideflow-pwa-v3', 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result; const tx = db.transaction('packages', 'readwrite');
      const store = tx.objectStore('packages'); const request = store.get(packageId);
      request.onsuccess = () => store.put({ ...request.result, expires_at: new Date(Date.now() - 60_000).toISOString() }, packageId);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), expires.package_id);
  await page.evaluate(() => window.__cacheUiTest.invalidateCachedShow(2, window.__cacheUiTest.readOfflineIdentity()));
  await management(page);
  const expired = card(page, 'UI缓存01'); const revoked = card(page, 'UI缓存02');
  await expired.waitFor(); await revoked.waitFor();
  assert.match(await expired.innerText(), /到期|过期/);
  assert.match(await revoked.innerText(), /撤销|失效/);
  for (const entry of [expired, revoked]) {
    assert.equal(await entry.getByRole('button', { name: '全屏放映', exact: true }).isEnabled(), false);
    assert.equal(await entry.getByRole('button', { name: '讲演视图', exact: true }).isEnabled(), false);
  }
});

test('an update-check failure clears the all-current result without damaging complete packages', { timeout: 60_000 }, async t => {
  const { page, state } = await setup(t);
  const original = await seed(page, [1, 2]);
  await management(page);
  const check = page.getByRole('button', { name: '检查全部更新', exact: true });
  await check.click();
  await page.locator('.page-shell').getByText('全部最新', { exact: true }).waitFor();
  const downloadsBefore = state.requests.filter(item => item.path.endsWith('/offline-manifest')).length;
  showState(1).resourceUpdates = { '100': 2 };
  await check.click();
  await card(page, 'UI缓存01').getByText(/素材新版，需先迭代发布放映/).waitFor();
  await page.locator('.page-shell').getByText('放映缓存已同步 · 素材需迭代', { exact: true }).waitFor();
  assert.equal(await card(page, 'UI缓存01').getByRole('button', { name: '下载更新', exact: true }).count(), 0);
  assert.equal(await page.locator('.page-shell').getByText('全部最新', { exact: true }).count(), 0);
  assert.equal(state.requests.filter(item => item.path.endsWith('/offline-manifest')).length, downloadsBefore);
  showState(1).updateStatus = 500; showState(1).manifestStatus = 500;
  await check.click();
  await page.getByText(/检查(?:更新)?失败/).first().waitFor();
  await check.click({ trial: true });
  assert.equal(await page.locator('.page-shell').getByText('全部最新', { exact: true }).count(), 0);
  assert.equal((await cached(page, 1)).package_id, original.find(entry => entry.show_id === 1).package_id);
  assert.equal((await cached(page, 2)).package_id, original.find(entry => entry.show_id === 2).package_id);
});

test('the fullscreen card entry opens and plays the selected fixed package', { timeout: 60_000 }, async t => {
  const { page, context } = await setup(t);
  const [saved] = await seed(page);
  await management(page);
  await card(page, saved.name).getByRole('button', { name: '全屏放映', exact: true }).click();
  const fullscreen = await playerPage(context, '/fullscreen');
  const url = new URL(fullscreen.url());
  assert.equal(url.searchParams.get('offline'), 'true');
  assert.equal(url.searchParams.get('package_id'), saved.package_id);
  await fullscreen.getByText('点击开始放映', { exact: true }).click();
  await visibleImage(fullscreen, 'img[alt=""][src^="blob:"].object-contain');
});

test('dual-screen launch preopens Display during the click and shares one fixed package and session', { timeout: 60_000 }, async t => {
  const { page, context, popups } = await setup(t);
  const [saved] = await seed(page);
  await management(page);
  showState(1).manifestMode = 'hold';
  await card(page, saved.name).getByRole('button', { name: '讲演视图', exact: true }).click();
  const requestDeadline = Date.now() + 10_000;
  while (!state.heldManifests.length && Date.now() < requestDeadline) await delay(20);
  assert.ok(state.heldManifests.length, 'playback authorization remains deliberately pending');
  const popupDeadline = Date.now() + 2000;
  while (!popups.some(item => item.name.startsWith('slideflow-display-')) && Date.now() < popupDeadline) await delay(20);
  const preopen = popups.find(item => item.name.startsWith('slideflow-display-'));
  assert.ok(preopen, 'Display must be preopened while authorization is still pending');
  assert.equal(new URL(preopen.sourceUrl).pathname, '/manage/offline-cache');
  assert.equal(preopen.duringClick, true, 'Display must be opened before the click handler yields');
  assert.equal(preopen.userActivation, true);
  showState(1).manifestMode = 'ok';
  for (const { id, response } of state.heldManifests.splice(0)) {
    if (!response.destroyed) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(manifest(id))); }
  }
  const presenter = await playerPage(context, '/present');
  const display = await playerPage(context, '/display');
  const presenterUrl = new URL(presenter.url()); const displayUrl = new URL(display.url());
  const session = presenterUrl.searchParams.get('playback_session');
  assert.match(session, /^[a-zA-Z0-9_-]{16,80}$/);
  assert.equal(displayUrl.searchParams.get('playback_session'), session);
  assert.equal(presenterUrl.searchParams.get('package_id'), saved.package_id);
  assert.equal(displayUrl.searchParams.get('package_id'), saved.package_id);
  assert.equal(presenterUrl.searchParams.get('offline'), 'true');
  assert.equal(displayUrl.searchParams.get('offline'), 'true');
  assert.equal(displayUrl.searchParams.get('source'), 'cache');
  assert.equal(preopen.name, 'slideflow-display-' + session);
  await visibleImage(presenter, 'img[alt="UI缓存01 第1页"][src^="blob:"].object-contain');
  await visibleImage(display, 'img[alt="幻灯片 1"][src^="blob:"]');
  assert.equal(context.pages().filter(candidate => new URL(candidate.url()).pathname.endsWith('/display')).length, 1);
});

async function seedLegacyManifest(page) {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('legacy-cache-ui-fixture', { create: true });
    const now = new Date().toISOString();
    const legacy = { version: 2, server_url: location.origin, generated_at: now, shows: {
      '7001': { id: 7001, name: '旧目录样例', version_no: 2, series_id: 'legacy-7001', cached_at: now,
        slide_count: 1, auth_mode: 'required', updated_at: now, subject: '历史', tags: ['旧目录'], status: 'active', owner_name: 'Legacy' } } };
    localStorage.removeItem('__legacy_js_ran');
    const file = await dir.getFileHandle('manifest.js', { create: true }); const writer = await file.createWritable();
    await writer.write('window.__OFFLINE_MANIFEST = ' + JSON.stringify(legacy) + ';');
    await writer.close();
    const shows = await dir.getDirectoryHandle('shows', { create: true });
    const legacyShow = await shows.getDirectoryHandle('7001', { create: true });
    const info = await legacyShow.getFileHandle('info.js', { create: true });
    const infoWriter = await info.createWritable();
    await infoWriter.write('localStorage.setItem("__legacy_js_ran", "1"); window.__SHOW_INFO = {};');
    await infoWriter.close();
    await new Promise((resolve, reject) => {
      const opening = indexedDB.open('slideflow-offline-cache', 1);
      opening.onupgradeneeded = () => { if (!opening.result.objectStoreNames.contains('settings')) opening.result.createObjectStore('settings'); };
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result; const tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put(dir, 'dir-handle');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  });
}

test('legacy manifest metadata allows only a fresh online download and never executes old JavaScript', { timeout: 60_000 }, async t => {
  const { page, context, state } = await setup(t);
  // Retain a real offline identity lease while leaving the new package list empty.
  await seed(page);
  await page.evaluate(() => window.__cacheUiTest.deleteCachedShow(1));
  showState(7001).name = '旧目录样例'; showState(7001).version = 3;
  await seedLegacyManifest(page);
  await management(page);
  await page.getByText('旧目录样例', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('__legacy_js_ran')), null);
  assert.equal(await page.evaluate(() => window.__OFFLINE_MANIFEST), undefined);
  for (const name of ['全屏放映', '讲演视图']) {
    const actions = page.getByRole('button', { name, exact: true });
    for (const action of await actions.all()) assert.equal(await action.isEnabled(), false);
  }
  await context.setOffline(true);
  await page.waitForFunction(() => window.__testAuth.offline === true);
  const redownload = page.getByRole('button', { name: /重新下载/ });
  assert.equal(await redownload.isEnabled(), false);
  assert.deepEqual(await page.evaluate(() => window.__cacheUiTest.listCachedShows()), []);
  await context.setOffline(false);
  await page.waitForFunction(() => !window.__testAuth.offline && !window.__testAuth.loading);
  await redownload.click();
  // Wait for the real ready card; async waitForFunction predicates resolve too early.
  await card(page, '旧目录样例').waitFor();
  const saved = await cached(page, 7001);
  assert.equal(saved.version_no, 3);
  assert.equal(saved.user_id, 1);
  assert.equal(saved.state, 'ready');
  assert.ok(state.requests.some(request => request.path === '/api/shows/7001/offline-manifest'));
  assert.equal(state.requests.some(request => request.path === '/api/shows/7001/offline-package'), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('__legacy_js_ran')), null);
  assert.equal(await page.evaluate(() => window.__OFFLINE_MANIFEST), undefined);
  await card(page, saved.name).waitFor();
});
