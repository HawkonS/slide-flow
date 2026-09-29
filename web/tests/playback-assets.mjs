import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

async function loadSource(file) {
  const source = (await readFile(new URL('../src/lib/' + file, import.meta.url), 'utf8')).replace(/^import .* from 'react';\n/, '');
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));
}
const { PlaybackAssets, isPlaybackTransportError, isPlaybackAccessError, playbackSnapshot } = await loadSource('playback-assets.ts');
const { PresentChannel, presentChannelName, isPresentMessage } = await loadSource('present-channel.ts');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function objectUrls() {
  const created = [], revoked = [];
  return { created, revoked, createUrl: () => { const url = 'blob:test-' + created.length; created.push(url); return url; }, revokeUrl: url => revoked.push(url) };
}

test('concurrent callers share one read and bounded prefetch never exceeds its limit', async () => {
  const urls = objectUrls();
  let active = 0, maximum = 0, reads = 0;
  const gates = [];
  const pool = new PlaybackAssets(async () => {
    reads++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => gates.push(resolve)); active--; return new Blob(['image']);
  }, { ...urls, concurrency: 2 });
  pool.retain([0, 1, 2, 3, 4]);
  const first = pool.load(0);
  assert.equal(pool.load(0, 'image', true), first);
  const all = [first, ...[1, 2, 3, 4].map(index => pool.load(index))];
  assert.equal(active, 2);
  while (reads < 5 || active) { gates.splice(0).forEach(resolve => resolve()); await tick(); }
  await Promise.all(all);
  assert.equal(reads, 5); assert.equal(maximum, 2);
  pool.dispose(); assert.deepEqual(urls.revoked.sort(), urls.created.sort());
});

test('navigation releases distant HD images and keeps the visible slide within the byte budget', async () => {
  const urls = objectUrls();
  const pool = new PlaybackAssets(async () => new Blob(['0123456789']), { ...urls, maxImages: 3, maxImageBytes: 25 });
  pool.retain([0, 1, 2]);
  const visible = await pool.load(0); await pool.load(1); await pool.load(2);
  assert.equal(pool.peek(0, 'image'), visible);
  assert.equal([0, 1, 2].filter(index => pool.peek(index, 'image')).length, 2);
  pool.retain([3, 4]);
  assert.equal(pool.peek(0, 'image'), ''); assert.ok(urls.revoked.includes(visible));
  await pool.load(3); pool.dispose(); assert.equal(urls.created.length, urls.revoked.length);
});

test('a cancelled queued page can be requested again immediately without inheriting its rejected promise', async () => {
  const urls = objectUrls(), gates = [];
  const pool = new PlaybackAssets(async () => { await new Promise(resolve => gates.push(resolve)); return new Blob(['x']); }, { ...urls, concurrency: 1 });
  pool.retain([0, 1]); const first = pool.load(0); const cancelled = pool.load(1);
  pool.retain([0]); pool.retain([0, 1]); const retry = pool.load(1);
  assert.notEqual(retry, cancelled);
  await assert.rejects(cancelled, error => error.name === 'AbortError');
  gates.shift()(); await first; await tick(); gates.shift()(); await retry;
  pool.dispose();
});

test('disposal rejects queued work and a late read cannot create an orphan object URL', async () => {
  const urls = objectUrls(); let release;
  const pool = new PlaybackAssets(() => new Promise(resolve => { release = resolve; }), { ...urls, concurrency: 1 });
  pool.retain([0, 1]); const first = pool.load(0), queued = pool.load(1);
  pool.dispose(); release(new Blob(['late']));
  await assert.rejects(first, error => error.name === 'AbortError');
  await assert.rejects(queued, error => error.name === 'AbortError');
  assert.equal(urls.created.length, 0);
});

test('only failed transport permits fallback; denial and corrupt metadata remain explicit errors', () => {
  assert.equal(isPlaybackTransportError(new TypeError('Failed to fetch')), true);
  assert.equal(isPlaybackTransportError(new DOMException('timeout', 'TimeoutError')), true);
  for (const status of [401, 403, 404, 409, 500]) assert.equal(isPlaybackTransportError({ status }), false);
  for (const status of [401, 403, 404]) assert.equal(isPlaybackAccessError({ status }), true);
  assert.equal(isPlaybackTransportError(new SyntaxError('Invalid JSON')), false);
  assert.equal(isPlaybackTransportError(new DOMException('cancelled', 'AbortError')), false);
});

test('the playback snapshot preserves order, hidden flags and pinned versions', () => {
  const original = { id: 8, version_no: 2, resources: [{ id: 3, version_no: 7, hidden: true, accessible: true }] };
  for (const resource of [{ ...original.resources[0], hidden: false }, { ...original.resources[0], version_no: 8 }, { ...original.resources[0], accessible: false }]) {
    assert.notEqual(playbackSnapshot(original), playbackSnapshot({ ...original, resources: [resource] }));
  }
});

test('presentation channels isolate users, login generations, playback sessions and fixed packages', async () => {
  const previous = globalThis.BroadcastChannel;
  const peers = [];
  globalThis.BroadcastChannel = class {
    constructor(name) { this.name = name; peers.push(this); }
    postMessage(data) { for (const peer of peers) if (peer !== this && peer.name === this.name) peer.onmessage?.({ data }); }
    close() { peers.splice(peers.indexOf(this), 1); }
  };
  const scope = { ownerKey: '1:2', sessionId: 'a'.repeat(32), packageId: 'package-a' };
  const sender = new PresentChannel(8, scope), intended = new PresentChannel(8, scope);
  const foreign = [new PresentChannel(8, { ...scope, ownerKey: '2:2' }), new PresentChannel(8, { ...scope, ownerKey: '1:3' }), new PresentChannel(8, { ...scope, sessionId: 'b'.repeat(32) }), new PresentChannel(8, { ...scope, packageId: 'package-b' })];
  let delivered = 0, leaked = 0;
  intended.onMessage(() => delivered++); foreign.forEach(channel => channel.onMessage(() => leaked++));
  sender.send({ type: 'slide-change', resourceId: 4, index: 1 });
  assert.equal(delivered, 1); assert.equal(leaked, 0);
  assert.throws(() => presentChannelName(8, { ...scope, sessionId: '' }));
  assert.equal(isPresentMessage({ type: 'pen-draw', points: [{ x: Infinity, y: 0 }], width: 2, color: '#ff0000' }), false);
  assert.equal(isPresentMessage({ type: 'sync-state', index: 0, resourceId: 1, source: 'cache', snapshot: 'fixed', packageId: 'package-a' }), true);
  [sender, intended, ...foreign].forEach(channel => channel.close()); globalThis.BroadcastChannel = previous;
});
