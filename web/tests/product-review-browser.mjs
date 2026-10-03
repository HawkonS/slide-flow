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
    await page.route('**/api/shows/1', route => route.fulfill({ json: { show: { ...show, resources } } }));
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
  await page.route('**/api/shows/1', route => route.fulfill({ json: { show: { ...show, resources: [] } } }));
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
