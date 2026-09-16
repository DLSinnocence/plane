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
import { EActivityFilterType, E_SORT_ORDER } from "@plane/constants";

const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL("./preferences.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
new Function("require", "exports", code)(require, exports);
const { normalizeActivityFilters, normalizeActivitySortOrder } = exports;
const { ACTIVITY, STATE, ASSIGNEE, COMMENT, DEFAULT } = EActivityFilterType;

test("legacy comment-only, empty and malformed filters fall back to all activity categories", () => {
  for (const value of [[COMMENT], [], [DEFAULT], ["unknown"], null, undefined, "COMMENT", {}, 42]) {
    assert.deepEqual(normalizeActivityFilters(value), [ACTIVITY, STATE, ASSIGNEE]);
  }
});

test("valid activity preferences survive migration without comment, default or duplicate options", () => {
  const stored = [COMMENT, STATE, DEFAULT, STATE, "unknown", ASSIGNEE];
  assert.deepEqual(normalizeActivityFilters(stored), [STATE, ASSIGNEE]);
  assert.deepEqual(stored, [COMMENT, STATE, DEFAULT, STATE, "unknown", ASSIGNEE]);
  assert.deepEqual(normalizeActivityFilters([STATE]), [STATE]);
  assert.deepEqual(normalizeActivityFilters([ACTIVITY, COMMENT, STATE, ASSIGNEE]), [ACTIVITY, STATE, ASSIGNEE]);
});

test("normalizing preferences does not expose a mutable shared default", () => {
  const filters = normalizeActivityFilters(null);
  filters.pop();
  assert.deepEqual(normalizeActivityFilters(null), [ACTIVITY, STATE, ASSIGNEE]);
});

test("valid sort directions are preserved and malformed or absent preferences fall back to ascending", () => {
  assert.equal(normalizeActivitySortOrder(E_SORT_ORDER.DESC), E_SORT_ORDER.DESC);
  for (const value of [E_SORT_ORDER.ASC, null, undefined, "newest", "DESC", {}, [], 0]) {
    assert.equal(normalizeActivitySortOrder(value), E_SORT_ORDER.ASC);
  }
});
