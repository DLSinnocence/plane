/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { NotAuthorizedView } from "@/components/auth-screens/not-authorized-view";
import { PageHead } from "@/components/core/page-title";
import { FeishuSettings } from "@/components/integration/feishu-settings";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useUserPermissions } from "@/hooks/store/user";

function WorkspaceIntegrationsPage() {
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();
  const { allowPermissions } = useUserPermissions();
  const isAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);
  const pageTitle = currentWorkspace?.name ? `${currentWorkspace.name} - ${t("integrations.integrations")}` : undefined;

  if (!isAdmin) return <NotAuthorizedView section="settings" className="h-auto" />;

  return (
    <>
      <PageHead title={pageTitle} />
      <section className="w-full overflow-y-auto">
        <div className="flex items-start gap-3 border-b border-subtle py-3.5">
          <h3 className="text-18 font-medium">{t("integrations.integrations")}</h3>
        </div>
        {currentWorkspace?.slug && <FeishuSettings key={currentWorkspace.slug} workspaceSlug={currentWorkspace.slug} />}
      </section>
    </>
  );
}

export default observer(WorkspaceIntegrationsPage);
