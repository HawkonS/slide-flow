// Real production chunks and list requests against an isolated server; no deployed data is changed.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/browser.mjs';

const dist = fileURLToPath(new URL('../../app/static/dist/', import.meta.url));
const stamp = '2026-10-12T00:00:00Z';
const user = { id: 1, username: 'admin', name: '管理员', role: 'system_admin', session_version: 1 };
const version = { id: 11, version_no: 1, preview_url: null, original_preview_url: null, font_names: [], created_at: stamp };
const resource = { id: 1, detail_token: 'a'.repeat(32), name: '加载测试素材', subject: '产品', status: '正式', tags: '精选', current_version: 1, current: version, can_manage: true, owner_id: 1, owner: user, visibility_scope: 'public', management_scope: 'private', created_at: stamp, updated_at: stamp };
const config = { site_name: 'Slide Flow', tag_defaults: { resource_list: { subject: '产品', status: '正式', resource_tags: ['精选'] } } };
const list = (query, name = resource.name) => ({ items: [{ ...resource, name }], total: 1, page: Number(query.page), page_size: Number(query.page_size), all_tags: ['精选'], all_subjects: ['产品'] });
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const encode = state => Buffer.from(JSON.stringify(state)).toString('base64url');
const explicitState = { q: '', sub: 'all', sta: 'all', tags: [], tm: 'all', p: 1, view: 'card' };
let browser, server, origin;

before(async () => {
  server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    const file = path.extname(p) ? p.slice(1) : 'index.html';
    if (file.includes('..')) { res.writeHead(404); res.end(); return; }
    try {
      const body = await readFile(path.join(dist, file));
      res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'text/html');
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

async function fixture(t, { width = 390, configGate, onList, shows = [] } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1000 }, serviceWorkers: 'block' });
  t.after(() => context.close());
  if (configGate) t.after(() => configGate.release());
  const requests = [], chunks = [];
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    const query = Object.fromEntries(url.searchParams);
    requests.push({ p, query });
    const json = data => route.fulfill({ json: data });
    if (p === '/api/me') return json({ user });
    if (p === '/api/config') { if (configGate) await configGate.promise; return json(config); }
    if (p === '/api/version') return json({ commit: 'test', updated_at: stamp });
    if (p === '/api/resources') return onList ? onList(route, query) : json(list(query));
    if (p === '/api/resources/1') return json({ resource: { ...resource, versions: [version] } });
    if (p === '/api/resources/delete-preview') return json({ targets: [{ id: 1, name: resource.name, version_count: 1, selected_version_count: 1, version_nos: [1], delete_resource: true }], has_references: false, show_count: 0, share_count: 0, shows: [], confirmation_token: 'test', available_actions: ['remove'] });
    if (p === '/api/me/home/stats') return json({ resources: {}, shows: {}, templates: {}, fonts: {} });
    if (p === '/api/shows') return json({ items: shows, total: shows.length, page: 1, page_size: 20, all_tags: [], all_subjects: [] });
    if (p === '/api/shows/36') return json({ show: shows[0] ?? null });
    if (p === '/api/shows/36/check-updates') return json({ updates: [] });
    return json({ items: [], tags: [], users: [], resources: [], shows: [], pins: [], preferences: {} });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on('request', request => { if (request.url().includes('/assets/')) chunks.push(new URL(request.url()).pathname); });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'uncaught browser errors'));
  return { page, requests, chunks };
}
async function menu(page, action) {
  await page.getByRole('button', { name: /更多操作$/ }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
/** URL updates before React commits the new location; poll the attribute. */
async function waitForCurrent(locator, expected, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await locator.getAttribute('aria-current') === expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(await locator.getAttribute('aria-current'), expected, message);
}
const modalChunk = /\/(?:Resource(?:Edit|Download|Deletion|Preview)Dialog|BatchEditDialog)-/;

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`first entry waits for defaults and dimensions, then sends one list request at ${width}px`, async t => {
    const configGate = gate();
    const { page, requests, chunks } = await fixture(t, { width, configGate });
    await page.goto(origin + '/resources');
    await page.getByPlaceholder('搜索标题、关键词').waitFor();
    await page.getByRole('status', { name: '正在加载列表' }).waitFor();
    assert.equal(requests.filter(r => r.p === '/api/resources').length, 0);
    assert.equal(await page.getByText('没有匹配的资源', { exact: true }).count(), 0);
    configGate.release();
    await page.getByRole('button', { name: /更多操作$/ }).waitFor();
    // Allow ResizeObserver and the pagination footer to settle after the response.
    await page.waitForTimeout(200);
    const lists = requests.filter(r => r.p === '/api/resources');
    assert.equal(lists.length, 1, JSON.stringify(lists));
    assert.equal(lists[0].query.subject, '产品');
    assert.equal(lists[0].query.status, '正式');
    assert.equal(lists[0].query.tags, '精选');
    if (width === 390) assert.equal(lists[0].query.page_size, '6');
    assert.deepEqual(chunks.filter(chunk => modalChunk.test(chunk)), []);
  });
}

test('invalid URL state still waits for defaults; explicit list state does not', async t => {
  const configGate = gate();
  const { page, requests } = await fixture(t, { configGate });
  await page.goto(origin + '/resources?s=malformed');
  await page.getByPlaceholder('搜索标题、关键词').waitFor();
  assert.equal(requests.filter(r => r.p === '/api/resources').length, 0);
  await page.goto(origin + '/resources?s=' + encode({ ...explicitState, view: 'list' }));
  await page.getByRole('button', { name: /更多操作$/ }).waitFor();
  configGate.release();
  await page.waitForTimeout(200);
  const lists = requests.filter(r => r.p === '/api/resources');
  assert.equal(lists.length, 1, JSON.stringify(lists));
  assert.equal(lists[0].query.status, undefined);
});

test('sidebar navigation remains usable while the resources route chunk waits', async t => {
  const { page } = await fixture(t);
  const chunkGate = gate();
  t.after(() => chunkGate.release());
  await page.route('**/assets/ResourcesPage-*.js', async route => { await chunkGate.promise; await route.continue(); });
  await page.goto(origin + '/');
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('link', { name: '单页素材', exact: true }).click();
  await page.getByRole('status', { name: '正在加载列表' }).waitFor();
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('link', { name: '用户首页', exact: true }).click();
  await page.waitForURL('**/home');
  chunkGate.release();
});

test('show detail keeps the sidebar entry of the list that opened it', async t => {
  const navShow = {
    id: 36, name: '导航测试放映', owner_id: 1, owner: user, subject: '产品', tags: '', status: 'active',
    visibility_scope: 'public', management_scope: 'private', can_manage: true, is_standard: false,
    series_id: 'nav', version_no: 1, version_count: 1, has_other_versions: false,
    created_at: stamp, updated_at: stamp, all_resource_ids: [], resources: [],
  };
  const { page } = await fixture(t, { width: 1360, shows: [navShow] });
  const showResources = page.getByRole('link', { name: '放映素材', exact: true });
  const standardShows = page.getByRole('link', { name: '标准放映', exact: true });

  await page.goto(origin + '/manage/shows');
  await waitForCurrent(showResources, 'page', '放映素材 list');
  await waitForCurrent(standardShows, null, '标准放映 must stay idle on the 放映素材 list');

  await page.getByRole('button', { name: /导航测试放映/ }).click();
  await page.waitForURL('**/shows/36');
  await waitForCurrent(showResources, 'page', 'opened from 放映素材');
  await waitForCurrent(standardShows, null, '标准放映 must stay idle after opening from 放映素材');

  await standardShows.click();
  await page.waitForURL('**/shows');
  await waitForCurrent(standardShows, 'page', 'standard list');

  await page.getByRole('button', { name: /导航测试放映/ }).click();
  await page.waitForURL('**/shows/36');
  await waitForCurrent(standardShows, 'page', 'opened from 标准放映');
  await waitForCurrent(showResources, null, '放映素材 must stay idle after opening from 标准放映');
});

test('order tab reorders pages and saves the order without a new version', async t => {
  const iterationShow = {
    id: 36, name: '顺序测试放映', owner_id: 1, owner: user, subject: '产品', tags: '', status: 'active',
    visibility_scope: 'public', management_scope: 'private', can_manage: true, is_standard: false,
    series_id: 'order', version_no: 1, version_count: 1, has_other_versions: false,
    created_at: stamp, updated_at: stamp, all_resource_ids: [1, 2, 3],
    resources: [1, 2, 3].map(id => ({
      id, name: ['第一页', '第二页', '第三页'][id - 1], version_no: 1, latest_version_no: 1,
      accessible: true, preview_url: null, original_preview_url: null, hidden: false,
    })),
  };
  const { page } = await fixture(t, { width: 1200, shows: [iterationShow] });
  let saved = null;
  await page.route('**/api/shows/36/resources', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    saved = route.request().postDataJSON();
    return route.fulfill({ json: { show: iterationShow } });
  });

  await page.goto(origin + '/shows/36/iterate');
  await page.getByRole('heading', { name: '版本迭代', exact: true }).waitFor();

  await page.getByRole('button', { name: /组织页面/ }).click();
  await page.getByRole('button', { name: /调整顺序/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /拖动第 \d+ 页调整顺序/ }).count(), 0, 'card grid is not mounted on 组织页面');

  await page.getByRole('button', { name: /调整顺序/ }).click();
  const grid = page.getByRole('list', { name: '调整播放顺序' });
  await grid.waitFor();
  const rows = () => grid.locator('li[data-sort-resource-id]');
  const names = () => rows().evaluateAll(nodes => nodes.map(node => node.querySelector('p')?.textContent ?? ''));
  assert.deepEqual(await names(), ['第一页', '第二页', '第三页']);

  await page.getByLabel('当前页码', { exact: true }).fill('1');
  await page.getByLabel('目标位置', { exact: true }).fill('3');
  await page.getByRole('button', { name: '移动', exact: true }).click();
  assert.deepEqual(await names(), ['第二页', '第三页', '第一页']);

  // Native card drag: drop on the target centre inserts before it.
  await page.dragAndDrop('li[data-sort-resource-id="1"]', 'li[data-sort-resource-id="3"]');
  assert.deepEqual(await names(), ['第二页', '第一页', '第三页']);

  await page.getByRole('button', { name: '保存播放顺序（不创建新版本）', exact: true }).click();
  await page.waitForURL('**/shows/36');
  assert.deepEqual(saved?.resource_ids, [2, 1, 3]);
});

test('organize tab thumbnails can be dragged to reorder', async t => {
  const iterationShow = {
    id: 36, name: '缩略图排序放映', owner_id: 1, owner: user, subject: '产品', tags: '', status: 'active',
    visibility_scope: 'public', management_scope: 'private', can_manage: true, is_standard: false,
    series_id: 'thumb', version_no: 1, version_count: 1, has_other_versions: false,
    created_at: stamp, updated_at: stamp, all_resource_ids: [1, 2, 3],
    resources: [1, 2, 3].map(id => ({
      id, name: ['第一页', '第二页', '第三页'][id - 1], version_no: 1, latest_version_no: 1,
      accessible: true, preview_url: null, original_preview_url: null, hidden: false,
    })),
  };
  const { page } = await fixture(t, { width: 1280, shows: [iterationShow] });
  await page.goto(origin + '/shows/36/iterate?tab=reorganize');
  await page.getByRole('heading', { name: '版本迭代', exact: true }).waitFor();
  await page.getByText(/已选 3/).waitFor();
  const selectedIds = () => page.locator('[data-selected-resource-id]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.selectedResourceId)));
  assert.deepEqual(await selectedIds(), [1, 2, 3]);

  const source = await page.locator('[data-selected-resource-id="1"]').boundingBox();
  const target = await page.locator('[data-selected-resource-id="3"]').boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width - 6, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();

  assert.deepEqual(await selectedIds(), [2, 3, 1]);
  await page.getByRole('button', { name: '保存播放顺序（不创建新版本）', exact: true }).waitFor();
});

test('creating a version asks for the change note in a dialog', async t => {
  const iterationShow = {
    id: 36, name: '迭代弹窗放映', owner_id: 1, owner: user, subject: '产品', tags: '', status: 'active',
    visibility_scope: 'public', management_scope: 'private', can_manage: true, is_standard: false,
    series_id: 'dialog', version_no: 1, version_count: 1, has_other_versions: false,
    created_at: stamp, updated_at: stamp, all_resource_ids: [1, 2, 3],
    resources: [1, 2, 3].map(id => ({
      id, name: ['第一页', '第二页', '第三页'][id - 1], version_no: 1, latest_version_no: 1,
      accessible: true, preview_url: null, original_preview_url: null, hidden: false,
    })),
  };
  const { page } = await fixture(t, { width: 1280, shows: [iterationShow] });
  let iterated = null;
  await page.route('**/api/shows/36/iterate', async route => {
    iterated = route.request().postDataJSON();
    return route.fulfill({ json: { show: iterationShow } });
  });

  await page.goto(origin + '/shows/36/iterate?tab=reorganize');
  await page.getByRole('heading', { name: '版本迭代', exact: true }).waitFor();
  await page.getByRole('button', { name: '移除 第三页', exact: true }).click();

  await page.getByRole('button', { name: '创建新版本并应用资源调整', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建新版本', exact: true });
  await dialog.waitFor();
  const confirm = dialog.getByRole('button', { name: '创建新版本', exact: true });
  assert.equal(await confirm.isDisabled(), true);

  await dialog.getByPlaceholder('说明本次新增、删除或升级的内容').fill('删除一页');
  assert.equal(await confirm.isDisabled(), false);
  await confirm.click();

  await page.waitForURL('**/shows/36');
  assert.equal(iterated?.change_note, '删除一页');
  assert.deepEqual(iterated?.resource_ids, [1, 2]);
});

test('download loads its own dialog without edit, deletion, batch-edit or detail requests', async t => {
  const { page, requests, chunks } = await fixture(t);
  await page.goto(origin + '/resources');
  await menu(page, '下载');
  await page.getByRole('dialog', { name: '选择下载格式' }).waitFor();
  assert.equal(requests.filter(r => r.p === '/api/resources/1').length, 0);
  assert.equal(chunks.filter(chunk => /\/ResourceDownloadDialog-/.test(chunk)).length, 1);
  assert.deepEqual(chunks.filter(chunk => /\/(?:Resource(?:Edit|Deletion|Preview)Dialog|BatchEditDialog)-/.test(chunk)), []);
});

test('deletion loads its own dialog and checks references after fetching version metadata', async t => {
  const { page, requests, chunks } = await fixture(t);
  await page.goto(origin + '/resources');
  await menu(page, '删除');
  const dialog = page.getByRole('dialog', { name: '删除素材', exact: true });
  await dialog.getByRole('button', { name: '确认删除', exact: true }).waitFor();
  assert.equal(requests.filter(r => r.p === '/api/resources/1').length, 1);
  assert.equal(requests.filter(r => r.p === '/api/resources/delete-preview').length, 1);
  assert.equal(chunks.filter(chunk => /\/ResourceDeletionDialog-/.test(chunk)).length, 1);
  assert.deepEqual(chunks.filter(chunk => /\/(?:Resource(?:Edit|Download|Preview)Dialog|BatchEditDialog)-/.test(chunk)), []);
});

test('edit fetches metadata alongside its chunk and cancelling suppresses a late dialog', async t => {
  const { page, requests } = await fixture(t);
  const chunkGate = gate();
  t.after(() => chunkGate.release());
  await page.route('**/assets/ResourceEditDialog-*.js', async route => { await chunkGate.promise; await route.continue(); });
  await page.goto(origin + '/resources');
  const detailResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/resources/1');
  await menu(page, '编辑');
  const waiting = page.getByRole('dialog', { name: '正在打开编辑窗口' });
  await waiting.waitFor();
  await detailResponse;
  assert.equal(requests.filter(r => r.p === '/api/resources/1').length, 1);
  const loaded = page.waitForResponse(response => /\/ResourceEditDialog-/.test(response.url()));
  await waiting.getByRole('button', { name: '取消', exact: true }).click();
  chunkGate.release();
  await loaded;
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await menu(page, '编辑');
  await page.getByRole('dialog', { name: '编辑信息' }).waitFor();
});

test('batch edit and preview work as the first dialog action in list mode', async t => {
  const { page, chunks } = await fixture(t, { width: 1440 });
  await page.goto(origin + '/resources?s=' + encode({ ...explicitState, view: 'list' }));
  await page.getByRole('checkbox', { name: `选择素材 ${resource.name}`, exact: true }).click();
  await page.getByRole('button', { name: '批量编辑', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量编辑单页素材' });
  await dialog.waitFor();
  assert.equal(chunks.filter(chunk => /\/BatchEditDialog-/.test(chunk)).length, 1);
  assert.deepEqual(chunks.filter(chunk => /\/Resource(?:Edit|Download|Deletion|Preview)Dialog-/.test(chunk)), []);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: `放大查看 ${resource.name}` }).click();
  // The previous dialog can remain mounted during its exit animation.
  await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: resource.name, exact: true }) }).waitFor();
  assert.equal(chunks.filter(chunk => /\/ResourcePreviewDialog-/.test(chunk)).length, 1);
});

test('a stalled list times out and a manual retry succeeds with one fresh request', { timeout: 30_000 }, async t => {
  const stalled = gate();
  t.after(() => stalled.release());
  let count = 0;
  const { page } = await fixture(t, { onList: async (route, query) => {
    count++;
    if (count === 1) await stalled.promise;
    await route.fulfill({ json: list(query) }).catch(() => {});
  } });
  const pending = page.waitForRequest(request => new URL(request.url()).pathname === '/api/resources');
  await page.goto(origin + '/resources');
  await pending;
  await page.getByRole('alert').filter({ hasText: '请求超时，请检查网络后重试' }).waitFor({ timeout: 15_000 });
  assert.equal(count, 1);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('button', { name: /更多操作$/ }).waitFor();
  assert.equal(count, 2);
  stalled.release();
});

test('changing filters cancels the previous request and ignores its late result', async t => {
  const stalled = gate();
  t.after(() => stalled.release());
  const { page } = await fixture(t, { onList: async (route, query) => {
    if (query.search === '旧筛选') await stalled.promise;
    await route.fulfill({ json: list(query, query.search || resource.name) }).catch(() => {});
  } });
  await page.goto(origin + '/resources');
  await page.getByRole('button', { name: /更多操作$/ }).waitFor();
  const pending = page.waitForRequest(request => new URL(request.url()).searchParams.get('search') === '旧筛选');
  await page.getByPlaceholder('搜索标题、关键词').fill('旧筛选');
  await pending;
  const cancelled = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).searchParams.get('search') === '旧筛选' });
  await page.getByPlaceholder('搜索标题、关键词').fill('新筛选');
  await cancelled;
  await page.getByText('新筛选', { exact: true }).waitFor();
  stalled.release();
  await page.waitForTimeout(200);
  assert.equal(await page.getByText('旧筛选', { exact: true }).count(), 0);
});
