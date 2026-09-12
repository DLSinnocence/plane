/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useContext, useMemo } from "react";
import { Combobox } from "@headlessui/react";
import {
  Link as RouterLink,
  UNSAFE_LocationContext,
  useInRouterContext,
  useNavigate,
  useParams as useRouteParams,
} from "react-router";
import { authFixtureEnabled, invitationAuthState } from "./invitation-auth-state";

export const users = {
  developer: { id: "developer", display_name: "Developer", first_name: "Dev", last_name: "", avatar_url: "" },
  reviewer: { id: "reviewer", display_name: "Reviewer", first_name: "Review", last_name: "", avatar_url: "" },
};
export const useUser = () => (authFixtureEnabled() ? invitationAuthState : { data: users.developer });
export const useUserProfile = () => ({
  data: authFixtureEnabled() ? invitationAuthState.profile : { start_of_the_week: 1 },
});
export const useUserSettings = () => ({
  data: invitationAuthState.settings,
  fetchCurrentUserSettings: invitationAuthState.fetchCurrentUserSettings,
});
export const useMember = () => ({
  getUserDetails: (id: string) => users[id as keyof typeof users],
  workspace: {
    isUserSuspended: () => false,
    fetchWorkspaceMembers: async () => [],
    getWorkspaceMemberIds: () => [],
    getWorkspaceMemberDetails: () => null,
  },
});
export const useWorkspace = () => ({
  currentWorkspace: { slug: "workspace", name: "Test workspace" },
  loader: invitationAuthState.loader,
  workspaces: invitationAuthState.workspaces,
  fetchWorkspaces: invitationAuthState.fetchWorkspaces,
});
export const useParams = () => ({ workspaceSlug: "workspace", ...useRouteParams() });
export const usePathname = () => {
  const location = useContext(UNSAFE_LocationContext);
  return location?.location.pathname ?? window.location.pathname;
};
export const useSearchParams = () => {
  const location = useContext(UNSAFE_LocationContext);
  const search = location?.location.search ?? window.location.search;
  return useMemo(() => new URLSearchParams(search), [search]);
};
export const useAppRouter = () => {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      push: (to: string) => navigate(to),
      replace: (to: string) => navigate(to, { replace: true }),
      back: () => navigate(-1),
    }),
    [navigate]
  );
};
export const useUserPermissions = () => ({
  allowPermissions: (roles: number[]) =>
    roles.includes(new URLSearchParams(window.location.search).get("role") === "member" ? 15 : 20),
});
export default function Link({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const inRouter = useInRouterContext();
  return inRouter ? (
    <RouterLink to={href ?? ""} {...props}>
      {children}
    </RouterLink>
  ) : (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
export const useTranslation = () => ({ t: (key: string) => key });
export const StateOption = ({ option }: { option: { value: string; content: React.ReactNode } }) => (
  <Combobox.Option value={option.value}>{option.content}</Combobox.Option>
);
