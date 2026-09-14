/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import { useEffect } from "react";
import { observer } from "mobx-react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { AIAssistant } from "@/components/navigation/ai-assistant";
import { AIProfileSettings } from "@/components/settings/profile/content/pages/ai";
import { aiFixtureState } from "./ai-state";
// eslint-disable-next-line import/no-unassigned-import -- load production chat styles in the browser fixture
import "./ai-assistant.css";

const Content = observer(function Content() {
  const navigate = useNavigate();
  useEffect(() => {
    document.body.classList.add("ai-fixture-page");
    window.aiFixture.navigate = navigate;
    return () => {
      document.body.classList.remove("ai-fixture-page");
    };
  }, [navigate]);
  return (
    <main className="ai-fixture-shell">
      <header>
        <h1>AI assistant browser fixture</h1>
        <AIAssistant />
      </header>
      <p>Production assistant and settings components with simulated API responses. No credentials or real changes.</p>
      {aiFixtureState.profileSettingsModal.isOpen && (
        <section aria-label="Profile settings fixture">
          <output data-testid="profile-options">{JSON.stringify(aiFixtureState.profileSettingsModal)}</output>
          <button onClick={() => aiFixtureState.toggleProfileSettingsModal({ isOpen: false })}>Close settings</button>
          <AIProfileSettings />
        </section>
      )}
    </main>
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
