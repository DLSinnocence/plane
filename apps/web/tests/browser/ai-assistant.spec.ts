/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import { expect, test, type Page } from "@playwright/test";

async function mockSettings(
  page: Page,
  configured = true,
  supportsImages = false,
  models = [
    {
      id: "fixture-model-id",
      model: "fixture-model",
      supports_images: supportsImages,
      is_enabled: true,
      is_default: true,
    },
  ]
) {
  const current = {
    providers: [
      {
        id: "fixture-provider",
        name: "Fixture provider",
        provider: "openai",
        base_url: "",
        has_api_key: configured,
        is_enabled: true,
        models,
      },
    ],
  };
  await page.route("**/auth/get-csrf-token/", (route) => route.fulfill({ json: { csrf_token: "fixture-csrf" } }));
  await page.route("**/api/workspaces/*/ai-settings/", async (route) => {
    await route.fulfill({ json: current });
  });
}
async function open(page: Page) {
  await page.getByRole("button", { name: "AI assistant", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "AI assistant" })).toBeVisible();
}
async function send(page: Page, message: string) {
  await page.getByRole("textbox", { name: "Message the assistant" }).fill(message);
  const count = await page.evaluate(() => window.aiFixture.requests.length);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.aiFixture.requests.length)).toBe(count + 1);
}
async function frames(page: Page, events: unknown[]) {
  await page.evaluate(
    (values) => window.aiFixture.push(values.map((value) => JSON.stringify(value)).join("\n") + "\n"),
    events
  );
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("streams visible thinking and answer before completion and updates the current phase", async ({ page }) => {
  await mockSettings(page);
  await page.goto("/?ai-assistant");
  await open(page);
  await send(page, "Explain this task");
  const status = page.locator(".agent-live-status");
  await expect(status).toContainText("Loading");
  await expect(status).not.toContainText("Writing a response");

  await frames(page, [{ type: "thinking", text: "Checking the request" }]);
  const thoughts = page.locator('[data-agent-part="native-thinking"]');
  await expect(thoughts.getByText("Checking the request", { exact: true })).toBeVisible();
  await expect(status).toContainText("Thinking");
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await frames(page, [{ type: "thinking", text: " step by step." }]);
  await expect(thoughts).toContainText("Checking the request step by step.");

  await frames(page, [{ type: "text", text: "The answer is" }]);
  const answer = page.locator(".agent-turn--assistant .agent-message-content");
  await expect(answer.getByText("The answer is", { exact: true })).toBeVisible();
  await expect(status).toContainText("Writing a response");
  await expect(status).not.toContainText("Thinking");
  await frames(page, [{ type: "text", text: " ready." }]);
  await expect(answer.getByText("The answer is ready.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();

  await frames(page, [{ type: "done", reason: "complete" }]);
  await expect(status).toHaveCount(0);
  await expect(answer.getByText("The answer is ready.", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await send(page, "Continue");
  const request = await page.evaluate(() => window.aiFixture.requests[1].body);
  expect(JSON.stringify(request)).toContain("The answer is ready.");
  expect(JSON.stringify(request)).not.toContain("Checking the request");
});

test("streams tagged thoughts visibly and respects a manually collapsed disclosure", async ({ page }) => {
  await mockSettings(page);
  await page.goto("/?ai-assistant");
  await open(page);
  await send(page, "Think then answer");
  await frames(page, [{ type: "text", text: "<think>Reviewing the context" }]);
  const thoughts = page.locator('[data-agent-part="thinking"]');
  await expect(thoughts.getByText("Reviewing the context", { exact: true })).toBeVisible();
  await expect(page.locator(".agent-live-status")).toContainText("Thinking");
  await thoughts.locator("summary").click();
  await frames(page, [{ type: "text", text: " and the task" }]);
  await expect(thoughts).not.toHaveAttribute("open");
  await frames(page, [{ type: "text", text: "</think><answer>Here is the result" }]);
  await expect(page.getByText("Here is the result", { exact: true })).toBeVisible();
  await expect(page.locator(".agent-live-status")).toContainText("Writing a response");
  await frames(page, [{ type: "text", text: ".</answer>" }, { type: "done" }]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("sidebar is docked, keeps the workspace interactive and retains memory while hidden", async ({ page }) => {
  await mockSettings(page);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/?ai-assistant");
  await open(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const aside = page.getByRole("complementary");
  const box = await aside.boundingBox();
  expect(box?.x).toBeGreaterThan(850);
  expect(box?.height).toBeGreaterThan(850);
  await page.getByRole("button", { name: "Workspace action" }).click();
  await expect(page.getByTestId("workspace-actions")).toHaveText("1");
  await send(page, "Remember this task");
  await frames(page, [{ type: "text", text: "I will use this context." }, { type: "done" }]);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(aside).toHaveCount(0);
  await open(page);
  await expect(aside).toContainText("I will use this context.");
  await page.evaluate(() => window.aiFixture.navigate("/workspace/projects/another-project"));
  await expect(aside).toContainText("I will use this context.");
  await send(page, "Continue");
  expect(JSON.stringify(await page.evaluate(() => window.aiFixture.requests[1].body))).toContain("Remember this task");
  await frames(page, [{ type: "text", text: "Continued." }, { type: "done" }]);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(aside).not.toContainText("Remember this task");
});

test("composer uses Enter to send and Shift+Enter for a newline and shows the current model", async ({ page }) => {
  await mockSettings(page);
  await page.goto("/?ai-assistant");
  await open(page);
  await expect(page.locator("select.agent-model-button")).toHaveValue("fixture-model-id");
  const input = page.getByRole("textbox", { name: "Message the assistant" });
  await input.fill("First line");
  await input.press("Shift+Enter");
  await input.press("End");
  await expect(input).toHaveValue("First line\n");
  await input.press("Enter");
  await expect.poll(() => page.evaluate(() => window.aiFixture.requests.length)).toBe(1);
  await frames(page, [
    {
      type: "text",
      text: '## A clear answer\n\nHere is the result.\n\n- First action\n- Next action\n\n```ts\nconst task = "ENG-42";\n```',
    },
    { type: "done" },
  ]);
  await page.screenshot({ path: "test-results/ai-sidebar.png", fullPage: true });
});

test("Chinese sidebar presents a complete Agent conversation beside the workspace", async ({ page }) => {
  await mockSettings(page, true, true);
  await page.setViewportSize({ width: 1521, height: 1085 });
  await page.goto("/?ai-assistant&lang=zh");
  await page.getByRole("button", { name: "AI 助手", exact: true }).click();
  const aside = page.getByRole("complementary", { name: "AI 助手" });
  await page.getByRole("textbox", { name: "向助手发送消息" }).fill("帮我整理登录超时问题，创建工作项并补充验收标准。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.aiFixture.requests.length)).toBe(1);
  await frames(page, [
    { type: "thinking", text: "先检查项目中是否已有相同的问题，再整理复现步骤和验收标准。" },
    { type: "tool", id: "lookup", name: "workitem", action: "list", status: "running" },
    {
      type: "tool",
      id: "lookup",
      name: "workitem",
      action: "list",
      status: "complete",
      details: { output: '{"results":[]}' },
    },
  ]);
  await frames(page, [
    {
      type: "tool",
      id: "create",
      name: "workitem",
      action: "create",
      status: "complete",
      details: {
        input: '{"name":"修复登录超时","priority":"high"}',
        output: '{"identifier":"ENG-42","state":"待处理"}',
        workItems: [
          {
            id: "12345678-1234-4234-8234-123456789abc",
            projectId: "87654321-1234-4234-8234-123456789abc",
            identifier: "ENG-42",
            name: "修复登录超时",
          },
        ],
      },
    },
    {
      type: "text",
      text: "已创建 **ENG-42：修复登录超时**，优先级设为高。\n\n### 验收标准\n\n- 登录请求超时后显示明确的错误提示\n- 用户可以直接重试，无需刷新页面\n- 正常网络下登录流程保持可用\n\n已经补充复现步骤和预期结果，你可以打开工作项继续完善。",
    },
  ]);
  await expect(
    aside.getByText("先检查项目中是否已有相同的问题，再整理复现步骤和验收标准。", { exact: true })
  ).toBeVisible();
  await expect(aside.locator(".agent-live-status")).toContainText("正在生成回复");
  await expect(aside.getByRole("heading", { name: "验收标准" })).toBeVisible();
  await page.screenshot({ path: "test-results/ai-sidebar-streaming-zh.png", fullPage: true });
  await frames(page, [{ type: "done" }]);
  await expect(aside.getByRole("link", { name: "ENG-42", exact: true })).toBeVisible();
  await expect(aside.locator("select.agent-model-button")).toHaveValue("fixture-model-id");
  await page.screenshot({ path: "test-results/ai-sidebar-zh.png", fullPage: true });
});

test("unconfigured assistant opens workspace settings instead of personal settings", async ({ page }) => {
  await mockSettings(page, false);
  await page.route("**/workspace/settings/ai/", (route) =>
    route.fulfill({ contentType: "text/html", body: "Workspace AI settings" })
  );
  await page.goto("/?ai-assistant");
  await open(page);
  await expect(page.getByRole("textbox", { name: "Message the assistant" })).toBeDisabled();
  await expect(page.getByRole("complementary")).toContainText("workspace administrator");
  await page.getByRole("button", { name: "Configure AI", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace\/settings\/ai\/$/);
});

for (const [language, notice, link] of [
  ["en", "Personal credentials are no longer used.", "Open workspace AI settings"],
  ["zh", "不再使用个人凭据", "打开工作区 AI 设置"],
] as const) {
  test("legacy personal AI settings shows a migration notice in " + language, async ({ page }) => {
    const legacyRequests: string[] = [];
    await page.route("**/api/users/me/ai-settings/**", async (route) => {
      legacyRequests.push(route.request().method());
      await route.fulfill({ status: 410, json: {} });
    });
    await page.goto("/?ai-assistant&lang=" + language);
    await page.getByRole("button", { name: "Legacy profile AI settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Profile settings fixture" });
    await expect(dialog).toContainText(notice);
    await expect(dialog.getByRole("link", { name: link })).toHaveAttribute("href", "/workspace/settings/ai");
    await expect(dialog.locator("form, input, select")).toHaveCount(0);
    expect(legacyRequests).toEqual([]);
  });
}

test("configured model settings opens the workspace configuration", async ({ page }) => {
  await mockSettings(page);
  await page.route("**/workspace/settings/ai/", (route) =>
    route.fulfill({ contentType: "text/html", body: "Workspace AI settings" })
  );
  await page.goto("/?ai-assistant");
  await open(page);
  await page.getByRole("button", { name: "Model settings" }).click();
  await expect(page).toHaveURL(/\/workspace\/settings\/ai\/$/);
});

const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=";
const imageFile = { name: "screen.png", mimeType: "image/png", buffer: Buffer.from(imageData, "base64") };

test("attaches real image data, sends image-only prompts and preserves images for follow-ups without storage", async ({
  page,
}) => {
  await mockSettings(page, true, true);
  await page.goto("/?ai-assistant");
  await open(page);
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  const picker = page.locator('input[type="file"]');
  await picker.setInputFiles(imageFile);
  await expect(page.getByRole("complementary").getByRole("img", { name: "screen.png" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await send(page, "");
  const request = await page.evaluate(() => window.aiFixture.requests[0].body);
  expect(request).toEqual({
    messages: [
      { role: "user", content: "", images: [{ data: imageData, mime_type: "image/png", name: "screen.png" }] },
    ],
    project_id: "fixture-project",
    model_id: "fixture-model-id",
  });
  await frames(page, [{ type: "text", text: "I can see the screenshot." }, { type: "done" }]);
  await expect(page.getByRole("complementary").getByRole("img", { name: "screen.png" })).toBeVisible();
  await send(page, "Explain the highlighted part");
  const followup = await page.evaluate(() => window.aiFixture.requests[1].body);
  expect(followup).toMatchObject({
    messages: [
      { role: "user", content: "", images: [{ data: imageData, mime_type: "image/png", name: "screen.png" }] },
      { role: "assistant", content: "I can see the screenshot." },
      { role: "user", content: "Explain the highlighted part" },
    ],
  });
  await frames(page, [{ type: "text", text: "The highlight is here." }, { type: "done" }]);
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual(storage);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByRole("complementary").locator(".agent-image-preview")).toHaveCount(0);
});

test("image upload rejects invalid files and excessive images and supports paste and removal", async ({ page }) => {
  await mockSettings(page, true, true);
  await page.goto("/?ai-assistant");
  await open(page);
  const picker = page.locator('input[type="file"]');
  await picker.setInputFiles({ name: "unsafe.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await expect(page.getByRole("alert")).toContainText("Use PNG, JPEG or WebP");
  await picker.setInputFiles([imageFile, imageFile, imageFile, imageFile]);
  await expect(page.getByRole("alert")).toContainText("up to 3 images");
  await picker.setInputFiles({ ...imageFile, buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
  await expect(page.getByRole("alert")).toContainText("up to 2 MB");
  await page.getByRole("textbox", { name: "Message the assistant" }).evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const files = new DataTransfer();
    files.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: files, bubbles: true, cancelable: true }));
  }, imageData);
  await expect(page.getByRole("img", { name: "pasted.png" })).toBeVisible();
  await page.getByRole("button", { name: "Remove image: pasted.png" }).click();
  await expect(page.getByRole("complementary").locator(".agent-image-preview")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.locator(".agent-chat-composer").evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const files = new DataTransfer();
    files.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("drop", { dataTransfer: files, bubbles: true, cancelable: true }));
  }, imageData);
  await expect(page.getByRole("img", { name: "dropped.png" })).toBeVisible();
});

test("text-only configuration disables image attachment with an actionable hint", async ({ page }) => {
  await mockSettings(page, true, false);
  await page.goto("/?ai-assistant");
  await open(page);
  const button = page.getByRole("button", { name: "Attach images", exact: true });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute(
    "title",
    "Ask a workspace administrator to enable image input for the default model in workspace AI settings."
  );
});

test("streams safe Markdown, updates friendly tool progress and keeps only successful text history", async ({
  page,
}) => {
  await mockSettings(page);
  await page.goto("/?ai-assistant");
  await open(page);
  const storageBefore = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  await send(page, "List my work items");
  expect(await page.evaluate(() => window.aiFixture.requests[0])).toMatchObject({
    credentials: "include",
    csrf: "fixture-csrf",
    body: { messages: [{ role: "user", content: "List my work items" }], project_id: "fixture-project" },
  });
  await frames(page, [
    { type: "tool", id: "one", name: "workitem", action: "list", status: "running" },
    { type: "text", text: "**Found two" },
  ]);
  await expect(page.getByRole("complementary")).toContainText("Found two");
  await expect(page.locator(".agent-tool-detail").getByRole("status")).toHaveText("Read · Work items: Running");
  await frames(page, [
    { type: "tool", id: "one", name: "workitem", action: "list", status: "complete" },
    { type: "text", text: " work items.**\n\n<img src=javascript:alert(1) onerror=alert(1)>" },
    { type: "done", reason: "complete" },
  ]);
  await expect(page.locator(".agent-tool-detail").getByRole("status")).toHaveText("Read · Work items: Complete");
  await expect(page.getByRole("complementary").locator("[data-tool-id]")).toHaveCount(1);
  await expect(page.getByRole("complementary").locator("strong")).toHaveText("Found two work items.");
  await expect(page.getByRole("complementary").locator("img")).toHaveCount(0);
  await page.screenshot({ path: "test-results/ai-assistant-fixture.png", fullPage: true });
  await send(page, "Summarize them");
  const body = await page.evaluate(() => window.aiFixture.requests[1].body);
  expect(body).toEqual({
    messages: [
      { role: "user", content: "List my work items" },
      { role: "assistant", content: "**Found two work items.**\n\n<img src=javascript:alert(1) onerror=alert(1)>" },
      { role: "user", content: "Summarize them" },
    ],
    project_id: "fixture-project",
    model_id: "fixture-model-id",
  });
  await frames(page, [{ type: "text", text: "Summary complete." }, { type: "done" }]);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByRole("complementary")).not.toContainText("Summary complete.");
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual(
    storageBefore
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "AI assistant", exact: true })).toBeFocused();
});

test("cancellation preserves the interrupted turn and offers verification without clearing chat", async ({ page }) => {
  await mockSettings(page);
  await page.goto("/?ai-assistant");
  await open(page);
  await send(page, "Create a work item");
  await frames(page, [
    { type: "tool", id: "one", name: "workitem", action: "create", status: "running" },
    { type: "text", text: "Creating it…" },
  ]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Request cancelled.");
  await expect(page.getByRole("alert")).toContainText("Some tool operations may have completed");
  await expect(page.getByRole("alert")).not.toContainText("clear");
  await expect.poll(() => page.evaluate(() => window.aiFixture.aborted)).toBe(1);
  await page.getByRole("button", { name: "Verify results", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await send(page, "Check whether the work item exists");
  const body = await page.evaluate(() => window.aiFixture.requests[1].body);
  expect(JSON.stringify(body)).toContain("Create a work item");
  expect(JSON.stringify(body)).toContain("Verify the current Plane state");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.aiFixture.aborted)).toBe(2);
});

for (const failure of ["model-error", "interrupted-stream", "empty-response", "run-limit"] as const) {
  test(`${failure} after a write preserves results and supports a verification follow-up`, async ({ page }) => {
    await mockSettings(page);
    await page.goto("/?ai-assistant");
    await open(page);
    await send(page, "Create the release work item");
    await frames(page, [
      { type: "tool", id: "write-one", name: "workitem", action: "create", status: "running" },
      { type: "tool", id: "write-one", name: "workitem", action: "create", status: "complete" },
      { type: "text", text: "The work item was created; checking the result…" },
    ]);
    if (failure === "model-error")
      await frames(page, [
        { type: "error", message: "Model connection ended while verifying the write.", may_have_changes: true },
      ]);
    else if (failure === "interrupted-stream") await page.evaluate(() => window.aiFixture.finish());
    else {
      await frames(page, [
        {
          type: "error",
          code: failure === "empty-response" ? "ai_empty_response" : "ai_run_limit",
          message: "Provider stopped without completing its answer.",
          may_have_changes: true,
        },
        { type: "done", reason: failure === "empty-response" ? "error" : "limit" },
      ]);
      await expect(page.getByRole("alert")).toContainText(
        failure === "empty-response" ? "The assistant completed without a response." : "execution limit"
      );
    }
    const panel = page.getByRole("complementary");
    await expect(panel).toContainText("Create the release work item");
    await expect(panel).toContainText("The work item was created; checking the result…");
    await expect(page.locator(".agent-tool-detail").getByRole("status")).toHaveText("Create · Work items: Complete");
    await expect(page.getByRole("alert")).toContainText("Some tool operations may have completed");
    await expect(page.getByRole("alert")).not.toContainText("clear");
    await send(page, "Check whether the release work item exists before creating anything");
    const body = await page.evaluate(() => window.aiFixture.requests[1].body);
    expect(JSON.stringify(body)).toContain("Verify the current Plane state before repeating any mutation");
    await page.getByRole("button", { name: "Close", exact: true }).click();
  });
}

for (const [code, message] of [
  ["ai_idle_timeout", "The model or tool has not responded for too long"],
  ["ai_model_output_limit", "The model reached its response length limit"],
  ["ai_output_limit", "This response is too large to display"],
] as const) {
  test(`${code} explains the interruption without claiming an execution limit`, async ({ page }) => {
    await mockSettings(page);
    await page.goto("/?ai-assistant");
    await open(page);
    await send(page, "Update and verify the work item");
    await frames(page, [
      { type: "tool", id: "write", name: "workitem", action: "update", status: "complete" },
      { type: "error", code, message: "Provider interruption", may_have_changes: true },
      { type: "done", reason: code === "ai_idle_timeout" ? "error" : "limit" },
    ]);
    await expect(page.getByRole("alert")).toContainText(message);
    await expect(page.getByRole("alert")).not.toContainText("execution limit");
    await expect(page.getByRole("alert")).toContainText("Some tool operations may have completed");
    await expect(page.getByRole("button", { name: "Verify results", exact: true })).toBeVisible();
  });
}

test("Chinese interruption identifies inactivity and keeps the write verification warning", async ({ page }) => {
  await mockSettings(page);
  await page.goto("/?ai-assistant&lang=zh");
  await page.getByRole("button", { name: "AI 助手", exact: true }).click();
  await page.getByRole("textbox", { name: "向助手发送消息" }).fill("修改后检查负责人");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.aiFixture.requests.length)).toBe(1);
  await frames(page, [
    { type: "tool", id: "update", name: "workitem_metadata", action: "update", status: "complete" },
    { type: "error", code: "ai_idle_timeout", message: "Idle timeout", may_have_changes: true },
    { type: "done", reason: "error" },
  ]);
  await expect(page.getByRole("alert")).toContainText("模型或工具长时间没有响应");
  await expect(page.getByRole("alert")).not.toContainText("本次请求已达到执行上限");
  await expect(page.getByRole("alert")).toContainText("部分工具操作可能已经完成");
  await expect(page.getByRole("button", { name: "核对执行结果", exact: true })).toBeVisible();
});

test("pre-execution service configuration errors preserve the draft and never claim changes", async ({ page }) => {
  await mockSettings(page);
  await page.goto("/?ai-assistant");
  await open(page);
  await page.evaluate(() => {
    window.aiFixture.failNext = {
      status: 503,
      body: {
        error: "The AI service is not configured on this instance.",
        code: "ai_service_not_configured",
        may_have_changes: false,
      },
    };
  });
  await send(page, "Create a task later");
  await expect(page.getByRole("alert")).toContainText("assistant service is unavailable");
  await expect(page.getByRole("alert")).not.toContainText("changes");
  await expect(page.getByRole("alert")).not.toContainText("clear");
  await expect(page.getByRole("textbox", { name: "Message the assistant" })).toHaveValue("Create a task later");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await send(page, "Show my tasks instead");
  expect(await page.evaluate(() => window.aiFixture.requests[1].body)).toEqual({
    messages: [{ role: "user", content: "Show my tasks instead" }],
    project_id: "fixture-project",
    model_id: "fixture-model-id",
  });
  await frames(page, [{ type: "text", text: "The service is connected." }, { type: "done" }]);
  await expect(page.getByRole("complementary")).toContainText("The service is connected.");
});

test("stream setup errors with no execution allow immediate retry", async ({ page }) => {
  await mockSettings(page);
  await page.goto("/?ai-assistant");
  await open(page);
  await send(page, "Hello");
  await frames(page, [
    { type: "error", code: "ai_tools_unavailable", message: "unavailable", may_have_changes: false },
  ]);
  await expect(page.getByRole("alert")).toContainText("Plane tools are unavailable");
  await expect(page.getByRole("alert")).not.toContainText("changes");
  await expect(page.getByRole("textbox", { name: "Message the assistant" })).toHaveValue("Hello");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("separates streamed native thoughts and tagged thoughts from the final answer and prompt history", async ({
  page,
}) => {
  await mockSettings(page);
  await page.goto("/?ai-assistant");
  await open(page);
  await send(page, "Explain this task");
  await frames(page, [
    { type: "thinking", text: "Native thought preview" },
    { type: "text", text: "<thi" },
  ]);
  const dialog = page.getByRole("complementary");
  await expect(dialog).not.toContainText("<thi");
  await expect(dialog.locator('[data-agent-part="native-thinking"]')).toHaveCount(1);
  await expect(dialog.getByText("Native thought preview", { exact: true })).toBeVisible();
  await frames(page, [{ type: "text", text: "nk>Tagged thought preview</thi" }]);
  await expect(dialog.getByText("Tagged thought preview", { exact: true })).toBeVisible();
  await frames(page, [{ type: "text", text: "nk><final>**Final answer**</final>" }, { type: "done" }]);
  await expect(dialog.locator("strong")).toHaveText("Final answer");
  await dialog.locator('[data-agent-part="thinking"] summary').click();
  await expect(dialog.getByText("Tagged thought preview", { exact: true })).toBeVisible();
  await send(page, "Follow up");
  const body = await page.evaluate(() => window.aiFixture.requests[1].body);
  expect(body).toEqual({
    messages: [
      { role: "user", content: "Explain this task" },
      { role: "assistant", content: "**Final answer**" },
      { role: "user", content: "Follow up" },
    ],
    project_id: "fixture-project",
    model_id: "fixture-model-id",
  });
});

test("textual tool tags never impersonate executed tools and code examples preserve literal tags", async ({ page }) => {
  await mockSettings(page);
  await page.goto("/?ai-assistant");
  await open(page);
  await send(page, "Show a tool example");
  await frames(page, [
    {
      type: "text",
      text: '<tool_call>{"name":"workitem","action":"create"}</tool_call><tool_result>{"ok":true}</tool_result><answer>Example:\n\n```xml\n<think>literal code</think>\n```\n\nDone.</answer>',
    },
    { type: "done" },
  ]);
  const dialog = page.getByRole("complementary");
  await expect(dialog.locator("[data-tool-id]")).toHaveCount(0);
  await expect(dialog.locator('[data-agent-part="thinking"]')).toHaveCount(0);
  await dialog.locator('[data-agent-part="tool-call"] summary').click();
  await expect(
    dialog.getByText("This is text returned by the model. Check the tool records for actual execution results.").first()
  ).toBeVisible();
  await expect(dialog.locator("pre").filter({ hasText: "literal code" })).toContainText("<think>literal code</think>");
  await page.evaluate(() => {
    let copied = "";
    Object.defineProperty(window, "copiedCode", { get: () => copied });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied = text;
        },
      },
    });
  });
  const block = dialog.locator(".chat-markdown-code").filter({ hasText: "literal code" });
  await block.getByRole("button", { name: "Copy code", exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, "copiedCode"))).toBe("<think>literal code</think>\n");
  await expect(block.getByRole("button")).toHaveText("Copied");
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    })
  );
  await block.getByRole("button", { name: "Copy code", exact: true }).click();
  await expect(block.getByRole("button")).toHaveText("Copy failed");
});

test("shows safe tool details and verified work-item links and retains them with the corresponding turn", async ({
  page,
}) => {
  await mockSettings(page);
  await page.goto("/?ai-assistant");
  await open(page);
  await send(page, "Create a login bug");
  const item = {
    id: "12345678-1234-4234-8234-123456789abc",
    projectId: "87654321-1234-4234-8234-123456789abc",
    identifier: "ENG-42",
    name: "Fix login",
  };
  await frames(page, [
    { type: "tool", id: "one", name: "workitem", action: "create", status: "running" },
    {
      type: "tool",
      id: "one",
      name: "workitem",
      action: "create",
      status: "complete",
      details: {
        input: '{"name":"Fix login"}',
        output: '{"id":"safe","name":"Fix login"}',
        truncated: true,
        workItems: [item],
      },
    },
    { type: "text", text: "Created ENG-42. Unverified ENG-99 stays plain." },
    { type: "done" },
  ]);
  const dialog = page.getByRole("complementary");
  await expect(dialog.getByRole("link", { name: "ENG-42", exact: true })).toHaveAttribute(
    "href",
    `/workspace/projects/${item.projectId}/issues/${item.id}/`
  );
  await expect(dialog.getByRole("link", { name: "ENG-99", exact: true })).toHaveCount(0);
  const record = dialog.locator('[data-tool-id="one"]');
  await record.locator("summary").click();
  await expect(record.getByRole("region", { name: "Parameters" })).toContainText("Fix login");
  await expect(record.getByRole("region", { name: "Result" })).toContainText("Fix login");
  await expect(record).toContainText("This preview is shortened.");
  await expect(record.getByRole("link")).toHaveAttribute("target", "_blank");
  await send(page, "List the task");
  await frames(page, [{ type: "text", text: "It is still ENG-42." }, { type: "done" }]);
  await expect(dialog.locator('[data-tool-id="one"]')).toHaveCount(1);
  const sent = await page.evaluate(() => window.aiFixture.requests[1].body);
  expect(JSON.stringify(sent)).not.toContain("workItems");
  expect(JSON.stringify(sent)).not.toContain("details");
});

test("renders GFM, safe structural HTML and bounded rich content on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await mockSettings(page);
  await page.goto("/?ai-assistant");
  await open(page);
  await send(page, "Format the result");
  const table = "| Column A | Column B | Column C |\n| --- | --- | --- |\n| one | two | three |";
  const rich = `# Result\n\n${table}\n\n- [x] Complete\n- [ ] Pending\n\n~~Removed~~\n\n<details><summary>Extra detail</summary><p>Press <kbd>Enter</kbd>, H<sub>2</sub>O and x<sup>2</sup>.</p></details>\n\n\`\`\`javascript\nconst message = "${"long-value-".repeat(200)}";\n\`\`\`\n\n<script>window.invalidMarkupRan = true</script><iframe src="https://example.invalid"></iframe><span onclick="alert(1)" style="position:fixed">Safe text</span>`;
  await frames(page, [{ type: "text", text: rich }, { type: "done" }]);
  const dialog = page.getByRole("complementary");
  await expect(dialog.getByRole("heading", { name: "Result", exact: true })).toBeVisible();
  await expect(dialog.getByRole("table")).toHaveCount(1);
  await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(dialog.locator('input[type="checkbox"]').first()).toBeChecked();
  await expect(dialog.locator('input[type="checkbox"]').last()).toBeDisabled();
  await expect(dialog.locator("del")).toHaveText("Removed");
  await dialog.locator("summary").filter({ hasText: "Extra detail" }).click();
  await expect(dialog.locator("kbd")).toHaveText("Enter");
  await expect(dialog.locator("code .hljs-keyword")).toContainText("const");
  await expect(dialog.locator(".agent-message-content").locator("script, iframe, [onclick], [style]")).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "invalidMarkupRan"))).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
  const code = dialog.locator(".chat-markdown-code pre");
  expect(await code.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
});

test("follows streamed output only while the reader remains at the bottom", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 700 });
  await mockSettings(page);
  await page.goto("/?ai-assistant");
  await open(page);
  await send(page, "Write a long explanation");
  await frames(page, [
    {
      type: "text",
      text: Array.from({ length: 25 }, (_, index) => `Paragraph ${index}: a useful explanation of the request.`).join(
        "\n\n"
      ),
    },
  ]);
  const scroll = page.locator(".agent-conversation");
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await frames(page, [{ type: "text", text: "\n\nAnother paragraph arrives." }]);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThan(64);
  await frames(page, [{ type: "done" }]);
});

test("sanitized model errors remain visible and navigation or user changes destroy the active turn", async ({
  page,
}) => {
  await mockSettings(page);
  await page.goto("/?ai-assistant");
  await open(page);
  await send(page, "Hello");
  await frames(page, [{ type: "error", message: "This model is unavailable for your account." }]);
  await expect(page.getByRole("alert")).toContainText("This model is unavailable for your account.");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await send(page, "Check project");
  await page.evaluate(() => window.aiFixture.navigate("/other/projects/next-project"));
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.aiFixture.aborted)).toBe(1);
  await open(page);
  await send(page, "Hello other workspace");
  expect(await page.evaluate(() => window.aiFixture.requests.at(-1)?.url)).toContain(
    "/api/workspaces/other/agent/chat/"
  );
  await page.evaluate(() => window.aiFixture.switchUser());
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.aiFixture.aborted)).toBe(2);
});

test("selects an administrator-configured workspace model without navigating away", async ({ page }) => {
  await mockSettings(page, true, false, [
    { id: "default-model-id", model: "default-model", supports_images: false, is_enabled: true, is_default: true },
    { id: "vision-model-id", model: "vision-model", supports_images: true, is_enabled: true, is_default: false },
  ]);
  await page.goto("/?ai-assistant");
  await open(page);

  const modelSelect = page.locator("select.agent-model-button");
  await expect(modelSelect).toHaveValue("default-model-id");
  await modelSelect.selectOption("vision-model-id");
  await expect(page).toHaveURL(/ai-assistant/);
  await send(page, "Use the selected model");
  await expect
    .poll(() => page.evaluate(() => window.aiFixture.requests.at(-1)?.body))
    .toMatchObject({
      model_id: "vision-model-id",
    });
});
