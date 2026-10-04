import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const source = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { api, downloadFile, responseErrorMessage, ApiTransportError, advanceApiSession, setUnauthorizedHandler } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('validation messages describe fields without echoing rejected secrets or internal errors', () => {
  const detail = [{ loc: ['body', 'password'], input: 'secret-password', msg: 'secret-password failed' }];
  assert.equal(responseErrorMessage(422, { detail }), '请检查密码的填写内容和长度');
  assert.equal(responseErrorMessage(500, { detail: 'SQL error /private/path with secret-password' }), '服务暂时出现问题，请稍后重试');
  assert.equal(responseErrorMessage(403, { detail: '无权修改此素材' }), '无权修改此素材');
});

test('transport failures stay distinguishable from application failures', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(api('/api/me'), error => error instanceof ApiTransportError && error.message.includes('检查网络'));
  globalThis.fetch = async () => new Response('Internal Server Error', { status: 500 });
  await assert.rejects(api('/api/shows'), error => !(error instanceof ApiTransportError) && !error.message.includes('Internal'));
});

test('late unauthorized response cannot log out a newer session', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; setUnauthorizedHandler(null); });
  let resolve, unauthorized = 0;
  setUnauthorizedHandler(() => unauthorized++);
  globalThis.fetch = () => new Promise(r => { resolve = r; });
  const pending = api('/api/shows');
  advanceApiSession();
  resolve(new Response('{}', { status: 401 }));
  await assert.rejects(pending);
  assert.equal(unauthorized, 0);
});

test('download preflight cannot trigger a browser download in a later login session', async t => {
  const originalFetch = globalThis.fetch, originalDocument = globalThis.document;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.document = originalDocument; });
  let resolve, clicks = 0;
  globalThis.document = {
    body: { appendChild() {} },
    createElement: () => ({ click() { clicks++; }, remove() {} }),
  };
  globalThis.fetch = () => new Promise(r => { resolve = r; });
  const pending = downloadFile('/api/downloads/1/file', 'slides.pptx');
  advanceApiSession();
  resolve(new Response('x', { status: 206 }));
  await pending;
  assert.equal(clicks, 0);
  globalThis.fetch = async () => new Response('x', { status: 206 });
  await downloadFile('/api/downloads/2/file', 'current.pptx');
  assert.equal(clicks, 1);
});
