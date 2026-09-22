// Run against a built, running app (default http://127.0.0.1:8088):
// node --test web/tests/resource-import-wizard.mjs
// PLAYWRIGHT_MODULE can point to a bundled Playwright index.mjs if it is not
// installed locally. All API requests are mocked: no real material is saved.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseUrl = process.env.SLIDEFLOW_TEST_URL || "http://127.0.0.1:8088";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=", "base64");
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function setup(t, options = {}) {
  const context = await browser.newContext({ viewport: options.viewport || { width: 1360, height: 960 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const calls = [];
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  t.after(() => assert.deepEqual(pageErrors, []));
  let fonts = options.missing ? ["非标准字体"] : ["微软雅黑"];
  let renderFailures = options.renderFailures || 0;
  let prepareFailures = options.prepareFailures || 0;
  let cleanupFailures = options.cleanupFailures || 0;
  const slideCount = options.slideCount || (options.images ? 2 : 10);
  if (options.stream) await page.addInitScript(({ total }) => {
    const nativeFetch = window.fetch.bind(window);
    const state = window.__renderStream = { calls: 0, aborts: 0, controller: null };
    const encoder = new TextEncoder();
    state.emit = (event) => state.controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    state.finish = () => state.controller.close();
    window.fetch = async (input, init) => {
      if (!String(input).endsWith("/previews")) return nativeFetch(input, init);
      state.calls += 1;
      const stream = new ReadableStream({
        start(controller) {
          state.controller = controller;
          state.emit({ type: "started", total });
          init.signal.addEventListener("abort", () => {
            state.aborts += 1;
            try { controller.error(new DOMException("Cancelled", "AbortError")); } catch { /* already closed */ }
          }, { once: true });
        },
      });
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
    };
  }, { total: slideCount });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push({ path, method: request.method(), body: request.postData() });
    const ok = (json) => route.fulfill({ json });
    if (path === "/api/me") return ok({ user: { id: 1, name: "Wizard test", username: "wizard_test", role: "admin" } });
    if (path === "/api/fonts") return options.fontCatalogFailure ? route.fulfill({ status: 503, json: { detail: "font catalog unavailable" } }) : ok({ fonts: [{ id: 1, family: "微软雅黑" }, { id: 2, family: "Arial" }] });
    if (path === "/api/users/options") return ok({ users: [{ id: 2, name: "Test User", username: "test_user" }] });
    if (path.endsWith("/prepare")) {
      if (options.prepareGate) await options.prepareGate;
      if (prepareFailures-- > 0) return route.fulfill({ status: 400, json: { detail: "字体检测失败：测试异常" } });
      return ok({ session_id: "wizard-test-session", slide_count: slideCount, fonts, missing_fonts: options.missing ? fonts : [], preview_status: options.images ? "ready" : "pending" });
    }
    if (path.endsWith("/replace-fonts")) {
      if (options.replaceGate) await options.replaceGate;
      const replacements = request.postDataJSON();
      fonts = [...new Set(fonts.map((font) => replacements[font] || font))];
      return ok({ fonts, missing_fonts: [], preview_status: options.images ? "ready" : "pending" });
    }
    if (path.endsWith("/previews")) {
      if (renderFailures-- > 0) return route.fulfill({ status: options.renderFailureStatus || 400, headers: options.retryAfter ? { "Retry-After": options.retryAfter } : {}, json: { detail: "预览图生成失败：测试异常" } });
      return ok({ preview_status: "ready", preview_count: slideCount });
    }
    if (path.includes("/preview/")) {
      if (options.lastPreviewGate && path.endsWith(`/${slideCount - 1}`)) await options.lastPreviewGate;
      if (options.previewFailure && path.endsWith("/0") && new URL(request.url()).searchParams.get("retry") === "0") return route.abort("failed");
      return route.fulfill({ contentType: "image/png", body: png });
    }
    if (path.endsWith("/result")) return ok({ status: "completed", created: slideCount });
    if (path.endsWith("/commit")) {
      if (options.commitGate) await options.commitGate;
      if (options.commitFailure) return route.fulfill({ status: 400, json: { detail: "导入提交失败，临时文件已清理，请重试" } });
      if (options.uncertain) return route.abort("failed");
      if (options.invalidReceipt) return ok({ created: 0 });
      return ok({ created: slideCount });
    }
    if (request.method() === "DELETE" && cleanupFailures-- > 0) return route.fulfill({ status: 409, headers: { "Retry-After": "0.02" }, json: { detail: "任务正在停止" } });
    return ok({});
  });
  await page.goto(`${baseUrl}/resources/import`);
  const heading = (name) => page.getByRole("heading", { name, exact: true });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const count = (suffix, method = "POST") => calls.filter((call) => call.path.endsWith(suffix) && call.method === method).length;
  await heading("1. 选择文件").waitFor();
  assert.equal(await page.getByRole("navigation", { name: "素材导入步骤" }).getByRole("listitem").count(), 5);
  assert.equal(await button("下一步：字体检测").isDisabled(), true);
  assert.equal(await page.getByRole("dialog").count(), 0);
  return { page, heading, button, count, calls };
}

async function prepare(ui) {
  await ui.page.getByLabel("选择 PPT 文件", { exact: true }).setInputFiles({ name: "wizard.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", buffer: Buffer.from("mocked PPTX") });
  await ui.button("下一步：字体检测").click();
  await ui.heading("2. 字体检测").waitFor();
  await ui.button("应用字体替换").waitFor();
  assert.equal(ui.count("/previews"), 0);
  assert.equal(ui.count("/commit"), 0);
  assert.equal(await ui.page.getByPlaceholder("如：产品介绍").count(), 0);
}

async function replace(ui, source, target) {
  await ui.page.getByRole("combobox", { name: `替换字体 ${source}`, exact: true }).click();
  await ui.page.getByRole("option", { name: target, exact: true }).click();
  assert.equal(await ui.button("字体已确认，下一步").isDisabled(), true);
  await ui.button("应用字体替换").click();
  await ui.page.getByRole("combobox", { name: `替换字体 ${target}`, exact: true }).waitFor();
}

async function render(ui, expectedLastVisiblePage = 10, expectedVisibleCount = 10) {
  await ui.button("字体已确认，下一步").click();
  await ui.heading("3. 图片渲染").waitFor();
  await ui.page.getByRole("link", { name: `查看第 ${expectedLastVisiblePage} 页高清图`, exact: true }).waitFor();
  assert.equal(await ui.page.getByRole("img", { name: /第 \d+ 页预览/ }).count(), expectedVisibleCount);
  assert.equal(ui.count("/commit"), 0);
}

async function metadata(ui) {
  await ui.button("图片已确认，下一步").click();
  await ui.heading("4. 信息编辑").waitFor();
  await ui.button("下一步：上传").click();
  assert.equal(await ui.heading("4. 信息编辑").isVisible(), true, "empty metadata must not advance");
  await ui.page.getByPlaceholder("如：产品介绍").fill("五步回归");
  await ui.page.getByLabel("主体", { exact: false }).fill("回归素材");
  await ui.button("下一步：上传").click();
  await ui.heading("5. 上传").waitFor();
  assert.equal(ui.count("/commit"), 0, "entering upload must not save automatically");
}

test("five separate stages; installed-font replacement; metadata persists on back; only final confirmation saves", async (t) => {
  let finishCommit;
  const commitGate = new Promise((resolve) => { finishCommit = resolve; });
  const ui = await setup(t, { commitGate });
  await prepare(ui);
  await replace(ui, "微软雅黑", "Arial");
  assert.equal(ui.count("/previews"), 0, "font replacement must not render");
  await render(ui);
  await metadata(ui);
  await ui.button("上一步").click();
  assert.equal(await ui.page.getByPlaceholder("如：产品介绍").inputValue(), "五步回归");
  await ui.button("下一步：上传").click();
  await ui.button("确认上传").click();
  await ui.button("上传保存中…").waitFor();
  assert.equal(await ui.button("上一步").isDisabled(), true);
  assert.equal(await ui.button("取消导入").isDisabled(), true);
  finishCommit();
  await ui.page.getByText("上传完成，已保存 10 个单页素材", { exact: true }).waitFor();
  assert.equal(ui.count("/commit"), 1);
  assert.equal(await ui.button("确认上传").count(), 0);
});

test("missing fonts block progress; render can retry; returning to fonts and replacing invalidates previews", async (t) => {
  const ui = await setup(t, { missing: true, renderFailures: 1 });
  await prepare(ui);
  assert.equal(await ui.button("字体已确认，下一步").isDisabled(), true);
  await replace(ui, "非标准字体", "Arial");
  await ui.button("字体已确认，下一步").click();
  await ui.button("重试图片渲染").waitFor();
  assert.equal(await ui.button("图片已确认，下一步").isDisabled(), true);
  await ui.button("重试图片渲染").click();
  await ui.page.getByRole("link", { name: "查看第 1 页高清图", exact: true }).waitFor();
  const oldUrl = await ui.page.getByRole("link", { name: "查看第 1 页高清图", exact: true }).getAttribute("href");
  await ui.button("上一步").click();
  await replace(ui, "Arial", "微软雅黑");
  await render(ui);
  const newUrl = await ui.page.getByRole("link", { name: "查看第 1 页高清图", exact: true }).getAttribute("href");
  assert.notEqual(oldUrl, newUrl);
  assert.equal(ui.count("/previews"), 3);
  assert.equal(ui.count("/commit"), 0);
});

test("PPT plus images still requires the image confirmation step, without rendering", async (t) => {
  const ui = await setup(t, { images: true });
  const imageDir = await mkdtemp(join(tmpdir(), "slideflow-wizard-images-"));
  t.after(() => rm(imageDir, { recursive: true, force: true }));
  await writeFile(join(imageDir, "1.png"), png);
  await writeFile(join(imageDir, "2.png"), png);
  await ui.page.getByRole("button", { name: /上传 PPT 及图片/ }).click();
  await ui.page.getByLabel("选择图片文件夹", { exact: true }).setInputFiles(imageDir);
  await prepare(ui);
  await ui.button("字体已确认，下一步").click();
  await ui.heading("3. 图片渲染").waitFor();
  await ui.page.getByRole("link", { name: "查看第 2 页高清图", exact: true }).waitFor();
  assert.equal(await ui.button("开始渲染高清图片").count(), 0);
  await metadata(ui);
  assert.equal(ui.count("/previews"), 0);
  await ui.button("确认上传").click();
  await ui.page.getByText("上传完成，已保存 2 个单页素材", { exact: true }).waitFor();
});

test("return to file selection clears only the temporary session and restores directory selection", async (t) => {
  const ui = await setup(t);
  await prepare(ui);
  const deleted = ui.page.waitForResponse((response) => response.request().method() === "DELETE");
  await ui.button("上一步").click();
  await ui.heading("1. 选择文件").waitFor();
  await deleted;
  assert.equal(ui.count("/wizard-test-session", "DELETE"), 1);
  assert.equal(await ui.page.getByLabel("选择图片文件夹", { exact: true }).getAttribute("webkitdirectory"), "");
  await ui.button("下一步：字体检测").click();
  await ui.button("应用字体替换").waitFor();
  assert.equal(ui.count("/prepare"), 2);
});

test("terminal commit failure returns to file selection instead of retrying a deleted session", async (t) => {
  const ui = await setup(t, { commitFailure: true });
  await prepare(ui); await render(ui); await metadata(ui);
  await ui.button("确认上传").click();
  await ui.heading("1. 选择文件").waitFor();
  assert.equal(ui.count("/commit"), 1);
  assert.equal(await ui.button("确认上传").count(), 0);
});

test("uncertain save result blocks duplicate submission", async (t) => {
  const ui = await setup(t, { uncertain: true });
  await prepare(ui); await render(ui); await metadata(ui);
  await ui.button("确认上传").click();
  await ui.button("返回素材库").waitFor();
  assert.equal(await ui.button("确认上传").count(), 0);
  assert.equal(await ui.button("上一步").count(), 0);
  assert.equal(ui.count("/commit"), 1);
  await ui.button("核对保存结果").click();
  await ui.page.getByText("上传完成，已保存 10 个单页素材").waitFor();
  assert.equal(ui.count("/commit"), 1);
});

test("font detection failure stays in step 2 and can retry without rendering", async (t) => {
  const ui = await setup(t, { prepareFailures: 1 });
  await ui.page.getByLabel("选择 PPT 文件", { exact: true }).setInputFiles({ name: "retry.pptx", mimeType: "application/octet-stream", buffer: Buffer.from("mock PPTX") });
  await ui.button("下一步：字体检测").click();
  await ui.button("重新检测字体").waitFor();
  assert.equal(await ui.heading("2. 字体检测").isVisible(), true);
  assert.equal(await ui.button("字体已确认，下一步").isDisabled(), true);
  await ui.button("重新检测字体").click();
  await ui.button("应用字体替换").waitFor();
  assert.equal(ui.count("/prepare"), 2);
  assert.equal(ui.count("/previews"), 0);
  assert.equal(ui.count("/commit"), 0);
});

test("preview cards are paginated and all pages must load before confirmation", async (t) => {
  let finishPreview;
  const lastPreviewGate = new Promise((resolve) => { finishPreview = resolve; });
  t.after(() => finishPreview());
  const ui = await setup(t, { slideCount: 25, lastPreviewGate });
  await prepare(ui); await render(ui, 12, 12);
  assert.equal(await ui.page.getByRole("img", { name: /第 \d+ 页预览/ }).count(), 12);
  assert.equal(await ui.button("图片已确认，下一步").isDisabled(), true);
  finishPreview();
  await ui.button("图片已确认，下一步").and(ui.page.locator(":enabled")).waitFor();
  await ui.button("下一组图片").click();
  assert.equal(await ui.page.getByRole("img", { name: /第 \d+ 页预览/ }).count(), 12);
  await ui.button("下一组图片").click();
  await ui.page.getByRole("link", { name: "查看第 25 页高清图", exact: true }).waitFor();
  assert.equal(await ui.page.getByRole("img", { name: /第 \d+ 页预览/ }).count(), 1);
  assert.equal(await ui.button("下一组图片").isDisabled(), true);
});

test("failed preview cannot be confirmed until that page is retried", async (t) => {
  const ui = await setup(t, { previewFailure: true });
  await prepare(ui);
  await ui.button("字体已确认，下一步").click();
  await ui.button("重试第 1 页").waitFor();
  assert.equal(await ui.button("图片已确认，下一步").isDisabled(), true);
  await ui.button("重试第 1 页").click();
  await ui.button("图片已确认，下一步").click();
  await ui.heading("4. 信息编辑").waitFor();
});

test("remarks survive leaving metadata and returning", async (t) => {
  const ui = await setup(t);
  await prepare(ui); await render(ui); await metadata(ui);
  await ui.button("上一步").click();
  await ui.page.getByRole("textbox", { name: "通用备注" }).fill("保留这段备注");
  await ui.button("下一步：上传").click();
  await ui.button("上一步").click();
  assert.equal(await ui.page.getByRole("textbox", { name: "通用备注" }).textContent(), "保留这段备注");
  await ui.button("下一步：上传").click();
  await ui.button("确认上传").click();
  await ui.button("返回素材库").waitFor();
  assert.match(ui.calls.find((call) => call.path.endsWith("/commit")).body, /保留这段备注/);
});

test("mobile wizard keeps all five stages and action buttons inside viewport", async (t) => {
  const ui = await setup(t, { viewport: { width: 390, height: 844 } });
  for (const action of [null, () => prepare(ui), () => render(ui), () => metadata(ui)]) {
    if (action) await action();
    assert.equal(await ui.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const box = await ui.button("取消导入").boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844);
  }
  if (process.env.SLIDEFLOW_SCREENSHOT_DIR) await ui.page.screenshot({ path: join(process.env.SLIDEFLOW_SCREENSHOT_DIR, "import-mobile.png") });
});

async function emitPage(ui, index) {
  await ui.page.evaluate((index) => window.__renderStream.emit({ type: "page", index, preview_url: `/api/resource-import/wizard-test-session/preview/${index}?attempt=test`, completed: index + 1, total: 2 }), index);
  await ui.page.getByRole("link", { name: `查看第 ${index + 1} 页高清图`, exact: true }).waitFor();
}

test("streaming displays each page before completion, and never confirms a partial result", async (t) => {
  const ui = await setup(t, { stream: true, slideCount: 2 });
  await prepare(ui);
  await ui.button("字体已确认，下一步").click();
  await ui.button("取消渲染").waitFor();
  assert.equal(await ui.button("图片已确认，下一步").isDisabled(), true);
  await ui.page.evaluate(() => window.__renderStream.emit({ type: "progress", stage: "queued", message: "渲染节点繁忙，正在排队" }));
  await ui.page.getByText("渲染节点繁忙，正在排队", { exact: true }).waitFor();
  await emitPage(ui, 0);
  assert.equal(await ui.page.getByRole("img", { name: /第 \d+ 页预览/ }).count(), 1);
  assert.equal(await ui.page.getByText("第 2 页等待渲染", { exact: true }).isVisible(), true);
  assert.equal(await ui.button("图片已确认，下一步").isDisabled(), true);
  await emitPage(ui, 1);
  assert.equal(await ui.button("图片已确认，下一步").isDisabled(), true, "all page events alone do not authorize saving");
  await ui.page.evaluate(() => {
    window.__renderStream.emit({ type: "completed", preview_status: "ready", preview_count: 2 });
    window.__renderStream.finish();
  });
  await ui.button("图片已确认，下一步").and(ui.page.locator(":enabled")).waitFor();
  await ui.button("图片已确认，下一步").click();
  await ui.heading("4. 信息编辑").waitFor();
  await ui.button("上一步").click();
  assert.equal(await ui.page.evaluate(() => window.__renderStream.calls), 1, "returning from metadata must not requeue unchanged slides");
  assert.equal(ui.count("/commit"), 0);
});

test("premature stream EOF keeps partial previews non-confirmable and allows retry", async (t) => {
  const ui = await setup(t, { stream: true, slideCount: 2 });
  await prepare(ui);
  await ui.button("字体已确认，下一步").click();
  await ui.button("取消渲染").waitFor();
  await emitPage(ui, 0);
  await ui.page.evaluate(() => window.__renderStream.finish());
  await ui.button("重试图片渲染").waitFor();
  assert.equal(await ui.button("图片已确认，下一步").isDisabled(), true);
  await ui.button("重试图片渲染").click();
  await ui.button("取消渲染").waitFor();
  assert.equal(await ui.page.getByRole("img", { name: /第 \d+ 页预览/ }).count(), 0);
  assert.equal(await ui.page.evaluate(() => window.__renderStream.calls), 2);
});

test("cancelling a render aborts transport and preserves completed font replacement", async (t) => {
  const ui = await setup(t, { stream: true, slideCount: 2, missing: true });
  await prepare(ui);
  await replace(ui, "非标准字体", "Arial");
  await ui.button("字体已确认，下一步").click();
  await ui.button("取消渲染").click();
  await ui.button("重试图片渲染").waitFor();
  assert.equal(await ui.page.evaluate(() => window.__renderStream.aborts), 1);
  assert.equal(await ui.button("图片已确认，下一步").isDisabled(), true);
  await ui.button("上一步").click();
  await ui.page.getByRole("combobox", { name: "替换字体 Arial", exact: true }).waitFor();
  assert.equal(ui.count("/replace-fonts"), 1);
  assert.equal(ui.count("/prepare"), 1);
});

test("legacy binary PPT is rejected with a save-as-PPTX hint", async (t) => {
  const ui = await setup(t);
  await ui.page.getByLabel("选择 PPT 文件", { exact: true }).setInputFiles({ name: "legacy.ppt", mimeType: "application/vnd.ms-powerpoint", buffer: Buffer.from("mocked legacy PPT") });
  await ui.page.getByRole("alert").filter({ hasText: "另存为 PPTX" }).waitFor();
  assert.equal(await ui.button("下一步：字体检测").isDisabled(), true);
  assert.equal(ui.count("/prepare"), 0);
});

test("claimed completion with missing page events cannot enable confirmation", async (t) => {
  const ui = await setup(t, { stream: true, slideCount: 2 });
  await prepare(ui);
  await ui.button("字体已确认，下一步").click();
  await ui.button("取消渲染").waitFor();
  await emitPage(ui, 0);
  await ui.page.evaluate(() => window.__renderStream.emit({ type: "completed", preview_status: "ready", preview_count: 2 }));
  await ui.button("重试图片渲染").waitFor();
  assert.equal(await ui.button("图片已确认，下一步").isDisabled(), true);
  assert.equal(ui.count("/commit"), 0);
});

test("foreign preview URLs are rejected rather than rendered", async (t) => {
  const ui = await setup(t, { stream: true, slideCount: 2 });
  await prepare(ui);
  await ui.button("字体已确认，下一步").click();
  await ui.button("取消渲染").waitFor();
  await ui.page.evaluate(() => window.__renderStream.emit({ type: "page", index: 0, preview_url: "https://invalid.example/collect" }));
  await ui.button("重试图片渲染").waitFor();
  assert.equal(await ui.page.getByRole("img", { name: /第 \d+ 页预览/ }).count(), 0);
  assert.equal(await ui.button("图片已确认，下一步").isDisabled(), true);
});

test("cancelling import aborts rendering and releases only the temporary session", async (t) => {
  const ui = await setup(t, { stream: true, slideCount: 2 });
  await prepare(ui);
  await ui.button("字体已确认，下一步").click();
  await ui.button("取消渲染").waitFor();
  const deleted = ui.page.waitForResponse((response) => response.request().method() === "DELETE");
  await ui.button("取消导入").click();
  await deleted;
  assert.equal(await ui.page.evaluate(() => window.__renderStream.aborts), 1);
  assert.equal(ui.count("/wizard-test-session", "DELETE"), 1);
  assert.equal(ui.count("/commit"), 0);
});

test("same-tick double clicks cannot duplicate prepare, font replacement or commit", async (t) => {
  let finishPrepare, finishReplace, finishCommit;
  const prepareGate = new Promise((resolve) => { finishPrepare = resolve; });
  const replaceGate = new Promise((resolve) => { finishReplace = resolve; });
  const commitGate = new Promise((resolve) => { finishCommit = resolve; });
  t.after(() => { finishPrepare(); finishReplace(); finishCommit(); });
  const ui = await setup(t, { prepareGate, replaceGate, commitGate });
  await ui.page.getByLabel("选择 PPT 文件", { exact: true }).setInputFiles({ name: "double.pptx", mimeType: "application/octet-stream", buffer: Buffer.from("mock") });
  await ui.button("下一步：字体检测").evaluate((button) => { button.click(); button.click(); });
  await ui.heading("2. 字体检测").waitFor();
  finishPrepare();
  await ui.button("应用字体替换").waitFor();
  assert.equal(ui.count("/prepare"), 1);
  await ui.page.getByRole("combobox", { name: "替换字体 微软雅黑", exact: true }).click();
  await ui.page.getByRole("option", { name: "Arial", exact: true }).click();
  await ui.button("应用字体替换").evaluate((button) => { button.click(); button.click(); });
  await ui.button("替换中…").waitFor();
  finishReplace();
  await ui.page.getByRole("combobox", { name: "替换字体 Arial", exact: true }).waitFor();
  assert.equal(ui.count("/replace-fonts"), 1);
  await render(ui); await metadata(ui);
  await ui.button("确认上传").evaluate((button) => { button.click(); button.click(); });
  await ui.button("上传保存中…").waitFor();
  finishCommit();
  await ui.page.getByText("上传完成，已保存 10 个单页素材", { exact: true }).waitFor();
  assert.equal(ui.count("/commit"), 1);
});

test("lost commit response survives refresh and recovers from receipt without another POST", async (t) => {
  const ui = await setup(t, { uncertain: true });
  await prepare(ui); await render(ui); await metadata(ui);
  await ui.button("确认上传").click();
  await ui.button("核对保存结果").waitFor();
  assert.ok(await ui.page.evaluate(() => sessionStorage.getItem("slide-flow:pending-import:1")));
  await ui.page.reload();
  await ui.heading("核对上次导入结果").waitFor();
  assert.equal(await ui.button("开始新的导入").isDisabled(), true);
  await ui.button("查询上次保存结果").click();
  await ui.page.getByText("已确认上次上传成功，共保存 10 个单页素材，无需重复上传。", { exact: true }).waitFor();
  assert.equal(ui.count("/commit"), 1);
  assert.equal(await ui.page.evaluate(() => sessionStorage.getItem("slide-flow:pending-import:1")), null);
});

test("mismatched commit count is not treated as success and retains recovery pointer", async (t) => {
  const ui = await setup(t, { invalidReceipt: true });
  await prepare(ui); await render(ui); await metadata(ui);
  await ui.button("确认上传").click();
  await ui.button("核对保存结果").waitFor();
  assert.equal(await ui.page.getByText("上传完成，已保存 0 个单页素材", { exact: true }).count(), 0);
  assert.ok(await ui.page.evaluate(() => sessionStorage.getItem("slide-flow:pending-import:1")));
  assert.equal(ui.count("/commit"), 1);
});

test("font catalog failure blocks confirmation even when detected fonts are installed", async (t) => {
  const ui = await setup(t, { fontCatalogFailure: true });
  await prepare(ui);
  assert.equal(await ui.button("字体已确认，下一步").isDisabled(), true);
  assert.equal(ui.count("/previews"), 0);
});

test("busy admission responses retry with bounded cancellable waits", async (t) => {
  const ui = await setup(t, { renderFailures: 2, renderFailureStatus: 429, retryAfter: "0.02" });
  await prepare(ui); await render(ui);
  assert.equal(ui.count("/previews"), 3);
  assert.equal(ui.count("/commit"), 0);
});

test("cancelling during 409 admission wait stops retries without losing fonts", async (t) => {
  const ui = await setup(t, { renderFailures: 20, renderFailureStatus: 409, retryAfter: "5" });
  await prepare(ui);
  await ui.button("字体已确认，下一步").click();
  await ui.page.getByText(/服务器正在排队或释放上次任务/).waitFor();
  await ui.button("取消渲染").click();
  await ui.button("重试图片渲染").waitFor();
  await ui.button("上一步").click();
  await ui.page.getByRole("combobox", { name: "替换字体 微软雅黑", exact: true }).waitFor();
  assert.equal(ui.count("/previews"), 1);
});

test("cleanup retries the render lease conflict instead of abandoning the session", async (t) => {
  const ui = await setup(t, { cleanupFailures: 2 });
  await prepare(ui);
  const released = ui.page.waitForResponse((response) => response.request().method() === "DELETE" && response.status() === 200);
  await ui.button("取消导入").click();
  await released;
  assert.equal(ui.count("/wizard-test-session", "DELETE"), 3);
});

test("retrying one failed image does not refetch all previously verified pages", async (t) => {
  const ui = await setup(t, { slideCount: 25, previewFailure: true });
  await prepare(ui);
  await ui.button("字体已确认，下一步").click();
  await ui.page.getByText(/已加载 24 张/).waitFor();
  const countBefore = ui.count("/preview/24", "GET");
  assert.ok(countBefore > 0);
  await ui.button("重试第 1 页").click();
  await ui.button("图片已确认，下一步").and(ui.page.locator(":enabled")).waitFor();
  assert.equal(ui.count("/preview/24", "GET"), countBefore);
});

test("500-page decks keep only 12 image cards in the DOM", async (t) => {
  const ui = await setup(t, { slideCount: 500 });
  await prepare(ui); await render(ui, 12, 12);
  await ui.button("图片已确认，下一步").and(ui.page.locator(":enabled")).waitFor({ timeout: 30000 });
  assert.equal(await ui.page.getByRole("img", { name: /第 \d+ 页预览/ }).count(), 12);
  assert.equal(ui.count("/commit"), 0);
});

test("expired render sessions reset instead of retrying a dead session", async (t) => {
  const ui = await setup(t, { renderFailures: 1, renderFailureStatus: 410 });
  await prepare(ui);
  await ui.button("字体已确认，下一步").click();
  await ui.heading("1. 选择文件").waitFor();
  assert.equal(ui.count("/previews"), 1);
  assert.equal(await ui.button("重试图片渲染").count(), 0);
});

test("out-of-order page events succeed only after all unique pages and completion", async (t) => {
  const ui = await setup(t, { stream: true, slideCount: 2 });
  await prepare(ui);
  await ui.button("字体已确认，下一步").click();
  await ui.button("取消渲染").waitFor();
  await emitPage(ui, 1);
  await emitPage(ui, 0);
  assert.equal(await ui.button("图片已确认，下一步").isDisabled(), true);
  await ui.page.evaluate(() => { window.__renderStream.emit({ type: "completed", preview_status: "ready", preview_count: 2 }); window.__renderStream.finish(); });
  await ui.button("图片已确认，下一步").and(ui.page.locator(":enabled")).waitFor();
});
