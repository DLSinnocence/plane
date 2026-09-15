/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EUserPermissions } from "@plane/constants";
import type { TIssue } from "@plane/types";

export type TIssueWorkflowContext = {
  issue: Pick<TIssue, "state_id" | "state_assignees" | "assignee_ids" | "created_by"> | undefined;
  userId: string | undefined;
  role: EUserPermissions | undefined;
  stateGroup?: string;
};

/** The effective role must come from a loaded, valid project membership. */
export const canCreateIssue = (role: EUserPermissions | undefined) => role === EUserPermissions.ADMIN;

/** UI affordances only; the API checks the persisted issue independently. */
export const getIssueWorkflowPermissions = ({ issue, userId, role, stateGroup }: TIssueWorkflowContext) => {
  const isMember = role === EUserPermissions.MEMBER || role === EUserPermissions.ADMIN;
  const fixedStage = stateGroup !== undefined && ["backlog", "completed", "cancelled"].includes(stateGroup);
  const assignees =
    (!fixedStage && issue?.state_id ? issue.state_assignees?.[issue.state_id] : undefined) ??
    (issue?.created_by ? [issue.created_by] : []);
  const isResponsible = stateGroup !== undefined && !!userId && assignees.includes(userId);
  const isOwner = !!userId && issue?.created_by === userId;
  const canEdit = !!issue && !!userId && isMember && (role === EUserPermissions.ADMIN || isOwner || isResponsible);

  return {
    canEdit,
    canUploadAttachments: canEdit,
    canTransition: canEdit,
    canManageAssignments: !!issue && !!userId && isMember && (role === EUserPermissions.ADMIN || isOwner),
  };
};

export const getIntakePermissions = (
  role: EUserPermissions | undefined,
  userId?: string,
  createdBy?: string | null
) => {
  const isAdmin = !!userId && role === EUserPermissions.ADMIN;
  const isMember = isAdmin || (!!userId && role === EUserPermissions.MEMBER);
  return {
    canSubmit: isMember,
    canEdit: isAdmin || (isMember && !!createdBy && createdBy === userId),
    canReview: isAdmin,
  };
};
