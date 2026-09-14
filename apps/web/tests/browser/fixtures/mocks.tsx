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
import attachmentMessages from "../../../../../packages/i18n/src/locales/en/common.json";
import chineseAttachmentMessages from "../../../../../packages/i18n/src/locales/zh-CN/common.json";
import { authFixtureEnabled, invitationAuthState } from "./invitation-auth-state";
import { aiFixtureEnabled, aiFixtureState } from "./ai-state";
import aiMessages from "../../../../../packages/i18n/src/locales/en/settings.json";
import aiChineseMessages from "../../../../../packages/i18n/src/locales/zh-CN/settings.json";
import { workflowStates } from "./stage-data";

export const users = {
  developer: { id: "developer", display_name: "Developer", first_name: "Dev", last_name: "", avatar_url: "" },
  reviewer: { id: "reviewer", display_name: "Reviewer", first_name: "Review", last_name: "", avatar_url: "" },
};
export const useUser = () =>
  aiFixtureEnabled() ? aiFixtureState.user : authFixtureEnabled() ? invitationAuthState : { data: users.developer };
export const useUserProfile = () => ({
  data: authFixtureEnabled() ? invitationAuthState.profile : { start_of_the_week: 1 },
});
export const useUserSettings = () => ({
  data: invitationAuthState.settings,
  fetchCurrentUserSettings: invitationAuthState.fetchCurrentUserSettings,
});
export const useIssues = () => ({ issuesFilter: { issueFilters: { displayFilters: { layout: "list" } } } });
export const useProject = () => ({
  getProjectIdentifierById: () => "DEMO",
  fetchProjects: async () => [{ id: "project", name: "Demo", identifier: "DEMO" }],
  workspaceProjectIds: ["project"],
  getProjectById: (id: string) => (id === "project" ? { id: "project", name: "Demo", identifier: "DEMO" } : undefined),
});
export const useProjectState = () => ({
  getStateById: (id: string) => workflowStates.find((state) => state.id === id),
  getProjectStates: () => workflowStates,
  fetchProjectStates: async () => workflowStates,
});
export const useMember = () => ({
  getUserDetails: (id: string) => users[id as keyof typeof users],
  project: {
    getProjectMemberIds: () => Object.keys(users),
    fetchProjectMembers: async () => [],
  },
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
    roles.includes(
      ["viewer", "guest"].includes(new URLSearchParams(window.location.search).get("role") ?? "")
        ? 5
        : new URLSearchParams(window.location.search).get("role") === "member"
          ? 15
          : 20
    ),
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
export const useTranslation = () => ({
  t: (key: string, values?: Record<string, unknown>) =>
    aiFixtureEnabled() && key.startsWith("account_settings.ai.")
      ? ((new URLSearchParams(window.location.search).get("lang") === "zh" ? aiChineseMessages : aiMessages)
          .account_settings.ai[
          key.slice("account_settings.ai.".length) as keyof typeof aiMessages.account_settings.ai
        ] ?? key)
      : key === "attachment.slots.default_name"
        ? chineseAttachmentMessages.attachment.slots.default_name
        : key === "attachment.slots.delete_slot_help"
          ? attachmentMessages.attachment.slots.delete_slot_help.replace("{name}", String(values?.name ?? ""))
          : key === "attachment.selection_details"
            ? `${key}: size=${values?.size}; limit=${values?.limit}; reason=${values?.reason}`
            : key,
});
export const StateOption = ({ option }: { option: { value: string; content: React.ReactNode } }) => (
  <Combobox.Option value={option.value}>{option.content}</Combobox.Option>
);
