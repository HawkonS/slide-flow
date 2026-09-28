// Focused browser regression tests for the durable four-step import flow.
// Run against a built, running app (default http://127.0.0.1:8088).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseUrl = process.env.SLIDEFLOW_TEST_URL || "http://127.0.0.1:8088";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=", "base64");
const sessionId = "a".repeat(32);
let browser;

before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
  });
});
after(async () => { await browser?.close(); });

function taskParams(previewStatus, workflowState) {
  return {
    session_id: sessionId,
    file_name: "render-regression.pptx",
    name_prefix: "render-regression",
    subject: "test",
    secrecy_level: "public",
    status: "active",
    visibility_scope: "public",
    visible_user_ids: "[]",
    visible_user_tags: "[]",
    management_scope: "public",
    manage_user_ids: "[]",
    manage_user_tags: "[]",
    slide_count: 2,
    fonts: ["Arial"],
    missing_fonts: [],
    preview_status: previewStatus,
    workflow_state: workflowState,
    render_completed: previewStatus === "ready" ? 2 : 0,
    render_total: 2,
    preview_error: null,
  };
}

function serializedTask(previewStatus, workflowState) {
  return {
    id: 101,
    task_type: "batch_split_import",
    status: "pending",
    progress: previewStatus === "ready" ? 2 : 0,
    total: 2,
    message: previewStatus === "ready" ? "图片已渲染，等待确认导入" : "等待图片渲染",
    error_message: null,
    result_data: null,
    params: taskParams(previewStatus, workflowState),
  };
}

async function setup(t, mode) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const pageErrors = [];
  let previewRequested = false;
  let pollsAfterPreview = 0;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  t.after(() => assert.deepEqual(pageErrors, []));

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const ok = (json) => route.fulfill({ json });
    if (path === "/api/me") return ok({ user: { id: 1, name: "Render Test", username: "render_test", role: "admin" } });
    if (path === "/api/fonts") return ok({ fonts: [{ id: 1, family: "Arial" }] });
    if (path.endsWith("-tags") || path === "/api/user-tags") return ok({ groups: [], can_create: false });
    if (path === "/api/tasks/101") {
      if (mode === "ready") return ok(serializedTask("ready", "awaiting_confirmation"));
      if (mode === "recover" && previewRequested && ++pollsAfterPreview >= 1) {
        return ok(serializedTask("ready", "awaiting_confirmation"));
      }
      return ok(serializedTask("pending", "awaiting_render"));
    }
    if (path === `/api/resource-import/${sessionId}/previews`) {
      previewRequested = true;
      const events = mode === "complete"
        ? [
            { type: "started", total: 2, message: "已提交 Windows 图片渲染任务" },
            { type: "page", index: 0, preview_url: `/api/resource-import/${sessionId}/preview/0?attempt=test` },
            { type: "page", index: 1, preview_url: `/api/resource-import/${sessionId}/preview/1?attempt=test` },
            { type: "completed", preview_status: "ready", preview_count: 2 },
          ]
        : mode === "terminal-error"
          ? [
              { type: "started", total: 2 },
              { type: "error", message: "Windows 转换节点明确失败" },
            ]
          : [{ type: "started", total: 2 }];
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

  await page.goto(`${baseUrl}/resources/import?task_id=101`);
  await page.getByRole("heading", { name: "3. 图片渲染", exact: true }).waitFor();
  return { page };
}

async function expectReady(page) {
  await page.getByText("共 2 页，已生成 2 页、已加载 2 张。", { exact: true }).waitFor({ timeout: 8_000 });
  await page.getByRole("img", { name: "第 2 页预览", exact: true }).waitFor();
  await page.getByRole("button", { name: "图片已确认，下一步", exact: true }).and(page.locator(":enabled")).waitFor();
  assert.equal(await page.getByRole("button", { name: /开始图片渲染|重试图片渲染|接入后台渲染进度/ }).count(), 0);
}

test("a persisted ready task resumes directly at image confirmation", async (t) => {
  const { page } = await setup(t, "ready");
  await expectReady(page);
});

test("an NDJSON completed event is success even though the stream returns no JSON body", async (t) => {
  const { page } = await setup(t, "complete");
  await page.getByRole("button", { name: "开始图片渲染", exact: true }).click();
  await expectReady(page);
});

test("premature stream EOF keeps polling and recovers from durable task state", async (t) => {
  const { page } = await setup(t, "recover");
  await page.getByRole("button", { name: "开始图片渲染", exact: true }).click();
  await page.getByText("进度连接已中断，后台渲染仍在继续，正在通过任务状态自动恢复…", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "重试图片渲染", exact: true }).count(), 0);
  await expectReady(page);
});

test("only an explicit non-recoverable renderer error shows retry", async (t) => {
  const { page } = await setup(t, "terminal-error");
  await page.getByRole("button", { name: "开始图片渲染", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Windows 转换节点明确失败" }).waitFor();
  await page.getByRole("button", { name: "重试图片渲染", exact: true }).waitFor();
});
