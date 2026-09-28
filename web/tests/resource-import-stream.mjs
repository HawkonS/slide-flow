// Standalone protocol tests: node --test web/tests/resource-import-stream.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function loadTypeScript(relative) {
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}
const { api, apiNdjson, ApiError, parseRetryAfter, setUnauthorizedHandler } = await loadTypeScript("../src/lib/api.ts");
const { parsePreviewRenderEvent } = await loadTypeScript("../src/lib/resourceImportStream.ts");
const encoder = new TextEncoder();
const parse = (event) => parsePreviewRenderEvent(event, "session", 2, "https://slideflow.test");

function mockFetch(t, response) {
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => typeof response === "function" ? response(...args) : response;
  t.after(() => { globalThis.fetch = original; setUnauthorizedHandler(null); });
}
function ndjson(chunks, cancel) {
  return new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
    cancel,
  }), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
}

test("UTF-8 split at every byte, CRLF and final unterminated event are parsed", async (t) => {
  const source = encoder.encode('\r\n{"type":"progress","message":"正在排队，字体已就绪"}\r\n{"type":"completed"}');
  mockFetch(t, ndjson([...source].map((byte) => Uint8Array.of(byte))));
  const events = [];
  assert.equal(await apiNdjson("/api/render", (event) => events.push(event)), undefined);
  assert.deepEqual(events, [{ type: "progress", message: "正在排队，字体已就绪" }, { type: "completed" }]);
});

test("multiple events per chunk and blank heartbeat lines are supported", async (t) => {
  mockFetch(t, ndjson([encoder.encode('{"type":"heartbeat"}\n\n{"type":"page"}\n')]));
  const events = [];
  await apiNdjson("/api/render", (event) => events.push(event.type));
  assert.deepEqual(events, ["heartbeat", "page"]);
});

test("JSON compatibility sends authenticated POST with streaming Accept", async (t) => {
  mockFetch(t, (path, options) => {
    assert.equal(path, "/api/render");
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "include");
    assert.match(new Headers(options.headers).get("Accept"), /application\/x-ndjson/);
    return Response.json({ preview_status: "ready", preview_count: 2 });
  });
  const result = await apiNdjson("/api/render", () => assert.fail("JSON fallback must not emit an NDJSON event"), { method: "POST" });
  assert.equal(result.preview_count, 2);
});

test("non-success status uses API errors and invokes login handler", async (t) => {
  let unauthorized = false;
  setUnauthorizedHandler(() => { unauthorized = true; });
  mockFetch(t, Response.json({ detail: "会话已失效" }, { status: 401 }));
  await assert.rejects(apiNdjson("/api/render", () => {}), (error) => error instanceof ApiError && error.status === 401 && error.message === "会话已失效");
  assert.equal(unauthorized, true);
});

test("oversized unterminated event is rejected before unbounded buffering", async (t) => {
  mockFetch(t, ndjson([encoder.encode("x".repeat(256 * 1024 + 1))]));
  await assert.rejects(apiNdjson("/api/render", () => {}), /事件过大/);
});

test("oversized complete line and malformed JSON are rejected", async (t) => {
  mockFetch(t, ndjson([encoder.encode('"' + "x".repeat(256 * 1024) + '"\n')]));
  await assert.rejects(apiNdjson("/api/render", () => {}), /事件过大/);
  globalThis.fetch = async () => ndjson([encoder.encode("not JSON\n")]);
  await assert.rejects(apiNdjson("/api/render", () => {}), /格式错误/);
});

test("invalid UTF-8 and unsupported response formats fail closed", async (t) => {
  mockFetch(t, ndjson([Uint8Array.of(0xff)]));
  await assert.rejects(apiNdjson("/api/render", () => {}));
  globalThis.fetch = async () => new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } });
  await assert.rejects(apiNdjson("/api/render", () => {}), /响应格式/);
});

test("callback failure cancels response body and releases the stream lock", async (t) => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('{"type":"error"}\n')); }, cancel() { cancelled = true; } });
  mockFetch(t, new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } }));
  await assert.rejects(apiNdjson("/api/render", () => { throw new Error("render failed"); }), /render failed/);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("abort interrupts a waiting stream without waiting for the next chunk", async (t) => {
  const controller = new AbortController();
  let cancelled = false;
  mockFetch(t, new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "application/x-ndjson" } }));
  const pending = apiNdjson("/api/render", () => {}, { signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("page URLs are confined to this same-origin session and exact page", () => {
  const event = { type: "page", index: 0, preview_url: "/api/resource-import/session/preview/0?attempt=123" };
  assert.deepEqual(parse(event), event);
  for (const preview_url of ["https://evil.test/api/resource-import/session/preview/0", "//evil.test/image", "javascript:alert(1)", "/api/resource-import/another/preview/0", "/api/resource-import/session/preview/1", "/api/resource-import/session/preview/0#fragment"]) {
    assert.throws(() => parse({ ...event, preview_url }));
  }
});

test("negative, out-of-range, fractional and string page indices are rejected", () => {
  for (const index of [-1, 2, 1.5, "0"]) assert.throws(() => parse({ type: "page", index, preview_url: `/api/resource-import/session/preview/${index}` }));
});

test("completion requires exact slide count and ready status", () => {
  assert.equal(parse({ type: "completed", preview_count: 2, preview_status: "ready" }).type, "completed");
  for (const event of [{ preview_count: 1, preview_status: "ready" }, { preview_count: 2, preview_status: "pending" }, { preview_status: "ready" }]) assert.throws(() => parse({ type: "completed", ...event }));
  assert.throws(() => parse({ type: "started", total: 3 }));
});

test("malformed events are rejected while heartbeat and bounded messages are accepted", () => {
  for (const event of [null, [], "page", {}, { type: "unknown" }]) assert.throws(() => parse(event));
  assert.equal(parse({ type: "heartbeat" }).type, "heartbeat");
  const terminalError = parse({ type: "error", message: "x".repeat(3000) });
  assert.equal(terminalError.message.length, 2000);
  assert.equal(terminalError.recoverable, false, "errors fail closed unless the server explicitly marks them recoverable");
  assert.equal(parse({ type: "error", message: "stream deadline", recoverable: true }).recoverable, true);
  assert.equal(parse({ type: "error", message: "not boolean", recoverable: "true" }).recoverable, false);
});

test("Headers input is preserved without duplicated case-insensitive Accept", async (t) => {
  mockFetch(t, (path, options) => {
    const headers = new Headers(options.headers);
    assert.equal(headers.get("Accept"), "application/x-ndjson, application/json");
    assert.equal(headers.get("X-Test"), "retained");
    return ndjson([]);
  });
  await apiNdjson("/api/render", () => {}, { headers: new Headers({ "X-Test": "retained" }) });
});

test("stalled response body and stalled headers time out with a distinct error", async (t) => {
  let cancelled = false;
  mockFetch(t, new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "application/x-ndjson" } }));
  await assert.rejects(apiNdjson("/api/render", () => {}, { idleTimeoutMs: 15 }), { name: "TimeoutError" });
  assert.equal(cancelled, true);
  globalThis.fetch = () => new Promise(() => {});
  await assert.rejects(apiNdjson("/api/render", () => {}, { idleTimeoutMs: 15 }), { name: "TimeoutError" });
});

test("heartbeat bytes reset the idle deadline", async (t) => {
  let interval;
  let count = 0;
  const body = new ReadableStream({
    start(controller) {
      interval = setInterval(() => {
        controller.enqueue(encoder.encode('{"type":"heartbeat"}\n'));
        if (++count === 5) { clearInterval(interval); controller.close(); }
      }, 5);
    }, cancel() { clearInterval(interval); },
  });
  t.after(() => clearInterval(interval));
  mockFetch(t, new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }));
  await apiNdjson("/api/render", () => {}, { idleTimeoutMs: 20 });
  assert.equal(count, 5);
});

test("total stream bytes are bounded even when each individual line is small", async (t) => {
  mockFetch(t, ndjson([encoder.encode('{"type":"heartbeat"}\n'.repeat(8))]));
  await assert.rejects(apiNdjson("/api/render", () => {}, { maxBytes: 50 }), /安全大小限制/);
});

test("JSON compatibility also obeys body idle timeout and size limits", async (t) => {
  mockFetch(t, new Response(new ReadableStream({}), { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(apiNdjson("/api/render", () => {}, { idleTimeoutMs: 15 }), { name: "TimeoutError" });
  globalThis.fetch = async () => Response.json({ oversized: "x".repeat(128) });
  await assert.rejects(apiNdjson("/api/render", () => {}, { maxBytes: 50 }), /安全大小限制/);
});

test("Retry-After accepts seconds/date, rejects garbage and bounds server delays", async (t) => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter("999999"), 30000);
  assert.equal(parseRetryAfter("-1"), 0);
  assert.equal(parseRetryAfter("invalid"), undefined);
  assert.equal(parseRetryAfter("Tue, 22 Sep 2026 00:00:02 GMT", Date.parse("2026-09-22T00:00:00Z")), 2000);
  mockFetch(t, Response.json({ detail: "queue full" }, { status: 429, headers: { "Retry-After": "3" } }));
  await assert.rejects(api("/api/render"), (error) => error instanceof ApiError && error.retryAfterMs === 3000);
});

test("an already-aborted stream does not call fetch", async (t) => {
  mockFetch(t, () => { assert.fail("fetch called after abort"); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(apiNdjson("/api/render", () => {}, { signal: controller.signal }), { name: "AbortError" });
});

test("cancel remains responsive when underlying stream cancellation never settles", async (t) => {
  mockFetch(t, new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } }), { headers: { "Content-Type": "application/x-ndjson" } }));
  const controller = new AbortController();
  const pending = apiNdjson("/api/render", () => {}, { signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { name: "AbortError" });
});
