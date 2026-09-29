import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const template = await readFile(new URL('../web/pwa/service-worker.js', import.meta.url), 'utf8');
const origin = 'https://slideflow.test';
const hash = value => createHash('sha256').update(value).digest('hex');
const assetBodies = {
  '/index.html': ['<html>offline shell</html>', 'text/html'],
  '/assets/main-12345678.js': ['export const main = 1;', 'text/javascript'],
  '/assets/Presenter-abcdef12.js': ['export const presenter = 1;', 'application/javascript'],
  '/assets/app-12345678.css': ['body { color: black; }', 'text/css'],
};

function environment({ failure, sharedCaches, version = 'one' } = {}) {
  const records = sharedCaches || new Map();
  const handlers = new Map();
  const network = [];
  let claimed = 0;
  let skipped = 0;
  const keyOf = value => new URL(typeof value === 'string' ? value : value.url, origin).href;
  const caches = {
    async open(name) {
      if (!records.has(name)) records.set(name, new Map());
      const items = records.get(name);
      return {
        async match(key) { return items.get(keyOf(key))?.clone(); },
        async put(key, response) { items.set(keyOf(key), response.clone()); },
        async keys() { return [...items.keys()].map(url => new Request(url)); },
      };
    },
    async keys() { return [...records.keys()]; },
    async has(name) { return records.has(name); },
    async delete(name) { return records.delete(name); },
  };
  const context = {
    caches, URL, Request, Response, Map, Set, Array, Uint8Array, Date, Promise, AbortController,
    crypto: webcrypto, setTimeout, clearTimeout,
    self: {
      location: { origin },
      clients: { async claim() { claimed++; } },
      async skipWaiting() { skipped++; },
      addEventListener(name, handler) { handlers.set(name, handler); },
    },
    async fetch(input, options) {
      const path = new URL(typeof input === 'string' ? input : input.url, origin).pathname;
      network.push({ path, options });
      const override = failure?.(path);
      if (override) return override;
      const entry = assetBodies[path];
      if (!entry) throw new Error('Offline');
      return new Response(entry[0], { headers: { 'Content-Type': entry[1] } });
    },
  };
  const config = { version, files: Object.entries(assetBodies).map(([url, [body]]) => ({ url, sha256: hash(body) })) };
  vm.runInNewContext(template.replace('__SLIDEFLOW_PWA_CONFIG__', JSON.stringify(config)), context);
  const lifecycle = name => {
    let done;
    handlers.get(name)({ waitUntil(promise) { done = promise; } });
    return done;
  };
  const fetch = (path, { method = 'GET', mode = 'cors' } = {}) => {
    let result;
    handlers.get('fetch')({ request: { url: new URL(path, origin).href, method, mode }, respondWith(promise) { result = promise; } });
    return result;
  };
  const status = async () => {
    let result; let done;
    handlers.get('message')({ data: { type: 'SLIDEFLOW_SHELL_STATUS' }, ports: [{ postMessage(value) { result = value; } }], waitUntil(promise) { done = promise; } });
    await done;
    return result;
  };
  return { lifecycle, fetch, status, caches, records, network, get claimed() { return claimed; }, get skipped() { return skipped; } };
}

test('complete installation precaches the shell and lazy presenter chunk, then claims first-use clients', async () => {
  const worker = environment();
  assert.equal((await worker.status()).ready, false);
  await worker.lifecycle('install');
  assert.equal((await worker.status()).ready, true);
  await worker.lifecycle('activate');
  assert.equal(worker.claimed, 1);
  assert.equal(worker.skipped, 0);
  const response = await worker.fetch('/shows/42/present?offline=true', { mode: 'navigate' });
  assert.equal(await response.text(), assetBodies['/index.html'][0]);
  assert.equal(await (await worker.fetch('/assets/Presenter-abcdef12.js')).text(), assetBodies['/assets/Presenter-abcdef12.js'][0]);
  assert.equal(worker.network.length, Object.keys(assetBodies).length);
  for (const request of worker.network) {
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.redirect, 'error');
  }
});

test('authenticated requests, signed media, missing files and external origins always bypass the shell cache', async () => {
  const worker = environment();
  await worker.lifecycle('install');
  for (const path of ['/api/me', '/api/slides/4/image?session_token=secret', '/storage/picture.png', '/ws/events',
    '/static/private.png', '/assets/main-12345678.js?token=secret', '/assets/missing.js', 'https://other.test/assets/main-12345678.js']) {
    assert.equal(worker.fetch(path), undefined, path);
    assert.equal(worker.fetch(path, { mode: 'navigate' }), undefined, path);
  }
  assert.equal(worker.fetch('/api/me', { method: 'POST' }), undefined);
});

test('HTTP failures, mismatched builds and HTML substituted for JavaScript fail atomically', async () => {
  for (const [name, failure] of [
    ['permission denial', path => path.endsWith('.js') ? new Response('denied', { status: 403 }) : null],
    ['mismatched build', path => path === '/index.html' ? new Response('new build', { headers: { 'Content-Type': 'text/html' } }) : null],
    ['HTML fallback', path => path.endsWith('.js') ? new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }) : null],
  ]) {
    const worker = environment({ failure });
    await assert.rejects(worker.lifecycle('install'), undefined, name);
    assert.equal((await worker.status()).ready, false, name);
    assert.deepEqual(await worker.caches.keys(), [], name);
    assert.equal(worker.skipped, 0);
  }
});

test('failed new installation leaves the active build intact', async () => {
  const old = environment({ version: 'old' });
  await old.lifecycle('install');
  const next = environment({ version: 'new', sharedCaches: old.records, failure: () => new Response('', { status: 503 }) });
  await assert.rejects(next.lifecycle('install'));
  assert.equal((await old.status()).ready, true);
  assert.deepEqual(await next.caches.keys(), ['slideflow-shell-old']);
});

test('readiness detects storage eviction and activation keeps two prior builds without deleting user data', async () => {
  const worker = environment();
  await worker.lifecycle('install');
  worker.records.get('slideflow-shell-one').delete(origin + '/assets/Presenter-abcdef12.js');
  assert.equal((await worker.status()).ready, false);
  await assert.rejects(worker.lifecycle('activate'));
  await worker.lifecycle('install');
  assert.equal((await worker.status()).ready, true);
  for (let index = 1; index <= 3; index++) {
    const cache = await worker.caches.open('slideflow-shell-old' + index);
    await cache.put('/__slideflow_shell_ready__', new Response(JSON.stringify({ installedAt: index })));
  }
  await worker.caches.open('slideflow-offline-user-data');
  await worker.lifecycle('activate');
  assert.deepEqual((await worker.caches.keys()).sort(), ['slideflow-offline-user-data', 'slideflow-shell-old2', 'slideflow-shell-old3', 'slideflow-shell-one']);
  assert.equal(worker.skipped, 0);
});
