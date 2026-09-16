/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import type { TActivityFilters, TActivityFilterOption } from "@plane/constants";
import { ACTIVITY_FILTER_TYPE_OPTIONS } from "@plane/constants";
// components
import { ActivityFilter } from "./activity-filter";
import { ACTIVITY_RECORD_FILTERS } from "./preferences";

export type TActivityFilterRoot = {
  selectedFilters: TActivityFilters[];
  toggleFilter: (filter: TActivityFilters) => void;
};

export function ActivityFilterRoot(props: TActivityFilterRoot) {
  const { selectedFilters, toggleFilter } = props;

  const filters: TActivityFilterOption[] = ACTIVITY_RECORD_FILTERS.map((filterKey) => ({
    key: filterKey,
    labelTranslationKey: ACTIVITY_FILTER_TYPE_OPTIONS[filterKey].labelTranslationKey,
    isSelected: selectedFilters.includes(filterKey),
    onClick: () => toggleFilter(filterKey),
  }));

  return <ActivityFilter selectedFilters={selectedFilters} filterOptions={filters} />;
}
