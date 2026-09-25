/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** Testing states are available only when a work item explicitly needs testing. */
export const isStateAvailableForIssue = (state: { is_testing?: boolean }, needsTesting = false): boolean =>
  needsTesting || !state.is_testing;
