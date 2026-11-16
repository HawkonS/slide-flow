// Exercise the real built header and notification drawer against isolated API fixtures.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/browser.mjs';

const dist = fileURLToPath(new URL('../../app/static/dist/', import.meta.url));
const stamp = '2026-11-15T10:00:00';
const user = { id: 1, username: 'review', name: '评审用户', role: 'system_admin', session_version: 1, avatar_url: null, must_change_pwd: false };
const STORAGE_KEY = 'slide-flow:local-notifications:v1';

function baseNotifications() {
  return [
    {
      id: 'task:101', kind: 'task', task_type: 'download', status: 'completed',
      title: '下载已完成', body: '《示例放映》 · 示例放映.pdf', link: '/home',
      created_at: stamp, read_at: null,
    },
    {
      id: 'task:102', kind: 'task', task_type: 'batch_split_import', status: 'failed',
      title: '导入失败', body: '请在任务管理中查看详情', link: '/home',
      created_at: '2026-11-15T09:00:00', read_at: null,
    },
    {
      id: 'task:103', kind: 'task', task_type: 'ai_tagging', status: 'completed',
      title: '智能标注完成', body: '示例单页 · 已生成 2 个标签建议', link: '/home',
      created_at: '2026-11-14T09:00:00', read_at: '2026-11-14T10:00:00',
    },
  ];
}

let browser;
let server;
let origin;
let notifications = baseNotifications();
let requests = [];
let failNotifications = false;

const json = (res, data, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

const unreadCount = () => notifications.filter((item) => !item.read_at).length;

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p.startsWith('/api/')) {
    requests.push({ method: req.method, path: decodeURIComponent(p), query: Object.fromEntries(url.searchParams) });
    if (p === '/api/me') return json(res, { user });
    if (p === '/api/config') {
      return json(res, {
        site_name: 'Slide Flow', site_description: '测试站点', logo_svg_path: '',
        tag_defaults: {}, resource_custom_tags: false, user_custom_tags: false,
      });
    }
    if (p === '/api/version') return json(res, { commit: 'test', updated_at: stamp });
    if (p === '/api/user/preferences') return json(res, { preferences: {} });
    if (p === '/api/me/home/stats') {
      return json(res, {
        resources: { total: 0, mine: 0, managed: 0, visible: 0 },
        shows: { total: 0, mine: 0, managed: 0, visible: 0 },
        standard_shows: 0, templates: { total: 0 }, fonts: { total: 0 },
        tasks: { total: 0, upload: 0, download: 0, unfinished: 0, failed: 0 },
      });
    }
    if (p === '/api/me/pins') return json(res, { resources: [], shows: [] });
    if (p === '/api/me/activity') return json(res, { start: '2025-11-16', end: '2026-11-15', login: [], upload: [], download: [] });
    if (p === '/api/tasks') return json(res, { items: [], total: 0, page: 1, page_size: 20 });
    if (p.startsWith('/api/me/notifications')) {
      if (failNotifications) return json(res, { detail: '不可用' }, 503);
      if (p === '/api/me/notifications/unread-count') return json(res, { count: unreadCount() });
      if (p === '/api/me/notifications/read-all' && req.method === 'POST') {
        for (const item of notifications) item.read_at = item.read_at || stamp;
        return json(res, { ok: true, marked: notifications.length, unread_count: 0 });
      }
      const readMatch = decodeURIComponent(p).match(/^\/api\/me\/notifications\/(.+)\/read$/);
      if (readMatch && req.method === 'POST') {
        const item = notifications.find((entry) => entry.id === readMatch[1]);
        if (!item) return json(res, { detail: '通知不存在' }, 404);
        item.read_at = item.read_at || stamp;
        return json(res, { ok: true, id: item.id, read_at: item.read_at, unread_count: unreadCount() });
      }
      if (readMatch && req.method === 'DELETE') {
        const item = notifications.find((entry) => entry.id === readMatch[1]);
        if (!item) return json(res, { detail: '通知不存在' }, 404);
        item.read_at = null;
        return json(res, { ok: true, id: item.id, unread_count: unreadCount() });
      }
      const filter = url.searchParams.get('filter') || 'all';
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || 20)));
      const items = notifications
        .filter((item) => filter === 'all' || (filter === 'unread' ? !item.read_at : !!item.read_at))
        .slice(0, limit);
      return json(res, { items, unread_count: unreadCount(), has_more: false, next_cursor: null });
    }
    return json(res, { items: [], total: 0, page: 1, page_size: 20, preferences: {} });
  }
  if (p === '/static/img/logo.svg' || p === '/favicon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#22345e"/></svg>');
    return;
  }
  const file = path.extname(p) ? p.slice(1) : 'index.html';
  if (file.includes('..')) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const body = await readFile(path.join(dist, file));
    res.writeHead(200, {
      'Content-Type': {
        '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
      }[path.extname(file)] || 'text/html',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

before(async () => {
  server = http.createServer((req, res) => void handle(req, res).catch((error) => {
    res.writeHead(500);
    res.end(String(error));
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function openApp(t, { local = false, empty = false, fail = false, viewport = { width: 1440, height: 900 } } = {}) {
  notifications = empty ? [] : baseNotifications();
  requests = [];
  failNotifications = fail;
  const context = await browser.newContext({ serviceWorkers: 'block', viewport });
  t.after(() => context.close());
  if (local) {
    await context.addInitScript(([key, payload]) => {
      window.localStorage.setItem(key, JSON.stringify(payload));
    }, [STORAGE_KEY, {
      version: 1,
      items: [{
        id: 'pwa-update:1:abc123',
        kind: 'pwa_update',
        user_id: 1,
        title: '本地应用有新版本',
        body: '完成当前工作后关闭所有窗口并重新打开即可更新。',
        link: '/home',
        version: 'abc123',
        created_at: '2026-11-15T11:00:00.000Z',
        read_at: null,
      }],
    }]);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'page errors'));
  await page.goto(origin + '/home');
  await page.getByRole('button', { name: /用户菜单/ }).waitFor();
  return { page, context };
}

async function openNotifications(page) {
  await page.getByRole('button', { name: /^通知/ }).click();
  const panel = page.getByRole('dialog', { name: '通知' });
  await panel.waitFor();
  return panel;
}

test('header renders app link, user menu and notification drawer with read groups', async (t) => {
  const { page } = await openApp(t, { local: true });
  const pwaLink = page.locator('a[href="/manage/offline-cache"]');
  const userButton = page.getByRole('button', { name: /用户菜单/ });
  const bell = page.getByRole('button', { name: /^通知/ });
  await pwaLink.waitFor();
  const boxes = await Promise.all([pwaLink.boundingBox(), userButton.boundingBox(), bell.boundingBox()]);
  assert.ok(boxes[0] && boxes[1] && boxes[2]);
  assert.ok(boxes[0].x < boxes[1].x && boxes[1].x < boxes[2].x, 'right side order should be app link, user menu, notifications');
  assert.match(await bell.getAttribute('aria-label'), /3 条未读/, 'server unread plus local update shows on the badge');

  await userButton.click();
  assert.ok(await page.getByRole('menuitem', { name: /修改密码/ }).isVisible());
  assert.ok(await page.getByRole('menuitem', { name: /退出登录/ }).isVisible());
  await page.getByRole('menuitem', { name: /修改密码/ }).click();
  const passwordDialog = page.getByRole('dialog', { name: '修改密码' });
  await passwordDialog.waitFor();
  assert.ok(await passwordDialog.getByLabel('原密码').isVisible());
  assert.ok(await passwordDialog.getByLabel('新密码', { exact: true }).isVisible());
  await passwordDialog.getByRole('button', { name: '取消' }).click();
  await passwordDialog.waitFor({ state: 'hidden' });

  const panel = await openNotifications(page);
  assert.ok(await panel.getByRole('heading', { name: /^未读/ }).isVisible());
  assert.ok(await panel.getByRole('heading', { name: /^已读/ }).isVisible());
  assert.ok(await panel.getByText('打开面板不会自动清空未读。').isVisible());
  await panel.getByRole('button', { name: /^下载已完成/ }).waitFor();
  await panel.getByRole('button', { name: /^本地应用有新版本/ }).waitFor();
  await panel.getByRole('button', { name: /^智能标注完成/ }).waitFor();
  assert.ok(await panel.getByRole('button', { name: /^下载已完成/ }).isVisible());
  assert.ok(await panel.getByRole('button', { name: /^本地应用有新版本/ }).isVisible());
  assert.ok(await panel.getByRole('button', { name: /^智能标注完成/ }).isVisible());
  assert.equal(requests.some((entry) => entry.method !== 'GET' && entry.path.startsWith('/api/me/notifications')), false, 'opening the drawer must not mark anything read');

  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  await panel.waitFor({ state: 'hidden' });
  const reopened = await openNotifications(page);
  assert.ok(await reopened.getByRole('button', { name: '关闭', exact: true }).isVisible());

  await reopened.getByRole('button', { name: '标为已读：下载已完成' }).click();
  await reopened.getByRole('button', { name: '标为未读：下载已完成' }).waitFor();
  await page.getByRole('button', { name: /通知，2 条未读/ }).waitFor();
  await reopened.getByRole('button', { name: '标为未读：下载已完成' }).click();
  await reopened.getByRole('button', { name: '标为已读：下载已完成' }).waitFor();
  await page.getByRole('button', { name: /通知，3 条未读/ }).waitFor();

  await reopened.getByRole('button', { name: /全部已读/ }).click();
  await page.getByText('暂无未读通知').waitFor();
  await page.getByRole('button', { name: /^通知$/ }).waitFor();
  const stored = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) || '{}'), STORAGE_KEY);
  assert.equal(stored.items.every((item) => item.read_at), true, 'local update notice should be marked read');
  assert.ok(requests.some((entry) => entry.method === 'POST' && entry.path === '/api/me/notifications/read-all'));
  assert.ok(requests.some((entry) => entry.method === 'DELETE' && entry.path === '/api/me/notifications/task:101/read'));
});

test('clicking an unread notification marks it read and closes the drawer', async (t) => {
  const { page } = await openApp(t);
  const panel = await openNotifications(page);
  const request = page.waitForRequest((req) => req.method() === 'POST'
    && decodeURIComponent(new URL(req.url()).pathname) === '/api/me/notifications/task:101/read');
  await panel.getByRole('button', { name: /^下载已完成/ }).click();
  await request;
  await panel.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => {
    const bell = [...document.querySelectorAll('button')].find((button) => (button.getAttribute('aria-label') || '').startsWith('通知'));
    return bell?.getAttribute('aria-label') === '通知，1 条未读';
  });
});

test('mobile drawer is full width and empty histories stay explicit', async (t) => {
  const { page } = await openApp(t, { empty: true, viewport: { width: 390, height: 844 } });
  const header = page.locator('header');
  assert.equal(await header.getByText('评审用户', { exact: true }).isVisible(), false, 'the user name collapses on narrow screens');
  const panel = await openNotifications(page);
  const box = await panel.boundingBox();
  assert.ok(box && Math.abs(box.width - 390) <= 2, 'drawer should use the full mobile width');
  assert.ok(await panel.getByText('暂无未读通知').isVisible());
  assert.ok(await panel.getByText('暂无已读通知').isVisible());
  assert.equal(await page.getByRole('button', { name: /^通知$/ }).getAttribute('aria-label'), '通知');
});

test('notification list failures show retryable error states', async (t) => {
  const { page } = await openApp(t, { fail: true });
  const panel = await openNotifications(page);
  await panel.getByRole('alert').first().waitFor();
  assert.ok(await panel.getByRole('alert').first().isVisible());
  assert.ok((await panel.getByRole('alert').count()) >= 1);
  assert.equal(await panel.getByRole('button', { name: /全部已读/ }).isDisabled(), true);
});

test('toast close button sits on the top-right edge and dismisses the bubble', async (t) => {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const fulfill = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (p === '/api/me') return fulfill({ detail: '未登录' }, 401);
    if (p === '/api/config') {
      return fulfill({
        site_name: 'Slide Flow', site_description: '测试站点', logo_svg_path: '',
        tag_defaults: {}, resource_custom_tags: false, user_custom_tags: false,
        feishu_sso_enabled: false,
      });
    }
    if (p === '/api/version') return fulfill({ commit: 'test', updated_at: stamp });
    if (p === '/api/auth/setup') return fulfill({ required: false });
    if (p === '/api/auth/login') return fulfill({ detail: '用户名或密码错误' }, 401);
    if (p === '/api/user/preferences') return fulfill({ preferences: {} });
    return fulfill({});
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  await page.goto(origin + '/login');
  await page.locator('input').nth(0).fill('review');
  await page.locator('input[type="password"]').first().fill('wrong-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const toast = page.locator('[data-sonner-toast]').first();
  await toast.waitFor();
  const geometry = await toast.evaluate((element) => {
    const close = element.querySelector('[data-close-button]');
    return {
      toast: element.getBoundingClientRect().toJSON(),
      close: close?.getBoundingClientRect().toJSON() ?? null,
    };
  });
  assert.ok(geometry.close, 'toast should expose a close control');
  assert.ok(geometry.close.x > geometry.toast.x + geometry.toast.width / 2, 'close control should sit on the right half');
  assert.ok(geometry.close.y < geometry.toast.y + geometry.toast.height / 2, 'close control should sit near the top');
  await toast.locator('[data-close-button]').click();
  await toast.waitFor({ state: 'hidden' });
});
