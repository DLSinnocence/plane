/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import Link from "next/link";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useUserPermissions } from "@/hooks/store/user";
// plane imports
import { useTranslation } from "@plane/i18n";
// components
import { PageHead } from "@/components/core/page-title";
import { SettingsContentWrapper } from "@/components/settings/content-wrapper";
import { WorkspaceDetails } from "@/components/workspace/settings/workspace-details";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";
// local imports
import { GeneralWorkspaceSettingsHeader } from "./header";

function GeneralWorkspaceSettingsPage() {
  // store hooks
  const { currentWorkspace } = useWorkspace();
  const { t } = useTranslation();
  const { allowPermissions } = useUserPermissions();
  const canConfigureIntegrations = allowPermissions(
    [EUserPermissions.ADMIN],
    EUserPermissionsLevel.WORKSPACE,
    currentWorkspace?.slug
  );
  // derived values
  const pageTitle = currentWorkspace?.name
    ? t("workspace_settings.page_label", { workspace: currentWorkspace.name })
    : undefined;

  return (
    <SettingsContentWrapper header={<GeneralWorkspaceSettingsHeader />}>
      <PageHead title={pageTitle} />
      {canConfigureIntegrations && currentWorkspace?.slug && (
        <div className="mb-4 flex justify-end">
          <Link
            href={`/${currentWorkspace.slug}/settings/integrations/`}
            className="rounded-md border border-strong px-3 py-2 text-body-xs-medium text-primary hover:bg-layer-transparent-hover"
          >
            {t("feishu_integration.name")} · {t("integrations.configure")}
          </Link>
        </div>
      )}
      <WorkspaceDetails />
    </SettingsContentWrapper>
  );
}

export default observer(GeneralWorkspaceSettingsPage);
