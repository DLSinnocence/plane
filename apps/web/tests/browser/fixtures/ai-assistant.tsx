/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { AIAssistant } from "@/components/navigation/ai-assistant";
import { AIProfileSettings } from "@/components/settings/profile/content/pages/ai";
import { aiFixtureState } from "./ai-state";
// eslint-disable-next-line import/no-unassigned-import -- use the production sidebar and Markdown styles
import "./ai-assistant.css";

const Content = observer(function Content() {
  const navigate = useNavigate();
  const [actions, setActions] = useState(0);
  useEffect(() => {
    document.body.classList.add("ai-fixture-page");
    window.aiFixture.navigate = navigate;
    return () => document.body.classList.remove("ai-fixture-page");
  }, [navigate]);
  return (
    <div className="ai-fixture-shell">
      <header className="ai-fixture-topbar">
        <strong>
          ◈ Plane <span>/ Product</span>
        </strong>
        <AIAssistant />
      </header>
      <div className="ai-fixture-layout">
        <main className="ai-fixture-workspace" aria-label="Workspace">
          <div className="ai-fixture-workspace-header">
            <div>
              <span>WORKSPACE</span>
              <h1>Product development</h1>
            </div>
            <button onClick={() => setActions((value) => value + 1)}>Workspace action</button>
          </div>
          <output data-testid="workspace-actions">{actions}</output>
          <nav className="ai-fixture-tabs">
            <span>All work items</span>
            <span>Board</span>
            <span>Cycles</span>
          </nav>
          <div className="ai-fixture-section-title">
            In progress <span>3</span>
          </div>
          {[
            ["ENG-42", "Fix login timeout", "High"],
            ["ENG-43", "Improve onboarding experience", "Medium"],
            ["ENG-44", "Update mobile navigation", "Medium"],
          ].map(([id, name, priority]) => (
            <div className="ai-fixture-task" key={id}>
              <span className="ai-fixture-state">◐</span>
              <code>{id}</code>
              <span>{name}</span>
              <small>{priority}</small>
            </div>
          ))}
          <p className="ai-fixture-note">The workspace remains interactive while the assistant is open.</p>
        </main>
        <div id="workspace-ai-sidebar" />
      </div>
      {aiFixtureState.profileSettingsModal.isOpen && (
        <section className="ai-fixture-settings" role="dialog" aria-label="Profile settings fixture">
          <output data-testid="profile-options">{JSON.stringify(aiFixtureState.profileSettingsModal)}</output>
          <button onClick={() => aiFixtureState.toggleProfileSettingsModal({ isOpen: false })}>Close settings</button>
          <AIProfileSettings />
        </section>
      )}
    </div>
  );
});
export function AIAssistantFixture() {
  return (
    <MemoryRouter initialEntries={["/workspace/projects/fixture-project"]}>
      <Routes>
        <Route path="/:workspaceSlug/projects/:projectId" element={<Content />} />
      </Routes>
    </MemoryRouter>
  );
}
