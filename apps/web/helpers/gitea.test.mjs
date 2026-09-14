/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { getCommitDate, getSafeCommitUrl } from "./gitea.ts";

// Isolate the transport while executing the actual service implementation.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@plane/constants")
      return { url: "data:text/javascript,export const API_BASE_URL = '';", shortCircuit: true };
    if (specifier === "@/services/api.service")
      return { url: "data:text/javascript,export class APIService {}", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { GiteaService } = await import("../core/services/integrations/gitea.service.ts");
hooks.deregister();

test("workspace config and explicit hook generation preserve envelopes, bodies, and encoded paths", async () => {
  const service = new GiteaService();
  const calls = [];
  const payload = { enabled: true, has_secret: true };
  for (const method of ["get", "post", "patch"]) {
    service[method] = async (...args) => {
      calls.push([method, ...args]);
      return { data: payload };
    };
  }
  const root = "/api/workspaces/team%2Fone/integrations/gitea/";
  assert.equal(await service.getConfig("team/one"), payload);
  assert.equal(await service.updateConfig("team/one", { enabled: true }), payload);
  assert.equal(await service.generateHooks("team/one", "https://git.example/a/b"), payload);
  assert.equal(await service.generateHooks("team/one"), payload);
  assert.equal(await service.rotateToken("team/one"), payload);
  assert.deepEqual(calls, [
    ["get", root],
    ["patch", root, { enabled: true }],
    ["post", `${root}hooks/`, { repository_url: "https://git.example/a/b" }],
    ["post", `${root}hooks/`, {}],
    ["post", `${root}rotate-token/`, {}],
  ]);
});

test("commit pagination passes the requested page and preserves count and next_page", async () => {
  const service = new GiteaService();
  const calls = [];
  const payload = { results: [], count: 13, next_page: 4 };
  service.get = async (...args) => {
    calls.push(args);
    return { data: payload };
  };
  assert.equal(await service.listIssueCommits("w/x", "p/x", "i?x", 3), payload);
  await service.listIssueCommits("w/x", "p/x", "i?x");
  const path = "/api/workspaces/w%2Fx/projects/p%2Fx/issues/i%3Fx/git-commits/";
  assert.deepEqual(calls, [
    [path, { params: { page: 3 } }],
    [path, { params: { page: 1 } }],
  ]);
});

test("service failures propagate for callers to display a retry state", async () => {
  const service = new GiteaService();
  const error = new Error("unavailable");
  service.get = async () => {
    throw error;
  };
  await assert.rejects(service.listIssueCommits("w", "p", "i"), (actual) => actual === error);
});

test("commit links allow only absolute HTTP and HTTPS URLs", () => {
  assert.equal(
    getSafeCommitUrl("https://git.example/owner/repo/commit/abc"),
    "https://git.example/owner/repo/commit/abc"
  );
  assert.equal(getSafeCommitUrl("http://git.example/commit/abc"), "http://git.example/commit/abc");
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "https://user:secret@example.test/commit",
    "//evil.example",
    "/relative",
    "invalid",
    "",
  ]) {
    assert.equal(getSafeCommitUrl(url), undefined);
  }
});

test("missing and invalid commit dates use the unknown-date path", () => {
  assert.equal(getCommitDate(null), undefined);
  assert.equal(getCommitDate(""), undefined);
  assert.equal(getCommitDate("invalid"), undefined);
  assert.equal(getCommitDate("2026-01-02T03:04:05Z")?.toISOString(), "2026-01-02T03:04:05.000Z");
});
