/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { getWorkItemLinkTitle } from "./work-item-link.ts";

test("work item link labels include the identifier and full Chinese name", () => {
  assert.equal(
    getWorkItemLinkTitle({ projectIdentifier: "WITCHFARM", sequenceId: 10, name: "修复农场显示" }),
    "WITCHFARM-10 修复农场显示"
  );
  assert.equal(
    getWorkItemLinkTitle({ projectIdentifier: " FARM ", sequenceId: 11, name: `  支持 <标签> & "引号"  ` }),
    `FARM-11 支持 <标签> & "引号"`
  );
});

test("partially loaded issue metadata never produces undefined identifiers", () => {
  for (const partial of [
    {},
    { projectIdentifier: "WITCHFARM" },
    { sequenceId: 10 },
    { projectIdentifier: " ", sequenceId: 10 },
    { projectIdentifier: "WITCHFARM", sequenceId: null },
  ]) {
    assert.equal(getWorkItemLinkTitle({ ...partial, name: "单子名称" }), "单子名称");
  }
  assert.equal(getWorkItemLinkTitle({ projectIdentifier: "WITCHFARM", sequenceId: 10 }), "WITCHFARM-10");
  assert.equal(getWorkItemLinkTitle({ name: "  " }), "");
  assert.equal(getWorkItemLinkTitle({ name: null }), "");
  assert.equal(getWorkItemLinkTitle({}), "");
});
