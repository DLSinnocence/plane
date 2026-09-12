import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import { copyTextToClipboard } from "@plane/utils";
import type { InvitationResult } from "@/helpers/invitations.helper";
import { invitationStatusMessage } from "@/helpers/invitations.helper";

export function InvitationResultPanel({ result }: { result: InvitationResult }) {
  const { t } = useTranslation();
  const copyLink = async (link: string) => {
    try {
      await copyTextToClipboard(new URL(link, window.location.origin).href);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("workspace_settings.settings.members.invitation_flow.link_copied"),
      });
    } catch {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("workspace_settings.settings.members.invitation_flow.copy_failed"),
        message: t("workspace_settings.settings.members.invitation_flow.copy_fallback"),
      });
    }
  };
  return (
    <div className="space-y-3 rounded-md border border-subtle p-4" role="status">
      <p className="text-13">{invitationStatusMessage(result, t)}</p>
      <p className="text-13 text-secondary">
        {t("workspace_settings.settings.members.invitation_flow.recipient_guidance")}
      </p>
      {result.invitations?.map((invitation) => (
        <div key={invitation.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-13">{invitation.email}</span>
          {invitation.invite_link && (
            <>
              <Button variant="secondary" size="sm" onClick={() => void copyLink(invitation.invite_link)}>
                {t("workspace_settings.settings.members.invitation_flow.copy_link")}
              </Button>
              <input
                className="w-full rounded border border-subtle p-2 text-12"
                aria-label={t("workspace_settings.settings.members.invitation_flow.link_for_email", {
                  email: invitation.email,
                })}
                value={
                  typeof window === "undefined"
                    ? invitation.invite_link
                    : new URL(invitation.invite_link, window.location.origin).href
                }
                readOnly
                onFocus={(event) => event.target.select()}
              />
            </>
          )}
        </div>
      ))}
    </div>
  );
}
