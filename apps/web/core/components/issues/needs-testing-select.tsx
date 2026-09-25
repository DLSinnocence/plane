/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";

type Props = {
  value?: boolean;
  onChange: (value: boolean) => void | Promise<unknown>;
  disabled?: boolean;
  isTestingState?: boolean;
};

/** Missing values from older issue payloads use the default: no. */
export function NeedsTestingSelect({ value, onChange, disabled, isTestingState }: Props) {
  const { t } = useTranslation();
  const [isSaving, setIsSaving] = useState(false);
  const handleChange = async (needsTesting: boolean) => {
    setIsSaving(true);
    try {
      await onChange(needsTesting);
    } catch (error: unknown) {
      console.error("Error saving testing preference:", error);
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("common.error.label"),
        message: t("entity.update.failed", { entity: t("issue.label") }),
      });
    } finally {
      setIsSaving(false);
    }
  };
  return (
    <select
      aria-label={t("workflows.needs_testing.label")}
      title={isTestingState ? t("workflows.needs_testing.change_state_first") : undefined}
      className="h-7 rounded-sm border border-subtle bg-surface-1 px-2 text-body-xs-regular disabled:opacity-60"
      value={value === true ? "yes" : "no"}
      onChange={(event) => void handleChange(event.target.value === "yes")}
      disabled={disabled || isSaving}
    >
      <option value="yes">{t("workflows.needs_testing.yes")}</option>
      <option value="no" disabled={isTestingState}>
        {t("workflows.needs_testing.no")}
      </option>
    </select>
  );
}
