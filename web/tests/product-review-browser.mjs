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
