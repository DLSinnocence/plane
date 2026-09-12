/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { Combobox } from "@headlessui/react";

export const users = {
  developer: { id: "developer", display_name: "Developer", first_name: "Dev", last_name: "", avatar_url: "" },
  reviewer: { id: "reviewer", display_name: "Reviewer", first_name: "Review", last_name: "", avatar_url: "" },
};
export const useUser = () => ({ data: users.developer });
export const useUserProfile = () => ({ data: { start_of_the_week: 1 } });
export const useMember = () => ({
  getUserDetails: (id: string) => users[id as keyof typeof users],
  workspace: { isUserSuspended: () => false },
});
export const useParams = () => ({ workspaceSlug: "workspace" });
export const usePathname = () => "/workspace/settings/integrations/";
export const useUserPermissions = () => ({
  allowPermissions: (roles: number[]) =>
    roles.includes(new URLSearchParams(window.location.search).get("role") === "member" ? 15 : 20),
});
export default function Link({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
export const useTranslation = () => ({ t: (key: string) => key });
export const StateOption = ({ option }: { option: { value: string; content: React.ReactNode } }) => (
  <Combobox.Option value={option.value}>{option.content}</Combobox.Option>
);
