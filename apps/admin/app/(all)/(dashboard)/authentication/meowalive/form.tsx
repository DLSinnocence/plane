/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import type { FieldErrors } from "react-hook-form";
import { API_BASE_URL } from "@plane/constants";
import { Button } from "@makeplane/propel/components/button";
import type { IFormattedInstanceConfiguration, TInstanceMeowAliveAuthenticationConfigurationKeys } from "@plane/types";
import { TOAST_TYPE, setToast } from "@/providers/toast";
import { ConfirmDiscardModal } from "@/components/common/confirm-discard-modal";
import { ControllerInput } from "@/components/common/controller-input";
import { CopyField } from "@/components/common/copy-field";
import {
  DEFAULT_MEOWALIVE_ISSUER_URL,
  getMeowAliveCallbackURLs,
  isValidMeowAliveIssuer,
} from "@/components/authentication/meowalive-utils";
import { useInstance } from "@/hooks/store";

type FormValues = Record<TInstanceMeowAliveAuthenticationConfigurationKeys, string>;

export function InstanceMeowAliveConfigForm({ config }: { config: IFormattedInstanceConfiguration }) {
  const [isDiscardChangesModalOpen, setIsDiscardChangesModalOpen] = useState(false);
  const { updateInstanceConfigurations } = useInstance();
  const {
    handleSubmit,
    control,
    reset,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: {
      MEOWALIVE_ISSUER_URL: config.MEOWALIVE_ISSUER_URL || DEFAULT_MEOWALIVE_ISSUER_URL,
      MEOWALIVE_CLIENT_ID: config.MEOWALIVE_CLIENT_ID || "",
      MEOWALIVE_CLIENT_SECRET: config.MEOWALIVE_CLIENT_SECRET || "",
    },
    resolver: (values) => {
      const validationErrors: FieldErrors<FormValues> = {};
      if (!isValidMeowAliveIssuer(values.MEOWALIVE_ISSUER_URL))
        validationErrors.MEOWALIVE_ISSUER_URL = {
          type: "validate",
          message: "Use an HTTPS issuer URL without credentials, a query, or a fragment.",
        };
      if (!values.MEOWALIVE_CLIENT_ID.trim())
        validationErrors.MEOWALIVE_CLIENT_ID = { type: "required", message: "Client ID is required." };
      if (!values.MEOWALIVE_CLIENT_SECRET.trim())
        validationErrors.MEOWALIVE_CLIENT_SECRET = { type: "required", message: "Client secret is required." };
      return Object.keys(validationErrors).length ? { values: {}, errors: validationErrors } : { values, errors: {} };
    },
  });
  const origin = API_BASE_URL || (typeof window !== "undefined" ? window.location.origin : "");
  const callbacks = getMeowAliveCallbackURLs(origin);
  const onSubmit = async (values: FormValues) => {
    try {
      // The admin API returns plaintext secrets; the server encrypts them at rest.
      const response = await updateInstanceConfigurations({ ...values });
      reset({
        MEOWALIVE_ISSUER_URL: response.find((item) => item.key === "MEOWALIVE_ISSUER_URL")?.value,
        MEOWALIVE_CLIENT_ID: response.find((item) => item.key === "MEOWALIVE_CLIENT_ID")?.value,
        MEOWALIVE_CLIENT_SECRET: response.find((item) => item.key === "MEOWALIVE_CLIENT_SECRET")?.value,
      });
      setToast({ type: TOAST_TYPE.SUCCESS, title: "Done!", message: "MeowAlive 验证 is configured." });
    } catch {
      setToast({ type: TOAST_TYPE.ERROR, title: "Error", message: "Failed to save MeowAlive configuration." });
    }
  };
  const fields = [
    {
      key: "MEOWALIVE_ISSUER_URL",
      label: "Issuer URL",
      type: "text",
      placeholder: DEFAULT_MEOWALIVE_ISSUER_URL,
      description: "Use the HTTPS issuer URL for your MeowAlive instance, without credentials, a query, or a fragment.",
    },
    {
      key: "MEOWALIVE_CLIENT_ID",
      label: "Client ID",
      type: "text",
      placeholder: "Client ID",
      description: "Copy the client ID from your MeowAlive application settings.",
    },
    {
      key: "MEOWALIVE_CLIENT_SECRET",
      label: "Client secret",
      type: "password",
      placeholder: "Client secret",
      description: "Copy the client secret from your MeowAlive application settings.",
    },
  ] as const;
  return (
    <>
      <ConfirmDiscardModal
        isOpen={isDiscardChangesModalOpen}
        onDiscardHref="/authentication"
        handleClose={() => setIsDiscardChangesModalOpen(false)}
      />
      <div className="grid w-full grid-cols-2 gap-x-12 gap-y-8">
        <div className="col-span-2 flex flex-col gap-y-4 pt-1 md:col-span-1">
          <div className="pt-2.5 text-18 font-medium">MeowAlive-provided details for Plane</div>
          {fields.map((field) => (
            <div key={field.key}>
              <ControllerInput
                control={control}
                name={field.key}
                type={field.type}
                label={field.label}
                description={field.description}
                placeholder={field.placeholder}
                error={!!errors[field.key]}
                required
              />
              {errors[field.key]?.message && (
                <p role="alert" className="pt-1 text-11 text-danger-primary">
                  {errors[field.key]?.message}
                </p>
              )}
            </div>
          ))}
          <div className="flex items-center gap-4 pt-4">
            <Button
              variant="primary"
              size="md"
              stretch="auto"
              onClick={(e) => void handleSubmit(onSubmit)(e)}
              loading={isSubmitting}
              disabled={!isDirty}
              label={isSubmitting ? "Saving" : "Save changes"}
            />
            <Button
              variant="secondary"
              size="md"
              stretch="auto"
              nativeButton={false}
              render={
                <Link
                  href="/authentication"
                  onClick={(e) => {
                    if (isDirty) {
                      e.preventDefault();
                      setIsDiscardChangesModalOpen(true);
                    }
                  }}
                />
              }
              label="Go back"
            />
          </div>
        </div>
        <div className="col-span-2 md:col-span-1">
          <div className="flex flex-col gap-y-4 rounded-lg bg-layer-1 px-6 pt-1.5 pb-4">
            <div className="pt-2 text-18 font-medium">Plane-provided details for MeowAlive</div>
            <CopyField
              label="Web callback URI"
              url={callbacks.web}
              description="Register this exact callback URI in your MeowAlive application, including the trailing slash."
            />
            <CopyField
              label="Spaces callback URI"
              url={callbacks.spaces}
              description="Register this exact Spaces callback URI in your MeowAlive application, including the trailing slash."
            />
          </div>
        </div>
      </div>
    </>
  );
}
