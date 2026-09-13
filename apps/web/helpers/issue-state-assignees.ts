/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TIssue } from "@plane/types";

type TStateAssignees = NonNullable<TIssue["state_assignees"]>;

type TWorkflowState = { id: string; group: string };

export const canConfigureStateAssignees = (state: TWorkflowState): boolean =>
  !["backlog", "completed", "cancelled"].includes(state.group);

/** Materialize every stage independently; an explicit empty selection stays empty. */
export const getDefaultStateAssignees = (
  states: readonly TWorkflowState[],
  creatorId: string | null | undefined,
  assignments?: TStateAssignees
): TStateAssignees =>
  Object.fromEntries(
    states.map((state) => [
      state.id,
      [
        ...((canConfigureStateAssignees(state) ? assignments?.[state.id] : undefined) ??
          (creatorId ? [creatorId] : [])),
      ],
    ])
  );

/** Current assignees are derived by the API and must never accompany form edits. */
export const getIssueWorkflowFormData = (
  data: Partial<TIssue>,
  states: readonly TWorkflowState[],
  creatorId: string | null | undefined
): Partial<TIssue> => {
  const { assignee_ids: _assigneeIds, ...payload } = data;
  return { ...payload, state_assignees: getDefaultStateAssignees(states, creatorId, data.state_assignees) };
};
