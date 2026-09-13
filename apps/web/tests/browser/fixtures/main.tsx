/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router";
import { WorkspaceSettingsSidebarItemCategories } from "@/components/settings/workspace/sidebar/item-categories";
import { MemberDropdownBase } from "@/components/dropdowns/member/base";
import { WorkItemStateDropdownBase } from "@/components/dropdowns/state/base";
import { DateDropdown } from "@/components/dropdowns/date";
import { PriorityDropdown } from "@/components/dropdowns/priority";
import { ModalCore } from "../../../../../packages/ui/src/modals/modal-core";
import { CustomSearchSelect } from "./ui";
import { users } from "./mocks";
import { IntegrationRouteFixture } from "./integration-route";
import { InvitationResultFixture } from "./invitation-result";
import { authFixtureEnabled } from "./invitation-auth-state";
import { AttachmentSlotsFixture } from "./attachment-slots";
import { StageAssigneesFixture } from "./stage-assignees";

function App() {
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [state, setState] = useState("todo");
  const [date, setDate] = useState<Date | null>(null);
  const [priority, setPriority] = useState("none");
  const [timezone, setTimezone] = useState("UTC");
  const [isOpen, setIsOpen] = useState(false);
  const inModal = new URLSearchParams(window.location.search).has("modal");
  const controls = (
    <>
      <h2>Create work item</h2>
      <div className="spacer">Description</div>
      <div className="controls">
        <div data-testid="state" className="control">
          <WorkItemStateDropdownBase
            projectId="project"
            stateIds={["todo", "started"]}
            value={state}
            onChange={setState}
            getStateById={(id) =>
              ({
                id: id ?? "todo",
                name: id === "started" ? "Developing" : "Todo",
                color: "#888888",
                group: id === "started" ? "started" : "unstarted",
              }) as never
            }
            buttonVariant="border-with-text"
          />
        </div>
        <div data-testid="member" className="control">
          <MemberDropdownBase
            memberIds={Object.keys(users)}
            getUserDetails={(id) => users[id as keyof typeof users] as never}
            value={memberIds}
            onChange={setMemberIds}
            multiple
            buttonVariant="border-with-text"
            placeholder="Assignees"
          />
        </div>
        <div data-testid="priority" className="control">
          <PriorityDropdown value={priority as never} onChange={setPriority} buttonVariant="border-with-text" />
        </div>
        <div data-testid="date" className="control">
          <DateDropdown value={date} onChange={setDate} buttonVariant="border-with-text" placeholder="Start date" />
        </div>
      </div>
      <output data-testid="selected">{JSON.stringify({ memberIds, state, priority, timezone, date })}</output>
    </>
  );
  return (
    <main>
      <h1>Dropdown regression fixture</h1>
      {inModal ? (
        <>
          <button onClick={() => setIsOpen(true)}>Open modal</button>
          <ModalCore isOpen={isOpen} handleClose={() => setIsOpen(false)} className="panel">
            {controls}
          </ModalCore>
        </>
      ) : (
        <>
          <div className="panel">{controls}</div>
          <div className="timezone-container" data-testid="timezone">
            <h2>Project timezone</h2>
            <CustomSearchSelect
              value={timezone}
              onChange={setTimezone}
              label={timezone}
              input
              placement="bottom-end"
              options={[
                { value: "UTC", query: "UTC", content: "UTC" },
                { value: "Asia/Shanghai", query: "Shanghai", content: "Asia/Shanghai" },
              ]}
            />
          </div>
        </>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  new URLSearchParams(window.location.search).has("attachment-slots") ? (
    <AttachmentSlotsFixture />
  ) : new URLSearchParams(window.location.search).has("stage-assignees") ? (
    <StageAssigneesFixture />
  ) : new URLSearchParams(window.location.search).has("invitation-result") ? (
    <InvitationResultFixture />
  ) : authFixtureEnabled() ||
    window.location.pathname.startsWith("/workspace-invitations") ||
    window.location.pathname.startsWith("/workspace/") ? (
    <IntegrationRouteFixture />
  ) : new URLSearchParams(window.location.search).has("settings") ? (
    <MemoryRouter initialEntries={["/workspace/settings/integrations/"]}>
      <Routes>
        <Route path="/:workspaceSlug/*" element={<WorkspaceSettingsSidebarItemCategories />} />
      </Routes>
    </MemoryRouter>
  ) : (
    <App />
  )
);
