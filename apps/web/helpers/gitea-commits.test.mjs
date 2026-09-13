/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const swrUrl = "data:text/javascript,export const state = {}; export default function useSWR() { return state; }";
const { state } = await import(swrUrl);
const componentUrl = new URL("../core/components/issues/issue-detail/git-commits.tsx", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocks = {
      swr: swrUrl,
      "@plane/i18n": "data:text/javascript,export function useTranslation() { return {t: key => key}; }",
      "@/helpers/gitea": new URL("./gitea.ts", import.meta.url).href,
      "@/services/integrations/gitea.service": "data:text/javascript,export class GiteaService {}",
    };
    if (Object.hasOwn(mocks, specifier)) return { url: mocks[specifier], shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === componentUrl) {
      const { outputText } = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      });
      return { format: "module", source: outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { IssueGitCommits } = await import(componentUrl);
hooks.deregister();

function render(response) {
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, response);
  return renderToStaticMarkup(createElement(IssueGitCommits, { workspaceSlug: "w", projectId: "p", issueId: "i" }));
}

test("commit widget renders loading, retryable errors, and an empty state", () => {
  assert.match(render({ isLoading: true }), /gitea_integration.loading/);
  const error = render({ error: new Error("private backend details") });
  assert.match(error, /role="alert"/);
  assert.match(error, /gitea_integration.load_error/);
  assert.match(error, /gitea_integration.retry/);
  assert.doesNotMatch(error, /private backend details/);
  assert.match(render({ data: { results: [], count: 0, next_page: null } }), /gitea_integration.empty_commits/);
});

test("commit widget escapes text, omits unsafe links, and exposes pagination", () => {
  const commit = {
    id: "1",
    sha: "abcdef012345",
    short_sha: "abcdef0",
    title: "<script>alert(1)</script>",
    author_name: "Author",
    repository_name: "owner/repo",
    branch: "main",
    committed_at: null,
    url: "javascript:alert(1)",
  };
  const html = render({ data: { results: [commit], count: 5, next_page: 2 } });
  assert.doesNotMatch(html, /href=|<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /gitea_integration.unknown_date/);
  assert.match(html, /gitea_integration.previous/);
  assert.match(html, /gitea_integration.next/);
  const safe = render({
    data: {
      results: [{ ...commit, url: "https://git.example/commit/abc", committed_at: "2026-01-01T00:00:00Z" }],
      count: 1,
      next_page: null,
    },
  });
  assert.match(safe, /target="_blank" rel="noopener noreferrer"/);
  assert.match(safe, /dateTime="2026-01-01T00:00:00.000Z"/);
  assert.doesNotMatch(safe, /gitea_integration.next/);
});
