// Exercise the real AuthProvider, QueryClient and offline-session in Chromium.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { launchBrowser } from './helpers/browser.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
let browser, server, dist, origin, state;
const account = id => ({ id, username: 'account' + id, role: 'user', session_version: 3, must_change_pwd: false });

before(async () => {
  dist = await mkdtemp(path.join(os.tmpdir(), 'slideflow-offline-auth-'));
  await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
    plugins: [{ name: 'offline-auth-test-entry', enforce: 'pre', transformIndexHtml: { order: 'pre', handler: html => html.replace('/src/main.tsx', '/tests/fixtures/offline-auth/entry.tsx') } }],
    build: { outDir: dist, emptyOutDir: true },
  });
  server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, origin || 'http://127.0.0.1');
      response.setHeader('Cache-Control', 'no-store');
      if (url.pathname === '/api/me') {
        state.meRequests++;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ user: account(state.userId) }));
        return;
      }
      const file = path.extname(url.pathname) ? url.pathname.slice(1) : 'index.html';
      if (file.includes('..')) { response.writeHead(404); response.end(); return; }
      const mime = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
      const bytes = await readFile(path.join(dist, file));
      response.setHeader('Content-Type', mime[path.extname(file)] || 'text/html');
      response.end(bytes);
    })().catch(error => { response.writeHead(500); response.end(String(error)); });
  });
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
  state = { userId: 1, meRequests: 0 };
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/auth-probe');
  await page.waitForFunction(() => window.__offlineAuth?.user?.id === 1 && !window.__offlineAuth.loading);
  await page.getByTestId('protected-player').waitFor();
  return { page, errors };
}

test('an external same-window identity lock clears queries, aborts verification and unmounts protected playback', { timeout: 60_000 }, async t => {
  const { page, errors } = await setup(t);
  await page.evaluate(() => {
    const original = window.fetch;
    const user = window.__offlineAuth.user;
    window.__offlineAuthTest.client.setQueryData(['private-data'], { private: true });
    window.__offlineAuthTest.downloads.getState().addTask(10, 'Private deck', 'a');
    window.fetch = (input, init) => {
      if (String(input).endsWith('/api/me')) {
        window.__heldSignal = init.signal;
        return new Promise(resolve => {
          // Deliberately allow a late response after abort to exercise generation checks.
          window.__releaseIdentity = () => resolve(new Response(JSON.stringify({ user }), { headers: { 'Content-Type': 'application/json' } }));
        });
      }
      return original(input, init);
    };
    window.__pendingVerification = window.__offlineAuth.reload();
  });
  await page.waitForFunction(() => !!window.__heldSignal && window.__offlineAuth.loading);
  const locked = await page.evaluate(() => {
    const { client, session, downloads } = window.__offlineAuthTest;
    session.lockOfflineIdentity();
    return { aborted: window.__heldSignal.aborted, queries: client.getQueryCache().getAll().length,
      tasks: downloads.getState().tasks.size, locked: session.isOfflineLoggedOut() };
  });
  assert.deepEqual(locked, { aborted: true, queries: 0, tasks: 0, locked: true });
  await page.getByRole('heading', { name: '需要登录' }).waitFor();
  assert.equal(await page.getByTestId('protected-player').count(), 0);
  assert.equal(await page.evaluate(() => window.__offlineAuthTest.lifecycle.unmounted), 1);
  await page.evaluate(async () => { window.__releaseIdentity(); await window.__pendingVerification; });
  assert.equal(await page.evaluate(() => window.__offlineAuth.user), null);
  assert.equal(await page.evaluate(() => window.__offlineAuthTest.session.readOfflineIdentity()), null);
  assert.deepEqual(errors, []);
});

test('normal local adoption and lease publication do not re-enter authentication or unmount playback', { timeout: 60_000 }, async t => {
  const { page, errors } = await setup(t);
  assert.equal(state.meRequests, 1, 'initial identity adoption must not start another /me request');
  await page.evaluate(() => {
    const { client, session, downloads } = window.__offlineAuthTest;
    client.setQueryData(['same-account-data'], { retained: true });
    downloads.getState().addTask(10, 'Same account deck', 'a');
    const identity = session.readOfflineIdentity();
    session.grantOfflineLease(identity, new Date(Date.now() + 60_000).toISOString());
    session.notifyPwaChange(17);
  });
  await page.evaluate(() => window.__offlineAuth.reload());
  assert.equal(state.meRequests, 2);
  assert.deepEqual(await page.evaluate(() => window.__offlineAuthTest.client.getQueryData(['same-account-data'])), { retained: true });
  assert.equal(await page.evaluate(() => window.__offlineAuthTest.downloads.getState().tasks.size), 1);
  state.userId = 2;
  await page.evaluate(() => window.__offlineAuth.reload());
  await page.waitForFunction(() => window.__offlineAuth.user?.id === 2 && !window.__offlineAuth.loading);
  assert.equal(state.meRequests, 3, 'account adoption must not recursively revalidate');
  assert.equal(await page.evaluate(() => window.__offlineAuthTest.downloads.getState().tasks.size), 0);
  assert.deepEqual(await page.evaluate(() => window.__offlineAuthTest.lifecycle), { mounted: 1, unmounted: 0 });
  assert.equal(await page.evaluate(() => window.__offlineAuthTest.session.isOfflineLoggedOut()), false);
  assert.deepEqual(errors, []);
});
