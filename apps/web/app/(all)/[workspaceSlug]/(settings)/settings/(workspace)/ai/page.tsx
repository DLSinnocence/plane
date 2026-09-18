import { observer } from "mobx-react";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { PageHead } from "@/components/core/page-title";
import { SettingsContentWrapper } from "@/components/settings/content-wrapper";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useUserPermissions } from "@/hooks/store/user";
import { WorkspaceAISettings } from "@/components/workspace/settings/ai/root";
import type { Route } from "./+types/page";

function WorkspaceAISettingsPage({ params }: Route.ComponentProps) {
  const { workspaceSlug } = params;
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();
  const { allowPermissions } = useUserPermissions();
  const canEdit = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE, workspaceSlug);

  return (
    <SettingsContentWrapper hugging>
      <PageHead
        title={
          currentWorkspace?.name ? `${currentWorkspace.name} - ${t("workspace_settings.settings.ai.title")}` : undefined
        }
      />
      <WorkspaceAISettings key={workspaceSlug} workspaceSlug={workspaceSlug} canEdit={canEdit} />
    </SettingsContentWrapper>
  );
}

export default observer(WorkspaceAISettingsPage);
