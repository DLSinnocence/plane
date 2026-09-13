/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useRef } from "react";
import { MemoryRouter, Route, Routes, useNavigate, useParams } from "react-router";
import type { TIssue } from "@plane/types";
import { WorkItemDetailQuickActions } from "@/components/issues/issue-layouts/quick-action-dropdowns/issue-detail";

function WorkItemDetail() {
  const parentRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const { issueId = "issue" } = useParams();
  const query = new URLSearchParams(window.location.search);
  const issue = {
    id: issueId,
    project_id: "project",
    name: `Detail ${issueId}`,
    sequence_id: issueId === "issue" ? 42 : 43,
    state_id: "todo",
    is_draft: query.has("draft"),
    archived_at: query.has("archived") ? "2026-01-01T00:00:00Z" : null,
  } as TIssue;
  return (
    <main ref={parentRef}>
      <h1>{issue.name}</h1>
      <p>Work item description</p>
      <button onClick={() => navigate("/workspace/projects/project/issues/other")}>Next work item</button>
      <div data-testid="detail-actions">
        <WorkItemDetailQuickActions
          issue={issue}
          parentRef={parentRef}
          handleDelete={async () => {}}
          readOnly={query.has("readonly")}
          isPeekMode={query.has("peek")}
        />
      </div>
    </main>
  );
}

export function GitCommitsMenuFixture() {
  return (
    <MemoryRouter initialEntries={["/workspace/projects/project/issues/issue"]}>
      <Routes>
        <Route path="/:workspaceSlug/projects/:projectId/issues/:issueId" element={<WorkItemDetail />} />
      </Routes>
    </MemoryRouter>
  );
}
