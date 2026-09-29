// Exercises the real three players and hook against a deterministic cache boundary.
// Persistent IndexedDB/cache integrity is covered by the cache module's own tests.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { launchBrowser } from './helpers/browser.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = path.join(root, 'tests/fixtures/playback');
let server, browser, baseUrl;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=', 'base64');

before(async () => {
  server = await createServer({
    root, configFile: false, logLevel: 'error',
    cacheDir: path.join(root, 'node_modules/.vite-playback-tests'),
    optimizeDeps: { entries: [path.join(fixtures, 'entry.tsx')] },
    resolve: { alias: { '@': path.join(root, 'src') } },
    plugins: [{ name: 'playback-test-boundaries', enforce: 'pre',
      resolveId(source, importer) {
        if ((source === './pwa-cache' && importer?.includes('/src/lib/')) || source.endsWith('/lib/pwa-cache')) return path.join(fixtures, 'cache.ts');
        if ((source === './auth' && importer?.includes('/src/lib/')) || source === '@/lib/auth' || source.endsWith('/src/lib/auth')) return path.join(fixtures, 'auth.ts');
      },
      configureServer(instance) {
        instance.middlewares.use((request, response, next) => {
          if (!request.headers.accept?.includes('text/html')) return next();
          const html = '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/tests/fixtures/playback/entry.tsx"></script></body></html>';
          void instance.transformIndexHtml(request.url, html).then(result => { response.setHeader('Content-Type', 'text/html'); response.end(result); });
        });
      },
    }, react()],
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  baseUrl = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await server?.close(); });

function manifest() {
  return {
    format_version: 3, package_id: 'a'.repeat(32), user_id: 1, session_version: 3,
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(),
    show_id: 1, name: 'Playback test', version_no: 3, series_id: 'test-series', updated_at: '2026-09-28T00:00:00Z',
    subject: 'test', tags: [], status: 'active', owner_name: 'Test', cached_at: new Date().toISOString(), total_bytes: 100, owner_key: '1:3',
    resources: Array.from({ length: 7 }, (_, index) => ({ id: 100 + index, name: 'Slide ' + (index + 1), version_no: index + 2,
      slide_index: index, hidden: index === 1, image_url: '/api/test/image/' + index, thumb_url: '/api/test/thumb/' + index,
      image_sha256: 'a'.repeat(64), thumb_sha256: 'b'.repeat(64), size_bytes: png.length, thumb_size_bytes: png.length,
      common_remark_html: '<p>cached-common-' + index + '</p>', personal_remark_html: '<p>cached-personal-' + index + '</p>', show_remark_html: '<p>cached-show-' + index + '</p>',
    })),
  };
}

async function setup(t, configuration = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const cached = manifest();
  if (configuration.empty) cached.resources = [];
  if (configuration.expiresIn) cached.expires_at = new Date(Date.now() + configuration.expiresIn).toISOString();
  const requests = [], consoleErrors = [];
  const state = { network: true, showStatus: 200, sessionStatus: 200, sessionAbort: false, manifestStatus: 200, ...configuration };
  await context.addInitScript(({ cached, offline, corrupt }) => {
    window.__playbackAuth = { user: { id: 1, session_version: 3, username: 'test', name: 'Test', role: 'admin' }, offline, loading: false };
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    if (!localStorage.getItem('playback-test-packages')) {
      localStorage.setItem('playback-test-packages', JSON.stringify({ [cached.package_id]: cached }));
      localStorage.setItem('playback-test-latest', cached.package_id);
    }
    if (corrupt) localStorage.setItem('playback-test-corrupt', 'true');
  }, { cached, offline: !!configuration.offline, corrupt: !!configuration.corrupt });
  context.on('page', page => page.on('pageerror', error => consoleErrors.push(error.message)));
  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    requests.push({ path: url.pathname, method: route.request().method(), version: url.searchParams.get('version_no'), versionId: url.searchParams.get('version_id'), body: route.request().postData() ? route.request().postDataJSON() : undefined });
    if (!state.network) return route.abort('internetdisconnected');
    const ok = json => route.fulfill({ json });
    if (url.pathname === '/api/shows/1') {
      if (state.showStatus !== 200) return route.fulfill({ status: state.showStatus, json: { detail: '明确拒绝访问' } });
      return ok({ show: { id: 1, name: cached.name, version_no: 3, can_manage: true,
        resources: cached.resources.map((resource, index) => ({ id: resource.id, name: resource.name, hidden: resource.hidden, accessible: index !== state.inaccessibleIndex, version_no: resource.version_no, latest_version_no: resource.version_no, preview_url: resource.thumb_url, original_preview_url: null })) } });
    }
    if (url.pathname.endsWith('/present-session')) return state.sessionAbort ? route.abort('internetdisconnected') : state.sessionStatus !== 200 ? route.fulfill({ status: state.sessionStatus, json: { detail: '明确拒绝访问' } }) : ok({ session_token: 'present-token' });
    if (url.pathname.endsWith('/offline-manifest')) return state.manifestStatus === 200 ? ok(state.manifestJson ?? cached) : route.fulfill({ status: state.manifestStatus, json: { detail: '缓存权限已撤销' } });
    if (url.pathname.includes('/offline-assets/') || url.pathname.startsWith('/api/test/')) return route.fulfill({ contentType: 'image/png', body: png });
    const resourceMatch = url.pathname.match(/^\/api\/resources\/(\d+)(?:\/(personal-remark|common-remark))?$/);
    if (resourceMatch) {
      const resourceId = Number(resourceMatch[1]);
      const resource = cached.resources.find(item => item.id === resourceId);
      const index = cached.resources.indexOf(resource);
      const versionId = resourceId * 1000 + resource.version_no;
      if (!resourceMatch[2]) return ok({ resource: { id: resourceId, can_manage: true, current: { id: resourceId * 1000 + 99, version_no: 99, common_remark_html: '<p>online-latest-' + index + '</p>' }, versions: [{ id: versionId, version_no: resource.version_no, common_remark_html: '<p>online-common-pinned-' + index + '</p>' }] } });
      if (route.request().method() !== 'GET') return ok({ ok: true });
      return ok({ content_html: '<p>' + (url.searchParams.get('version_id') === String(versionId) ? 'online-personal-pinned-' : 'online-personal-latest-') + index + '</p>', version_id: versionId });
    }
    return ok({ preferences: {}, content_html: '<p>online note</p>', resource: { id: 100, current: { common_remark_html: '<p>online common</p>' }, can_manage: true } });
  });
  const page = await context.newPage();
  return { context, page, cached, requests, state, consoleErrors };
}

async function waitImage(page, name) {
  const image = page.getByRole('img', { name, exact: true }).first();
  await image.waitFor();
  await image.evaluate(image => image.complete && image.naturalWidth > 0 ? undefined : new Promise((resolve, reject) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', reject, { once: true }); }));
}

test('offline presenter preserves hidden slides, pinned versions, all notes and matching Display package', async t => {
  const { context, page, requests, cached, consoleErrors } = await setup(t, { offline: true });
  const popupPromise = context.waitForEvent('page', { predicate: candidate => candidate !== page });
  await page.goto(baseUrl + '/shows/1/presenter?offline=true&package_id=' + cached.package_id);
  const popup = await popupPromise;
  await waitImage(page, 'Slide 1'); await waitImage(popup, '幻灯片 1');
  assert.equal(new URL(popup.url()).searchParams.get('package_id'), cached.package_id);
  await page.getByText('cached-common-0', { exact: true }).waitFor();
  await page.getByRole('button', { name: '个人备注', exact: false }).last().click();
  await page.getByText('cached-personal-0', { exact: true }).waitFor();
  await page.getByRole('button', { name: '放映备注', exact: false }).last().click();
  await page.getByText('cached-show-0', { exact: true }).waitFor();
  await page.keyboard.press('ArrowRight');
  await waitImage(page, 'Slide 3'); await waitImage(popup, '幻灯片 3');
  assert.equal(requests.length, 0, 'offline identity must not send preferences, remarks or image API requests');
  assert.deepEqual(consoleErrors, []);
});

test('a selected cache still rechecks server permission and cannot bypass an explicit 403', async t => {
  const { page, cached, requests } = await setup(t, { manifestStatus: 403 });
  await page.goto(baseUrl + '/shows/1/fullscreen?offline=true&package_id=' + cached.package_id);
  await page.getByText('缓存权限已撤销', { exact: true }).waitFor();
  assert.ok(requests.some(request => request.path.endsWith('/offline-manifest')));
  assert.equal(await page.evaluate(() => localStorage.getItem('playback-test-revoked')), 'true');
});

test('HTTP denial wins over a simultaneous session transport failure', async t => {
  const { page } = await setup(t, { showStatus: 403, sessionAbort: true });
  await page.goto(baseUrl + '/shows/1/fullscreen');
  await page.getByText('明确拒绝访问', { exact: true }).waitFor();
  assert.equal(await page.getByText('点击开始放映', { exact: true }).count(), 0);
});

test('online transport loss uses the pinned cache and reconnect does not switch the active source', async t => {
  const { page, state, requests, cached } = await setup(t);
  await page.goto(baseUrl + '/shows/1/fullscreen');
  await page.getByText('点击开始放映', { exact: true }).click();
  await page.locator('img[src^="blob:"]').first().waitFor();
  assert.ok(requests.some(request => request.path.includes('/offline-assets/100/') && request.version === '2'));
  state.network = false;
  await page.evaluate(cached => { const next = { ...cached, package_id: 'b'.repeat(32), resources: cached.resources.map(resource => ({ ...resource, version_no: 99 })) }; const packages = JSON.parse(localStorage.getItem('playback-test-packages')); packages[next.package_id] = next; localStorage.setItem('playback-test-packages', JSON.stringify(packages)); localStorage.setItem('playback-test-latest', next.package_id); }, cached);
  await page.keyboard.press('g'); await page.getByRole('textbox').fill('7'); await page.getByRole('textbox').press('Enter');
  await page.getByText('7 / 7', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('img[src^="blob:"]')?.naturalWidth > 0);
  const before = requests.filter(request => request.path.includes('/offline-assets/')).length;
  state.network = true; await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(300);
  assert.equal(requests.filter(request => request.path.includes('/offline-assets/')).length, before);
});

test('corrupt cached images reach a finite error state', async t => {
  const { page, cached } = await setup(t, { offline: true, corrupt: true });
  await page.goto(baseUrl + '/shows/1/fullscreen?offline=true&package_id=' + cached.package_id);
  await page.getByText('缓存图片校验失败', { exact: true }).waitFor();
  assert.equal(await page.getByText('点击开始放映', { exact: true }).count(), 0);
});

test('a Display opened without a valid playback session fails explicitly', async t => {
  const { page } = await setup(t, { offline: true });
  await page.goto(baseUrl + '/shows/1/display');
  await page.getByRole('alert').filter({ hasText: '没有有效会话' }).waitFor();
});

test('an explicit access denial outranks another HTTP failure', async t => {
  const { page } = await setup(t, { showStatus: 500, sessionStatus: 403 });
  await page.goto(baseUrl + '/shows/1/fullscreen');
  await page.getByText('明确拒绝访问', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('playback-test-revoked')), 'true');
});

test('partial online success cannot bypass a known resource denial with an old cache', async t => {
  const { page } = await setup(t, { inaccessibleIndex: 0, sessionAbort: true });
  await page.goto(baseUrl + '/shows/1/fullscreen');
  await page.getByText('此放映中有素材已无权访问，不能使用旧缓存播放', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('playback-test-revoked')), 'true');
});

test('malformed manifest data is an error rather than permission for cache fallback', async t => {
  const { page, cached } = await setup(t, { manifestJson: {} });
  await page.goto(baseUrl + '/shows/1/fullscreen?offline=true&package_id=' + cached.package_id);
  await page.getByText('缓存内容与当前放映版本不一致，请更新缓存后重新播放', { exact: true }).waitFor();
  assert.equal(await page.locator('img[src^="blob:"]').count(), 0);
});

test('cache revocation removes an already displayed image immediately', async t => {
  const { page, cached } = await setup(t, { offline: true });
  await page.goto(baseUrl + '/shows/1/fullscreen?offline=true&package_id=' + cached.package_id);
  await page.getByText('点击开始放映', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('img[src^="blob:"]')?.naturalWidth > 0);
  await page.evaluate(() => { localStorage.setItem('playback-test-revoked', 'true'); window.dispatchEvent(new Event('slideflow-pwa-change')); });
  await page.getByText('缓存授权已撤销', { exact: true }).waitFor();
  assert.equal(await page.locator('img[src^="blob:"]').count(), 0);
});

test('changing login generation cannot reuse the previous owner image', async t => {
  const { page, cached } = await setup(t, { offline: true });
  await page.goto(baseUrl + '/shows/1/fullscreen?offline=true&package_id=' + cached.package_id);
  await page.getByText('点击开始放映', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('img[src^="blob:"]')?.naturalWidth > 0);
  await page.evaluate(() => { window.__playbackAuth = { ...window.__playbackAuth, user: { ...window.__playbackAuth.user, session_version: 4 } }; window.dispatchEvent(new Event('playback-test-auth')); });
  await page.getByText('缓存不属于当前身份', { exact: true }).waitFor();
  assert.equal(await page.locator('img[src^="blob:"]').count(), 0);
});

test('cached playback stops at the authorization expiry without a new navigation', async t => {
  const { page, cached } = await setup(t, { offline: true, expiresIn: 3000 });
  await page.goto(baseUrl + '/shows/1/fullscreen?offline=true&package_id=' + cached.package_id);
  await page.getByText('点击开始放映', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('img[src^="blob:"]')?.naturalWidth > 0);
  await page.getByText('此离线缓存授权已过期，请联网重新下载', { exact: true }).waitFor();
  assert.equal(await page.locator('img[src^="blob:"]').count(), 0);
});

test('an empty show gives Display a finite error instead of an endless image spinner', async t => {
  const { page } = await setup(t, { empty: true });
  const popupPromise = page.waitForEvent('popup');
  await page.goto(baseUrl + '/shows/1/presenter');
  const display = await popupPromise;
  await display.getByRole('alert').filter({ hasText: '没有可显示的幻灯片' }).waitFor();
});

test('independent presenters isolate navigation and keep drawings synchronized across a page change', async t => {
  const { page, context, cached, requests } = await setup(t, { offline: true });
  const url = baseUrl + '/shows/1/presenter?offline=true&package_id=' + cached.package_id;
  const popupPromise = page.waitForEvent('popup');
  await page.goto(url);
  const display = await popupPromise;
  await waitImage(page, 'Slide 1'); await waitImage(display, '幻灯片 1');
  const second = await context.newPage();
  const secondPopupPromise = second.waitForEvent('popup');
  await second.goto(url);
  const secondDisplay = await secondPopupPromise;
  await waitImage(second, 'Slide 1'); await waitImage(secondDisplay, '幻灯片 1');
  assert.notEqual(new URL(display.url()).searchParams.get('playback_session'), new URL(secondDisplay.url()).searchParams.get('playback_session'));
  await page.getByRole('button', { name: '钢笔', exact: true }).click();
  const canvas = page.locator('canvas').first();
  const originalCanvas = await canvas.elementHandle();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 4 }); await page.mouse.up();
  const hasInk = () => { const canvas = document.querySelector('canvas'); const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; return data.some((value, index) => index % 4 === 3 && value > 0); };
  await page.waitForFunction(hasInk); await display.waitForFunction(hasInk);
  assert.equal(await secondDisplay.evaluate(hasInk), false);
  await page.keyboard.press('ArrowRight');
  await waitImage(page, 'Slide 3'); await waitImage(display, '幻灯片 3');
  await waitImage(secondDisplay, '幻灯片 1');
  assert.equal(await originalCanvas.evaluate(node => node.isConnected), true);
  assert.equal(await page.evaluate(hasInk), true); assert.equal(await display.evaluate(hasInk), true);
  await page.getByRole('button', { name: '清屏', exact: true }).click();
  await display.waitForFunction(() => { const canvas = document.querySelector('canvas'); return !canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0); });
  assert.equal(requests.length, 0);
});

test('online remarks read and write the pinned resource version and retain drafts after returning to a slide', async t => {
  const { page, requests } = await setup(t);
  await page.goto(baseUrl + '/shows/1/presenter');
  await waitImage(page, 'Slide 1');
  await page.getByText('online-common-pinned-0', { exact: true }).waitFor();
  assert.equal(await page.getByText('online-latest-0', { exact: true }).count(), 0);
  await page.keyboard.press('ArrowRight'); await waitImage(page, 'Slide 3');
  await page.keyboard.press('ArrowLeft'); await waitImage(page, 'Slide 1');
  await page.getByText('online-common-pinned-0', { exact: true }).waitFor();
  await page.locator('svg.lucide-pencil').first().locator('..').click();
  assert.match(await page.locator('textarea').inputValue(), /online-common-pinned-0/);
  await page.locator('textarea').fill('<p>edited common</p>');
  await page.getByText('保存', { exact: true }).click();
  await page.waitForTimeout(100);
  const commonSave = requests.find(request => request.path === '/api/resources/100/common-remark' && request.method === 'POST');
  assert.equal(commonSave?.body.apply_scope, 'selected');
  assert.equal(commonSave?.body.version_id, 100002);
  await page.getByRole('button', { name: '通用备注', exact: false }).last().click();
  await page.getByRole('button', { name: '个人备注', exact: false }).last().click();
  await page.getByText('online-personal-pinned-0', { exact: true }).waitFor();
  assert.ok(requests.some(request => request.path === '/api/resources/100/personal-remark' && request.versionId === '100002'));
  await page.locator('svg.lucide-pencil').last().locator('..').click();
  assert.match(await page.locator('textarea').inputValue(), /online-personal-pinned-0/);
  await page.locator('textarea').fill('<p>edited personal</p>');
  await page.getByText('保存', { exact: true }).click();
  await page.waitForTimeout(100);
  const personalSave = requests.find(request => request.path === '/api/resources/100/personal-remark' && request.method === 'PUT');
  assert.equal(personalSave?.body.version_id, 100002);
});

test('Display reports a lost master connection after its bounded heartbeat deadline', async t => {
  const { page, cached } = await setup(t, { offline: true });
  const popupPromise = page.waitForEvent('popup');
  await page.goto(baseUrl + '/shows/1/presenter?offline=true&package_id=' + cached.package_id);
  const display = await popupPromise;
  await waitImage(page, 'Slide 1'); await waitImage(display, '幻灯片 1');
  await page.evaluate(() => { BroadcastChannel.prototype.postMessage = () => {}; });
  await display.evaluate(() => { const realNow = Date.now; Date.now = () => realNow() + 20_000; });
  await display.getByRole('alert').filter({ hasText: '与主控的连接已中断' }).waitFor();
  assert.equal(await display.locator('img').count(), 0);
});
