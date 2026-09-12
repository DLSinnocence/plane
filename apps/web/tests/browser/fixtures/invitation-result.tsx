/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { InvitationResultPanel } from "@/components/workspace/invite-modal/result";
import type { InvitationResult } from "@/helpers/invitations.helper";

export function InvitationResultFixture() {
  const failed = new URLSearchParams(window.location.search).get("email_status") === "failed";
  const result: InvitationResult = {
    message: "Invitations created successfully",
    email_status: failed ? "failed" : "not_configured",
    invitations: [
      {
        id: "invitation-fixture",
        email: "new.person@example.test",
        accepted: false,
        message: "",
        responded_at: new Date(0),
        role: 15,
        token: "fixture-token",
        invite_link: "/workspace-invitations/?invitation_id=invitation-fixture&slug=workspace&token=fixture-token",
        workspace: { id: "workspace", slug: "workspace", name: "Test workspace", logo_url: "" },
      },
    ],
  };
  return <InvitationResultPanel result={result} />;
}
