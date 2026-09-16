/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import type { E_SORT_ORDER, TActivityFilters } from "@plane/constants";
import { filterActivityOnSelectedFilters } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TCommentsOperations } from "@plane/types";
// components
import { CommentCard } from "@/components/comments/card/root";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// local imports
import { IssueActivityItem } from "./activity/activity-list";
import { IssueActivityLoader } from "./loader";

type TIssueCommentList = {
  workspaceSlug: string;
  projectId: string;
  isIntakeIssue: boolean;
  issueId: string;
  activityOperations: TCommentsOperations;
  showAccessSpecifier?: boolean;
  disabled?: boolean;
  sortOrder: E_SORT_ORDER;
};

export const IssueCommentList = observer(function IssueCommentList(props: TIssueCommentList) {
  const {
    workspaceSlug,
    isIntakeIssue,
    issueId,
    activityOperations,
    showAccessSpecifier,
    projectId,
    disabled,
    sortOrder,
  } = props;
  const { t } = useTranslation();
  const {
    comment: { getSortedCommentsByIssueId },
  } = useIssueDetail();
  const comments = getSortedCommentsByIssueId(issueId, sortOrder);

  if (!comments) return <IssueActivityLoader />;
  if (comments.length === 0)
    return <p className="text-body-sm-regular text-tertiary">{t("activity_empty_state.no_comments")}</p>;

  return (
    <div>
      {comments.map((comment, index) => (
        <CommentCard
          key={comment.id}
          workspaceSlug={workspaceSlug}
          entityId={issueId}
          comment={comment}
          activityOperations={activityOperations}
          ends={index === 0 ? "top" : index === comments.length - 1 ? "bottom" : undefined}
          showAccessSpecifier={!!showAccessSpecifier}
          showCopyLinkOption={!isIntakeIssue}
          disabled={disabled}
          projectId={projectId}
          enableReplies
        />
      ))}
    </div>
  );
});

type TIssueActivityList = {
  issueId: string;
  selectedFilters: TActivityFilters[];
  sortOrder: E_SORT_ORDER;
};

export const IssueActivityList = observer(function IssueActivityList(props: TIssueActivityList) {
  const { issueId, selectedFilters, sortOrder } = props;
  const { t } = useTranslation();
  const {
    activity: { getActivityItemsByIssueId },
  } = useIssueDetail();
  const activities = getActivityItemsByIssueId(issueId, sortOrder);

  if (!activities) return <IssueActivityLoader />;
  const filteredActivities = filterActivityOnSelectedFilters(activities, selectedFilters);
  if (filteredActivities.length === 0)
    return <p className="text-body-sm-regular text-tertiary">{t("activity_empty_state.no_activity")}</p>;

  return (
    <div>
      {filteredActivities.map((activity, index) => (
        <IssueActivityItem
          key={activity.id}
          activityId={activity.id}
          ends={index === 0 ? "top" : index === filteredActivities.length - 1 ? "bottom" : undefined}
        />
      ))}
    </div>
  );
});
