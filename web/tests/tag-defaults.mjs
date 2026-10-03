// Real built routes against isolated fixtures; never changes a running deployment.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/browser.mjs';

const dist = fileURLToPath(new URL('../../app/static/dist/', import.meta.url));
const user = { id: 1, username: 'admin', name: '管理员', role: 'system_admin', session_version: 1 };
const stamp = '2026-10-03T00:00:00Z';
const resource = { id: 1, detail_token: 'sample', name: '示例单页', subject: '产品', status: '正式', tags: '精选', current_version: 1, preview_url: null, can_manage: true, created_at: stamp, updated_at: stamp };
const show = { id: 1, name: '示例放映', subject: '市场', status: '草稿', tags: '', can_manage: true, is_standard: true, version_no: 1, version_count: 1, series_id: 'sample', created_at: stamp, updated_at: stamp, owner: user, visibility_scope: 'public', management_scope: 'private', all_resource_ids: [1], resources: [{ ...resource, version_no: 1, latest_version_no: 1, accessible: true }] };
const definitions = {
  subject: ['产品', '市场'], status: ['草稿', '正式', '封存'], resource: ['精选', '对外'], user: ['研发', '销售'],
};
const scenes = [
  ['resource_list', '单页素材 · 查询', 'query'], ['resource_create', '单页素材 · 导入', 'create'],
  ['show_list', '放映素材 · 查询', 'query'], ['show_create', '放映素材 · 新建', 'create'],
  ['standard_show_list', '标准放映 · 查询', 'query'], ['resource_picker', '放映内 · 选择素材', 'query'],
  ['resource_manage', '素材管理 · 查询', 'query'], ['user_list', '用户管理 · 查询', 'query'],
].map(([id, label, kind]) => ({ id, label, kind, domains: id === 'user_list' ? ['user'] : ['subject', 'status', 'resource'] }));
const initialRules = () => Object.fromEntries(scenes.map(({ id, domains }) => [id, Object.fromEntries(domains.map(domain => [domain,
  domain === 'status' ? [id === 'show_list' ? 1 : id === 'standard_show_list' ? 3 : 2] : [1],
]))]));
const tags = domain => definitions[domain].map((name, i) => ({ id: i + 1, name, label: name, category: domain, sort_order: i, usage_count: 1, default_scopes: [] }));
const list = items => ({ items, total: items.length, page: 1, page_size: 20, all_tags: definitions.resource, all_subjects: definitions.subject });
let browser, server, origin;
before(async () => {
  server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    const file = path.extname(p) ? p.slice(1) : 'index.html';
    if (file.includes('..')) { res.writeHead(404); res.end(); return; }
    try {
      const body = await readFile(path.join(dist, file));
      res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'text/html');
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

async function fixture(t, { delay = 0, failConfig = false, draft, emptyDefaults = false } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  if (draft) await context.addInitScript(value => localStorage.setItem('slide-flow.show-create-draft.1', JSON.stringify(value)), draft);
  let rules = initialRules();
  if (emptyDefaults) for (const slots of Object.values(rules)) for (const domain of Object.keys(slots)) slots[domain] = [];
  const requests = [];
  let configCount = 0;
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    requests.push({ p, query: Object.fromEntries(url.searchParams), method: request.method(), body: request.postDataJSON() });
    const json = (data, status = 200) => route.fulfill({ status, json: data });
    if (p === '/api/me') return json({ user });
    if (p === '/api/version') return json({ commit: 'test', updated_at: stamp });
    if (p === '/api/user/preferences') return json({ preferences: {} });
    if (p === '/api/config') {
      configCount++;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (failConfig) return json({ detail: 'offline' }, 503);
      const tag_defaults = Object.fromEntries(Object.entries(rules).map(([scene, slots]) => [scene, Object.fromEntries(Object.entries(slots).map(([domain, ids]) => {
        const values = ids.map(id => definitions[domain][id - 1]);
        return [{ resource: 'resource_tags', user: 'user_tags' }[domain] || domain, ['subject', 'status'].includes(domain) ? values[0] ?? null : values];
      }))]));
      return json({ site_name: 'Slide Flow', tag_defaults, resource_custom_tags: false, user_custom_tags: false });
    }
    if (p === '/api/admin/tag-defaults') {
      if (request.method() === 'PATCH') for (const change of request.postDataJSON().changes) rules[change.scene][change.domain] = change.tag_ids;
      return json({ scenes, defaults: rules });
    }
    const match = p.match(/^\/api\/(admin\/)?(?:(subject|status|user)-)?tags$/);
    if (match) {
      const domain = match[2] || 'resource';
      const items = tags(domain).map(tag => ({ ...tag, default_scopes: scenes.filter(s => rules[s.id][domain]?.includes(tag.id)).map(s => s.id) }));
      return json({ tags: items, groups: [{ category: domain, tags: items }], can_create: true });
    }
    if (p === '/api/resources' || p === '/api/resources/pick') return json(list([resource]));
    if (p === '/api/resources/ids' || p === '/api/resources/pick-ids') return json({ ids: [1] });
    if (p === '/api/shows') return json(list([show]));
    if (p === '/api/shows/1') return json({ show });
    if (p === '/api/shows/1/check-updates') return json({ updates: [] });
    if (p === '/api/shows/1/versions') return json({ versions: [show], current_version_no: 1 });
    if (p === '/api/admin/users') return json({ ...list([user]), users: [user] });
    if (p === '/api/admin/user-tags' || p === '/api/users/options') return json({ items: [], users: [] });
    if (p === '/api/tasks/101') return json({ id: 101, status: 'pending', params: { name_prefix: '恢复的导入', subject: '市场', status: '草稿', tags: '对外', file_name: 'resume.pptx', session_id: 'b'.repeat(32), slide_count: 1, fonts: [], missing_fonts: [], preview_status: 'pending' } });
    if (p.includes('remark')) return json({ content_html: '' });
    return json({ items: [], fonts: [], users: [], pins: [], preferences: {}, resources: [], shows: [] });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'page errors'));
  return { page, requests, rules, get configCount() { return configCount; } };
}
async function until(check) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.fail('Timed out waiting for expected state');
}
const last = (requests, p) => requests.filter(r => r.p === p).at(-1)?.query;

for (const [routePath, apiPath, status, userScene] of [
  ['/resources', '/api/resources', '正式'], ['/manage/resources', '/api/resources', '正式'],
  ['/manage/shows', '/api/shows', '草稿'], ['/shows', '/api/shows', '封存'],
  ['/admin/users', '/api/admin/users', undefined, true],
]) test(`defaults, clear, refresh, restore: ${routePath}`, async t => {
  const { page, requests } = await fixture(t);
  await page.goto(origin + routePath);
  await until(() => last(requests, apiPath)?.tags === (userScene ? '研发' : '精选') && (userScene || last(requests, apiPath)?.status === status));
  await page.getByRole('button', { name: '清空筛选', exact: true }).click();
  await until(() => last(requests, apiPath) && !last(requests, apiPath).tags && !last(requests, apiPath).status);
  assert.ok(new URL(page.url()).searchParams.has('s'));
  requests.length = 0;
  await page.reload();
  await page.getByRole('button', { name: '恢复默认', exact: true }).waitFor();
  await until(() => Boolean(last(requests, apiPath)));
  assert.equal(last(requests, apiPath).tags, undefined);
  assert.equal(last(requests, apiPath).status, undefined);
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await until(() => last(requests, apiPath)?.tags === (userScene ? '研发' : '精选'));
  if (!userScene) assert.equal(last(requests, apiPath).status, status);
});

test('URL and browser history win, shows keep independent defaults', async t => {
  const { page, requests } = await fixture(t);
  await page.goto(origin + '/resources');
  await page.getByPlaceholder('搜索标题、关键词').fill('手动搜索');
  await until(() => last(requests, '/api/resources')?.search === '手动搜索');
  await page.getByRole('link', { name: '放映素材', exact: true }).click();
  await until(() => last(requests, '/api/shows')?.status === '草稿');
  await page.goBack();
  await until(async () => await page.getByPlaceholder('搜索标题、关键词').inputValue() === '手动搜索');
  await page.goForward();
  await page.getByRole('link', { name: '标准放映', exact: true }).click();
  await until(() => last(requests, '/api/shows')?.status === '封存');
});

test('late config does not overwrite manual filters', async t => {
  const { page, requests } = await fixture(t, { delay: 1600 });
  await page.goto(origin + '/resources');
  await page.getByPlaceholder('搜索标题、关键词').fill('先输入');
  await until(() => last(requests, '/api/resources')?.search === '先输入');
  await page.waitForResponse(response => response.url().endsWith('/api/config'));
  assert.equal(await page.getByPlaceholder('搜索标题、关键词').inputValue(), '先输入');
  assert.equal(last(requests, '/api/resources').status, undefined);
});

test('failed config leaves lists usable', async t => {
  const { page, requests } = await fixture(t, { failConfig: true });
  await page.goto(origin + '/resources');
  await page.getByPlaceholder('搜索标题、关键词').fill('可查询');
  await until(() => last(requests, '/api/resources')?.search === '可查询');
  assert.equal(last(requests, '/api/resources').status, undefined);
});

test('new show fills metadata; picker restores explicit clear without removing selection', async t => {
  const { page, requests } = await fixture(t);
  await page.goto(origin + '/manage/shows/new');
  await until(async () => (await page.locator('#show-create-subject').textContent())?.includes('产品'));
  await page.locator('#show-create-name').fill('新的放映');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await until(() => last(requests, '/api/resources/pick')?.status === '正式');
  await page.getByRole('button', { name: /无预览 示例单页/ }).click();
  await page.getByRole('button', { name: '清空筛选', exact: true }).click();
  await until(() => !last(requests, '/api/resources/pick')?.status);
  await page.getByRole('button', { name: '暂存', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('slide-flow.show-create-draft.1')).resourceIds), [1]);
  requests.length = 0;
  await page.reload();
  await until(() => Boolean(last(requests, '/api/resources/pick')));
  assert.equal(last(requests, '/api/resources/pick').status, undefined);
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await until(() => last(requests, '/api/resources/pick')?.status === '正式');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('slide-flow.show-create-draft.1')).resourceIds), [1]);
});

test('saved show draft wins over new-form defaults', async t => {
  const { page } = await fixture(t, { draft: { form: { name: '原草稿', subject: '市场', status: '草稿', tagList: ['对外'] }, resourceIds: [], step: 0, savedAt: stamp } });
  await page.goto(origin + '/manage/shows/new');
  await page.locator('#show-create-name').waitFor();
  assert.equal(await page.locator('#show-create-name').inputValue(), '原草稿');
  assert.match(await page.locator('#show-create-subject').textContent(), /市场/);
  assert.ok(await page.getByRole('combobox').filter({ hasText: '草稿' }).count());
});

test('unconfigured show status stays empty', async t => {
  const { page } = await fixture(t, { emptyDefaults: true });
  await page.goto(origin + '/manage/shows/new');
  await page.locator('#show-create-name').waitFor();
  await page.getByRole('combobox').filter({ hasText: '选择状态' }).waitFor();
  assert.equal(await page.getByRole('combobox').filter({ hasText: '草稿' }).count(), 0);
});

test('resource import fills defaults, template import stays empty', async t => {
  const { page } = await fixture(t);
  await page.goto(origin + '/resources/import');
  await until(async () => (await page.locator('#import-subject').textContent())?.includes('产品'));
  assert.match(await page.locator('#import-status').textContent(), /正式/);
  await page.goto(origin + '/templates/import');
  await page.locator('#import-template-subject').waitFor();
  assert.doesNotMatch(await page.locator('#import-template-subject').textContent(), /产品/);
});

test('iteration picker uses the shared picker defaults', async t => {
  const { page, requests } = await fixture(t);
  await page.goto(origin + '/shows/1/iterate?tab=reorganize');
  await until(() => last(requests, '/api/resources/pick')?.status === '正式');
});

test('resuming an import protects the saved metadata', async t => {
  const { page, requests } = await fixture(t);
  await page.goto(origin + '/resources/import?task_id=101');
  await until(() => requests.some(request => request.p === '/api/tasks/101'));
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await until(async () => (await page.locator('#import-subject').textContent())?.includes('市场'));
  assert.match(await page.locator('#import-status').textContent(), /草稿/);
});

test('editing an existing show does not apply new-form metadata', async t => {
  const { page } = await fixture(t);
  await page.goto(origin + '/manage/shows');
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '编辑信息', exact: true }).click();
  await until(async () => (await page.locator('#show-subject').textContent())?.includes('市场'));
  assert.ok(await page.getByRole('dialog').getByRole('combobox').filter({ hasText: '草稿' }).count());
});

test('late new-form defaults do not overwrite user choices', async t => {
  const { page } = await fixture(t, { delay: 1600 });
  await page.goto(origin + '/resources/import');
  await page.locator('#import-status').click();
  await page.getByRole('option', { name: '草稿', exact: true }).click();
  await page.waitForResponse(response => response.url().endsWith('/api/config'));
  assert.match(await page.locator('#import-status').textContent(), /草稿/);
});

test('tag entry and scene overview save the same slots with replacement preview', async t => {
  const { page, rules } = await fixture(t);
  await page.goto(origin + '/manage/tags?tab=status');
  await page.getByRole('button', { name: '草稿 更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '默认设置…', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: '单页素材 · 查询', exact: true }).check();
  await dialog.getByText('保存后将替换「正式」', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '保存默认设置', exact: true }).click();
  await until(() => rules.resource_list.status[0] === 1);
  await page.getByRole('button', { name: '默认设置', exact: true }).click();
  await until(async () => await page.getByLabel('单页素材 · 查询 状态', { exact: true }).inputValue() === '1');
  if (process.env.TAG_DEFAULTS_SCREENSHOT) await page.screenshot({ path: process.env.TAG_DEFAULTS_SCREENSHOT, animations: 'disabled' });
  await page.getByLabel('标准放映 · 查询 状态', { exact: true }).selectOption('2');
  await page.setViewportSize({ width: 390, height: 844 });
  const dialogBounds = await page.getByRole('dialog').boundingBox();
  const saveBounds = await page.getByRole('button', { name: '保存默认设置', exact: true }).boundingBox();
  assert.ok(dialogBounds.x >= 0 && dialogBounds.x + dialogBounds.width <= 390, 'dialog fits mobile width');
  assert.ok(saveBounds.y >= 0 && saveBounds.y + saveBounds.height <= 844, 'save remains visible while scrolling');
  await page.getByRole('button', { name: '保存默认设置', exact: true }).click();
  await until(() => rules.standard_show_list.status[0] === 2);
  assert.deepEqual(rules.show_list.status, [1]);
});
