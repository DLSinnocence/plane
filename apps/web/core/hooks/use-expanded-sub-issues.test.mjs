/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import React, { createElement, useCallback, useState } from "react";
import { act, create } from "react-test-renderer";
import ts from "typescript";
import { getListRootIssueIds, MAX_LIST_NESTING_LEVEL } from "../components/issues/issue-layouts/list/hierarchy.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL("./use-expanded-sub-issues.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const hookModule = {};
new Function("require", "exports", compiled)((id) => {
  if (id === "../components/issues/issue-layouts/list/hierarchy") return { MAX_LIST_NESTING_LEVEL };
  return require(id);
}, hookModule);
const { useExpandedSubIssues } = hookModule;

const defaults = {
  workspaceSlug: "workspace",
  projectId: "project",
  issueId: "parent",
  subIssueCount: 1,
  nestingLevel: 0,
};

async function mountHook(initialProps) {
  let snapshot;
  let renderer;
  function Probe(props) {
    snapshot = useExpandedSubIssues(props);
    return createElement(
      "button",
      { onClick: () => snapshot.setExpanded((value) => !value) },
      String(snapshot.isExpanded)
    );
  }
  await act(async () => {
    renderer = create(createElement(Probe, initialProps));
  });
  return {
    get snapshot() {
      return snapshot;
    },
    toggle: () => act(async () => renderer.root.findByType("button").props.onClick()),
    update: (props) => act(async () => renderer.update(createElement(Probe, props))),
    unmount: () => act(async () => renderer.unmount()),
  };
}

test("mount expands and fetches children without a click; manual collapse survives rerender", async () => {
  const calls = [];
  const props = {
    ...defaults,
    fetchSubIssues: async (...args) => {
      calls.push(args);
    },
  };
  const view = await mountHook(props);
  try {
    assert.equal(view.snapshot.isExpanded, true);
    assert.deepEqual(calls, [["workspace", "project", "parent"]]);
    await view.toggle();
    assert.equal(view.snapshot.isExpanded, false);
    await view.update({ ...props });
    assert.equal(view.snapshot.isExpanded, false);
    await view.toggle();
    assert.equal(view.snapshot.isExpanded, true);
    assert.equal(calls.length, 1);
  } finally {
    await view.unmount();
  }
});

test("re-entering a list does not restore a previous temporary collapse", async () => {
  const props = { ...defaults, fetchSubIssues: async () => {} };
  const first = await mountHook(props);
  await first.toggle();
  assert.equal(first.snapshot.isExpanded, false);
  await first.unmount();
  const next = await mountHook(props);
  try {
    assert.equal(next.snapshot.isExpanded, true);
  } finally {
    await next.unmount();
  }
});

test("loading waits for identity and child count, then starts automatically", async () => {
  const calls = [];
  const fetchSubIssues = async (...args) => {
    calls.push(args);
  };
  const view = await mountHook({ ...defaults, workspaceSlug: undefined, subIssueCount: undefined, fetchSubIssues });
  try {
    assert.equal(calls.length, 0);
    await view.update({ ...defaults, fetchSubIssues });
    assert.equal(calls.length, 1);
    await view.update({ ...defaults, subIssueCount: 2, fetchSubIssues });
    assert.equal(calls.length, 2);
  } finally {
    await view.unmount();
  }
});

test("leaf, epic, and maximum inline depth do not fetch children", async () => {
  for (const overrides of [{ subIssueCount: 0 }, { isEpic: true }, { nestingLevel: MAX_LIST_NESTING_LEVEL }]) {
    let calls = 0;
    const view = await mountHook({
      ...defaults,
      ...overrides,
      fetchSubIssues: async () => {
        calls++;
      },
    });
    try {
      assert.equal(calls, 0);
      if (overrides.isEpic || overrides.nestingLevel !== undefined) assert.equal(view.snapshot.isExpanded, false);
    } finally {
      await view.unmount();
    }
  }
});

test("failed initial load can retry after collapsing and reopening", async () => {
  let calls = 0;
  const originalError = console.error;
  console.error = () => {};
  const view = await mountHook({
    ...defaults,
    fetchSubIssues: async () => {
      calls++;
      if (calls === 1) throw new Error("temporary failure");
    },
  });
  try {
    await view.toggle();
    await view.toggle();
    assert.equal(calls, 2);
    assert.equal(view.snapshot.isExpanded, true);
  } finally {
    await view.unmount();
    console.error = originalError;
  }
});

test("nested read-only trees actually load and render all matching deep rows once", async () => {
  const issuesMap = Object.fromEntries(
    Array.from({ length: 9 }, (_, depth) => [
      String(depth),
      {
        id: String(depth),
        project_id: "project",
        parent_id: depth ? String(depth - 1) : null,
        created_at: "2026-01-01",
        sub_issues_count: depth < 8 ? 1 : 0,
      },
    ])
  );
  const calls = [];
  function Row({ issueId, nestingLevel, childrenById, fetchSubIssues }) {
    const expansion = useExpandedSubIssues({
      ...defaults,
      issueId,
      nestingLevel,
      subIssueCount: issuesMap[issueId].sub_issues_count,
      fetchSubIssues,
    });
    return createElement(
      React.Fragment,
      null,
      createElement("span", { "data-issue": issueId, "data-editable": false }, issueId),
      expansion.isExpanded &&
        (childrenById[issueId] ?? []).map((id) =>
          createElement(Row, {
            key: id,
            issueId: id,
            nestingLevel: nestingLevel + 1,
            childrenById,
            fetchSubIssues,
          })
        )
    );
  }
  function Tree({ issueIds }) {
    const [childrenById, setChildrenById] = useState({});
    const fetchSubIssues = useCallback(async (_workspace, _project, id) => {
      calls.push(id);
      const childIds = Object.keys(issuesMap).filter((childId) => issuesMap[childId].parent_id === id);
      setChildrenById((previous) => ({ ...previous, [id]: childIds }));
    }, []);
    return getListRootIssueIds(issueIds, issuesMap).map((id) =>
      createElement(Row, {
        key: id,
        issueId: id,
        nestingLevel: 0,
        childrenById,
        fetchSubIssues,
      })
    );
  }
  let renderer;
  try {
    await act(async () => {
      renderer = create(createElement(Tree, { issueIds: Object.keys(issuesMap) }));
    });
    const renderedIds = renderer.root.findAllByType("span").map((row) => row.props["data-issue"]);
    assert.deepEqual(renderedIds, Object.keys(issuesMap));
    assert.deepEqual(calls.slice().sort(), ["0", "1", "2", "4", "5", "6"]);
    await act(async () => renderer.update(createElement(Tree, { issueIds: ["8"] })));
    assert.deepEqual(
      renderer.root.findAllByType("span").map((row) => row.props["data-issue"]),
      ["8"]
    );
  } finally {
    if (renderer) await act(async () => renderer.unmount());
  }
});
