/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useState } from "react";
import { MemoryRouter } from "react-router";
import type { TIssue } from "@plane/types";
import { StateAssigneeFields } from "@/components/issues/state-assignee-fields";
import { getDefaultStateAssignees, getIssueWorkflowFormData } from "@/helpers/issue-state-assignees";
import { workflowStates } from "./stage-data";

export function StageAssigneesFixture() {
  const params = new URLSearchParams(window.location.search);
  const [assignments, setAssignments] = useState<TIssue["state_assignees"]>(
    params.has("legacy") ? { backlog: ["reviewer"], done: [], cancelled: ["reviewer"] } : undefined
  );
  const [submitted, setSubmitted] = useState<Partial<TIssue>>();
  return (
    <MemoryRouter>
      <main className="panel">
        <h1>Stage assignees</h1>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(
              getIssueWorkflowFormData(
                {
                  name: "Workflow work item",
                  state_id: "todo",
                  assignee_ids: ["legacy-owner"],
                  state_assignees: assignments,
                },
                workflowStates,
                "developer"
              )
            );
          }}
        >
          <section data-testid="stage-fields">
            <StateAssigneeFields
              workspaceSlug="workspace"
              projectId="project"
              stateId="todo"
              creatorId="developer"
              value={assignments}
              onChange={setAssignments}
              disabled={params.has("disabled")}
            />
          </section>
          <button type="submit">Submit workflow</button>
        </form>
        <output data-testid="assignments">
          {JSON.stringify(getDefaultStateAssignees(workflowStates, "developer", assignments))}
        </output>
        <output data-testid="submitted">{JSON.stringify(submitted)}</output>
      </main>
    </MemoryRouter>
  );
}
