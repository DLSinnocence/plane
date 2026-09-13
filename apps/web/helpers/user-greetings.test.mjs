/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { getUserGreetingDetails } from "./user-greetings.ts";

test("greetings change at noon and evening in the user's time zone", () => {
  for (const [time, expected] of [
    ["2026-06-08T15:59:00Z", "evening"],
    ["2026-06-08T16:00:00Z", "morning"],
    ["2026-06-09T03:59:00Z", "morning"],
    ["2026-06-09T04:00:00Z", "afternoon"],
    ["2026-06-09T09:59:00Z", "afternoon"],
    ["2026-06-09T10:00:00Z", "evening"],
  ]) {
    assert.equal(getUserGreetingDetails(new Date(time), "zh-CN", "Asia/Shanghai").greeting, expected, time);
  }
});

test("Chinese dates show the weekday, month and time in the same time zone as the greeting", () => {
  const instant = new Date("2026-06-08T23:05:00Z");
  const shanghai = getUserGreetingDetails(instant, "zh-CN", "Asia/Shanghai");
  assert.equal(shanghai.greeting, "morning");
  assert.match(shanghai.dateTime, /6月9日/);
  assert.match(shanghai.dateTime, /星期二/);
  assert.match(shanghai.dateTime, /07:05/);
  assert.doesNotMatch(shanghai.dateTime, /June|Jun|Tuesday/);
  assert.equal(getUserGreetingDetails(instant, "zh-CN", "America/New_York").greeting, "evening");
});

test("changing language preserves the instant and localizes the displayed date", () => {
  const instant = new Date("2026-06-09T00:05:00Z");
  const english = getUserGreetingDetails(instant, "en", "UTC");
  const chinese = getUserGreetingDetails(instant, "zh-CN", "UTC");
  assert.equal(english.greeting, chinese.greeting);
  assert.match(english.dateTime, /Tuesday/);
  assert.match(english.dateTime, /Jun/);
  assert.match(chinese.dateTime, /星期二/);
  assert.match(chinese.dateTime, /00:05/);
  assert.match(getUserGreetingDetails(instant, "ua", "UTC").dateTime, /вівторок/);
});
