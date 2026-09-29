// Native service-worker integration using the project's Playwright dependency.
// This anonymous production-shell test must preserve the real RequireAuth guard.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../web/tests/helpers/browser.mjs';

const root = fileURLToPath(new URL('../app/static/dist/', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error('Browser condition timed out: ' + description);
}

test('native shell guards anonymous offline Display navigation and waits for every old window before updating', { timeout: 60_000 }, async () => {
  assert.ok(existsSync(path.join(root, 'sw.js')), 'Missing production build: run npm run build from web/ before test:pwa:browser');
  const builtWorker = await readFile(path.join(root, 'sw.js'), 'utf8');
  const config = JSON.parse(builtWorker.match(/const SHELL_CONFIG = (.+);/)[1]);
  const workerTemplate = await readFile(new URL('../web/pwa/service-worker.js', import.meta.url), 'utf8');
  const workerSource = workerTemplate.replace('__SLIDEFLOW_PWA_CONFIG__', JSON.stringify(config));
  const files = new Map(await Promise.all(config.files.map(async file => [file.url, await readFile(path.join(root, file.url))])));
  const mime = value => value.endsWith('.js') ? 'text/javascript' : value.endsWith('.css') ? 'text/css'
    : value.endsWith('.svg') ? 'image/svg+xml' : value.endsWith('.png') ? 'image/png'
      : value.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html';
  let nextVersion = false;
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Cache-Control', 'no-store');
    if (pathname === '/sw.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.setHeader('Service-Worker-Allowed', '/');
      response.end(nextVersion ? workerSource.replace(config.version, config.version + '-next') : workerSource);
    } else if (pathname.startsWith('/api/')) {
      response.writeHead(403, { 'Content-Type': 'application/json' });
      response.end('{"detail":"Denied in isolated test"}');
    } else if (pathname === '/__pwa_probe') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>PWA probe</title>');
    } else {
      const file = files.has(pathname) ? pathname : pathname.startsWith('/assets/') ? null : '/index.html';
      if (!file) { response.writeHead(404); response.end(); return; }
      response.setHeader('Content-Type', mime(file));
      response.end(files.get(file));
    }
  });
  let browser;
  try {
    browser = await launchBrowser();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext();
    const status = page => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const channel = new MessageChannel();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { channel.port1.close(); reject(new Error('Worker status timed out')); }, 5_000);
        channel.port1.onmessage = event => { clearTimeout(timeout); channel.port1.close(); resolve(event.data); };
        registration.active.postMessage({ type: 'SLIDEFLOW_SHELL_STATUS' }, [channel.port2]);
      });
    });
    const first = await context.newPage();
    await first.goto(origin + '/__pwa_probe');
    await first.evaluate(() => navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }));
    await first.waitForFunction(() => !!navigator.serviceWorker.controller);
    assert.equal((await status(first)).ready, true);
    assert.equal(await first.evaluate(() => fetch('/api/forbidden').then(response => response.status)), 403);
    await context.setOffline(true);
    assert.equal(await first.evaluate(() => fetch('/api/forbidden').then(() => false, () => true)), true);

    const guarded = await context.newPage();
    const responses = [], requests = [];
    guarded.on('response', response => responses.push(response));
    guarded.on('request', request => requests.push(request.url()));
    const documentResponse = await guarded.goto(origin + '/shows/42/display?offline=true');
    await guarded.waitForURL(origin + '/login');
    await guarded.locator('input[name="username"]').waitFor();
    assert.equal(documentResponse.fromServiceWorker(), true);
    const loginResponse = responses.find(response => response.url().includes('/LoginPage-'));
    assert.ok(loginResponse, 'The guarded route must lazy-load the login UI offline');
    assert.equal(loginResponse.fromServiceWorker(), true);
    assert.equal(requests.some(url => url.includes('/DisplayPage-')), false, 'Unauthenticated users must not mount DisplayPage');
    assert.equal(requests.some(url => new URL(url).pathname.startsWith('/api/shows/42')), false);
    assert.equal(await guarded.locator('img[src^="blob:"]').count(), 0);
    assert.equal((await status(guarded)).version, config.version);
    await guarded.evaluate(() => { window.__pwaWindowContinuity = 123; });

    nextVersion = true;
    await context.setOffline(false);
    await first.evaluate(() => navigator.serviceWorker.getRegistration().then(registration => registration.update()));
    // Await asynchronous browser work with evaluate + node polling; waitForFunction predicates stay synchronous.
    await until(() => first.evaluate(() => navigator.serviceWorker.getRegistration().then(registration => !!registration.waiting)), 'new worker waiting');
    assert.equal((await status(guarded)).version, config.version);
    assert.equal(await guarded.evaluate(() => window.__pwaWindowContinuity), 123);
    await first.close();
    assert.equal((await status(guarded)).version, config.version);
    await guarded.close();
    await delay(250);
    const reopened = await context.newPage();
    await reopened.goto(origin + '/__pwa_probe');
    await reopened.waitForFunction(() => !!navigator.serviceWorker.controller);
    await until(async () => (await status(reopened)).version === config.version + '-next', 'new worker activated');
    assert.equal((await status(reopened)).ready, true);
    console.log(`Validated ${config.files.length} shell files, offline RequireAuth/login lazy loading and deferred multi-window update`);
  } finally {
    await browser?.close();
    if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
});
