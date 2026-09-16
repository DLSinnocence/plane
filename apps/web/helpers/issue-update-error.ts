/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** Map the API's explicit error code without depending on server message text. */
export function getIssueUpdateErrorKey(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "unfinished_sub_issues") {
    return "workflows.errors.unfinished_sub_issues" as const;
  }
  return undefined;
}
