/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { BrowserRouter, Outlet, useRoutes, type RouteObject } from "react-router";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import applicationRoutes from "virtual:application-routes";
import IntegrationPage from "../../../app/(all)/[workspaceSlug]/(settings)/settings/(workspace)/integrations/page";
import WorkspaceInvitationPage from "../../../app/(all)/workspace-invitations/page";
import { SimulatedInvitationLogin } from "./invitation-login";
import { authFixtureEnabled } from "./invitation-auth-state";
import PageNotFound from "../../../app/not-found";
import { WorkspaceSettingsSidebarItemCategories } from "@/components/settings/workspace/sidebar/item-categories";

const workspaceLayout = "./(all)/[workspaceSlug]/(settings)/settings/(workspace)/layout.tsx";
const integrationPage = "./(all)/[workspaceSlug]/(settings)/settings/(workspace)/integrations/page.tsx";

// Match the real application graph. Only unrelated page content and application
// shells are omitted, so a missing integration registration reaches the real 404.
function routeElement(entry: RouteConfigEntry): React.ReactNode {
  if (entry.file === "./(all)/workspace-invitations/page.tsx") return <WorkspaceInvitationPage />;
  if (authFixtureEnabled() && ["./(home)/page.tsx", "./(all)/sign-up/page.tsx"].includes(entry.file)) {
    return <SimulatedInvitationLogin />;
  }
  if (entry.file === integrationPage) return <IntegrationPage />;
  if (entry.file === "./not-found.tsx") return <PageNotFound />;
  if (entry.file === workspaceLayout)
    return (
      <>
        <WorkspaceSettingsSidebarItemCategories />
        <Outlet />
      </>
    );
  if (entry.children) return <Outlet />;
  return <div data-testid="route-placeholder">Workspace settings</div>;
}

function toRoute(entry: RouteConfigEntry): RouteObject {
  const common = { id: entry.file, element: routeElement(entry) };
  return entry.index
    ? { ...common, index: true }
    : { ...common, path: entry.path, children: entry.children?.map(toRoute) };
}

function ApplicationRouteContent() {
  return useRoutes(applicationRoutes.map(toRoute));
}

export function IntegrationRouteFixture() {
  return (
    <BrowserRouter>
      <ApplicationRouteContent />
    </BrowserRouter>
  );
}
