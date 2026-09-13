/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { calculateTimeAgo, calculateTimeAgoShort } from "../src/datetime.ts";

const now = new Date("2026-06-15T12:00:00Z").getTime();
const at = (seconds) => new Date(now + seconds * 1000);

function freeze(t) {
  t.mock.timers.enable({ apis: ["Date"], now });
}

test("full relative times use the selected language for recent past and future", (t) => {
  freeze(t);
  assert.equal(calculateTimeAgo(at(-10), "en"), "less than a minute ago");
  assert.equal(calculateTimeAgo(at(10), "en"), "in less than a minute");
  assert.equal(calculateTimeAgo(at(-10), "zh-CN"), "不到 1 分钟前");
  assert.equal(calculateTimeAgo(at(10), "zh-CN"), "不到 1 分钟内");
  assert.match(calculateTimeAgo(at(-120), "fr"), /il y a 2 minutes/);
  assert.match(calculateTimeAgo(at(-120), "zh-TW"), /分鐘前/);
});

test("every supported app language has localized full and compact relative dates", (t) => {
  freeze(t);
  const locales = [
    "fr",
    "es",
    "ja",
    "zh-CN",
    "zh-TW",
    "ru",
    "it",
    "cs",
    "sk",
    "de",
    "ua",
    "pl",
    "ko",
    "pt-BR",
    "id",
    "ro",
    "vi-VN",
    "tr-TR",
    "ka-ge",
  ];
  for (const locale of locales) {
    assert.notEqual(calculateTimeAgo(at(-120), locale), calculateTimeAgo(at(-120), "en"), locale);
    assert.notEqual(calculateTimeAgoShort(at(-120), locale), calculateTimeAgoShort(at(-120), "en"), locale);
  }
});

test("compact dates localize direction and units across all boundaries", (t) => {
  freeze(t);
  const cases = [
    [59, "second"],
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [30 * 86400, "month"],
    [360 * 86400, "year"],
  ];
  for (const [seconds, unit] of cases) {
    for (const direction of [-1, 1]) {
      const amount = direction * (unit === "second" ? 59 : 1);
      assert.equal(
        calculateTimeAgoShort(at(direction * seconds), "zh-CN"),
        new Intl.RelativeTimeFormat("zh-CN", { style: "narrow", numeric: "always" }).format(amount, unit)
      );
    }
  }
  assert.equal(calculateTimeAgoShort(at(-120), "zh-CN"), "2分钟前");
  assert.equal(calculateTimeAgoShort(at(120), "zh-CN"), "2分钟后");
});

test("invalid inputs stay empty and numeric timestamps include the Unix epoch", (t) => {
  freeze(t);
  for (const format of [calculateTimeAgo, calculateTimeAgoShort]) {
    for (const invalid of [null, "", "invalid", new Date(NaN), NaN]) assert.equal(format(invalid, "zh-CN"), "");
    assert.equal(format(0, "zh-CN"), format(new Date(0), "zh-CN"));
    assert.equal(format(at(-120).getTime(), "zh-CN"), format(at(-120).toISOString(), "zh-CN"));
    assert.equal(format(at(-120), "unsupported"), format(at(-120), "en"));
  }
});
