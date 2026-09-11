/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { isMeowAliveConfigured } from "./meowalive-utils";
import { observer } from "mobx-react";
import Link from "next/link";
import { SettingsOutline } from "@makeplane/propel/icons";
import { AnchorButton } from "@makeplane/propel/components/anchor-button";
import { Button } from "@makeplane/propel/components/button";
import { Switch } from "@makeplane/propel/components/switch";
import type { TInstanceAuthenticationMethodKeys } from "@plane/types";
import { useInstance } from "@/hooks/store";

type Props = {
  disabled: boolean;
  updateConfig: (key: TInstanceAuthenticationMethodKeys, value: string) => void;
};

export const MeowAliveConfiguration = observer(function MeowAliveConfiguration({ disabled, updateConfig }: Props) {
  const { formattedConfig } = useInstance();
  const enabled = formattedConfig?.IS_MEOWALIVE_ENABLED === "1";
  const configured = isMeowAliveConfigured(formattedConfig);
  return configured ? (
    <div className="flex items-center gap-4">
      <AnchorButton
        variant="primary"
        size="sm"
        nativeButton={false}
        render={<Link href="/authentication/meowalive" />}
        label="Edit"
      />
      <Switch
        checked={enabled}
        onCheckedChange={() => updateConfig("IS_MEOWALIVE_ENABLED", enabled ? "0" : "1")}
        size="sm"
        disabled={disabled}
      />
    </div>
  ) : (
    <Button
      variant="secondary"
      size="sm"
      stretch="auto"
      nativeButton={false}
      render={<Link href="/authentication/meowalive" />}
      icon={<SettingsOutline className="h-4 w-4 p-0.5 text-tertiary" />}
      label="Configure"
    />
  );
});
