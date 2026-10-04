import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { create } from 'zustand';

const source = await readFile(new URL('../src/stores/download-manager.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source.replaceAll('import.meta.env', '({})'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness() {
  const sockets = [], downloads = [], notices = [], timers = new Map(), storage = new Map();
  let nextTimer = 0;
  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeSocket.CONNECTING;
    constructor(url) { this.url = url; sockets.push(this); }
    open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
    message(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
    close() { this.readyState = FakeSocket.CLOSED; }
    finishClose() { this.close(); this.onclose?.(); }
    send() {}
  }
  const exports = {};
  vm.runInNewContext(js, {
    exports, console, URLSearchParams, WebSocket: FakeSocket,
    window: {
      location: { host: 'slides.example', protocol: 'https:' },
      sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout: id => timers.delete(id),
    },
    require: name => {
      if (name === 'zustand') return { create };
      if (name === 'sonner') return { toast: Object.fromEntries(['success', 'error', 'warning'].map(
        type => [type, (message, options) => notices.push({ type, message, options })],
      )) };
      if (name === '@/lib/api') return { downloadFile: async (...args) => { downloads.push(args); } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return { store: exports.useDownloadManager, sockets, downloads, notices, timers, storage };
}

const completed = (task_id, extra = {}) => ({
  type: 'download_completed', task_id, file_name: 'slides.pptx', file_size: 100, ...extra,
});

test('account switch clears old tasks and ignores late socket callbacks', () => {
  const { store, sockets, downloads, timers } = harness();
  store.getState().connect('alice:1:session-a');
  const old = sockets[0]; old.open();
  store.getState().addTask(1, 'Alice deck', 'a');
  store.getState().connect('bob:1:session-b');
  const current = sockets[1]; current.open();
  assert.equal(store.getState().tasks.size, 0);
  store.getState().addTask(2, 'Bob deck', 'b');
  old.message(completed(1));
  old.finishClose();
  old.open();
  assert.equal(downloads.length, 0);
  assert.equal(timers.size, 0);
  assert.equal(store.getState().wsConnected, true);
  assert.equal(store.getState().tasks.size, 1);
  current.message(completed(2));
  assert.equal(downloads.length, 1);
  assert.equal(store.getState().tasks.get(2).status, 'completed');
});

test('temporary disconnection keeps tasks and cursor; logout clears tasks', () => {
  const { store, sockets, downloads, timers } = harness();
  store.getState().connect('alice:1:session-a');
  sockets[0].open();
  store.getState().addTask(1, 'Deck', 'a');
  sockets[0].message({ type: 'event_cursor', event_id: 7 });
  store.getState().disconnect(false);
  store.getState().connect('alice:1:session-a');
  sockets[1].open();
  sockets[0].finishClose();
  assert.match(sockets[1].url, /after=7$/);
  assert.equal(store.getState().tasks.size, 1);
  sockets[1].message(completed(1, { event_id: 8 }));
  sockets[1].message(completed(1, { event_id: 8 }));
  assert.equal(downloads.length, 1);
  store.getState().disconnect();
  sockets[1].message(completed(2, { event_id: 9 }));
  sockets[1].finishClose();
  assert.equal(store.getState().tasks.size, 0);
  assert.equal(store.getState().wsConnected, false);
  assert.equal(timers.size, 0);
  assert.equal(downloads.length, 1);
});

test('new login of the same account gets its own cursor and task state', () => {
  const { store, sockets, notices, downloads } = harness();
  store.getState().connect('alice:1:session-a');
  sockets[0].open();
  store.getState().addTask(1, 'Deck', 'a');
  sockets[0].message(completed(1, { event_id: 5 }));
  const oldAction = notices.find(notice => notice.type === 'success').options.action;
  store.getState().connect('alice:1:session-b');
  sockets[1].open();
  assert.equal(store.getState().tasks.size, 0);
  assert.equal(new URL(sockets[1].url).search, '');
  oldAction.onClick();
  assert.equal(downloads.length, 1);
});

test('malformed events are ignored and clean exports do not warn about watermarks', () => {
  const { store, sockets, notices } = harness();
  store.getState().connect('alice:1:session-a');
  sockets[0].open();
  sockets[0].message(null);
  sockets[0].message(17);
  sockets[0].onmessage({ data: '{' });
  sockets[0].message(completed(1, { watermark_applied: false, watermark_requested: false }));
  assert.equal(notices.filter(notice => notice.type === 'warning').length, 0);
  sockets[0].message(completed(2, { watermark_applied: false, watermark_requested: true }));
  assert.equal(notices.filter(notice => notice.type === 'warning').length, 1);
});

test('network reconnect resumes the event cursor without losing pending tasks', () => {
  const { store, sockets, timers } = harness();
  store.getState().connect('alice:1:session-a');
  sockets[0].open();
  store.getState().addTask(1, 'Deck', 'a');
  sockets[0].message({ type: 'event_cursor', event_id: 11 });
  sockets[0].finishClose();
  assert.equal(timers.size, 1);
  const [timerId, reconnect] = timers.entries().next().value;
  timers.delete(timerId); reconnect();
  sockets[1].open();
  assert.match(sockets[1].url, /after=11$/);
  assert.equal(store.getState().tasks.get(1).status, 'pending');
  sockets[0].finishClose();
  assert.equal(timers.size, 0);
  assert.equal(store.getState().wsConnected, true);
});
