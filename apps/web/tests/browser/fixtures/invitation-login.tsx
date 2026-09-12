/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useState } from "react";
import { useLocation } from "react-router";
import { AuthenticationWrapper } from "@/lib/wrappers/authentication-wrapper";
import { EPageTypes } from "@/helpers/authentication.helper";
import { invitationAuthState } from "./invitation-auth-state";

/** The form simulates login; redirects are performed by the real production auth wrapper. */
export function SimulatedInvitationLogin() {
  const location = useLocation();
  const [email, setEmail] = useState("invitee@example.test");
  const [busy, setBusy] = useState(false);
  return (
    <AuthenticationWrapper pageType={EPageTypes.NON_AUTHENTICATED}>
      <form
        aria-label="Simulated session login"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await invitationAuthState.simulateLogin(email);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>Simulated session login</h1>
        <p>This test form does not call a real SSO provider or create an account.</p>
        <label htmlFor="fixture-login-email">Session email</label>
        <input id="fixture-login-email" value={email} onChange={(event) => setEmail(event.target.value)} />
        <button type="submit" disabled={busy}>
          Simulate sign in
        </button>
        <output data-testid="login-return-query">{location.search}</output>
      </form>
    </AuthenticationWrapper>
  );
}
