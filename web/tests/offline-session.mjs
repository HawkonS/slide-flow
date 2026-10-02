import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

async function source(name) {
  const text = await readFile(new URL('../src/lib/' + name, import.meta.url), 'utf8');
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64') + '#' + crypto.randomUUID());
}
class Storage {
  entries = new Map(); failRead = false; failWrite = false;
  getItem(key) { if (this.failRead) throw new DOMException('blocked', 'SecurityError'); return this.entries.get(key) ?? null; }
  setItem(key, value) { if (this.failWrite) throw new DOMException('full', 'QuotaExceededError'); this.entries.set(key, String(value)); }
  removeItem(key) { this.entries.delete(key); }
}
class Channel {
  static peers = [];
  constructor(name) { this.name = name; this.sent = []; Channel.peers.push(this); }
  postMessage(data) { this.sent.push(data); }
  close() { Channel.peers = Channel.peers.filter(item => item !== this); }
}
const user = { id: 7, username: 'seven', name: 'Seven', role: 'system_admin', session_version: 3, tags: 'privileged', avatar_url: '/private.png', must_change_pwd: false };
async function fresh(t) {
  const oldWindow = globalThis.window, oldChannel = globalThis.BroadcastChannel;
  const storage = new Storage();
  const target = Object.assign(new EventTarget(), { localStorage: storage });
  globalThis.window = target; globalThis.BroadcastChannel = Channel;
  t.after(() => { globalThis.window = oldWindow; globalThis.BroadcastChannel = oldChannel; Channel.peers = []; });
  return { session: await source('offline-session.ts'), storage, target };
}
function online(session, account = user) { return session.rememberOnlineIdentity(account, session.offlineAuthEpoch()); }

test('stored identity strips administrator roles and account capabilities', async t => {
  const { session: s, storage } = await fresh(t);
  const identity = online(s);
  assert.equal(identity.user.role, 'user');
  assert.equal(identity.sessionVersion, 3);
  assert.equal(identity.expiresAt, 0);
  assert.equal(identity.user.tags, undefined);
  assert.equal(identity.user.avatar_url, undefined);
  assert.equal(storage.getItem(s.OFFLINE_SESSION_KEY).includes('system_admin'), false);
  assert.equal(storage.getItem(s.OFFLINE_SESSION_KEY).includes('privileged'), false);
  assert.equal(s.offlineOwnerKey(identity), `7:3:${identity.epoch}`);
});

test('expired identities remain readable for renewal but granting a lease preserves generation', async t => {
  const { session: s } = await fresh(t);
  const identity = online(s);
  assert.equal(s.readOfflineIdentity().expiresAt, 0);
  s.assertOfflineIdentity(identity);
  const expiry = new Date(Date.now() + 60_000).toISOString();
  s.grantOfflineLease(identity, expiry);
  assert.equal(s.readOfflineIdentity().expiresAt, Date.parse(expiry));
  assert.equal(s.offlineOwnerKey(s.readOfflineIdentity()), s.offlineOwnerKey(identity));
  s.grantOfflineLease(identity, new Date(Date.now() + 30_000).toISOString());
  assert.equal(s.readOfflineIdentity().expiresAt, Date.parse(expiry));
  assert.throws(() => s.grantOfflineLease(identity, new Date(0).toISOString()));
});

test('logout synchronously locks identity and blocks late grants and login completions', async t => {
  const { session: s, target } = await fresh(t);
  const identity = online(s);
  let observedUnlocked = false;
  target.addEventListener('slideflow-pwa-change', () => { if (s.readOfflineIdentity()) observedUnlocked = true; });
  const attempt = s.beginOfflineLogin();
  s.lockOfflineIdentity();
  assert.equal(s.readOfflineIdentity(), null);
  assert.equal(s.isOfflineLoggedOut(), true);
  assert.equal(observedUnlocked, false);
  assert.throws(() => s.assertOfflineIdentity(identity));
  assert.throws(() => s.grantOfflineLease(identity, new Date(Date.now() + 60_000).toISOString()));
  assert.throws(() => s.completeOfflineLogin(attempt));
  assert.throws(() => s.rememberOnlineIdentity(user, identity.epoch));
});

test('an explicit later login clears the marker without reusing the old owner namespace', async t => {
  const { session: s } = await fresh(t);
  const first = online(s);
  s.lockOfflineIdentity();
  const attempt = s.beginOfflineLogin();
  s.completeOfflineLogin(attempt);
  assert.equal(s.isOfflineLoggedOut(), false);
  assert.equal(s.readOfflineIdentity(), null, 'login payload alone must not create offline access');
  const second = s.rememberOnlineIdentity(user, attempt);
  assert.notEqual(s.offlineOwnerKey(second), s.offlineOwnerKey(first));
  assert.equal(second.expiresAt, 0);
});

test('fresh /me account and session changes invalidate an earlier owner', async t => {
  const { session: s } = await fresh(t);
  const first = online(s);
  const second = online(s, { ...user, id: 8, username: 'eight' });
  assert.notEqual(first.epoch, second.epoch);
  assert.throws(() => s.assertOfflineIdentity(first));
  const third = online(s, { ...user, id: 8, username: 'eight', session_version: 4 });
  assert.notEqual(second.epoch, third.epoch);
  assert.throws(() => s.assertOfflineIdentity(second));
});

test('missing session_version and forced password changes never enable caching', async t => {
  const { session: s } = await fresh(t);
  assert.equal(online(s, { ...user, session_version: undefined }), null);
  assert.equal(online(s, { ...user, must_change_pwd: true }), null);
  assert.equal(s.readOfflineIdentity(), null);
});

test('corrupted snapshots fail closed while live login and storage failures remain recoverable', async t => {
  const { session: s, storage } = await fresh(t);
  storage.setItem(s.OFFLINE_SESSION_KEY, 'invalid-json');
  assert.equal(s.readOfflineIdentity(), null);
  const identity = online(s);
  assert.equal(identity.user.id, 7);
  storage.failWrite = true;
  assert.equal(online(s), null);
  assert.equal(s.readOfflineIdentity(), null);
  storage.failRead = true;
  assert.doesNotThrow(() => s.offlineAuthEpoch());
  assert.equal(s.readOfflineIdentity(), null);
  s.lockOfflineIdentity();
  assert.equal(s.isOfflineLoggedOut(), true);
});

test('lease persistence errors propagate so a cache publisher retains the previous ready package', async t => {
  const { session: s, storage } = await fresh(t);
  const identity = online(s);
  storage.failWrite = true;
  assert.throws(() => s.grantOfflineLease(identity, new Date(Date.now() + 60_000).toISOString()), /存储|保存/);
});

test('PWA changes notify the current window and leave a cross-window signal', async t => {
  const { session: s, target, storage } = await fresh(t);
  const ownerKey = s.offlineOwnerKey(online(s));
  const stop = s.installOfflineSessionSync(); t.after(stop);
  const changes = []; target.addEventListener('slideflow-pwa-change', event => changes.push(event.detail));
  s.notifyPwaChange(17, { ownerKey, reason: 'revoked' });
  for (const detail of [changes[0], JSON.parse(storage.getItem('slideflow-pwa-change-v3')), Channel.peers[0].sent.at(-1)]) {
    assert.equal(detail.showId, 17);
    assert.equal(detail.ownerKey, ownerKey);
    assert.equal(detail.reason, 'revoked');
  }
  s.notifyPwaChange(17);
  assert.equal(changes.at(-1).reason, undefined, 'ordinary publication must not become revocation');
  assert.equal(changes.at(-1).ownerKey, undefined);
});

test('cross-window revocation and deletion signals preserve only approved fields', async t => {
  const { session: s, target } = await fresh(t);
  const stop = s.installOfflineSessionSync(); t.after(stop);
  const ownerKey = s.offlineOwnerKey(online(s));
  const changes = []; target.addEventListener('slideflow-pwa-change', event => changes.push(event.detail));
  Channel.peers[0].onmessage({ data: { type: 'cache', sender: 'another-tab', showId: 17, ownerKey, reason: 'revoked', remote: false, unexpected: 'ignore' } });
  assert.deepEqual(changes.at(-1), { showId: 17, ownerKey, reason: 'revoked', remote: true });
  const event = Object.assign(new Event('storage'), { key: 'slideflow-pwa-change-v3', newValue: JSON.stringify({ showId: 18, ownerKey, reason: 'deleted', remote: false, unexpected: 'ignore' }) });
  target.dispatchEvent(event);
  assert.deepEqual(changes.at(-1), { showId: 18, ownerKey, reason: 'deleted', remote: true });
});

test('malformed cross-window cache signals cannot forward invalid revocation fields', async t => {
  const { session: s, target } = await fresh(t);
  const stop = s.installOfflineSessionSync(); t.after(stop);
  const changes = []; target.addEventListener('slideflow-pwa-change', event => changes.push(event.detail));
  for (const payload of [
    { showId: '17', ownerKey: 'x'.repeat(257), reason: 'invalid' },
    { showId: -1, ownerKey: {}, reason: ['revoked'] },
    { showId: Number.MAX_SAFE_INTEGER + 1, ownerKey: '', reason: null },
  ]) {
    Channel.peers[0].onmessage({ data: { type: 'cache', sender: 'another-tab', ...payload } });
    assert.deepEqual(changes.at(-1), { remote: true });
    target.dispatchEvent(Object.assign(new Event('storage'), { key: 'slideflow-pwa-change-v3', newValue: JSON.stringify(payload) }));
    assert.deepEqual(changes.at(-1), { remote: true });
  }
  target.dispatchEvent(Object.assign(new Event('storage'), { key: 'slideflow-pwa-change-v3', newValue: 'broken-json' }));
  assert.deepEqual(changes.at(-1), { remote: true });
});

test('a late broadcast for a previous epoch cannot revoke a newer shared identity', async t => {
  const { session: s } = await fresh(t);
  const stop = s.installOfflineSessionSync(); t.after(stop);
  const first = online(s);
  const second = online(s, { ...user, id: 8 });
  Channel.peers[0].onmessage({ data: { type: 'session', sender: 'another-tab', epoch: first.epoch, loggedOut: true } });
  Channel.peers[0].onmessage({ data: { type: 'session', sender: 'another-tab', epoch: crypto.randomUUID(), previousEpoch: first.epoch, loggedOut: true } });
  assert.equal(s.offlineOwnerKey(s.readOfflineIdentity()), s.offlineOwnerKey(second));
});

test('logout broadcasts lock another tab when storage is readable but writes fail', async t => {
  const { session: s, storage } = await fresh(t);
  const stop = s.installOfflineSessionSync(); t.after(stop);
  const identity = online(s);
  const remote = await source('offline-session.ts');
  const stopRemote = remote.installOfflineSessionSync(); t.after(stopRemote);
  assert.equal(remote.offlineAuthEpoch(), identity.epoch);
  storage.failWrite = true;
  remote.lockOfflineIdentity();
  const message = Channel.peers[1].sent.findLast(item => item.type === 'session');
  assert.equal(message.previousEpoch, identity.epoch);
  Channel.peers[0].onmessage({ data: message });
  assert.equal(s.isOfflineLoggedOut(), true);
  assert.equal(s.readOfflineIdentity(), null);
  assert.throws(() => s.assertOfflineIdentity(identity));
});

test('offline route allowlist grants only cache management and the three players', async t => {
  const { session: s } = await fresh(t);
  for (const path of ['/manage/offline-cache', '/manage/offline-cache/', '/shows/7/present', '/shows/7/display', '/shows/7/fullscreen']) assert.equal(s.isOfflineRouteAllowed(path), true, path);
  for (const path of ['/home', '/admin/users', '/resources', '/shows/7', '/shows/0/display', '/shows/7/display/extra', '/shows/7/iterate']) assert.equal(s.isOfflineRouteAllowed(path), false, path);
});

test('late 401 from an old request cannot invoke the new session unauthorized handler', async t => {
  const a = await source('api.ts');
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  let finish, denied = 0;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  a.setUnauthorizedHandler(() => { denied++; });
  const pending = a.api('/api/me');
  a.advanceApiSession();
  finish(new Response(JSON.stringify({ detail: 'expired' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(pending, error => error instanceof a.ApiError && error.status === 401);
  assert.equal(denied, 0);
  globalThis.fetch = async () => new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(a.api('/api/me'));
  assert.equal(denied, 1);
});

test('replacing the unauthorized callback also invalidates earlier pending requests', async t => {
  const a = await source('api.ts'); const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  let finish, first = 0, second = 0;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  a.setUnauthorizedHandler(() => { first++; });
  const pending = a.api('/api/me');
  a.setUnauthorizedHandler(() => { second++; });
  finish(new Response('{}', { status: 401 }));
  await assert.rejects(pending);
  assert.deepEqual([first, second], [0, 0]);
});

test('only failures raised by fetch transport allow offline identity restoration', async t => {
  const a = await source('api.ts'); const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(a.api('/api/me'), error => error instanceof a.ApiTransportError);
  for (const status of [401, 403, 404, 409, 500]) {
    globalThis.fetch = async () => new Response('{}', { status, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(a.api('/api/me'), error => error instanceof a.ApiError && !(error instanceof a.ApiTransportError));
  }
  globalThis.fetch = async () => new Response('broken-json', { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(a.api('/api/me'), error => error instanceof SyntaxError && !(error instanceof a.ApiTransportError));
  globalThis.fetch = async () => { throw new DOMException('cancelled', 'AbortError'); };
  await assert.rejects(a.api('/api/me'), error => error.name === 'AbortError' && !(error instanceof a.ApiTransportError));
});
