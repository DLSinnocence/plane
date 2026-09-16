/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { Collapsible } from "@makeplane/propel/components/collapsible";
import type { E_SORT_ORDER } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { IssueActivityList } from "./activity-comment-root";
import type { TActivityFilterRoot } from "./filter-root";
import { ActivityFilterRoot } from "./filter-root";

type TIssueActivityCollapsible = TActivityFilterRoot & {
  issueId: string;
  sortOrder: E_SORT_ORDER;
};

export function IssueActivityCollapsible(props: TIssueActivityCollapsible) {
  const { issueId, sortOrder, selectedFilters, toggleFilter } = props;
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      trigger={<span className="text-h5-medium text-primary">{t("common.activity")}</span>}
      // The panel clips overflow for its animation. Keep the menu in the header
      // so all filter options remain reachable even when the activity list is empty.
      trailing={isOpen && <ActivityFilterRoot selectedFilters={selectedFilters} toggleFilter={toggleFilter} />}
    >
      <div className="pt-3">
        <IssueActivityList issueId={issueId} selectedFilters={selectedFilters} sortOrder={sortOrder} />
      </div>
    </Collapsible>
  );
}
