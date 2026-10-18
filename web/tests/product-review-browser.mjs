// Exercise the real production routes and responsive layout against isolated HTTP fixtures.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/browser.mjs';
const dist = fileURLToPath(new URL('../../app/static/dist/', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=', 'base64');
const stamp = '2026-09-29T12:00:00Z';
const user = { id: 1, username: 'review', name: '测试用户', role: 'system_admin', session_version: 1 };
const version = { id: 11, version_no: 1, preview_url: '/fixture.png', original_preview_url: '/fixture.png', common_remark_html: '<p>演示时可参考这里的内容</p>', font_names: [], missing_fonts: [], created_at: stamp, created_by: user, change_note: '初始版本' };
const resource = { id: 1, detail_token: 'review-resource', name: '客户介绍页面', owner_id: 1, owner: user, subject: '产品介绍', tags: '对外,精选', status: 'active', visibility_scope: 'public', management_scope: 'private', current_version: 1, current: version, versions: [version], can_manage: true, created_at: stamp, updated_at: stamp, visible_user_ids: [], manage_user_ids: [], visible_user_tags: [], manage_user_tags: [] };
const show = { id: 1, name: '客户介绍标准放映', owner_id: 1, owner: user, subject: '产品介绍', tags: '对外,精选', status: 'active', visibility_scope: 'public', management_scope: 'private', can_manage: true, is_standard: true, series_id: 'review', version_no: 1, version_count: 1, has_other_versions: false, created_at: stamp, updated_at: stamp, all_resource_ids: [1, 2, 3], resources: [1, 2, 3].map(id => ({ id, name: '介绍第 ' + id + ' 页', version_no: 1, latest_version_no: 1, accessible: true, preview_url: '/fixture.png', original_preview_url: '/fixture.png', hidden: false })) };
let browser, server, origin, requests = [], deletionDelay = 0;
const list = items => ({ items, total: items.length, page: 1, page_size: 20, all_tags: ['对外', '精选'], all_subjects: ['产品介绍'] });
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost'), p = url.pathname;
  res.setHeader('Cache-Control', 'no-store');
  const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (p.startsWith('/api/')) {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    requests.push({ path: p, method: req.method, body: Buffer.concat(parts).toString() });
    if (p === '/api/me') return json({ user });
    if (p === '/api/config') return json({ site_name: 'Slide Flow', resource_status_options: ['active'] });
    if (p === '/api/version') return json({ commit: 'review', updated_at: stamp });
    if (p === '/api/user/preferences') return json({ preferences: {} });
    if (p === '/api/me/home/stats') return json({ resources: { total: 12, mine: 6 }, shows: { total: 4, mine: 2 }, templates: { total: 6 }, fonts: { total: 8 } });
    if (p === '/api/me/pins') return json({ resources: [resource], shows: [show] });
    if (p === '/api/shows') return json(list([show]));
    if (p === '/api/shows/1' && req.method === 'DELETE') { await new Promise(r => setTimeout(r, deletionDelay)); return json({ ok: true }); }
    if (p === '/api/shows/1') return json({ show });
    if (p === '/api/shows/1/versions') return json({ versions: [{ ...show, resource_count: 3 }], current_version_no: 1 });
    if (p === '/api/shows/1/check-updates') return json({ updates: [] });
    if (p === '/api/shows/1/duplicate') return json({ show: { ...show, id: 2 } });
    if (p === '/api/shows/1/share-links') return req.method === 'POST' ? json({ share_path: '/share/shows/review-token', expires_at: '2030-01-01T00:00:00Z', page_count: 3 }) : json({ items: [] });
    if (p === '/api/resources/ids' || p === '/api/resources/pick-ids') return json({ ids: [1] });
    if (p === '/api/resources' || p === '/api/resources/pick') return json(list([resource]));
    if (p.startsWith('/api/resources/by-key/') || /^\/api\/resources\/\d+$/.test(p)) return json({ resource });
    if (p.includes('remark')) return json({ content_html: '<p>可直接编辑讲演备注</p>' });
    if (p.endsWith('/share-links')) return json({ items: [] });
    if (p.endsWith('-share-links')) return json({ ...list([]), stats: { total: 0, active: 0, expired: 0, revoked: 0 } });
    if (p === '/api/tasks') return json({ ...list([]), stats: { total: 0, pending: 0, running: 0, completed: 0, failed: 0 } });
    if (p === '/api/fonts') return json(list([]));
    if (p === '/api/templates') return json(list([]));
    if (p === '/api/admin/users') return json({ ...list([user]), users: [user] });
    if (p.endsWith('/tags') || p.endsWith('-tags')) return json({ tags: [], items: [] });
    if (p === '/api/users/options') return json({ items: [user], users: [user], has_more: false });
    if (p.includes('/preview')) { res.setHeader('Content-Type', 'image/png'); res.end(png); return; }
    return json({ ok: true, items: [], tags: [], preferences: {} });
  }
  if (p === '/fixture.png') { res.setHeader('Content-Type', 'image/png'); res.end(png); return; }
  const file = path.extname(p) ? p.slice(1) : 'index.html';
  if (file.includes('..')) { res.writeHead(404); res.end(); return; }
  try { const body = await readFile(path.join(dist, file)); res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }[path.extname(file)] || 'text/html'); res.end(body); }
  catch { res.writeHead(404); res.end(); }
}
before(async () => {
  server = http.createServer((req, res) => void handle(req, res).catch(error => { res.writeHead(500); res.end(String(error)); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

async function versionedResourcePage(t) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'uncaught browser errors'));
  const versions = [1, 2, 3].map(no => ({
    ...version, id: no * 10 + 1, version_no: no,
    preview_url: `/fixture.png?version=${no}`, original_preview_url: `/fixture.png?version=${no}`,
    common_remark_html: `<p>版本 ${no} 的通用备注</p>`, change_note: `版本 ${no}`,
  }));
  let current = 2;
  const detailToken = 'version-history-'.padEnd(32, 'a');
  await page.route('**/api/resources/by-key/*', route => route.fulfill({ json: {
    resource: { ...resource, detail_token: detailToken, current_version: current, current: versions[current - 1], versions: versions.slice(0, current) },
  } }));
  await page.route('**/api/resources/1/personal-remark*', route => {
    const versionId = Number(new URL(route.request().url()).searchParams.get('version_id'));
    return route.fulfill({ json: { content_html: `<p>版本 ID ${versionId} 的个人备注</p>`, version_id: versionId } });
  });
  const assertVersion = async no => {
    await page.waitForFunction(({ name, no }) => document.querySelector(`img[alt="${name}"]`)?.getAttribute('src') === `/fixture.png?version=${no}`, { name: resource.name, no });
    assert.equal(await page.getByRole('button', { name: /通用备注/ }).locator('span.line-clamp-3').textContent(), `版本 ${no} 的通用备注`);
    await page.getByRole('button', { name: /个人备注/ }).getByText(`版本 ID ${no * 10 + 1} 的个人备注`, { exact: true }).waitFor();
  };
  const chooseVersion = async no => {
    await page.getByRole('combobox', { name: '切换版本' }).click();
    await page.getByRole('option', { name: no === 'latest' ? /^最新版/ : new RegExp(`^v${no}(?:（| ·)`), exact: false }).click();
  };
  return { page, path: `/resources/${detailToken}`, assertVersion, chooseVersion, update: no => { current = no; } };
}

test('resource version selection updates the URL, survives reload and follows browser history', { timeout: 30_000 }, async t => {
  const { page, path: detailPath, assertVersion, chooseVersion, update } = await versionedResourcePage(t);
  const latestUrl = origin + detailPath + '?source=test#preview';
  await page.goto(latestUrl);
  await assertVersion(2);
  assert.equal(page.url(), latestUrl, 'bare version URL stays unpinned');
  await chooseVersion(1);
  await assertVersion(1);
  assert.equal(page.url(), origin + detailPath + '?source=test&version=1#preview');

  await page.getByRole('button', { name: '链接与分享' }).click();
  assert.equal(await page.getByRole('textbox', { name: '素材页面地址', exact: true }).inputValue(), page.url());
  await page.getByText('固定显示 v1', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.reload();
  await assertVersion(1);

  // Returning to the cached bare route must pick up an iteration made elsewhere.
  update(3);
  await page.goBack();
  await assertVersion(3);
  assert.equal(page.url(), latestUrl);
  await page.goForward();
  await assertVersion(1);
  await chooseVersion('latest');
  await assertVersion(3);
  assert.equal(page.url(), latestUrl, 'latest removes only the version parameter');
});

test('an explicit resource version remains pinned when newer versions arrive', { timeout: 20_000 }, async t => {
  const { page, path: detailPath, assertVersion, chooseVersion, update } = await versionedResourcePage(t);
  await page.goto(origin + detailPath + '?version=2');
  await assertVersion(2);
  update(3);
  await page.reload();
  await assertVersion(2);
  assert.equal(new URL(page.url()).searchParams.get('version'), '2');
  await chooseVersion('latest');
  await assertVersion(3);
  assert.equal(new URL(page.url()).searchParams.has('version'), false);
  await chooseVersion(3);
  await assertVersion(3);
  assert.equal(new URL(page.url()).searchParams.get('version'), '3', 'the current version can also be pinned');
});

test('invalid and missing resource versions show an error and can return to latest', { timeout: 30_000 }, async t => {
  const { page, path: detailPath, assertVersion } = await versionedResourcePage(t);
  for (const invalid of ['', '0', '-1', '1.5', 'abc', '9007199254740993']) {
    await page.goto(origin + detailPath + '?version=' + invalid);
    await page.getByRole('heading', { name: '版本参数无效', exact: true }).waitFor();
    assert.equal(await page.getByRole('img', { name: resource.name, exact: true }).count(), 0);
  }
  await page.goto(origin + detailPath + '?version=99&source=test');
  await page.getByRole('heading', { name: '版本不存在', exact: true }).waitFor();
  assert.equal(await page.getByRole('img', { name: resource.name, exact: true }).count(), 0);
  await page.getByRole('button', { name: '查看最新版', exact: true }).click();
  await assertVersion(2);
  assert.equal(page.url(), origin + detailPath + '?source=test');
});

async function versionedShowPage(t) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'uncaught browser errors'));
  const records = [1, 2, 3].map(no => ({
    ...show, id: no === 1 ? 1 : no * 100 + 1, name: `放映 v${no}`, version_no: no, change_note: `版本 ${no}`,
    resources: Array.from({ length: no === 1 ? 1 : 2 }, (_, index) => ({
      ...show.resources[index], name: `版本 ${no} 第 ${index + 1} 页`, version_no: no,
      preview_url: `/fixture.png?showVersion=${no}&page=${index + 1}`,
      original_preview_url: `/fixture.png?showVersion=${no}&page=${index + 1}`,
    })),
  }));
  let current = 2;
  await context.route(url => /^\/api\/shows\/\d+(?:\/.*)?$/.test(url.pathname), route => {
    const url = new URL(route.request().url());
    calls.push({ path: url.pathname, version: url.searchParams.get('version') });
    const recordId = Number(url.pathname.split('/')[3]);
    if (url.pathname.endsWith('/versions')) return route.fulfill({ json: {
      versions: records.slice(0, current).map(record => ({ ...record, resource_count: record.resources.length })),
      current_version_no: records.find(record => record.id === recordId)?.version_no,
    } });
    if (url.pathname.includes('/remarks/')) return route.fulfill({ json: { content_html: `<p>放映记录 ${recordId} 的备注</p>` } });
    if (/^\/api\/shows\/\d+$/.test(url.pathname)) {
      const selected = url.searchParams.get('version');
      const record = selected === 'latest' ? records[current - 1]
        : selected !== null ? records.slice(0, current).find(record => record.version_no === Number(selected))
          : records.find(record => record.id === recordId);
      if (!record) return route.fulfill({ status: 404, json: { detail: '放映版本不存在或已删除' } });
      return route.fulfill({ json: { show: { ...record, latest_version_no: current, version_count: current, has_other_versions: true } } });
    }
    return route.fulfill({ json: { items: [], updates: [] } });
  });
  await context.route(url => /^\/api\/resources\/\d+$/.test(url.pathname), route => route.fulfill({ json: {
    resource: { ...resource, current: version, versions: [1, 2, 3].map(no => ({ ...version, id: no * 10 + 1, version_no: no })) },
  } }));
  const assertVersion = async no => {
    await page.getByRole('heading', { name: `放映 v${no}`, exact: true }).waitFor();
    await page.waitForFunction(no => document.querySelector('main img')?.getAttribute('src') === `/fixture.png?showVersion=${no}&page=1`, no);
    await page.getByRole('combobox', { name: '切换放映版本' }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="切换放映版本"]')?.textContent?.includes('v'));
  };
  const chooseVersion = async no => {
    await page.getByRole('combobox', { name: '切换放映版本' }).click();
    await page.getByRole('option', { name: no === 'latest' ? /^最新版/ : new RegExp(`^v${no}(?:（| ·)`) }).click();
  };
  return { page, calls, assertVersion, chooseVersion, update: no => { current = no; } };
}

test('show detail keeps a stable address and restores URL versions through reload and history', { timeout: 30_000 }, async t => {
  const { page, calls, assertVersion, chooseVersion, update } = await versionedShowPage(t);
  const latestUrl = origin + '/shows/1?source=test#preview';
  await page.goto(latestUrl);
  await assertVersion(2);
  assert.equal(page.url(), latestUrl);
  await page.getByRole('button', { name: '第 2 页：版本 2 第 2 页', exact: true }).click();
  await chooseVersion(1);
  await assertVersion(1);
  assert.equal(page.url(), origin + '/shows/1?source=test&version=1#preview');
  await page.getByRole('button', { name: '分享', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '放映页面地址', exact: true }).inputValue(), page.url());
  await page.getByText('固定显示 v1', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.reload();
  await assertVersion(1);
  update(3);
  await page.goBack();
  await assertVersion(3);
  assert.equal(page.url(), latestUrl);
  await page.goForward();
  await assertVersion(1);
  await chooseVersion('latest');
  await assertVersion(3);
  assert.equal(page.url(), latestUrl);
  assert.ok(calls.some(call => call.path === '/api/shows/301/check-updates'), 'update checks use the displayed record');
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: '放映', exact: true }).click();
  const popup = await popupPromise;
  assert.equal(new URL(popup.url()).pathname, '/shows/301/fullscreen', 'playback pins the displayed version');
  await popup.close();
});

test('explicit show versions stay pinned across iterations and support anchors from any version', { timeout: 20_000 }, async t => {
  const { page, assertVersion, chooseVersion, update } = await versionedShowPage(t);
  await page.goto(origin + '/shows/1?version=2');
  await assertVersion(2);
  update(3);
  await page.reload();
  await assertVersion(2);
  assert.equal(new URL(page.url()).searchParams.get('version'), '2');
  await chooseVersion('latest');
  await assertVersion(3);
  assert.equal(page.url(), origin + '/shows/1');
  await chooseVersion(3);
  assert.equal(page.url(), origin + '/shows/1?version=3');
  await page.goto(origin + '/shows/301?version=1');
  await assertVersion(1);
  await chooseVersion('latest');
  await assertVersion(3);
  assert.equal(page.url(), origin + '/shows/301');
});

test('invalid and missing show versions show an error and can return to latest', { timeout: 20_000 }, async t => {
  const { page, assertVersion } = await versionedShowPage(t);
  for (const invalid of ['', '0', '-1', '1.5', 'abc', '9007199254740993']) {
    await page.goto(origin + '/shows/1?version=' + invalid);
    await page.getByRole('heading', { name: '版本参数无效', exact: true }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: '切换放映版本' }).count(), 0);
  }
  await page.goto(origin + '/shows/1?version=99&source=test');
  await page.getByRole('heading', { name: '版本不存在', exact: true }).waitFor();
  await page.getByRole('button', { name: '查看最新版', exact: true }).click();
  await assertVersion(2);
  assert.equal(page.url(), origin + '/shows/1?source=test');
});

const encodeListState = state => Buffer.from(JSON.stringify(state)).toString('base64url');

for (const viewport of [{ width: 1360, height: 960 }, { width: 390, height: 844 }]) {
  test(`resource detail switches in the same frame at ${viewport.width}px`, { timeout: 30_000 }, async t => {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    const resources = [1, 2, 3].map(id => {
      const versions = [1, 2].map(no => ({ ...version, id: id * 10 + no, version_no: no, common_remark_html: `<p>素材 ${id} 版本 ${no}</p>` }));
      return {
        ...resource, id, detail_token: `neighbor-resource-${id}`.padEnd(32, 'a'),
        name: id === 2 ? '客户介绍二：这是一个很长的标题用于检查切换时框架和按钮不会移动'.repeat(3) : `客户介绍${id}`,
        tags: id === 2 ? Array.from({ length: 20 }, (_, i) => `分类标签${i}`).join(',') : '精选',
        can_manage: id !== 2, current_version: 2, current: versions[1], versions,
      };
    });
    let releaseSecond;
    const secondGate = new Promise(resolve => { releaseSecond = resolve; });
    let requestedSecond = false;
    let failThird = true;
    const neighborCalls = [];
    await page.route(url => url.pathname === '/api/resources', route => route.fulfill({ json: { ...list(resources), total: 100, page: 3 } }));
    await page.route('**/api/resources/by-key/*', async route => {
      const item = resources.find(item => route.request().url().includes(item.detail_token));
      if (item?.id === 2) { requestedSecond = true; await secondGate; }
      if (item?.id === 3 && failThird) { failThird = false; return route.fulfill({ status: 504, json: { detail: 'timeout' } }); }
      return route.fulfill({ json: { resource: item } });
    });
    await page.route('**/api/resources/*/neighbors*', route => {
      const url = new URL(route.request().url());
      const index = Number(url.pathname.split('/')[3]) - 1;
      neighborCalls.push(Object.fromEntries(url.searchParams));
      return route.fulfill({ json: { previous: resources[index - 1] ?? null, next: resources[index + 1] ?? null, position: index + 1, total: resources.length } });
    });
    const listUrl = origin + '/resources?s=' + encodeListState({ q: '客户', sub: '产品介绍', sta: 'active', tags: ['精选'], tm: 'all', sort: 'name_asc', p: 3, view: 'list' });
    await page.goto(listUrl);
    await page.locator('[data-list-scroll="results"]').getByRole('button', { name: resources[0].name, exact: true }).click();
    const card = page.getByRole('region', { name: '素材预览' });
    const nav = page.getByRole('navigation', { name: '素材切换' });
    const previous = nav.getByRole('button', { name: '上一个素材', exact: true });
    const next = nav.getByRole('button', { name: '下一个素材', exact: true });
    await next.and(page.locator(':enabled')).waitFor();
    assert.equal(await previous.isDisabled(), true);
    await page.getByRole('combobox', { name: '切换版本' }).click();
    await page.getByRole('option', { name: /^v1/ }).click();
    await page.waitForURL(url => url.searchParams.get('version') === '1');
    await page.getByText('已固定到 v1，切换至最新版可自动跟随更新', { exact: true }).waitFor();
    await next.and(page.locator(':enabled')).waitFor();
    const originalCard = await card.boundingBox();
    const originalNext = await next.boundingBox();
    const originalNav = await nav.elementHandle();
    await next.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="素材预览"]')?.getAttribute('aria-busy') === 'true');
    assert.equal(requestedSecond, true);
    assert.equal(await next.isDisabled(), true);
    assert.equal(await page.getByRole('heading', { name: resources[0].name, exact: true }).count(), 1);
    assert.deepEqual(await next.boundingBox(), originalNext, 'button must stay put while loading');
    releaseSecond();
    await page.waitForURL(url => url.pathname.endsWith(resources[1].detail_token));
    await next.and(page.locator(':enabled')).waitFor();
    assert.equal(new URL(page.url()).searchParams.has('version'), false, 'new material opens its latest version');
    assert.equal(await originalNav.evaluate(element => element.isConnected), true, 'detail frame must not remount');
    assert.deepEqual(await card.boundingBox(), originalCard, 'long titles, tags and permission changes must not move the preview');
    assert.deepEqual(await next.boundingBox(), originalNext);
    if (process.env.REVIEW_SCREENSHOTS) {
      await mkdir(process.env.REVIEW_SCREENSHOTS, { recursive: true });
      await card.screenshot({ path: path.join(process.env.REVIEW_SCREENSHOTS, `${viewport.width}-resource-navigation.png`) });
    }
    await next.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="素材预览"]')?.getAttribute('aria-busy') === 'false');
    assert.equal(new URL(page.url()).pathname.endsWith(resources[1].detail_token), true, 'failed navigation keeps the current resource');
    assert.deepEqual(await next.boundingBox(), originalNext);
    await next.click();
    await page.waitForURL(url => url.pathname.endsWith(resources[2].detail_token));
    await nav.getByText('3 / 3', { exact: true }).waitFor();
    assert.equal(await next.isDisabled(), true);
    assert.deepEqual(await card.boundingBox(), originalCard);
    await previous.click();
    await page.waitForURL(url => url.pathname.endsWith(resources[1].detail_token));
    await page.reload();
    await nav.getByText('2 / 3', { exact: true }).waitFor();
    assert.ok(neighborCalls.length >= 4);
    for (const params of neighborCalls) {
      assert.equal(params.search, '客户');
      assert.equal(params.subject, '产品介绍');
      assert.equal(params.status, 'active');
      assert.equal(params.tags, '精选');
      assert.equal(params.tags_mode, 'all');
      assert.equal(params.sort, 'name_asc');
      assert.equal(params.page, undefined, 'navigation is not limited to the visible list page');
    }
    await page.getByRole('button', { name: '返回素材库', exact: true }).click();
    await page.waitForURL(listUrl);
  });
}

async function pagedDetailList(page, kind, detailPath) {
  const model = kind === 'resource' ? resource : show;
  const calls = [];
  await page.route(url => url.pathname === `/api/${kind === 'resource' ? 'resources' : 'shows'}`, route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    calls.push(query);
    const count = Number(query.page_size) || 6;
    const items = Array.from({ length: count }, (_, index) => ({
      ...model,
      id: index === count - 1 ? 1 : index + 10,
      name: index === count - 1 ? model.name : `${model.name} ${index + 1}`,
      detail_token: detailPath.split('/').at(-1),
    }));
    return route.fulfill({ json: { ...list(items), total: 300, page: Number(query.page), page_size: count } });
  });
  return calls;
}

for (const { route, kind, view } of [
  { route: '/resources', kind: 'resource', view: 'card' },
  { route: '/resources', kind: 'resource', view: 'list' },
  { route: '/manage/resources', kind: 'resource', view: 'list' },
  { route: '/manage/shows', kind: 'show', view: 'card' },
  { route: '/manage/shows', kind: 'show', view: 'list' },
  { route: '/shows', kind: 'show', view: 'card' },
]) {
  test(`${route} ${view} returns to its page, filters and scroll after detail versions and reload`, { timeout: 30_000 }, async t => {
    const fixture = await (kind === 'resource' ? versionedResourcePage(t) : versionedShowPage(t));
    const { page, chooseVersion, assertVersion } = fixture;
    await page.setViewportSize({ width: 390, height: 480 });
    const detailPath = fixture.path ?? '/shows/1';
    const calls = await pagedDetailList(page, kind, detailPath);
    const state = { q: '客户', sub: '产品介绍', sta: 'active', tags: ['精选'], tm: 'any', p: 3, view };
    const listUrl = origin + route + '?s=' + encodeListState(state) + '&source=catalog#results';
    const title = kind === 'resource' ? resource.name : show.name;
    const target = () => page.locator('[data-list-scroll="results"]').getByText(title, { exact: true });
    const assertReturned = async scroll => {
      await page.waitForURL(listUrl);
      await target().waitFor();
      assert.equal(page.url(), listUrl);
      assert.equal(await page.getByPlaceholder(route === '/manage/resources' ? '搜索名称、主体、所有者、ID' : '搜索标题、关键词', { exact: true }).inputValue(), '客户');
      await page.getByText(/^3 \/ \d+$/).waitFor();
      await page.waitForFunction(scroll => document.querySelector('[data-list-scroll="results"]')?.scrollTop === scroll, scroll);
      const latest = calls.filter(call => call.search === '客户').at(-1);
      assert.equal(latest.page, '3');
      assert.equal(latest.search, '客户');
      assert.equal(latest.subject, '产品介绍');
      assert.equal(latest.status, 'active');
      assert.equal(latest.tags, '精选');
    };
    await page.goto(listUrl);
    await target().click(); // The last item also scrolls the list before navigation.
    await assertVersion(2);
    const originalScroll = await page.evaluate(() => history.state.usr.detailOrigin.scroll.results.top);
    assert.ok(originalScroll > 0, 'fixture must exercise a scrolled list');
    await page.reload();
    await assertVersion(2);
    await page.goBack();
    await assertReturned(originalScroll);
    await target().click();
    await assertVersion(2);
    await chooseVersion(1);
    await assertVersion(1);
    await chooseVersion('latest');
    await assertVersion(2);
    await chooseVersion(1);
    await page.reload();
    await assertVersion(1);
    await page.getByRole('button', { name: kind === 'resource' ? '返回素材库' : '返回放映库', exact: true }).click();
    await assertReturned(originalScroll);
  });
}

test('recommended resource details retain the original filtered list', { timeout: 20_000 }, async t => {
  const { page, path: detailPath, assertVersion, chooseVersion } = await versionedResourcePage(t);
  await pagedDetailList(page, 'resource', detailPath);
  const listUrl = origin + '/resources?s=' + encodeListState({ q: '客户', sub: 'all', sta: 'all', tags: [], tm: 'all', p: 4, view: 'card' });
  await page.goto(listUrl);
  await page.locator('article').getByText(resource.name, { exact: true }).click();
  await assertVersion(2);
  await chooseVersion(1);
  await page.locator(`a[href="${detailPath}"]`).first().click();
  await assertVersion(2);
  await page.reload();
  await assertVersion(2);
  await page.getByRole('button', { name: '返回素材库', exact: true }).click();
  await page.waitForURL(listUrl);
  await page.getByText(/^4 \/ \d+$/).waitFor();
});

test('a resource loading error returns to its original list', { timeout: 20_000 }, async t => {
  const { page, path: detailPath } = await versionedResourcePage(t);
  await pagedDetailList(page, 'resource', detailPath);
  await page.route('**/api/resources/by-key/*', route => route.fulfill({ status: 404, json: { detail: '素材不存在' } }));
  const listUrl = origin + '/resources?s=' + encodeListState({ q: '客户', sub: 'all', sta: 'all', tags: [], tm: 'all', p: 3, view: 'card' });
  await page.goto(listUrl);
  await page.locator('article').getByText(resource.name, { exact: true }).click();
  await page.getByRole('heading', { name: '素材不存在', exact: true }).waitFor();
  await page.getByRole('button', { name: '返回素材库', exact: true }).click();
  await page.waitForURL(listUrl);
  await page.getByText(/^3 \/ \d+$/).waitFor();
});

for (const entry of ['detail', 'list']) {
  test(`show iteration entered from ${entry} retains the original list`, { timeout: 20_000 }, async t => {
    const { page, assertVersion } = await versionedShowPage(t);
    await pagedDetailList(page, 'show', '/shows/1');
    const listUrl = origin + '/manage/shows?s=' + encodeListState({ q: '客户', sub: 'all', sta: 'all', tags: [], tm: 'all', p: 3, view: 'card' });
    await page.goto(listUrl);
    const card = page.locator('article').filter({ has: page.getByText(show.name, { exact: true }) });
    if (entry === 'detail') {
      await card.click();
      await assertVersion(2);
      await page.getByRole('button', { name: '版本迭代', exact: true }).click();
    } else {
      await card.getByRole('button', { name: '更多操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '版本迭代', exact: true }).click();
    }
    await page.getByRole('heading', { name: '版本迭代', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: '返回放映详情', exact: true }).click();
    await assertVersion(2);
    await page.getByRole('button', { name: '返回放映库', exact: true }).click();
    await page.waitForURL(listUrl);
    await page.getByText(/^3 \/ \d+$/).waitFor();
  });
}

for (const kind of ['resource', 'show']) {
  test(`pinned ${kind} details return to the scrolled home page`, { timeout: 20_000 }, async t => {
    const fixture = await (kind === 'resource' ? versionedResourcePage(t) : versionedShowPage(t));
    const { page, assertVersion, chooseVersion } = fixture;
    await page.setViewportSize({ width: 390, height: 600 });
    const token = fixture.path?.split('/').at(-1);
    await page.route(url => url.pathname === '/api/me/pins', route => route.fulfill({ json: {
      shows: [show], resources: [{ ...resource, detail_token: token ?? resource.detail_token }],
    } }));
    await page.goto(origin + '/home');
    await page.locator('article').getByText(kind === 'resource' ? resource.name : show.name, { exact: true }).click();
    await assertVersion(2);
    const scroll = await page.evaluate(() => history.state.usr.detailOrigin.scroll);
    assert.ok(scroll.results.top > 0 || scroll.app.top > 0, 'fixture must exercise home scrolling');
    await chooseVersion(1);
    await page.reload();
    await assertVersion(1);
    await page.getByRole('button', { name: kind === 'resource' ? '返回素材库' : '返回放映库', exact: true }).click();
    await page.waitForURL(origin + '/home');
    await page.getByRole('heading', { name: '我的置顶', exact: true }).waitFor();
    await page.waitForFunction(scroll => ['app', 'results'].every(key => document.querySelector(`[data-list-scroll="${key}"]`)?.scrollTop === scroll[key].top), scroll);
  });

  test(`direct ${kind} links return to their library without an origin`, { timeout: 20_000 }, async t => {
    const fixture = await (kind === 'resource' ? versionedResourcePage(t) : versionedShowPage(t));
    const { page, assertVersion, chooseVersion } = fixture;
    await page.goto(origin + (fixture.path ?? '/shows/1'));
    await assertVersion(2);
    await chooseVersion(1);
    await page.getByRole('button', { name: kind === 'resource' ? '返回素材库' : '返回放映库', exact: true }).click();
    await page.waitForURL(origin + (kind === 'resource' ? '/resources' : '/manage/shows'));
  });
}

for (const { name, html, expected } of [
  {
    name: 'decode nested entities only once',
    html: '<p>&amp;lt; &amp;gt; &amp;quot; &amp;#39; &amp;apos; &amp;nbsp; &amp;#160; &amp;#xA0; &amp;amp;lt;</p>',
    expected: '&lt; &gt; &quot; &#39; &apos; &nbsp; &#160; &#xA0; &amp;lt;',
  },
  {
    name: 'preserve ordinary entities and whitespace normalization',
    html: '<p> A&nbsp;&#160;&#xA0;B<br/>C </p><div>&amp; &lt; &gt; &quot; &#39; &apos;</div><ul><li>D</li><li>E</li></ul>',
    expected: 'A B C & < > " \' \' D E',
  },
  {
    name: 'keep decoded markup and unknown entities as text',
    html: '<p>&lt;b&gt;正文&lt;/b&gt; &unknown; &amp;unknown; &AMP;LT; &LT;</p>',
    expected: '<b>正文</b> &unknown; &unknown; &LT; <',
  },
  {
    name: 'retain empty remark placeholders',
    html: '<p>&nbsp;&#160;&#xA0; <br/></p>',
    expected: '',
  },
]) {
  test(`resource remark previews ${name}`, { timeout: 15_000 }, async t => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const detailToken = 'remark-preview-'.padEnd(32, 'a');
    const remarkVersion = { ...version, common_remark_html: html };
    await page.route('**/api/resources/by-key/*', route => route.fulfill({ json: {
      resource: { ...resource, detail_token: detailToken, current: remarkVersion, versions: [remarkVersion] },
    } }));
    await page.route('**/api/resources/1/personal-remark*', route => route.fulfill({ json: { content_html: html, version_id: version.id } }));
    await page.goto(origin + '/resources/' + detailToken);
    await page.waitForLoadState('networkidle');
    for (const label of ['通用备注', '个人备注']) {
      const preview = page.getByRole('button', { name: new RegExp(label) }).locator('span.line-clamp-3');
      assert.equal(await preview.textContent(), expected || `暂无${label}`, label);
      assert.equal(await preview.locator('*').count(), 0, `${label} must render plain text`);
    }
  });
}

const routes = ['/home', '/resources', '/resources/review-resource', '/shows', '/shows/1', '/shows/1/iterate', '/manage/shows', '/manage/shows/new', '/manage/resources', '/manage/shares', '/manage/tasks', '/manage/offline-cache', '/manage/tags', '/admin/users', '/templates', '/fonts'];
for (const width of [1440, 390, 320]) {
  test(`production pages remain usable at ${width}px`, { timeout: 90_000 }, async t => {
    const context = await browser.newContext({ viewport: { width, height: width > 500 ? 1000 : 844 }, serviceWorkers: 'block' });
    t.after(() => context.close()); const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const route of routes) {
      await page.goto(origin + route);
      await page.waitForLoadState('networkidle');
      assert.equal(await page.getByText('页面加载失败', { exact: true }).count(), 0, route);
      assert.equal(errors.length, 0, `${route}: ${errors.join('; ')}`);
      const layout = await page.evaluate(() => {
        const main = document.querySelector('main');
        return { body: document.documentElement.scrollWidth, viewport: innerWidth, main: main?.clientWidth, content: main?.scrollWidth };
      });
      assert.ok(layout.body <= width + 1, `${route}: document overflow ${JSON.stringify(layout)}`);
      assert.ok(!layout.main || layout.content <= layout.main + 1, `${route}: main content clipped ${JSON.stringify(layout)}`);
      if (process.env.REVIEW_SCREENSHOTS && ['/home', '/shows/1', '/resources/review-resource', '/shows/1/iterate'].includes(route)) {
        await mkdir(process.env.REVIEW_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.REVIEW_SCREENSHOTS, `${width}-${route.replaceAll('/', '-')}.png`) });
      }
    }
  });
}

for (const width of [1440, 390, 320]) {
  test(`show thumbnail arrows scroll independently of the preview at ${width}px`, { timeout: 30_000 }, async t => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block', reducedMotion: width === 320 ? 'reduce' : 'no-preference' });
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const resources = Array.from({ length: 24 }, (_, index) => ({
      ...show.resources[0], id: index + 1, name: `介绍第 ${index + 1} 页`,
      preview_url: `/fixture.png?slide=${index + 1}`, original_preview_url: `/fixture.png?slide=${index + 1}`,
    }));
    await page.route(url => url.pathname === '/api/shows/1', route => route.fulfill({ json: { show: { ...show, resources } } }));
    await page.route('**/fixture.png?slide=*', route => {
      const number = Number(new URL(route.request().url()).searchParams.get('slide'));
      const dark = number % 3 === 1;
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="${dark ? '#24364f' : '#f1f4f8'}"/><circle cx="1090" cy="210" r="250" fill="${dark ? '#304763' : '#e1e8f0'}"/><rect x="96" y="230" width="64" height="8" rx="4" fill="#7596ba"/><text x="96" y="180" font-family="sans-serif" font-size="24" letter-spacing="5" fill="#7596ba">SLIDE FLOW</text><text x="96" y="350" font-family="sans-serif" font-size="62" fill="${dark ? '#ffffff' : '#24364f'}">客户介绍 · ${String(number).padStart(2, '0')}</text><text x="96" y="420" font-family="sans-serif" font-size="26" fill="#8597ad">产品与解决方案</text></svg>` });
    });
    await page.goto(origin + '/shows/1');
    const navigation = page.getByRole('navigation', { name: '放映页面导航' });
    const rail = navigation.getByRole('group', { name: '页面缩略图' });
    const left = navigation.getByRole('button', { name: '向左滚动缩略图' });
    const right = navigation.getByRole('button', { name: '向右滚动缩略图' });
    const preview = navigation.locator('..').locator('img').first();
    await rail.waitFor();
    await page.locator('button[aria-label="向右滚动缩略图"]:enabled').waitFor();
    const firstPreview = await preview.getAttribute('src');
    assert.equal(await left.isDisabled(), true);
    await right.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="页面缩略图"]').scrollLeft > 10);
    assert.equal(await preview.getAttribute('src'), firstPreview, 'scrolling right must not change the preview');
    assert.equal(await rail.getByRole('button', { pressed: true }).getAttribute('aria-label'), '第 1 页：介绍第 1 页');

    // Native scrolling and arrow scrolling must share the same boundary state.
    await rail.evaluate(element => element.scrollTo({ left: element.scrollWidth, behavior: 'instant' }));
    await page.locator('button[aria-label="向右滚动缩略图"]:disabled').waitFor();
    assert.equal(await left.isDisabled(), false);
    const end = await rail.evaluate(element => element.scrollLeft);
    await left.click();
    await page.waitForFunction(end => document.querySelector('[aria-label="页面缩略图"]').scrollLeft < end - 10, end);
    assert.equal(await preview.getAttribute('src'), firstPreview, 'scrolling left must not change the preview');

    await rail.evaluate(element => element.scrollTo({ left: element.scrollWidth, behavior: 'instant' }));
    await rail.getByRole('button', { name: '第 24 页：介绍第 24 页', exact: true }).click();
    assert.equal(await preview.getAttribute('src'), '/fixture.png?slide=24');
    await navigation.getByRole('button', { name: '全部页面', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '全部页面', exact: true });
    await dialog.getByRole('button', { name: '第 12 页：介绍第 12 页', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await preview.getAttribute('src'), '/fixture.png?slide=12');
    const selection = await rail.evaluate(element => {
      const container = element.getBoundingClientRect();
      const selected = element.querySelector('[aria-pressed="true"]').getBoundingClientRect();
      return { left: selected.left - container.left, right: container.right - selected.right };
    });
    assert.ok(selection.left >= -1 && selection.right >= -1, `the selected thumbnail must be visible: ${JSON.stringify(selection)}`);
    const beforeWheel = await rail.evaluate(element => element.scrollLeft);
    await rail.hover();
    await page.mouse.wheel(160, 0);
    await page.waitForFunction(previous => document.querySelector('[aria-label="页面缩略图"]').scrollLeft > previous + 10, beforeWheel);
    assert.equal(await preview.getAttribute('src'), '/fixture.png?slide=12', 'horizontal wheel scrolling must not change the preview');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'the rail must not widen the page');
    if (process.env.REVIEW_SCREENSHOTS) {
      await mkdir(process.env.REVIEW_SCREENSHOTS, { recursive: true });
      await navigation.locator('..').screenshot({ path: path.join(process.env.REVIEW_SCREENSHOTS, `${width}-show-page-rail.png`) });
    }
  });
}

test('show thumbnail arrows reflect overflow after resizing and handle an empty show', { timeout: 15_000 }, async t => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(origin + '/shows/1');
  const navigation = page.getByRole('navigation', { name: '放映页面导航' });
  await navigation.waitFor();
  assert.equal(await navigation.getByRole('button', { name: '向左滚动缩略图' }).isDisabled(), true);
  assert.equal(await navigation.getByRole('button', { name: '向右滚动缩略图' }).isDisabled(), true);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.locator('button[aria-label="向右滚动缩略图"]:enabled').waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('button[aria-label="向右滚动缩略图"]:disabled').waitFor();
  await page.route(url => url.pathname === '/api/shows/1', route => route.fulfill({ json: { show: { ...show, resources: [] } } }));
  await page.reload();
  await page.getByText('暂无放映页面', { exact: true }).waitFor();
  assert.equal(await navigation.count(), 0);
});

test('show deletion supports keyboard cancellation and prevents repeat submits', { timeout: 30_000 }, async t => {
  const context = await browser.newContext({ serviceWorkers: 'block' }); t.after(() => context.close());
  const page = await context.newPage(); page.setDefaultTimeout(5000); await page.goto(origin + '/manage/shows'); await page.waitForLoadState('networkidle');
  const menuButton = page.getByRole('button', { name: '更多操作', exact: true }).first();
  await menuButton.click(); await page.getByRole('menuitem', { name: /删除/ }).click();
  const dialog = page.getByRole('dialog', { name: '删除放映', exact: true }); await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '取消');
await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert.equal(requests.filter(r => r.method === 'DELETE').length, 0);
  await page.waitForTimeout(500);
  await menuButton.click(); await page.getByRole('menuitem', { name: /删除/ }).click();
  deletionDelay = 650;
  await dialog.getByRole('button', { name: '删除放映', exact: true }).click();
  assert.equal(await dialog.getByRole('button', { name: '处理中…' }).isDisabled(), true);
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(requests.filter(r => r.method === 'DELETE').length, 1);
});

const importKey = id => `import-material-${id}-`.padEnd(32, 'a');
const importMaterial = id => ({ ...resource, id, detail_token: importKey(id), name: `网址素材 ${id}` });
const pickerMaterial = id => ({ ...importMaterial(id), preview_url: '/fixture.png' });

async function showUrlImportPage(t, width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  t.after(() => context.close());
  await context.addInitScript(draft => {
    if (!localStorage.getItem('slide-flow.show-create-draft.1')) {
      localStorage.setItem('slide-flow.show-create-draft.1', JSON.stringify(draft));
    }
  }, { form: { name: '网址导入放映', status: 'active' }, step: 1, resourceIds: [9], resources: [pickerMaterial(9)], savedAt: stamp });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [], lookups = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'uncaught browser errors'));
  await page.route('**/api/resources/ids', route => route.fulfill({ json: { ids: [1, 2, 3, 4, 5, 6, 9] } }));
  await page.route('**/api/resources/pick?*', route => route.fulfill({ json: list([pickerMaterial(1)]) }));
  await page.route('**/api/resources/by-key/*', async route => {
    const key = new URL(route.request().url()).pathname.split('/').at(-1);
    lookups.push(key);
    const id = [1, 2, 3, 4, 5, 6].find(id => importKey(id) === key);
    if (id === 3) await new Promise(resolve => setTimeout(resolve, 150));
    return id ? route.fulfill({ json: { resource: importMaterial(id) } })
      : route.fulfill({ status: key === importKey(7) ? 403 : 404, json: { detail: '素材不可用' } });
  });
  await page.goto(origin + '/manage/shows/new');
  await page.getByRole('heading', { name: '选择单页素材', exact: true }).waitFor();
  return { page, lookups };
}

test('show URL import accepts mixed separators, preserves selection order and restores off-page metadata', async t => {
  const { page, lookups } = await showUrlImportPage(t);
  const url = id => `${origin}/resources/${importKey(id)}`;
  await page.getByRole('button', { name: '网址导入', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '网址导入', exact: true });
  const input = dialog.getByRole('textbox', { name: '单页素材网址', exact: true });
  await input.fill(`  ${url(3)}\r\n${url(1)}, ${url(2)};${url(4)}，${url(5)}；/resources/${importKey(6)}\n${url(3)}?version=1#preview,${url(1)}  `);
  await dialog.getByRole('button', { name: '导入并选中', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const selected = page.locator('[data-selected-resource-id]');
  assert.deepEqual(await selected.evaluateAll(items => items.map(item => Number(item.dataset.selectedResourceId))), [9, 3, 1, 2, 4, 5, 6]);
  for (const id of [9, 3, 1, 2, 4, 5, 6]) {
    const item = page.locator(`[data-selected-resource-id="${id}"]`);
    assert.ok((await item.textContent()).includes(`网址素材 ${id}`));
    assert.equal(await item.locator('img').getAttribute('src'), '/fixture.png');
  }
  assert.deepEqual(lookups.sort(), [1, 2, 3, 4, 5, 6].map(importKey).sort(), 'each material is fetched once');
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  assert.equal(await page.getByRole('checkbox', { name: '选择素材 网址素材 1', exact: true }).isChecked(), true);
  await page.getByRole('button', { name: '暂存', exact: true }).click();
  await page.reload();
  await page.locator('[data-selected-resource-id="3"]').getByText('网址素材 3', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('[data-selected-resource-id="3"] img').getAttribute('src'), '/fixture.png');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  assert.deepEqual(await page.locator('[data-sort-resource-id]').evaluateAll(items => items.map(item => Number(item.dataset.sortResourceId))), [9, 3, 1, 2, 4, 5, 6]);
});

test('show URL import keeps failed addresses visible and selects only accessible materials on mobile', async t => {
  const { page, lookups } = await showUrlImportPage(t, 390);
  await page.getByRole('button', { name: '网址导入', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '网址导入', exact: true });
  await dialog.getByRole('textbox', { name: '单页素材网址', exact: true }).fill([
    `${origin}/resources/${importKey(2)}`, `${origin}/resources/${importKey(7)}`,
    `${origin}/resources/${importKey(8)}`, `https://other.example/resources/${importKey(1)}`,
    'javascript:alert(1)', `${origin}/manage/shows/new`,
  ].join('\n'));
  await dialog.getByRole('button', { name: '导入并选中', exact: true }).click();
  await dialog.getByText('已选中', { exact: true }).waitFor();
  assert.equal(await dialog.getByText('素材不存在或当前账号无权查看', { exact: true }).count(), 2);
  assert.equal(await dialog.getByText('请使用本站单页素材的页面网址', { exact: true }).count(), 3);
  assert.deepEqual(lookups.sort(), [2, 7, 8].map(importKey).sort());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.REVIEW_SCREENSHOTS) {
    await mkdir(process.env.REVIEW_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.REVIEW_SCREENSHOTS, 'show-url-import-mobile.png') });
  }
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  assert.deepEqual(await page.locator('[data-selected-resource-id]').evaluateAll(items => items.map(item => Number(item.dataset.selectedResourceId))), [9, 2]);
});

test('closing show URL import cancels a pending lookup without changing selection', async t => {
  const { page, lookups } = await showUrlImportPage(t);
  await page.getByRole('button', { name: '网址导入', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '网址导入', exact: true });
  await dialog.getByRole('textbox', { name: '单页素材网址', exact: true }).fill(`${origin}/resources/${importKey(3)}`);
  const pending = page.waitForRequest(request => new URL(request.url()).pathname.endsWith(importKey(3)));
  await dialog.getByRole('button', { name: '导入并选中', exact: true }).click();
  await pending;
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForTimeout(250);
  assert.deepEqual(lookups, [importKey(3)]);
  assert.deepEqual(await page.locator('[data-selected-resource-id]').evaluateAll(items => items.map(item => Number(item.dataset.selectedResourceId))), [9]);
  await page.getByRole('button', { name: '网址导入', exact: true }).click();
  assert.equal(await dialog.getByRole('textbox', { name: '单页素材网址', exact: true }).inputValue(), '');
});

const longTableText = '超长名称用于验证表格固定列宽及完整内容展示'.repeat(5);
const longTableTags = ['短标签', '没有分隔符的超长标签'.repeat(12), '销售部', '方案组', '华东区', '内部用户'];
const tableWidths = page => page.locator('table:visible thead th').evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width));

async function assertTableContentFits(page, route) {
  const overflow = await page.locator('table:visible tbody td').evaluateAll(cells => cells.flatMap(cell => {
    const bounds = cell.getBoundingClientRect();
    return [...cell.querySelectorAll('button, [role="checkbox"], .truncate')].filter(element => {
      if (!element.getClientRects().length) return false;
      const rect = element.getBoundingClientRect();
      return rect.right > bounds.right + 1 || rect.left < bounds.left - 1;
    }).map(element => element.textContent || element.getAttribute('aria-label'));
  }));
  assert.deepEqual(overflow, [], `${route}: controls and text must stay inside their columns`);
  assert.equal(await page.locator('table:visible').evaluate(table => getComputedStyle(table).tableLayout), 'fixed');
}

test('fixed tables: user pagination preserves column widths and exposes all truncated content', { timeout: 30_000 }, async t => {
  const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.route('**/api/admin/users?*', route => {
    const secondPage = new URL(route.request().url()).searchParams.get('page') === '2';
    const record = { ...user, id: secondPage ? 21 : 2, role: 'user', name: secondPage ? longTableText : '张三', username: secondPage ? 'long_account_'.repeat(12) : 'zhangsan', tags: secondPage ? longTableTags.join(',') : '', must_change_pwd: secondPage, created_at: stamp, last_login_at: stamp };
    return route.fulfill({ json: { users: [record], total: 21, page_size: 20, available_tags: [] } });
  });
  await page.goto(origin + '/admin/users');
  await page.getByText('zhangsan', { exact: true }).waitFor();
  const widths = await tableWidths(page);
  const rowHeight = await page.locator('tbody tr').evaluate(row => row.getBoundingClientRect().height);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByText('long_account_'.repeat(12), { exact: true }).waitFor();
  assert.deepEqual(await tableWidths(page), widths);
  assert.equal(await page.locator('tbody tr').evaluate(row => row.getBoundingClientRect().height), rowHeight);
  await assertTableContentFits(page, '/admin/users');
  const name = page.locator('tbody td').nth(1).locator('.truncate');
  assert.equal(await name.evaluate(element => element.scrollWidth > element.clientWidth), true);
  await name.hover();
  await page.getByRole('tooltip').waitFor();
  assert.equal(await page.getByRole('tooltip').textContent(), longTableText);
  assert.equal(await page.getByRole('tooltip').evaluate(element => element.closest('table')), null);
  await page.keyboard.press('Escape');
  await page.getByRole('tooltip').waitFor({ state: 'hidden' });
  const tags = page.locator('tbody td').nth(4).locator('[tabindex="0"]');
  await tags.focus();
  await page.getByRole('tooltip').waitFor();
  for (const tag of longTableTags) assert.ok((await page.getByRole('tooltip').textContent()).includes(tag));
  await page.keyboard.press('Escape');
  await page.getByRole('tooltip').waitFor({ state: 'hidden' });
  if (process.env.REVIEW_SCREENSHOTS) {
    await mkdir(process.env.REVIEW_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.REVIEW_SCREENSHOTS, 'fixed-user-table.png') });
  }
  await page.getByRole('button', { name: '更多用户操作 ' + 'long_account_'.repeat(12) }).click();
  await page.getByRole('menuitem', { name: '重置密码' }).waitFor();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await assertTableContentFits(page, '/admin/users mobile');
  assert.ok(await page.locator('table').evaluate(table => table.parentElement.scrollWidth > table.parentElement.clientWidth));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});

for (const routePath of ['/resources', '/manage/shows', '/manage/resources', '/fonts', '/manage/shares', '/manage/tasks?tab=uploads', '/manage/tasks?tab=downloads']) {
  test(`fixed tables: ${routePath} keeps long records inside stable columns`, { timeout: 30_000 }, async t => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let long = false;
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const name = long ? longTableText : '简短名称';
      const tags = long ? longTableTags.join(',') : '';
      const owner = { ...user, name };
      const target = { ...resource, name, subject: name, tags, owner, status: long ? '自定义的超长状态名称' : 'active', detail_path: '/resources/review-resource' };
      if (url.pathname === '/api/resources') return route.fulfill({ json: list([target]) });
      if (url.pathname === '/api/shows') return route.fulfill({ json: list([{ ...show, name, subject: name, tags, has_other_versions: true }]) });
      if (url.pathname === '/api/fonts') return route.fulfill({ json: { fonts: [{ id: 1, family: name, file_name: name + '.ttf', aliases: [name + ' alias'], uploaded_by: name, installed_on_server: true, created_at: stamp }] } });
      if (url.pathname.endsWith('-share-links')) return route.fulfill({ json: { ...list([{ id: 1, creator: owner, resource: target, show: { ...target, version_no: 1, page_count: 3 }, status: 'active', share_path: '/share/test', created_at: stamp, expires_at: stamp }]), stats: { total: 1, active: 1, expired: 0, revoked: 0 } } });
      if (url.pathname === '/api/tasks') return route.fulfill({ json: list([{ id: 1, task_type: url.searchParams.get('task_type'), status: 'processing', owner_id: 1, owner, progress: 0, total: 0, message: name, params: { series: name, show_name: name, subject: name, download_type: 'pptx', track_code: long ? 'a'.repeat(80) : 'abc123' }, created_at: stamp, updated_at: stamp }]) });
      return route.continue();
    });
    const openTable = async () => {
      await page.goto(origin + routePath);
      if (['/resources', '/manage/shows'].includes(routePath)) await page.getByRole('button', { name: '列表视图' }).click();
      await page.locator('table:visible tbody tr').first().waitFor();
    };
    await openTable();
    const widths = await tableWidths(page);
    long = true;
    await openTable();
    await page.locator('table:visible').getByText(longTableText, { exact: true }).first().waitFor();
    assert.deepEqual(await tableWidths(page), widths);
    await assertTableContentFits(page, routePath);
    assert.deepEqual(errors, []);
    await page.setViewportSize({ width: 390, height: 844 });
    await assertTableContentFits(page, routePath + ' mobile');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
}
