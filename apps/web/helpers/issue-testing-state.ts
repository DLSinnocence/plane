/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** Missing needsTesting values preserve the default workflow for existing work items. */
export const isStateAvailableForIssue = (state: { is_testing?: boolean }, needsTesting = true): boolean =>
  needsTesting || !state.is_testing;
