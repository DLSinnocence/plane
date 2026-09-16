/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EActivityFilterType, E_SORT_ORDER } from "@plane/constants";

export type TActivityRecordFilter = Exclude<
  EActivityFilterType,
  EActivityFilterType.COMMENT | EActivityFilterType.DEFAULT
>;

export const ACTIVITY_RECORD_FILTERS: TActivityRecordFilter[] = [
  EActivityFilterType.ACTIVITY,
  EActivityFilterType.STATE,
  EActivityFilterType.ASSIGNEE,
];

// Older preferences can contain COMMENT alone. Comments now remain visible independently.
export const normalizeActivityFilters = (value: unknown): TActivityRecordFilter[] => {
  const filters = Array.isArray(value) ? ACTIVITY_RECORD_FILTERS.filter((filter) => value.includes(filter)) : [];
  return filters.length > 0 ? filters : [...ACTIVITY_RECORD_FILTERS];
};

export const normalizeActivitySortOrder = (value: unknown): E_SORT_ORDER =>
  value === E_SORT_ORDER.DESC ? E_SORT_ORDER.DESC : E_SORT_ORDER.ASC;
