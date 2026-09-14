/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import { expect, test, type Page } from "@playwright/test";

async function mockSettings(page: Page, configured = true, supportsImages = false) {
  let current = {
    provider: "openai",
    base_url: "",
    model: "fixture-model",
    has_api_key: configured,
    supports_images: supportsImages,
  };
  const mutations: { method: string; body: unknown; csrf: string | undefined }[] = [];
  await page.route("**/auth/get-csrf-token/", (route) => route.fulfill({ json: { csrf_token: "fixture-csrf" } }));
  await page.route("**/api/users/me/ai-settings/", async (route) => {
    const request = route.request();
    if (request.method() === "PATCH") {
      const data = request.postDataJSON();
      mutations.push({ method: "PATCH", body: data, csrf: request.headers()["x-csrftoken"] });
      current = {
        provider: data.provider,
        base_url: data.base_url,
        model: data.model,
        has_api_key: true,
        supports_images: data.supports_images ?? false,
      };
    }
    await route.fulfill({ json: current });
  });
  return mutations;
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
  await expect(page.getByRole("button", { name: "Model settings: fixture-model" })).toBeVisible();
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
  await page.route("**/api/users/me/ai-settings/", (route) =>
    route.fulfill({
      json: {
        provider: "openai",
        base_url: "https://custom.example/v1",
        model: "gpt-4o",
        has_api_key: true,
        supports_images: true,
        model_metadata: { name: "GPT-4o", vision: true, tools: true, metadata_source: "models.dev" },
      },
    })
  );
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
    { type: "done" },
  ]);
  await expect(aside.getByRole("link", { name: "ENG-42", exact: true })).toBeVisible();
  await expect(aside.getByRole("button", { name: "模型设置: GPT-4o" })).toBeVisible();
  await page.screenshot({ path: "test-results/ai-sidebar-zh.png", fullPage: true });
});

test("opens docked sidebar and configures personal settings without repopulating the key", async ({ page }) => {
  const mutations = await mockSettings(page, false);
  await page.route("**/api/users/me/ai-settings/models/", (route) =>
    route.fulfill({
      json: { models: [{ id: "fixture-model", name: "fixture-model", vision: null, tools: null }], truncated: false },
    })
  );
  await page.goto("/?ai-assistant");
  await expect(page.getByRole("button", { name: "AI assistant", exact: true })).toHaveText("AI");
  await open(page);
  await expect(page.locator("#workspace-ai-sidebar > aside")).toBeVisible();
  await expect(page.getByRole("complementary")).not.toContainText("fixture-project");
  await page.getByRole("button", { name: "Configure AI", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Profile settings fixture" })).toBeVisible();
  await expect(page.getByTestId("profile-options")).toContainText('"activeTab":"ai"');
  await page.getByLabel(/^API key/).fill("synthetic-fixture-key");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Fetch models", exact: true }).click();
  await page.getByRole("button", { name: "Model Select a model", exact: true }).click();
  await page.getByRole("listbox").getByRole("option").filter({ hasText: "fixture-model" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("form").getByRole("status")).toHaveText("Settings updated.");
  await expect(page.getByLabel(/^API key/)).toHaveValue("");
  expect(mutations[0]).toEqual({
    method: "PATCH",
    csrf: "fixture-csrf",
    body: {
      provider: "openai",
      base_url: "",
      model: "fixture-model",
      api_key: "synthetic-fixture-key",
      supports_images: false,
    },
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => mutations.length).toBe(2);
  expect(mutations[1].body).not.toHaveProperty("api_key");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.getByRole("textbox", { name: "Message the assistant" })).toBeEnabled();
});

test("saved model metadata renders registry capabilities without unknown placeholders", async ({ page }) => {
  await mockSettings(page);
  await page.route("**/api/users/me/ai-settings/", (route) =>
    route.fulfill({
      json: {
        provider: "openai",
        base_url: "https://custom.example/v1",
        model: "gpt-4o",
        has_api_key: true,
        supports_images: false,
        model_metadata: {
          name: "GPT-4o",
          vision: true,
          tools: true,
          reasoning: false,
          context_window: 128000,
          metadata_source: "models.dev",
        },
      },
    })
  );
  await page.goto("/?ai-assistant");
  await open(page);
  await expect(page.getByRole("button", { name: "Model settings: GPT-4o" })).toBeVisible();
  await page.getByRole("button", { name: "Model settings", exact: true }).click();
  await page.getByRole("button", { name: "Model GPT-4o", exact: true }).click();
  const option = page.getByRole("listbox").getByRole("option");
  await expect(option).toContainText("Images supported");
  await expect(option).toContainText("Tools supported");
  await expect(option).toContainText("models.dev");
  await expect(option).not.toContainText("unknown");
  await option.click();
  await expect(page.getByRole("checkbox", { name: "Enable image input" })).toBeEnabled();
});

test("fetches models from an arbitrary gateway and searches by name or ID with capability selection", async ({
  page,
}) => {
  const mutations = await mockSettings(page, false);
  const discoveries: unknown[] = [];
  await page.route("**/api/users/me/ai-settings/models/", async (route) => {
    discoveries.push(route.request().postDataJSON());
    expect(route.request().headers()["x-csrftoken"]).toBe("fixture-csrf");
    await route.fulfill({
      json: {
        models: [
          { id: "team-text", name: "Text model", vision: false, tools: true },
          { id: "my-vision-v2", name: "Screenshot Reader", vision: true, tools: true },
          { id: "private-model", name: "Unknown capability", vision: null, tools: null },
        ],
        truncated: false,
      },
    });
  });
  await page.goto("/?ai-assistant");
  await open(page);
  await page.getByRole("button", { name: "Configure AI", exact: true }).click();
  await page.getByLabel(/^Base URL/).fill("http://model-gateway.internal:8080/custom/v1");
  await page.getByLabel(/^API key/).fill("custom-test-key");
  await expect(page.getByRole("textbox", { name: "Model", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Fetch models", exact: true }).click();
  await page.getByRole("button", { name: "Model Select a model", exact: true }).click();
  const search = page.getByRole("combobox", { name: "Search models by name or ID" });
  await search.fill("VISION-v2");
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("listbox").getByRole("option")).toContainText("Screenshot Reader");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(page.getByRole("checkbox", { name: "Enable image input" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Enable image input" })).toBeEnabled();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => mutations.length).toBe(1);
  expect(mutations[0].body).toMatchObject({
    base_url: "http://model-gateway.internal:8080/custom/v1",
    model: "my-vision-v2",
    supports_images: true,
  });
  expect(discoveries[0]).toEqual({
    provider: "openai",
    base_url: "http://model-gateway.internal:8080/custom/v1",
    api_key: "custom-test-key",
  });
  await page.getByRole("button", { name: "Model Screenshot Reader", exact: true }).click();
  await search.fill("Unknown");
  await page.getByRole("listbox").getByRole("option").click();
  await expect(page.getByRole("checkbox", { name: "Enable image input" })).toBeEnabled();
  await page.getByRole("checkbox", { name: "Enable image input" }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => mutations.length).toBe(2);
  expect(mutations[1].body).toMatchObject({ model: "private-model", supports_images: true });
});

test("destination changes invalidate fetched models and ignore obsolete model responses", async ({ page }) => {
  await mockSettings(page, false);
  let firstResolve: (() => void) | undefined;
  let calls = 0;
  await page.route("**/api/users/me/ai-settings/models/", async (route) => {
    const id = ++calls;
    if (id === 1)
      await new Promise<void>((resolve) => {
        firstResolve = resolve;
      });
    await route
      .fulfill({
        json: {
          models: [
            {
              id: id === 1 ? "obsolete-model" : "new-model",
              name: id === 1 ? "Obsolete" : "Current",
              vision: null,
              tools: null,
            },
          ],
          truncated: false,
        },
      })
      .catch(() => undefined);
  });
  await page.goto("/?ai-assistant");
  await open(page);
  await page.getByRole("button", { name: "Configure AI", exact: true }).click();
  await page.getByLabel(/^API key/).fill("key");
  await page.getByRole("button", { name: "Fetch models", exact: true }).click();
  await expect.poll(() => calls).toBe(1);
  await page.getByLabel(/^Base URL/).fill("https://different.example/v1");
  firstResolve?.();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Fetch models", exact: true }).click();
  await page.getByRole("button", { name: "Model Select a model", exact: true }).click();
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("listbox").getByRole("option")).toContainText("Current");
  await expect(page.getByRole("listbox").getByRole("option")).not.toContainText("Obsolete");
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
  await expect(button).toHaveAttribute("title", "Enable image input in AI settings to attach images.");
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

for (const failure of ["model-error", "interrupted-stream"] as const) {
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
    else await page.evaluate(() => window.aiFixture.finish());
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
  await expect(dialog.getByText("Native thought preview", { exact: true })).not.toBeVisible();
  await frames(page, [{ type: "text", text: "nk>Tagged thought preview</thi" }]);
  await expect(dialog.getByText("Tagged thought preview", { exact: true })).not.toBeVisible();
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
