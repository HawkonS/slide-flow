// Production build, real service worker, AuthProvider, offline-session and
// IndexedDB package storage. Only the backend HTTP responses are simulated.
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
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function currentManifest() {
  return {
    format_version: 3, package_id: randomUUID().replaceAll('-', ''), user_id: state.userId,
    session_version: 3, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(),
    show_id: 1, name: 'Integration show V' + state.version, version_no: state.version, series_id: 'integration',
    updated_at: '2026-09-28T00:00:00Z', subject: 'test', tags: [], status: 'active', owner_name: 'Test',
    resources: Array.from({ length: 7 }, (_, index) => {
      const version = state.version + index;
      const asset = '/api/shows/1/offline-assets/' + (100 + index);
      return { id: 100 + index, name: 'V' + state.version + ' slide ' + (index + 1), version_no: version,
        slide_index: index, hidden: index === 1,
        image_url: asset + '/image?version_no=' + version + '&sha256=' + hash,
        thumb_url: asset + '/thumb?version_no=' + version + '&sha256=' + hash,
        image_sha256: hash, thumb_sha256: hash, size_bytes: png.length, thumb_size_bytes: png.length,
        common_remark_html: '<p>V' + state.version + ' common ' + index + '</p>',
        personal_remark_html: '<p>V' + state.version + ' personal ' + index + '</p>',
        show_remark_html: '<p>V' + state.version + ' show ' + index + '</p>',
      };
    }),
  };
}

async function handle(request, response) {
  const url = new URL(request.url, origin || 'http://127.0.0.1');
  response.setHeader('Cache-Control', 'no-store');
  const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/api/')) {
    const body = [];
    for await (const part of request) body.push(part);
    state.requests.push({ path: url.pathname, method: request.method, query: url.search, body: Buffer.concat(body).toString() });
    if (url.pathname === '/api/me') {
      if (state.meStatus !== 200) return json({ detail: '身份已拒绝' }, state.meStatus);
      return json({ user: { id: state.userId, session_version: 3, username: 'test' + state.userId, name: 'Test', role: 'admin' } });
    }
    if (url.pathname === '/api/auth/logout') { state.meStatus = 401; return json({ ok: true }); }
    if (url.pathname.endsWith('/offline-manifest')) {
      if (state.manifestStatus !== 200) return json({ detail: '放映权限已撤销' }, state.manifestStatus);
      return json(currentManifest());
    }
    if (url.pathname.includes('/offline-assets/')) {
      const mode = state.assetMode;
      if (mode === 'hold') { state.assetMode = 'ok'; state.held.push(response); return; }
      if (mode === 'deny') return json({ detail: '素材权限已撤销' }, 403);
      response.writeHead(200, { 'Content-Type': 'image/png' });
      if (mode === 'interrupt') { response.write(png.subarray(0, 12)); response.destroy(); return; }
      if (mode === 'sha') { const wrong = Buffer.from(png); wrong[wrong.length - 1] ^= 1; response.end(wrong); return; }
      if (mode === 'short') { response.end(png.subarray(0, png.length - 1)); return; }
      response.end(png); return;
    }
    if (url.pathname === '/api/shows/1') {
      if (state.showStatus !== 200) return json({ detail: '放映访问已拒绝' }, state.showStatus);
      const manifest = currentManifest();
      return json({ show: { ...manifest, id: 1, can_manage: true, resources: manifest.resources.map(resource => ({
        id: resource.id, name: resource.name, version_no: resource.version_no, latest_version_no: resource.version_no,
        hidden: resource.hidden, accessible: true, preview_url: resource.thumb_url, original_preview_url: null,
      })) } });
    }
    if (url.pathname.endsWith('/present-session')) {
      if (state.sessionMode === 'hold') { state.sessionMode = 'ok'; state.heldSessions.push(response); return; }
      return json({ session_token: 'integration-token' });
    }
    const match = url.pathname.match(/^\/api\/resources\/(\d+)(?:\/(personal-remark|common-remark))?$/);
    if (match) {
      const id = Number(match[1]); const version = state.version + id - 100;
      if (!match[2]) return json({ resource: { id, can_manage: true, versions: [{ id: id * 1000 + version, version_no: version, common_remark_html: '<p>Online common</p>' }] } });
      return json({ content_html: '<p>Online personal</p>', ok: true });
    }
    return json({ preferences: {}, content_html: '<p>Online show</p>', ok: true });
  }
  const extension = path.extname(url.pathname);
  const mime = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  let file = url.pathname === '/' || !extension ? 'index.html' : url.pathname.slice(1);
  if (file === 'sw.js') response.setHeader('Service-Worker-Allowed', '/');
  if (file.includes('..')) { response.writeHead(404); response.end(); return; }
  try {
    const data = await readFile(path.join(dist, file));
    response.setHeader('Content-Type', mime[path.extname(file)] || 'text/html'); response.end(data);
  } catch { response.writeHead(404); response.end(); }
}

before(async () => {
  dist = await mkdtemp(path.join(os.tmpdir(), 'slideflow-playback-build-'));
  await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
    plugins: [{ name: 'integration-test-entry', enforce: 'pre', transformIndexHtml: { order: 'pre', handler: html => html.replace('/src/main.tsx', '/tests/fixtures/playback-integration/entry.tsx') } }],
    build: { outDir: dist, emptyOutDir: true },
  });
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

async function setup(t, seed = true, denyIdentityStorage = false) {
  state = { userId: 1, version: 1, meStatus: 200, showStatus: 200, manifestStatus: 200, assetMode: 'ok', sessionMode: 'ok', requests: [], held: [], heldSessions: [] };
  const context = await browser.newContext();
  t.after(() => context.close());
  if (denyIdentityStorage) await context.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'slideflow-offline-session-v3') throw new DOMException('Identity persistence unavailable', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  const attempts = [], errors = [];
  context.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) attempts.push(url.pathname); });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  await page.goto(origin + '/manage/offline-cache');
  await page.waitForFunction(() => window.__testAuth?.user?.id === 1 && !window.__testAuth.loading);
  await page.evaluate(() => window.__pwaTest.ensureOfflineShellReady());
  const cached = seed ? await page.evaluate(() => window.__pwaTest.downloadShow(1)) : null;
  return { context, page, cached, attempts, errors, state };
}
async function currentPackage(page, packageId) {
  return page.evaluate(packageId => window.__pwaTest.getCachedShow(1, packageId), packageId);
}
async function startDownload(page) {
  await page.evaluate(() => { window.__downloadAbort = new AbortController(); window.__downloadResult = window.__pwaTest.downloadShow(1, { signal: window.__downloadAbort.signal }).then(value => ({ ok: true, value }), error => ({ ok: false, name: error.name, message: error.message })); });
}
async function finishDownload(page) { return page.evaluate(() => window.__downloadResult); }
async function waitHeld(key = 'held') {
  const deadline = Date.now() + 10_000;
  while (!state[key].length && Date.now() < deadline) await delay(20);
  assert.ok(state[key].length, 'request reached the controlled HTTP boundary');
}
function releaseHeld() { for (const response of state.held.splice(0)) if (!response.destroyed) { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(png); } }
async function waitImage(page, name) {
  try {
    await page.getByRole('img', { name, exact: true }).first().waitFor({ timeout: 10_000 });
    await page.waitForFunction(name => [...document.images].some(image => image.alt === name && image.naturalWidth > 0), name, { timeout: 10_000 });
  } catch (error) {
    const detail = await page.evaluate(() => ({ href: location.href, body: document.body.innerText.slice(0, 1600),
      auth: { user: window.__testAuth?.user?.id, offline: window.__testAuth?.offline, epoch: window.__testAuth?.epoch },
      identity: window.__pwaTest?.readOfflineIdentity(), controlled: !!navigator.serviceWorker.controller,
    })).catch(() => ({ closed: true }));
    throw new Error(error.message + '\nPlayback diagnostics: ' + JSON.stringify(detail));
  }
}
async function assertSeed(page, cached) {
  assert.equal((await currentPackage(page)).package_id, cached.package_id);
  assert.equal(await page.evaluate(packageId => window.__pwaTest.getCachedAsset(packageId, 0, 'image').then(blob => blob.size), cached.package_id), png.length);
}
async function storedPackages(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const opening = indexedDB.open('slideflow-pwa-v3', 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction('packages', 'readonly');
      const request = tx.objectStore('packages').getAll();
      tx.oncomplete = () => { resolve(request.result); db.close(); };
      tx.onerror = () => { reject(tx.error); db.close(); };
    };
  }));
}

test('real download survives offline cold start and serves matching Presenter/Display packages', { timeout: 60_000 }, async t => {
  const { context, page, cached, attempts, errors } = await setup(t);
  assert.equal(cached.state, 'ready');
  const owner = await page.evaluate(() => window.__pwaTest.offlineOwnerKey(window.__pwaTest.readOfflineIdentity()));
  assert.equal(cached.owner_key, owner);
  await page.close();
  await context.setOffline(true);
  attempts.length = 0;
  const cold = await context.newPage();
  const response = await cold.goto(origin + '/shows/1/fullscreen?offline=true&package_id=' + cached.package_id);
  assert.equal(response.fromServiceWorker(), true);
  await cold.getByText('点击开始放映', { exact: true }).click();
  await cold.waitForFunction(() => document.querySelector('img[src^="blob:"]')?.naturalWidth > 0);
  assert.equal(await cold.evaluate(() => window.__testAuth.offline), true);
  await cold.close();
  const presenter = await context.newPage();
  const popupPromise = presenter.waitForEvent('popup');
  await presenter.goto(origin + '/shows/1/present?offline=true&package_id=' + cached.package_id);
  const display = await popupPromise;
  await waitImage(presenter, 'V1 slide 1'); await waitImage(display, '幻灯片 1');
  assert.equal(new URL(display.url()).searchParams.get('package_id'), cached.package_id);
  await presenter.getByText('V1 common 0', { exact: true }).waitFor();
  await presenter.getByRole('button', { name: '个人备注', exact: false }).last().click();
  await presenter.getByText('V1 personal 0', { exact: true }).waitFor();
  await presenter.getByRole('button', { name: '放映备注', exact: false }).last().click();
  await presenter.getByText('V1 show 0', { exact: true }).waitFor();
  await presenter.keyboard.press('ArrowRight');
  await waitImage(presenter, 'V1 slide 3'); await waitImage(display, '幻灯片 3');
  assert.deepEqual(attempts.filter(pathname => pathname !== '/api/me'), []);
  assert.deepEqual(errors, []);
});

test('a package update preserves the active old package, including after reconnect', { timeout: 60_000 }, async t => {
  const { context, page, cached, state } = await setup(t);
  const presenter = await context.newPage();
  const popupPromise = presenter.waitForEvent('popup');
  await presenter.goto(origin + '/shows/1/present?offline=true&package_id=' + cached.package_id);
  const display = await popupPromise;
  await waitImage(presenter, 'V1 slide 1'); await waitImage(display, '幻灯片 1');
  const imageBefore = await presenter.getByRole('img', { name: 'V1 slide 1', exact: true }).first().getAttribute('src');
  state.version = 2;
  const updated = await page.evaluate(() => window.__pwaTest.downloadShow(1));
  assert.notEqual(updated.package_id, cached.package_id);
  assert.equal((await currentPackage(page)).package_id, updated.package_id);
  assert.equal((await currentPackage(page, cached.package_id)).version_no, 1);
  await context.setOffline(true);
  await presenter.waitForFunction(() => window.__testAuth.offline === true);
  await waitImage(presenter, 'V1 slide 1');
  await context.setOffline(false);
  await presenter.waitForFunction(() => window.__testAuth.offline === false && !window.__testAuth.loading);
  await waitImage(presenter, 'V1 slide 1'); await waitImage(display, '幻灯片 1');
  assert.equal(await presenter.getByRole('img', { name: 'V1 slide 1', exact: true }).first().getAttribute('src'), imageBefore);
  await presenter.keyboard.press('ArrowRight');
  await waitImage(presenter, 'V1 slide 3'); await waitImage(display, '幻灯片 3');
});

test('real cache revocation and cross-window logout stop both playback windows', { timeout: 60_000 }, async t => {
  const { context, page, cached } = await setup(t);
  const presenter = await context.newPage();
  const popupPromise = presenter.waitForEvent('popup');
  await presenter.goto(origin + '/shows/1/present?offline=true&package_id=' + cached.package_id);
  const display = await popupPromise;
  await waitImage(presenter, 'V1 slide 1'); await waitImage(display, '幻灯片 1');
  await page.evaluate(() => window.__pwaTest.invalidateCachedShow(1, window.__pwaTest.readOfflineIdentity()));
  await presenter.getByText('此放映的离线授权已失效，请联网重新获取', { exact: true }).waitFor();
  await display.getByRole('alert').filter({ hasText: '离线授权已失效' }).waitFor();
  assert.equal(await presenter.locator('img[src^="blob:"]').count(), 0);
  await page.evaluate(() => window.__testAuth.logout());
  await presenter.getByText('需要登录', { exact: true }).waitFor();
  await display.getByText('需要登录', { exact: true }).waitFor();
  assert.equal(await display.locator('img').count(), 0);
});

for (const failure of ['sha', 'short', 'interrupt']) {
  test('a ' + failure + ' asset failure preserves the previous complete package', { timeout: 60_000 }, async t => {
    const { page, cached, state } = await setup(t);
    state.version = 2; state.assetMode = failure;
    await startDownload(page);
    const result = await finishDownload(page);
    assert.equal(result.ok, false);
    await assertSeed(page, cached);
    assert.equal((await page.evaluate(() => window.__pwaTest.listCachedShows())).length, 1);
  });
}

test('cancelling an in-flight real download leaves the old package playable', { timeout: 60_000 }, async t => {
  const { page, cached, state } = await setup(t);
  state.version = 2; state.assetMode = 'hold';
  await startDownload(page); await waitHeld();
  await page.evaluate(() => window.__downloadAbort.abort());
  const result = await finishDownload(page); releaseHeld();
  assert.equal(result.ok, false);
  assert.equal(result.name, 'AbortError');
  await assertSeed(page, cached);
});

for (const action of ['deleteCachedShow', 'invalidateCachedShow']) {
  test(action + ' during a download prevents its late publication', { timeout: 60_000 }, async t => {
    const { page, cached, state } = await setup(t);
    state.version = 2; state.assetMode = 'hold';
    await startDownload(page); await waitHeld();
    await page.evaluate(action => window.__pwaTest[action](1, window.__pwaTest.readOfflineIdentity()), action);
    releaseHeld();
    const result = await finishDownload(page);
    assert.equal(result.ok, false);
    assert.match(result.message, /未发布|删除|撤销|更新/);
    await assert.rejects(currentPackage(page));
    const entries = await page.evaluate(() => window.__pwaTest.listCachedShows());
    assert.ok(entries.every(entry => entry.version_no === 1 && entry.revoked));
    const stored = await page.evaluate(() => new Promise((resolve, reject) => {
      const opening = indexedDB.open('slideflow-pwa-v3', 1);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const tx = db.transaction(['packages', 'assets'], 'readonly');
        const packages = tx.objectStore('packages').getAll();
        const assets = tx.objectStore('assets').getAllKeys();
        tx.oncomplete = () => { resolve({ packages: packages.result, assets: assets.result }); db.close(); };
        tx.onerror = () => { reject(tx.error); db.close(); };
      };
    }));
    assert.ok(stored.packages.every(entry => entry.version_no === 1));
    if (action === 'deleteCachedShow') assert.deepEqual(stored, { packages: [], assets: [] });
    else assert.ok(stored.assets.every(key => String(key).startsWith(cached.package_id + ':')));
  });
}

test('two authenticated windows cannot concurrently download the same show', { timeout: 60_000 }, async t => {
  const { page, context, state } = await setup(t);
  const second = await context.newPage();
  await second.goto(origin + '/manage/offline-cache');
  await second.waitForFunction(() => window.__testAuth?.user?.id === 1 && !window.__testAuth.loading);
  state.version = 2; state.assetMode = 'hold';
  await startDownload(page); await waitHeld();
  const secondResult = await second.evaluate(() => window.__pwaTest.downloadShow(1).then(() => ({ ok: true }), error => ({ ok: false, message: error.message })));
  assert.equal(secondResult.ok, false);
  assert.match(secondResult.message, /另一个窗口下载/);
  releaseHeld();
  const firstResult = await finishDownload(page);
  assert.equal(firstResult.ok, true);
  assert.equal((await currentPackage(second)).package_id, firstResult.value.package_id);
});

test('switching accounts invalidates an earlier in-flight package and its owner', { timeout: 60_000 }, async t => {
  const { page, cached, state } = await setup(t);
  state.version = 2; state.assetMode = 'hold';
  await startDownload(page); await waitHeld();
  state.userId = 2;
  await page.evaluate(() => window.__testAuth.reload());
  await page.waitForFunction(() => window.__testAuth?.user?.id === 2 && !window.__testAuth.loading);
  releaseHeld();
  const result = await finishDownload(page);
  assert.equal(result.ok, false);
  await assert.rejects(currentPackage(page, cached.package_id));
  assert.deepEqual(await page.evaluate(() => window.__pwaTest.listCachedShows()), []);
  const identity = await page.evaluate(() => window.__pwaTest.readOfflineIdentity());
  assert.equal(identity.user.id, 2);
  assert.notEqual(await page.evaluate(() => window.__pwaTest.offlineOwnerKey(window.__pwaTest.readOfflineIdentity())), cached.owner_key);
});

test('a real IndexedDB QuotaExceededError preserves the active package', { timeout: 60_000 }, async t => {
  const { page, cached, state } = await setup(t);
  state.version = 2;
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    window.__restoreQuota = () => { IDBObjectStore.prototype.put = original; };
    IDBObjectStore.prototype.put = function (...arguments_) {
      if (this.name === 'assets') throw new DOMException('Simulated browser quota', 'QuotaExceededError');
      return original.apply(this, arguments_);
    };
  });
  await startDownload(page);
  const result = await finishDownload(page);
  await page.evaluate(() => window.__restoreQuota());
  assert.equal(result.ok, false);
  assert.match(result.message, /存储空间不足/);
  await assertSeed(page, cached);
});

test('explicit manifest denial cannot open a real cached package', { timeout: 60_000 }, async t => {
  const { page, context, cached, state } = await setup(t);
  state.manifestStatus = 403;
  const player = await context.newPage();
  await player.goto(origin + '/shows/1/fullscreen?offline=true&package_id=' + cached.package_id);
  await player.getByText(/放映权限已撤销|离线授权已失效/).first().waitFor();
  assert.equal(await player.locator('img[src^="blob:"]').count(), 0);
  await assert.rejects(currentPackage(page, cached.package_id));
});

test('a fresh HTTP 401 identity response never falls back to the saved identity', { timeout: 60_000 }, async t => {
  const { context, cached, state } = await setup(t);
  state.meStatus = 401;
  const player = await context.newPage();
  await player.goto(origin + '/shows/1/fullscreen?offline=true&package_id=' + cached.package_id);
  await player.getByText('需要登录', { exact: true }).waitFor();
  assert.equal(await player.evaluate(() => window.__pwaTest.readOfflineIdentity()), null);
  assert.equal(await player.locator('img').count(), 0);
});

test('logging into the same account creates a fresh epoch and cannot revive old packages', { timeout: 60_000 }, async t => {
  const { page, cached, state } = await setup(t);
  await page.evaluate(() => window.__testAuth.logout());
  await page.getByText('需要登录', { exact: true }).waitFor();
  state.meStatus = 200;
  await page.evaluate(async () => {
    const epoch = window.__testAuth.beginLogin();
    await window.__testAuth.completeLogin({ id: 1, username: 'test1', name: 'Test', role: 'admin', session_version: 3 }, epoch);
  });
  await page.waitForFunction(() => window.__testAuth?.user?.id === 1 && !window.__testAuth.loading);
  assert.notEqual(await page.evaluate(() => window.__pwaTest.offlineOwnerKey(window.__pwaTest.readOfflineIdentity())), cached.owner_key);
  await assert.rejects(currentPackage(page, cached.package_id));
  assert.deepEqual(await page.evaluate(() => window.__pwaTest.listCachedShows()), []);
});

test('an online account change clears private queries when identity persistence is unavailable', { timeout: 60_000 }, async t => {
  const { page, state } = await setup(t, false, true);
  assert.equal(await page.evaluate(() => window.__testAuth.identity), null);
  await page.evaluate(() => window.__testQueries.setQueryData(['integration-private', 1], 'account A content'));
  state.userId = 2;
  await page.evaluate(() => window.__testAuth.reload());
  await page.waitForFunction(() => window.__testAuth?.user?.id === 2 && !window.__testAuth.loading);
  assert.equal(await page.evaluate(() => window.__testQueries.getQueryData(['integration-private', 1])), undefined);
  assert.equal(await page.evaluate(() => window.__testAuth.identity), null);
  await assert.rejects(page.evaluate(() => window.__pwaTest.downloadShow(1)));
});

test('logout stops another player when identity writes fail but reads still work', { timeout: 60_000 }, async t => {
  const { page, context, cached } = await setup(t);
  const player = await context.newPage();
  await player.goto(origin + '/shows/1/fullscreen?offline=true&package_id=' + cached.package_id);
  await player.getByText('点击开始放映', { exact: true }).click();
  await player.waitForFunction(() => document.querySelector('img[src^="blob:"]')?.naturalWidth > 0);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'slideflow-offline-session-v3') throw new DOMException('Identity write unavailable', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.evaluate(() => window.__testAuth.logout());
  await player.getByText('需要登录', { exact: true }).waitFor();
  assert.equal(await player.locator('img').count(), 0);
  assert.equal(await player.evaluate(() => window.__pwaTest.readOfflineIdentity()), null);
});

test('online playback falls back to its original package after a newer download', { timeout: 60_000 }, async t => {
  const { page, context, cached, attempts, state } = await setup(t);
  const presenter = await context.newPage();
  const popupPromise = presenter.waitForEvent('popup');
  await presenter.goto(origin + '/shows/1/present');
  const display = await popupPromise;
  await waitImage(presenter, 'V1 slide 1'); await waitImage(display, '幻灯片 1');
  assert.equal(new URL(display.url()).searchParams.get('package_id'), cached.package_id);
  state.version = 2;
  const updated = await page.evaluate(() => window.__pwaTest.downloadShow(1));
  assert.notEqual(updated.package_id, cached.package_id);
  await context.setOffline(true);
  await presenter.waitForFunction(() => window.__testAuth.offline === true);
  await presenter.getByText('V1 common 0', { exact: true }).waitFor();
  await waitImage(display, '幻灯片 1');
  await presenter.keyboard.press('ArrowRight');
  await waitImage(presenter, 'V1 slide 3'); await waitImage(display, '幻灯片 3');
  await presenter.getByText('V1 common 2', { exact: true }).waitFor();
  await context.setOffline(false);
  await presenter.waitForFunction(() => !window.__testAuth.offline && !window.__testAuth.loading);
  attempts.length = 0;
  await presenter.keyboard.press('ArrowRight');
  await waitImage(presenter, 'V1 slide 4'); await waitImage(display, '幻灯片 4');
  assert.deepEqual(attempts.filter(pathname => pathname !== '/api/me'), []);
});

test('a newly authorized package never revives an older revoked package', { timeout: 60_000 }, async t => {
  const { page, context, cached, state } = await setup(t);
  await page.evaluate(async packageId => { window.__releaseOldPackage = await window.__pwaTest.pinCachedShow(packageId); }, cached.package_id);
  await page.evaluate(() => window.__pwaTest.invalidateCachedShow(1, window.__pwaTest.readOfflineIdentity()));
  await assert.rejects(currentPackage(page, cached.package_id));
  state.version = 2;
  const updated = await page.evaluate(() => window.__pwaTest.downloadShow(1));
  assert.notEqual(updated.package_id, cached.package_id);
  await assertSeed(page, updated);
  await assert.rejects(currentPackage(page, cached.package_id));
  const oldRecord = (await storedPackages(page)).find(entry => entry.package_id === cached.package_id);
  assert.ok(!oldRecord || oldRecord.revoked, 'the old snapshot is removed or permanently marked revoked');
  await context.setOffline(true);
  const denied = await context.newPage();
  await denied.goto(origin + '/shows/1/fullscreen?offline=true&package_id=' + cached.package_id);
  await denied.getByText(/离线授权已失效|缓存不存在|没有可用|重新下载/).first().waitFor();
  assert.equal(await denied.locator('img[src^="blob:"]').count(), 0);
  const allowed = await context.newPage();
  await allowed.goto(origin + '/shows/1/fullscreen?offline=true&package_id=' + updated.package_id);
  await allowed.getByText('点击开始放映', { exact: true }).click();
  await allowed.waitForFunction(() => document.querySelector('img[src^="blob:"]')?.naturalWidth > 0);
  assert.equal(await allowed.evaluate(() => window.__testAuth.offline), true);
});

test('a failed IndexedDB revocation transaction locks identity before an offline reopen', { timeout: 60_000 }, async t => {
  const { page, context, cached } = await setup(t);
  const result = await page.evaluate(async () => {
    const identity = window.__pwaTest.readOfflineIdentity();
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...arguments_) {
      const tx = original.apply(this, arguments_);
      if (arguments_[1] === 'readwrite') queueMicrotask(() => { try { tx.abort(); } catch {} });
      return tx;
    };
    return window.__pwaTest.invalidateCachedShow(1, identity).then(
      () => ({ ok: true }), error => ({ ok: false, message: error.message }));
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /暂停此登录会话|重新登录/);
  await page.getByText('需要登录', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__pwaTest.readOfflineIdentity()), null);
  assert.ok((await storedPackages(page)).some(entry => entry.package_id === cached.package_id), 'the package remains physically readable after write failure');
  await context.setOffline(true);
  const reopened = await context.newPage();
  await reopened.goto(origin + '/shows/1/fullscreen?offline=true&package_id=' + cached.package_id);
  await reopened.getByText('需要登录', { exact: true }).waitFor();
  assert.equal(await reopened.locator('img').count(), 0);
  await assert.rejects(currentPackage(reopened, cached.package_id));
});

test('a late account A denial cannot revoke account B cached playback', { timeout: 60_000 }, async t => {
  const { page, context, state } = await setup(t);
  const player = await context.newPage();
  await player.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname.endsWith('/present-session') && !window.__oldSessionStarted) {
        window.__oldSessionStarted = true;
        // Model a response already beyond abort's reach without replacing any auth/cache module.
        const response = await original(input, { ...init, signal: undefined });
        window.__oldSessionResolved = true;
        return response;
      }
      return original(input, init);
    };
  });
  state.showStatus = 403; state.sessionMode = 'hold';
  const deniedResponse = player.waitForResponse(response => new URL(response.url()).pathname === '/api/shows/1' && response.status() === 403);
  await player.goto(origin + '/shows/1/fullscreen');
  await deniedResponse; await waitHeld('heldSessions');
  state.showStatus = 200; state.userId = 2; state.version = 2;
  await player.evaluate(() => window.__testAuth.reload());
  await player.waitForFunction(() => window.__testAuth?.user?.id === 2 && !window.__testAuth.loading);
  await page.evaluate(() => window.__testAuth.reload());
  await page.waitForFunction(() => window.__testAuth?.user?.id === 2 && !window.__testAuth.loading);
  const cachedB = await page.evaluate(() => window.__pwaTest.downloadShow(1));
  await page.evaluate(() => {
    window.__revocationEvents = [];
    window.addEventListener('slideflow-pwa-change', event => { if (event.detail?.reason === 'revoked') window.__revocationEvents.push(event.detail); });
  });
  for (const response of state.heldSessions.splice(0)) {
    if (!response.destroyed) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ session_token: 'late-account-A-token' })); }
  }
  await player.waitForFunction(() => window.__oldSessionResolved === true);
  await player.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await assertSeed(page, cachedB);
  assert.equal(await page.evaluate(() => window.__pwaTest.readOfflineIdentity().user.id), 2);
  assert.deepEqual(await page.evaluate(() => window.__revocationEvents), []);
  assert.equal((await storedPackages(page)).find(entry => entry.package_id === cachedB.package_id)?.revoked, undefined);
});

test('a cross-window revocation stops online preloaded blobs while cache deletion preserves online playback', { timeout: 60_000 }, async t => {
  const { page, context, state } = await setup(t);
  const presenter = await context.newPage();
  const popupPromise = presenter.waitForEvent('popup');
  await presenter.goto(origin + '/shows/1/present');
  const display = await popupPromise;
  await waitImage(presenter, 'V1 slide 1'); await waitImage(display, '幻灯片 1');
  assert.equal(new URL(display.url()).searchParams.get('source'), 'online');
  await page.evaluate(() => window.__pwaTest.deleteCachedShow(1));
  await waitImage(presenter, 'V1 slide 1'); await waitImage(display, '幻灯片 1');
  await presenter.keyboard.press('ArrowRight');
  await waitImage(presenter, 'V1 slide 3'); await waitImage(display, '幻灯片 3');
  await presenter.keyboard.press('ArrowLeft');
  await waitImage(presenter, 'V1 slide 1'); await waitImage(display, '幻灯片 1');
  state.manifestStatus = 403;
  const denied = await page.evaluate(() => window.__pwaTest.downloadShow(1).then(
    () => ({ ok: true }), error => ({ ok: false, message: error.message })));
  assert.equal(denied.ok, false);
  await presenter.getByText('此放映的访问授权已撤销，请重新打开', { exact: true }).waitFor();
  await display.getByRole('alert').filter({ hasText: '访问授权已撤销' }).waitFor();
  assert.equal(await presenter.locator('img[src^="blob:"]').count(), 0);
  assert.equal(await display.locator('img[src^="blob:"]').count(), 0);
  await presenter.keyboard.press('ArrowRight');
  assert.equal(await presenter.locator('img[src^="blob:"]').count(), 0);
  assert.equal(await display.locator('img[src^="blob:"]').count(), 0);
});
