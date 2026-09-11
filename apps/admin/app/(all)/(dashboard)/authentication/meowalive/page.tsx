/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { isMeowAliveConfigured } from "@/components/authentication/meowalive-utils";
import { useState } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
import { Switch } from "@makeplane/propel/components/switch";
import { KeyOutline } from "@makeplane/propel/icons";
import { AuthenticationMethodCard } from "@/components/authentication/authentication-method-card";
import { PageWrapper } from "@/components/common/page-wrapper";
import { Skeleton } from "@/components/common/skeleton";
import { setPromiseToast } from "@/providers/toast";
import { useInstance } from "@/hooks/store";
import type { Route } from "./+types/page";
import { InstanceMeowAliveConfigForm } from "./form";

const InstanceMeowAliveAuthenticationPage = observer(function InstanceMeowAliveAuthenticationPage() {
  const { fetchInstanceConfigurations, formattedConfig, updateInstanceConfigurations } = useInstance();
  const [isSubmitting, setIsSubmitting] = useState(false);
  useSWR("INSTANCE_CONFIGURATIONS", () => fetchInstanceConfigurations());
  const enabled = formattedConfig?.IS_MEOWALIVE_ENABLED === "1";
  const configured = isMeowAliveConfigured(formattedConfig);
  const updateConfig = async () => {
    setIsSubmitting(true);
    const promise = updateInstanceConfigurations({ IS_MEOWALIVE_ENABLED: enabled ? "0" : "1" });
    setPromiseToast(promise, {
      loading: "Saving Configuration",
      success: {
        title: "Configuration saved",
        message: () => `MeowAlive 验证 is now ${enabled ? "disabled" : "active"}.`,
      },
      error: { title: "Error", message: () => "Failed to save configuration" },
    });
    try {
      await promise;
    } catch {
      // The promise toast above reports failure without logging request details.
    } finally {
      setIsSubmitting(false);
    }
  };
  return (
    <PageWrapper
      customHeader={
        <AuthenticationMethodCard
          name="MeowAlive 验证"
          description="Allow members to log in or sign up for Plane with their MeowAlive accounts."
          icon={<KeyOutline className="h-6 w-6 p-0.5 text-tertiary" />}
          config={
            <Switch
              checked={enabled}
              onCheckedChange={() => void updateConfig()}
              size="sm"
              disabled={isSubmitting || !formattedConfig || (!enabled && !configured)}
            />
          }
          disabled={isSubmitting || !formattedConfig}
          withBorder={false}
        />
      }
    >
      {formattedConfig ? (
        <InstanceMeowAliveConfigForm config={formattedConfig} />
      ) : (
        <Skeleton className="space-y-8">
          <Skeleton.Item height="50px" width="25%" />
          <Skeleton.Item height="50px" />
          <Skeleton.Item height="50px" />
          <Skeleton.Item height="50px" />
        </Skeleton>
      )}
    </PageWrapper>
  );
});

export const meta: Route.MetaFunction = () => [{ title: "MeowAlive 验证 - God Mode" }];
export default InstanceMeowAliveAuthenticationPage;
