/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { useWorkspace } from "@/hooks/store/use-workspace";

export const AIProfileSettings = observer(function AIProfileSettings() {
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();

  return (
    <section className="flex max-w-2xl flex-col gap-5 p-6">
      <div>
        <h2 className="text-h5-medium">{t("account_settings.ai.title")}</h2>
        <p className="mt-2 text-body-sm-regular text-secondary">{t("account_settings.ai.description")}</p>
      </div>
      <p className="text-body-sm-regular text-secondary">{t("account_settings.ai.migration_notice")}</p>
      {currentWorkspace?.slug ? (
        <a className="text-body-sm-medium text-accent-primary" href={`/${currentWorkspace.slug}/settings/ai`}>
          {t("account_settings.ai.workspace_settings")}
        </a>
      ) : (
        <p className="text-body-sm-regular text-secondary">{t("account_settings.ai.select_workspace")}</p>
      )}
    </section>
  );
});
