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

async function fixture(t, { width = 390, configGate, onList } = {}) {
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
  await page.getByRole('dialog').waitFor();
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
