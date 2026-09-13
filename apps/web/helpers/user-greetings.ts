/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** Keep the greeting and displayed date in the user's selected time zone. */
export function getUserGreetingDetails(currentTime: Date, locale: string, timeZone?: string) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "numeric",
    }).format(currentTime)
  );
  const greeting = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  // The app's Ukrainian language key predates the standard BCP 47 language code.
  const dateTime = new Intl.DateTimeFormat(locale === "ua" ? "uk" : locale, {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(currentTime);

  return { greeting, dateTime };
}
