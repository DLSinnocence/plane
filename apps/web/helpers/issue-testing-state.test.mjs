/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isStateAvailableForIssue } from "./issue-testing-state.ts";

const states = [
  { id: "todo", name: "Todo", default: true },
  { id: "acceptance", name: "Acceptance", is_testing: false },
  { id: "testing", name: "Renamed testing stage", is_testing: true },
  { id: "custom", name: "验收完成/待测试" },
  { id: "done", name: "Done", is_testing: false },
];

test("testing remains available when explicitly required", () => {
  assert.deepEqual(
    states.filter((state) => isStateAvailableForIssue(state, true)),
    states
  );
});

test("the default and opting out hide only backend-marked testing states", () => {
  for (const needsTesting of [undefined, false]) {
    assert.deepEqual(
      states.filter((state) => isStateAvailableForIssue(state, needsTesting)).map((state) => state.id),
      ["todo", "acceptance", "custom", "done"]
    );
  }
});

test("changing the testing preference restores choices without mutating the project workflow", () => {
  const original = structuredClone(states);
  assert.equal(states.filter((state) => isStateAvailableForIssue(state, false)).length, 4);
  assert.equal(states.filter((state) => isStateAvailableForIssue(state, true)).length, 5);
  assert.deepEqual(states, original);
});
