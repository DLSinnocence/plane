/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const code = ts.transpileModule(
  readFileSync(new URL("./issue-detail-widget-collapsibles.tsx", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }
).outputText;
const Attachments = () => null;
const emptyComponent = () => null;

function attachmentsAreVisible({ serviceType = "issues", count = 0, uploading = false, hidden = false } = {}) {
  const store = {
    issue: { getIssueById: () => ({ id: "issue", link_count: 0 }) },
    subIssues: { subIssuesByIssueId: () => [] },
    attachment: {
      getAttachmentsCountByIssueId: () => count,
      getAttachmentsUploadStatusByIssueId: () => (uploading ? [{}] : []),
    },
    relation: { getRelationCountByIssueId: () => 0 },
  };
  const imports = {
    "mobx-react": { observer: (component) => component },
    "@plane/types": { EIssueServiceType: { ISSUES: "issues" } },
    "@/hooks/store/use-issue-detail": { useIssueDetail: () => store },
    "@/components/relations": { useTimeLineRelationOptions: () => [] },
    "./attachments": { AttachmentsCollapsible: Attachments },
    "./links": { LinksCollapsible: emptyComponent },
    "./relations": { RelationsCollapsible: emptyComponent },
    "./sub-issues": { SubIssuesCollapsible: emptyComponent },
  };
  const exports = {};
  new Function("require", "exports", code)((name) => imports[name] ?? require(name), exports);
  const element = exports.IssueDetailWidgetCollapsibles({
    workspaceSlug: "workspace",
    projectId: "project",
    issueId: "issue",
    disabled: false,
    issueServiceType: serviceType,
    hideWidgets: hidden ? ["attachments"] : [],
  });
  return element.props.children.some((child) => child && child.type === Attachments);
}

test("new work items expose the attachment slot and template entry before any file upload", () => {
  assert.equal(attachmentsAreVisible(), true);
});

test("explicitly hidden attachments stay hidden even with existing files or uploads", () => {
  assert.equal(attachmentsAreVisible({ count: 2, hidden: true }), false);
  assert.equal(attachmentsAreVisible({ uploading: true, hidden: true }), false);
});

test("drafts retain the ordinary attachment visibility rules", () => {
  assert.equal(attachmentsAreVisible({ serviceType: "draft-issues" }), false);
  assert.equal(attachmentsAreVisible({ serviceType: "draft-issues", count: 1 }), true);
});
