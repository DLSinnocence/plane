/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import { BoxesOutline, CloseOutline, TickOutline } from "@makeplane/propel/icons";
import { LogoSpinner } from "@/components/common/logo-spinner";
import { EmptySpace, EmptySpaceItem } from "@/components/ui/empty-space";
import { EPageTypes } from "@/helpers/authentication.helper";
import { invitationErrorMessage } from "@/helpers/invitations.helper";
import { useUser, useUserSettings } from "@/hooks/store/user";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useAppRouter } from "@/hooks/use-app-router";
import { AuthenticationWrapper } from "@/lib/wrappers/authentication-wrapper";
import { InvitationService } from "@/services/invitation.service";

const invitationService = new InvitationService();

const InvitationContent = observer(function InvitationContent() {
  const { t } = useTranslation();
  const router = useAppRouter();
  const searchParams = useSearchParams();
  const invitationId = searchParams.get("invitation_id");
  const slug = searchParams.get("slug");
  const token = searchParams.get("token");
  const projectId = searchParams.get("project_id");
  const { data: currentUser } = useUser();
  const { fetchWorkspaces } = useWorkspace();
  const { fetchCurrentUserSettings } = useUserSettings();
  const [actionError, setActionError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const validLink = !!(invitationId && slug && token);
  const { data: invitation, error } = useSWR(
    validLink ? ["INVITATION", slug, invitationId, projectId] : null,
    () => invitationService.detail(slug!, invitationId!, projectId),
    { shouldRetryOnError: false }
  );
  const currentEmail = typeof currentUser?.email === "string" ? currentUser.email : "";
  const wrongEmail = !!(
    currentEmail &&
    invitation?.email &&
    currentEmail.toLowerCase() !== invitation.email.toLowerCase()
  );

  const respond = async (accepted: boolean) => {
    if (!invitation || !slug || !token || !currentUser || wrongEmail || isSubmitting) return;
    setIsSubmitting(true);
    setActionError(undefined);
    try {
      await invitationService.respond(slug, invitation.id, token, accepted, projectId);
      if (accepted) await Promise.allSettled([fetchWorkspaces(), fetchCurrentUserSettings(true)]);
      router.push(accepted ? (projectId ? `/${slug}/projects/${projectId}/issues` : `/${slug}`) : "/");
    } catch (err) {
      setActionError(invitationErrorMessage(err, t));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-3">
      {!validLink || error || invitation?.responded_at ? (
        <EmptySpace
          title={t("workspace_settings.settings.members.invitation_flow.invalid_link")}
          description={t("workspace_settings.settings.members.invitation_flow.request_new_link")}
        >
          <EmptySpaceItem
            Icon={BoxesOutline}
            title={t("workspace_settings.settings.members.invitation_flow.home")}
            href="/"
          />
        </EmptySpace>
      ) : invitation ? (
        <EmptySpace
          title={t("workspace_settings.settings.members.invitation_flow.invited_to", {
            name: invitation.project?.name ?? invitation.workspace.name,
          })}
          description={
            invitation.email
              ? t("workspace_settings.settings.members.invitation_flow.signin_email", { email: invitation.email })
              : t("workspace_settings.settings.members.invitation_flow.signin_invited")
          }
        >
          {wrongEmail ? (
            <p role="alert" className="text-13 text-danger-primary">
              {t("workspace_settings.settings.members.invitation_flow.wrong_email", {
                currentEmail,
                invitedEmail: invitation.email,
              })}
            </p>
          ) : isSubmitting ? (
            <p role="status">{t("workspace_settings.settings.members.invitation_flow.saving")}</p>
          ) : (
            <>
              <EmptySpaceItem
                Icon={TickOutline}
                title={t("workspace_settings.settings.members.invitation_flow.accept")}
                action={() => void respond(true)}
              />
              <EmptySpaceItem
                Icon={CloseOutline}
                title={t("workspace_settings.settings.members.invitation_flow.ignore")}
                action={() => void respond(false)}
              />
            </>
          )}
        </EmptySpace>
      ) : (
        <LogoSpinner />
      )}
      {actionError && (
        <p role="alert" className="text-13 text-danger-primary">
          {actionError}
        </p>
      )}
    </div>
  );
});

function WorkspaceInvitationPage() {
  return (
    <AuthenticationWrapper pageType={EPageTypes.INVITATION}>
      <InvitationContent />
    </AuthenticationWrapper>
  );
}

export default observer(WorkspaceInvitationPage);
