import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/offline-cache.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { readLegacyManifest, getDirectoryHandle } = await import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));
const origin = 'https://slideflow.test';
const manifest = () => ({ version: 2, server_url: origin, shows: { '7': { id: 7, name: 'Legacy show', version_no: 3, auth_hash: 'untrusted', resources: ['old.png'] } } });
function directory(files) {
  const reads = [];
  return { reads, async getFileHandle(name, options) {
    reads.push({ name, options });
    if (!(name in files)) throw new DOMException('Missing', 'NotFoundError');
    const value = files[name];
    if (value instanceof Error) throw value;
    return { async getFile() { return typeof value === 'string' ? new File([value], name) : value; } };
  } };
}
const parse = value => readLegacyManifest(directory({ 'manifest.json': JSON.stringify(value) }), origin);

test('legacy JSON and anchored assignment return only bounded re-download metadata', async () => {
  for (const files of [{ 'manifest.json': JSON.stringify(manifest()), 'info.js': 'throw 1' },
    { 'manifest.js': 'window.__OFFLINE_MANIFEST = ' + JSON.stringify(manifest()) + ';', 'info.js': 'throw 1' }]) {
    const handle = directory(files);
    assert.deepEqual(await readLegacyManifest(handle, origin), [{ show_id: 7, name: 'Legacy show', version_no: 3 }]);
    assert.ok(handle.reads.every(read => /^manifest\.(json|js)$/.test(read.name) && read.options === undefined));
  }
});

test('legacy parsing never executes scripts or accepts surrounding code', async () => {
  const json = JSON.stringify(manifest());
  for (const text of ['globalThis.__legacyExecuted = true;' + json,
    'window.__OFFLINE_MANIFEST = ' + json + '; globalThis.__legacyExecuted = true;',
    'window.__OFFLINE_MANIFEST = {version: 2};',
    'window.__OFFLINE_MANIFEST = (() => { globalThis.__legacyExecuted = true; return ' + json + '; })();']) {
    await assert.rejects(readLegacyManifest(directory({ 'manifest.js': text }), origin));
    assert.equal(globalThis.__legacyExecuted, undefined);
    assert.equal(globalThis.__OFFLINE_MANIFEST, undefined);
  }
});

test('oversized legacy files fail before text is read', async () => {
  let read = false;
  const handle = directory({ 'manifest.json': { size: 2 * 1024 * 1024 + 1, async text() { read = true; return '{}'; } } });
  await assert.rejects(readLegacyManifest(handle, origin), /清单过大/);
  assert.equal(read, false);
});

test('legacy manifests reject invalid structures, formats and other origins', async () => {
  for (const value of [null, [], 'bad', { ...manifest(), version: 3 }, { ...manifest(), shows: [] },
    { ...manifest(), shows: null }, { ...manifest(), server_url: 'https://other.test' },
    { ...manifest(), server_url: 'not a URL' }, { ...manifest(), server_url: 'javascript:alert(1)' }]) {
    await assert.rejects(parse(value));
  }
});

test('legacy IDs and versions are strict, duplicate aliases are ignored, and names are bounded', async () => {
  const row = (id, version_no = 1, name = 'entry') => ({ id, version_no, name });
  const data = { ...manifest(), shows: {
    '7': row(7, 3, 'x'.repeat(600)), '07': row(7), '7e0': row(7), '8': row(9),
    '9': row(9, 0), '10': row(10, 1.5), '11': row(11, '1'), '12': row(12, 1, null),
    '0': row(0), '-1': row(-1), '9007199254740992': row(9007199254740992),
  } };
  assert.deepEqual(await parse(data), [{ show_id: 7, name: 'x'.repeat(500), version_no: 3 }]);
});

test('legacy entry counts are capped before migration', async () => {
  const shows = Object.fromEntries(Array.from({ length: 10001 }, (_, i) => [String(i + 1), { id: i + 1, name: 's', version_no: 1 }]));
  await assert.rejects(parse({ ...manifest(), shows }), /条目过多/);
  delete shows['10001'];
  assert.equal((await parse({ ...manifest(), shows })).length, 10000);
});

test('legacy read permission errors never fall back to another file', async () => {
  const handle = directory({ 'manifest.json': new DOMException('Denied', 'NotAllowedError'), 'manifest.js': JSON.stringify(manifest()) });
  await assert.rejects(readLegacyManifest(handle, origin), error => error.name === 'NotAllowedError');
  assert.deepEqual(handle.reads, [{ name: 'manifest.json', options: undefined }]);
});

test('saved legacy handles use only a readonly transaction and validate the handle', async t => {
  const previous = globalThis.indexedDB;
  t.after(() => { globalThis.indexedDB = previous; });
  for (const value of [{ kind: 'directory', getFileHandle() {} }, { kind: 'file' }, 'bad']) {
    const calls = [];
    globalThis.indexedDB = { open(...args) {
      calls.push(['open', ...args]);
      const request = { result: { objectStoreNames: { contains: name => name === 'settings' }, close() { calls.push(['close']); },
        transaction(name, mode) {
          calls.push(['transaction', name, mode]);
          const tx = { objectStore(name) {
            calls.push(['store', name]);
            return { get(key) {
              calls.push(['get', key]);
              const read = { result: value };
              queueMicrotask(() => { read.onsuccess(); tx.oncomplete(); });
              return read;
            } };
          } };
          return tx;
        } } };
      queueMicrotask(() => request.onsuccess());
      return request;
    } };
    assert.equal(await getDirectoryHandle(), value.kind === 'directory' ? value : null);
    assert.deepEqual(calls, [['open', 'slideflow-offline-cache'], ['transaction', 'settings', 'readonly'], ['store', 'settings'], ['get', 'dir-handle'], ['close']]);
  }
});

test('a missing legacy database is not created for migration', async t => {
  const previous = globalThis.indexedDB;
  t.after(() => { globalThis.indexedDB = previous; });
  let aborted = false;
  globalThis.indexedDB = { open() {
    const request = { transaction: { abort() { aborted = true; queueMicrotask(() => request.onerror()); } } };
    queueMicrotask(() => request.onupgradeneeded());
    return request;
  } };
  assert.equal(await getDirectoryHandle(), null);
  assert.equal(aborted, true);
});
