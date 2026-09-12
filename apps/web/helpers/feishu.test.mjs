/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { getFeishuDeliveryLabelKey, prepareFeishuConfiguration } from "./feishu.ts";

test("unexpected delivery response text never becomes a visible translation key", () => {
  assert.equal(
    getFeishuDeliveryLabelKey("error", "provider included credential details"),
    "feishu_integration.delivery_error.unknown"
  );
  assert.equal(getFeishuDeliveryLabelKey("error", "toString"), "feishu_integration.delivery_error.unknown");
  assert.equal(getFeishuDeliveryLabelKey("error", "phone_missing"), "feishu_integration.delivery_error.phone_missing");
  assert.equal(getFeishuDeliveryLabelKey("status", "pending"), "feishu_integration.delivery_status.pending");
  assert.equal(getFeishuDeliveryLabelKey("status", "unexpected"), "feishu_integration.delivery_status.unknown");
});

const saved = { id: "config", app_id: "cli_old", enabled: true, has_app_secret: true };

test("editing an existing app preserves its credential without sending a blank or placeholder", () => {
  assert.deepEqual(prepareFeishuConfiguration(saved, " cli_old ", "  ", true), {
    data: { app_id: "cli_old", enabled: true },
  });
});

test("enabling a new application needs its own app ID and credential", () => {
  assert.equal(prepareFeishuConfiguration(saved, " ", "secret", true).error, "app_id_required");
  assert.equal(
    prepareFeishuConfiguration({ ...saved, has_app_secret: false }, "cli_old", "", true).error,
    "secret_required"
  );
  assert.equal(prepareFeishuConfiguration(saved, "cli_new", "", true).error, "secret_required");
  assert.deepEqual(prepareFeishuConfiguration(saved, "cli_new", " new-secret ", true), {
    data: { app_id: "cli_new", app_secret: "new-secret", enabled: true },
  });
});

test("disabling remains possible without supplying credentials", () => {
  assert.deepEqual(prepareFeishuConfiguration({ ...saved, has_app_secret: false }, "cli_old", "", false), {
    data: { app_id: "cli_old", enabled: false },
  });
  assert.equal(prepareFeishuConfiguration(saved, "cli_new", "", false).error, "secret_required");
});
