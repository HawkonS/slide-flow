// Browser regression coverage for automatic frontend deployment recovery.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseUrl = process.env.SLIDEFLOW_TEST_URL || "http://127.0.0.1:8088";
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

const updatedHtml = "<!doctype html><html><body><div id=\"root\"></div><script type=\"module\" src=\"/assets/index-new-deployment.js\"></script></body></html>";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=",
  "base64",
);

async function waitForValue(read, expected, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(read(), expected);
}

test("a changed entry hash reloads once and the session marker prevents a loop", async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  let loads = 0;
  let checks = 0;
  page.on("load", () => { loads += 1; });
  await page.route("**/?__slideflow_entry=*", async (route) => {
    checks += 1;
    await route.fulfill({ contentType: "text/html", body: updatedHtml });
  });

  await page.goto(`${baseUrl}/login`);
  await waitForValue(() => loads, 2);
  await page.waitForTimeout(1_300);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(250);

  assert.equal(loads, 2, "the same deployment hash must not trigger a reload loop");
  assert.ok(checks >= 2, "the page should continue checking after the first reload");
});

test("a deployment reload waits until the complete resource-import workflow leaves the page", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  let loads = 0;
  let serveUpdate = false;
  let releaseUpload;
  let uploadStarted = false;
  let renderRequests = 0;
  let renderReady = false;
  const sessionId = "c".repeat(32);
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  page.on("load", () => { loads += 1; });

  await page.route("**/?__slideflow_entry=*", async (route) => {
    if (serveUpdate) return route.fulfill({ contentType: "text/html", body: updatedHtml });
    return route.fallback();
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const ok = (json) => route.fulfill({ json });
    if (path === "/api/me") return ok({ user: { id: 1, name: "Deploy Test", username: "deploy_test", role: "admin" } });
    if (path === "/api/fonts") return ok({ fonts: [{ id: 1, family: "Arial" }] });
    if (path === "/api/subject-tags") return ok({ groups: [{ category: "default", tags: [{ id: 1, name: "产品", label: "产品", sort_order: 0 }] }], can_create: false });
    if (path === "/api/secrecy-tags") return ok({ groups: [{ category: "default", tags: [{ id: 1, name: "public", label: "公开", sort_order: 0 }] }], can_create: false });
    if (path === "/api/status-tags") return ok({ groups: [{ category: "default", tags: [{ id: 1, name: "active", label: "正常", sort_order: 0 }] }], can_create: false });
    if (path.endsWith("-tags") || path === "/api/user-tags") return ok({ groups: [], can_create: false });
    if (path === "/api/tasks/split-import") {
      uploadStarted = true;
      await uploadGate;
      return ok({ task_id: 202, session_id: sessionId });
    }
    if (path === "/api/tasks/202") {
      return ok({
        status: "pending",
        message: renderReady ? "图片已渲染，等待确认导入" : "等待图片渲染",
        params: {
          session_id: sessionId,
          file_name: "deployment.pptx",
          name_prefix: "部署恢复",
          subject: "产品",
          secrecy_level: "public",
          status: "active",
          visibility_scope: "public",
          management_scope: "public",
          visible_user_ids: "[]",
          visible_user_tags: "[]",
          manage_user_ids: "[]",
          manage_user_tags: "[]",
          slide_count: 2,
          fonts: ["Arial"],
          missing_fonts: [],
          preview_status: renderReady ? "ready" : "pending",
          workflow_state: renderReady ? "awaiting_confirmation" : "awaiting_render",
          render_completed: renderReady ? 2 : 0,
          render_total: 2,
          preview_error: null,
        },
      });
    }
    if (path === `/api/resource-import/${sessionId}/previews`) {
      renderRequests += 1;
      renderReady = true;
      const events = [
        { type: "started", total: 2, message: "已提交 Windows 图片渲染任务" },
        { type: "page", index: 0, preview_url: `/api/resource-import/${sessionId}/preview/0?attempt=deployment` },
        { type: "page", index: 1, preview_url: `/api/resource-import/${sessionId}/preview/1?attempt=deployment` },
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
    return ok({});
  });

  await page.goto(`${baseUrl}/resources/import`);
  await page.getByLabel("选择 PPT 文件", { exact: true }).setInputFiles({
    name: "deployment.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from("mocked PPTX"),
  });
  await page.getByPlaceholder("如：产品介绍", { exact: true }).fill("部署恢复");
  for (const [label, option] of [
    ["主体", "产品"],
    ["密级", "公开"],
    ["状态", "正常"],
    ["可见范围", "公开（全体可见）"],
    ["管理范围", "公开（全体可管理）"],
  ]) {
    const selector = {
      "主体": "#import-subject",
      "密级": "#import-secrecy",
      "状态": "#import-status",
      "可见范围": "#import-visibility",
      "管理范围": "#import-management",
    }[label];
    await page.locator(selector).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  }
  await page.getByRole("button", { name: "创建上传任务", exact: true }).click();
  await waitForValue(() => uploadStarted, true);

  serveUpdate = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(300);
  assert.equal(loads, 1, "an in-flight upload must block automatic reload");

  releaseUpload();
  await page.waitForURL((url) => url.searchParams.get("task_id") === "202");
  await page.getByRole("heading", { name: "2. 字体检测", exact: true }).waitFor();
  await page.getByText("字体检测通过，请确认后继续。", { exact: true }).waitFor();
  await page.waitForTimeout(250);
  assert.equal(loads, 1, "task creation must not release a pending deployment reload");

  await page.getByRole("button", { name: "字体已确认，下一步", exact: true }).click();
  await waitForValue(() => renderRequests, 1);
  await page.getByText("共 2 页，已生成 2 页、已加载 2 张。", { exact: true }).waitFor();
  assert.equal(loads, 1, "render-task creation and preview loading must not be interrupted");

  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await waitForValue(() => Math.min(loads, 2), 2);
  assert.ok(loads >= 2, "the pending deployment reload should run after leaving the import workflow");
});
