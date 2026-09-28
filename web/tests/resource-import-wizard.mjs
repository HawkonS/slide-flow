// Browser regression coverage for the durable four-step resource import flow.
// Run against a built, running app (default http://127.0.0.1:8088).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseUrl = process.env.SLIDEFLOW_TEST_URL || "http://127.0.0.1:8088";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=",
  "base64",
);
const sessionId = "b".repeat(32);
let browser;

before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
  });
});

after(async () => { await browser?.close(); });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForCount(read, expected, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (read() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(read(), expected, message);
}

function metadataTags(domain) {
  const values = {
    subject: ["产品"],
    secrecy: ["public"],
    status: ["active"],
  }[domain];
  return {
    groups: [{
      category: "default",
      tags: values.map((name, index) => ({
        id: index + 1,
        name,
        label: name === "public" ? "公开" : name === "active" ? "正常" : name,
        sort_order: index,
      })),
    }],
    can_create: false,
  };
}

function serializedTask({ fonts, missingFonts, renderReady }) {
  return {
    id: 101,
    task_type: "batch_split_import",
    status: "pending",
    progress: renderReady ? 2 : 0,
    upload_progress: 100,
    total: 2,
    message: renderReady ? "图片已渲染，等待确认导入" : "等待图片渲染",
    error_message: null,
    result_data: null,
    params: {
      session_id: sessionId,
      file_name: "wizard.pptx",
      name_prefix: "四步回归",
      subject: "产品",
      secrecy_level: "public",
      status: "active",
      visibility_scope: "public",
      visible_user_ids: "[]",
      visible_user_tags: "[]",
      management_scope: "public",
      manage_user_ids: "[]",
      manage_user_tags: "[]",
      remark_html: "",
      slide_count: 2,
      fonts,
      missing_fonts: missingFonts,
      preview_status: renderReady ? "ready" : missingFonts.length ? "blocked" : "pending",
      workflow_state: renderReady ? "awaiting_confirmation" : missingFonts.length ? "awaiting_fonts" : "awaiting_render",
      render_completed: renderReady ? 2 : 0,
      render_total: 2,
      preview_error: null,
    },
  };
}

async function selectOption(page, label, option) {
  const selector = {
    "主体": "#import-subject",
    "密级": "#import-secrecy",
    "状态": "#import-status",
    "可见范围": "#import-visibility",
    "管理范围": "#import-management",
  }[label];
  if (selector) await page.locator(selector).click();
  else await page.getByLabel(label, { exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function fillUploadStep(page) {
  await page.getByLabel("选择 PPT 文件", { exact: true }).setInputFiles({
    name: "wizard.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from("mocked PPTX"),
  });
  await page.getByPlaceholder("如：产品介绍", { exact: true }).fill("四步回归");
  await selectOption(page, "主体", "产品");
  await selectOption(page, "密级", "公开");
  await selectOption(page, "状态", "正常");
  await selectOption(page, "可见范围", "公开（全体可见）");
  await selectOption(page, "管理范围", "公开（全体可管理）");
}

async function clickTwiceInOneTurn(locator) {
  await locator.evaluate((element) => {
    element.click();
    element.click();
  });
}

async function createHarness(t, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 960 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const pageErrors = [];
  const calls = { upload: 0, replace: 0, render: 0, commit: 0 };
  const gates = {
    upload: deferred(),
    replace: deferred(),
    render: deferred(),
    commit: deferred(),
  };
  let fonts = options.missingFont === false ? ["Arial"] : ["旧字体"];
  let missingFonts = options.missingFont === false ? [] : ["旧字体"];
  let renderReady = false;

  page.on("pageerror", (error) => pageErrors.push(error.message));
  t.after(() => assert.deepEqual(pageErrors, []));

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const ok = (json) => route.fulfill({ json });

    if (path === "/api/me") {
      return ok({ user: { id: 1, name: "Wizard Test", username: "wizard_test", role: "admin" } });
    }
    if (path === "/api/fonts") return ok({ fonts: [{ id: 1, family: "Arial" }] });
    const tagMatch = path.match(/^\/api\/(subject|secrecy|status)-tags$/);
    if (tagMatch) return ok(metadataTags(tagMatch[1]));
    if (path === "/api/user-tags") return ok({ groups: [], can_create: false });
    if (path === "/api/users/options") return ok({ users: [] });
    if (path === "/api/tasks/split-import") {
      calls.upload += 1;
      await gates.upload.promise;
      return ok({ task_id: 101, session_id: sessionId });
    }
    if (path === "/api/tasks/101") {
      return ok(serializedTask({ fonts, missingFonts, renderReady }));
    }
    if (path === `/api/resource-import/${sessionId}/replace-fonts`) {
      calls.replace += 1;
      await gates.replace.promise;
      fonts = ["Arial"];
      missingFonts = [];
      return ok({ fonts, missing_fonts: [], preview_status: "pending" });
    }
    if (path === `/api/resource-import/${sessionId}/previews`) {
      calls.render += 1;
      await gates.render.promise;
      renderReady = true;
      const events = [
        { type: "started", total: 2, message: "已提交 Windows 图片渲染任务" },
        { type: "page", index: 0, preview_url: `/api/resource-import/${sessionId}/preview/0?attempt=wizard` },
        { type: "page", index: 1, preview_url: `/api/resource-import/${sessionId}/preview/1?attempt=wizard` },
        { type: "completed", preview_status: "ready", preview_count: 2 },
      ];
      return route.fulfill({
        contentType: "application/x-ndjson; charset=utf-8",
        body: events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      });
    }
    if (path.includes(`/api/resource-import/${sessionId}/preview/`)) {
      return route.fulfill({ contentType: "image/png", body: png });
    }
    if (path === `/api/resource-import/${sessionId}/commit`) {
      calls.commit += 1;
      await gates.commit.promise;
      return ok({ created: 2 });
    }
    if (path === `/api/resource-import/${sessionId}/status`) {
      return ok({ status: "processing", progress: 0, total: 2, message: "正在保存" });
    }
    return ok({});
  });

  await page.goto(`${baseUrl}/resources/import`);
  await page.getByRole("heading", { name: "1. 上传与信息", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("navigation", { name: "素材导入步骤" }).getByRole("listitem").count(),
    4,
  );
  return { page, calls, gates };
}

test("four-step import survives refresh and same-turn double clicks never duplicate work", async (t) => {
  const { page, calls, gates } = await createHarness(t);
  await fillUploadStep(page);

  const createButton = page.getByRole("button", { name: "创建上传任务", exact: true });
  await clickTwiceInOneTurn(createButton);
  await waitForCount(() => calls.upload, 1, "upload must be submitted once");
  assert.equal(await page.getByRole("dialog", { name: "正在创建上传任务" }).count(), 1);
  gates.upload.resolve();

  await page.waitForURL((url) => url.searchParams.get("task_id") === "101");
  await page.getByRole("heading", { name: "2. 字体检测", exact: true }).waitFor();
  assert.match(page.url(), /[?&]task_id=101(?:&|$)/);

  await page.reload();
  await page.getByRole("heading", { name: "2. 字体检测", exact: true }).waitFor();
  await page.getByText("检测到 1 个非标准字体，请替换后继续。", { exact: true }).waitFor();
  assert.match(page.url(), /[?&]task_id=101(?:&|$)/);

  await selectOption(page, "替换字体 旧字体", "Arial");
  const replaceButton = page.getByRole("button", { name: "应用字体替换", exact: true });
  await clickTwiceInOneTurn(replaceButton);
  await waitForCount(() => calls.replace, 1, "font replacement must be submitted once");
  gates.replace.resolve();
  await page.getByText("字体检测通过，请确认后继续。", { exact: true }).waitFor();

  const fontsNext = page.getByRole("button", { name: "字体已确认，下一步", exact: true });
  await clickTwiceInOneTurn(fontsNext);
  await waitForCount(() => calls.render, 1, "image render must be submitted once");
  await page.getByRole("heading", { name: "3. 图片渲染", exact: true }).waitFor();
  gates.render.resolve();
  await page.getByText("共 2 页，已生成 2 页、已加载 2 张。", { exact: true }).waitFor();
  assert.equal(calls.render, 1);

  await page.getByRole("button", { name: "图片已确认，下一步", exact: true }).click();
  await page.getByRole("heading", { name: "4. 确认导入", exact: true }).waitFor();
  const commitButton = page.getByRole("button", { name: "确认导入", exact: true });
  await clickTwiceInOneTurn(commitButton);
  await waitForCount(() => calls.commit, 1, "commit must be submitted once");
  gates.commit.resolve();

  await page.getByText("导入完成，已保存 2 个单页素材", { exact: true }).waitFor();
  assert.deepEqual(calls, { upload: 1, replace: 1, render: 1, commit: 1 });
});

test("an existing task URL restores a completed image render without another render request", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  let renderCalls = 0;

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const ok = (json) => route.fulfill({ json });
    if (path === "/api/me") return ok({ user: { id: 1, name: "Wizard Test", username: "wizard_test", role: "admin" } });
    if (path === "/api/fonts") return ok({ fonts: [{ id: 1, family: "Arial" }] });
    if (path.endsWith("-tags") || path === "/api/user-tags") return ok({ groups: [], can_create: false });
    if (path === "/api/tasks/101") return ok(serializedTask({ fonts: ["Arial"], missingFonts: [], renderReady: true }));
    if (path === `/api/resource-import/${sessionId}/previews`) {
      renderCalls += 1;
      return ok({ preview_status: "ready", preview_count: 2 });
    }
    if (path.includes(`/api/resource-import/${sessionId}/preview/`)) {
      return route.fulfill({ contentType: "image/png", body: png });
    }
    return ok({});
  });

  await page.goto(`${baseUrl}/resources/import?task_id=101`);
  await page.getByText("共 2 页，已生成 2 页、已加载 2 张。", { exact: true }).waitFor();
  assert.equal(renderCalls, 0);
  assert.equal(await page.getByRole("button", { name: "图片已确认，下一步", exact: true }).isEnabled(), true);
});
