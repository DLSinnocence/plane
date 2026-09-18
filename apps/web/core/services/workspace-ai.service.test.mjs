/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@plane/constants")
      return { url: "data:text/javascript,export const API_BASE_URL = '';", shortCircuit: true };
    if (specifier === "@/services/agent.service")
      return { url: new URL("./agent.service.ts", import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const service = await import("./workspace-ai.service.ts");
hooks.deregister();

test("workspace reads and writes use scoped paths, CSRF and cancellation without exposing keys in URLs", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, ...init });
    return new Response(JSON.stringify(url.includes("get-csrf-token") ? { csrf_token: "csrf" } : { providers: [] }));
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await service.getWorkspaceAISettings("alpha/beta", signal), { providers: [] });
  await service.updateWorkspaceAIProvider(
    "alpha/beta",
    "provider/id",
    { base_url: "https://example.test", api_key: "secret" },
    signal
  );
  await service.createWorkspaceAIModel("alpha/beta", "provider/id", { model: "shared", is_default: true }, signal);
  assert.equal(calls[0].url, "/api/workspaces/alpha%2Fbeta/ai-settings/");
  assert.equal(calls[2].url, "/api/workspaces/alpha%2Fbeta/ai-settings/providers/provider%2Fid/");
  assert.equal(calls[2].headers["X-CSRFToken"], "csrf");
  assert.deepEqual(JSON.parse(calls[2].body), { base_url: "https://example.test", api_key: "secret" });
  assert.equal(calls[4].url, "/api/workspaces/alpha%2Fbeta/ai-settings/providers/provider%2Fid/models/");
  for (const call of calls) {
    assert.equal(call.credentials, "include");
    assert.equal(call.signal, signal);
    assert.ok(!call.url.includes("secret"));
  }
});

test("default validation failures are shown and never retried", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls++;
    return url.includes("get-csrf-token")
      ? new Response('{"csrf_token":"csrf"}')
      : new Response('{"is_default":["Enable the provider first."]}', { status: 400 });
  });
  await assert.rejects(
    service.updateWorkspaceAIModel("alpha", "provider", "model", { is_default: true }, new AbortController().signal),
    /Default model: Enable the provider first/
  );
  assert.equal(calls, 2);
});
