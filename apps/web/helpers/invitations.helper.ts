import type { IWorkspaceMemberInvitation } from "@plane/types";

export type InvitationResult = {
  message: string;
  email_status?: "not_configured" | "queued" | "failed" | "pending";
  invitations?: IWorkspaceMemberInvitation[];
};

export function invitationStatusMessage(
  result: Pick<InvitationResult, "email_status">,
  t?: (key: string) => string
): string {
  if (t) {
    const key = ["not_configured", "failed", "queued", "pending"].includes(result.email_status ?? "")
      ? result.email_status
      : "created_default";
    return t(`workspace_settings.settings.members.invitation_flow.${key}`);
  }
  switch (result.email_status) {
    case "not_configured":
      return "Invitations created. Email is not configured. Copy the invitation links and share them with your teammates.";
    case "failed":
      return "Invitations created, but email could not be queued. Copy the invitation links to share them.";
    case "queued":
      return "Invitations created and emails queued for delivery.";
    case "pending":
      return "Invitations created. Email dispatch is pending. You can also share the invitation links.";
    default:
      return "Invitations created. You can copy invitation links from the pending invitations list.";
  }
}

export function invitationErrorMessage(error: unknown, t?: (key: string) => string): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    for (const key of ["error", "detail", "emails", "message"]) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        const messages = value.map((entry) => invitationErrorMessage(entry, t)).filter(Boolean);
        if (messages.length) return messages.join(" ");
      }
    }
    for (const value of Object.values(error)) {
      if (Array.isArray(value) && typeof value[0] === "string") return value.join(" ");
    }
  }
  return t
    ? t("workspace_settings.settings.members.invitation_flow.error_fallback")
    : "Unable to complete the invitation request. Please try again.";
}
