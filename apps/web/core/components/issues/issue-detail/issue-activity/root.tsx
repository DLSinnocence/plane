/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane package imports
import type { TActivityFilters } from "@plane/constants";
import { E_SORT_ORDER } from "@plane/constants";
import { useLocalStorage } from "@plane/hooks";
import { useTranslation } from "@plane/i18n";
import type { TFileSignedURLResponse, TIssueComment } from "@plane/types";
// components
import { CommentCreate } from "@/components/comments/comment-create";
// hooks
import { useProject } from "@/hooks/store/use-project";
// local imports
import { IssueCommentList } from "./activity-comment-root";
import { IssueActivityCollapsible } from "./activity-collapsible";
import { useWorkItemCommentOperations } from "./helper";
import { ActivitySortRoot } from "./sort-root";
import { ACTIVITY_RECORD_FILTERS, normalizeActivityFilters, normalizeActivitySortOrder } from "./preferences";

type TIssueActivity = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  disabled?: boolean;
  isIntakeIssue?: boolean;
};

export type TActivityOperations = {
  createComment: (data: Partial<TIssueComment>) => Promise<TIssueComment>;
  updateComment: (commentId: string, data: Partial<TIssueComment>) => Promise<void>;
  removeComment: (commentId: string) => Promise<void>;
  uploadCommentAsset: (blockId: string, file: File, commentId?: string) => Promise<TFileSignedURLResponse>;
};

export const IssueActivity = observer(function IssueActivity(props: TIssueActivity) {
  const { workspaceSlug, projectId, issueId, disabled = false, isIntakeIssue = false } = props;
  const { t } = useTranslation();
  const { setValue: setFilterValue, storedValue: storedFilters } = useLocalStorage(
    "issue_activity_filters",
    ACTIVITY_RECORD_FILTERS
  );
  const { setValue: setSortOrder, storedValue: storedSortOrder } = useLocalStorage(
    "activity_sort_order",
    E_SORT_ORDER.ASC
  );
  const { getProjectById } = useProject();
  const activityOperations = useWorkItemCommentOperations(workspaceSlug, projectId, issueId);
  const selectedFilters = normalizeActivityFilters(storedFilters);
  const sortOrder = normalizeActivitySortOrder(storedSortOrder);
  const issueKey = `${workspaceSlug}:${projectId}:${issueId}`;

  const toggleFilter = (filter: TActivityFilters) => {
    const isSelected = selectedFilters.some((selected) => selected === filter);
    if (isSelected && selectedFilters.length === 1) return;
    setFilterValue(
      normalizeActivityFilters(
        isSelected ? selectedFilters.filter((selected) => selected !== filter) : [...selectedFilters, filter]
      )
    );
  };

  const project = getProjectById(projectId);
  if (!project) return null;

  // Keep keyed siblings when changing sort order so the editor retains its draft.
  // A different work item gets a new editor to prevent drafts and uploads leaking across items.
  const commentContents = [
    <IssueCommentList
      key={`comments:${issueKey}`}
      projectId={projectId}
      workspaceSlug={workspaceSlug}
      isIntakeIssue={isIntakeIssue}
      issueId={issueId}
      activityOperations={activityOperations}
      showAccessSpecifier={!!project.anchor}
      disabled={disabled}
      sortOrder={sortOrder}
    />,
    !disabled && (
      <CommentCreate
        key={`create:${issueKey}`}
        workspaceSlug={workspaceSlug}
        entityId={issueId}
        activityOperations={activityOperations}
        showToolbarInitially
        projectId={projectId}
      />
    ),
  ];

  return (
    <div className="space-y-6">
      <section aria-label={t("common.comments")} className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-h5-medium text-primary">{t("common.comments")}</h3>
          <ActivitySortRoot
            sortOrder={sortOrder}
            toggleSort={() => setSortOrder(sortOrder === E_SORT_ORDER.ASC ? E_SORT_ORDER.DESC : E_SORT_ORDER.ASC)}
          />
        </div>
        <div className="space-y-3">
          {sortOrder === E_SORT_ORDER.DESC ? [commentContents[1], commentContents[0]] : commentContents}
        </div>
      </section>
      <section aria-label={t("common.activity")} className="border-t border-subtle pt-4">
        <IssueActivityCollapsible
          key={issueKey}
          issueId={issueId}
          sortOrder={sortOrder}
          selectedFilters={selectedFilters}
          toggleFilter={toggleFilter}
        />
      </section>
    </div>
  );
});
