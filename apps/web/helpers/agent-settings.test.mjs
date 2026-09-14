/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { buildAISettingsInput } from "./agent-settings.ts";
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@plane/constants")
      return { url: "data:text/javascript,export const API_BASE_URL = '';", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { getAISettings, saveAISettings, disconnectAISettings, startAgentChat, fetchAIModels } =
  await import("../core/services/agent.service.ts");
hooks.deregister();
test("blank keys are omitted and model fields trimmed", () => {
  assert.deepEqual(buildAISettingsInput("openai", " https://example.test/v1 ", " model ", "  "), {
    provider: "openai",
    base_url: "https://example.test/v1",
    model: "model",
  });
  assert.equal(buildAISettingsInput("anthropic", "", "model", " new-key ").api_key, "new-key");
});
test("image settings preserve explicit true and false without changing legacy inputs", () => {
  assert.equal(buildAISettingsInput("openai", "", "model", "", true).supports_images, true);
  assert.equal(buildAISettingsInput("openai", "", "model", "", false).supports_images, false);
  assert.equal("supports_images" in buildAISettingsInput("openai", "", "model", ""), false);
});
test("model discovery posts unsaved destinations with CSRF and preserves capability metadata", async (t) => {
  const calls = [];
  const result = {
    models: [{ id: "opaque-1", name: "Enterprise model", vision: false, tools: null }],
    truncated: true,
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, ...init });
    return new Response(JSON.stringify(url.includes("get-csrf-token") ? { csrf_token: "fixture" } : result));
  });
  const signal = new AbortController().signal;
  assert.deepEqual(
    await fetchAIModels({ provider: "openai", base_url: " http://localhost:8000/v1 ", api_key: "  " }, signal),
    result
  );
  assert.equal(calls[1].url, "/api/users/me/ai-settings/models/");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].headers["X-CSRFToken"], "fixture");
  assert.equal(calls[1].credentials, "include");
  assert.equal(calls[1].signal, signal);
  assert.deepEqual(JSON.parse(calls[1].body), { provider: "openai", base_url: "http://localhost:8000/v1" });
  await fetchAIModels({ provider: "anthropic", base_url: "", api_key: " new-key " }, signal);
  assert.deepEqual(JSON.parse(calls[3].body), { provider: "anthropic", base_url: "", api_key: "new-key" });
});
test("model discovery forwards abort signals and does not retry failures", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls++;
    if (init.signal.aborted) throw new DOMException("Aborted", "AbortError");
    return url.includes("get-csrf-token")
      ? new Response('{"csrf_token":"fixture"}')
      : new Response('{"detail":"Provider unavailable"}', { status: 502 });
  });
  const controller = new AbortController();
  await assert.rejects(fetchAIModels({ provider: "openai", base_url: "" }, controller.signal), /Provider unavailable/);
  assert.equal(calls, 2);
  controller.abort();
  await assert.rejects(fetchAIModels({ provider: "openai", base_url: "" }, controller.signal), { name: "AbortError" });
  assert.equal(calls, 3);
});
test("settings and chat mutations obtain CSRF and include credentials without retry", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, ...init });
    return new Response(
      JSON.stringify(
        url.includes("get-csrf-token")
          ? { csrf_token: "fixture-csrf" }
          : { provider: "openai", model: "fixture", base_url: "", has_api_key: true }
      )
    );
  });
  const signal = new AbortController().signal;
  await getAISettings(signal);
  await saveAISettings(buildAISettingsInput("openai", "", "fixture", ""), signal);
  await disconnectAISettings(signal);
  await startAgentChat("a/b", [{ role: "user", content: "hello" }], "project-1", signal);
  assert.equal(calls.length, 7);
  for (const call of calls) {
    assert.equal(call.credentials, "include");
    assert.equal(call.signal, signal);
  }
  assert.equal(calls[1].url, "/auth/get-csrf-token/");
  for (const index of [2, 4, 6]) assert.equal(calls[index].headers["X-CSRFToken"], "fixture-csrf");
  assert.equal(calls[4].method, "DELETE");
  assert.equal(calls[6].url, "/api/workspaces/a%2Fb/agent/chat/");
  assert.deepEqual(JSON.parse(calls[6].body), {
    messages: [{ role: "user", content: "hello" }],
    project_id: "project-1",
  });
  assert.equal("api_key" in JSON.parse(calls[2].body), false);
});
test("settings errors include readable field validation and preserve a non-JSON fallback", async (t) => {
  let payload = JSON.stringify({ api_key: ["An API key is required."], model: ["Choose a valid model."] });
  t.mock.method(globalThis, "fetch", async (url) =>
    url.includes("get-csrf-token") ? new Response('{"csrf_token":"fixture"}') : new Response(payload, { status: 400 })
  );
  const signal = new AbortController().signal;
  await assert.rejects(
    saveAISettings(buildAISettingsInput("openai", "", "", ""), signal),
    /Model: Choose a valid model\. API key: An API key is required\./
  );
  payload = JSON.stringify({ detail: "Settings are unavailable." });
  await assert.rejects(getAISettings(signal), /Settings are unavailable\./);
  payload = JSON.stringify({ error: "Configure your model in personal AI settings first." });
  await assert.rejects(
    startAgentChat("workspace", [{ role: "user", content: "hello" }], undefined, signal),
    /Configure your model in personal AI settings first\./
  );
  payload = "<html>Proxy unavailable</html>";
  await assert.rejects(getAISettings(signal), /Request failed \(400\)/);
});

test("CSRF failures prevent writes and failed writes are never retried", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("{}", { status: 403 });
  });
  await assert.rejects(disconnectAISettings(new AbortController().signal));
  assert.equal(calls, 1);
  globalThis.fetch = async () => {
    calls++;
    return calls === 2 ? new Response('{"csrf_token":"fixture"}') : new Response("{}", { status: 502 });
  };
  await assert.rejects(startAgentChat("workspace", [], undefined, new AbortController().signal));
  assert.equal(calls, 3);
});
