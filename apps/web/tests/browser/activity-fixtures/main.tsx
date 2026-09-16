/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { observer } from "mobx-react";
import { runInAction } from "mobx";
import { IssueActivity } from "@/components/issues/issue-detail/issue-activity/root";
import { fixtureState } from "./state";

const params = new URLSearchParams(window.location.search);
const App = observer(function App() {
  const [issueId, setIssueId] = useState("A");
  const [mounted, setMounted] = useState(true);
  const [workspaceSlug, setWorkspaceSlug] = useState("workspace");
  const [projectId, setProjectId] = useState("project");
  return (
    <main className="fixture-page">
      <nav aria-label="Fixture controls">
        <button onClick={() => setIssueId("A")}>Open A</button>
        <button onClick={() => setIssueId("B")}>Open B</button>
        <button onClick={() => setMounted((value) => !value)}>{mounted ? "Close detail" : "Reopen detail"}</button>
        <button onClick={() => setWorkspaceSlug((value) => (value === "workspace" ? "other-workspace" : "workspace"))}>
          Change workspace
        </button>
        <button onClick={() => setProjectId((value) => (value === "project" ? "other-project" : "project"))}>
          Change project
        </button>
        <button
          onClick={() =>
            runInAction(() => {
              fixtureState.commentsReady = true;
            })
          }
        >
          Load comments
        </button>
        <button
          onClick={() =>
            runInAction(() => {
              fixtureState.activitiesReady = true;
            })
          }
        >
          Load activities
        </button>
      </nav>
      <h1>Work item {issueId}</h1>
      {params.has("deep-link") && <div className="fixture-description">Work item description before discussion</div>}
      <div data-testid="activity-root">
        {mounted && (
          // No issue key here: changing props must exercise the real root's
          // activity reset and comment form isolation, just like existing peeks.
          <IssueActivity
            workspaceSlug={workspaceSlug}
            projectId={projectId}
            issueId={issueId}
            disabled={params.has("disabled")}
            isIntakeIssue={params.has("intake")}
          />
        )}
      </div>
      <output data-testid="submitted">{JSON.stringify(fixtureState.submitted)}</output>
    </main>
  );
});

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
