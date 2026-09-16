/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { memo } from "react";
import { SortAscendingOutline, SortDescendingOutline } from "@makeplane/propel/icons";
// plane package imports
import { E_SORT_ORDER } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { IconButton } from "@plane/propel/icon-button";

export type TActivitySortRoot = {
  sortOrder: E_SORT_ORDER;
  toggleSort: () => void;
};
export const ActivitySortRoot = memo(function ActivitySortRoot(props: TActivitySortRoot) {
  const { t } = useTranslation();
  const SortIcon = props.sortOrder === E_SORT_ORDER.ASC ? SortAscendingOutline : SortDescendingOutline;
  const label = `${t("common.sort.created_on")}: ${t(props.sortOrder === E_SORT_ORDER.ASC ? "common.sort.desc" : "common.sort.asc")}`;
  return <IconButton variant="tertiary" icon={SortIcon} onClick={props.toggleSort} aria-label={label} title={label} />;
});

ActivitySortRoot.displayName = "ActivitySortRoot";
