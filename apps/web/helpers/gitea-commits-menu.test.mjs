/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

function parse(relativePath) {
  const file = new URL(`../core/components/issues/${relativePath}`, import.meta.url);
  return ts.createSourceFile(
    file.pathname,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function collect(source, predicate) {
  const result = [];
  function visit(node) {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

const importsNamed = (source, name) => collect(source, (node) => ts.isImportSpecifier(node) && node.name.text === name);
const rendersNamed = (source, name) =>
  collect(
    source,
    (node) =>
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === name
  );

test("work item main content does not import or render linked commits inline", () => {
  const source = parse("issue-detail/main-content.tsx");
  assert.equal(importsNamed(source, "IssueGitCommits").length, 0);
  assert.equal(rendersNamed(source, "IssueGitCommits").length, 0);
  assert.equal(importsNamed(source, "IssueGitCommitsModal").length, 0);
  const commitImports = collect(
    source,
    (node) => ts.isImportDeclaration(node) && /git-commits/.test(node.moduleSpecifier.text)
  );
  assert.equal(commitImports.length, 0);
});

for (const path of ["issue-detail/issue-detail-quick-actions.tsx", "peek-overview/header.tsx"]) {
  test(`${path} uses the shared work item detail menu`, () => {
    const source = parse(path);
    assert.equal(importsNamed(source, "WorkItemDetailQuickActions").length, 1);
    assert.equal(rendersNamed(source, "WorkItemDetailQuickActions").length, 1);
  });
}

test("the shared menu owns the real commits dialog", () => {
  const source = parse("issue-layouts/quick-action-dropdowns/issue-detail.tsx");
  assert.equal(importsNamed(source, "IssueGitCommitsModal").length, 1);
  assert.equal(rendersNamed(source, "IssueGitCommitsModal").length, 1);
});
